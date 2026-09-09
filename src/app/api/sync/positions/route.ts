import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSyncAuthorized } from "@/lib/sync/auth";
import {
  getConfiguredAccounts,
  getVehiclesForUser,
  parseVehiclePosition,
  type TrackitAccount,
} from "@/lib/trackit/client";

// One GET /api/vehiclesForUser call per TRACKiT account plus one bulk upsert
// each — nothing here is per-vehicle. Accounts run in parallel, so wall time is
// ~the slowest account, not the sum. Budget is 180s (not 60s): a large-fleet
// TRACKiT tenant can take 20-30s to answer /vehiclesForUser, and a bad run can
// still need a retry or two on top of that. Warm runs are ~10-17s. (Contrast
// /api/sync/travels, which is ~15s *per vehicle*.)
export const maxDuration = 180;

// A new odometer reading more than 5% below the vehicle's last known value is
// treated as a corrupted/cached TRACKiT read and the whole ping is dropped
// (see 0007_vehicle_pings.sql). 0.95 matches the reference implementation.
const ODOMETER_REGRESSION_FLOOR = 0.95;

// vehicle_pings is append-only and detect_stops rescans it every run, so old
// rows are pure cost. Any ping older than this is well past every vehicle's
// resume point (which tracks the last stop — days old at most), so it can be
// pruned on each ingest to keep the table bounded.
const PING_RETENTION_DAYS = 30;

type AccountResult = {
  trackitAccount: string;
  vehiclesReturned?: number;
  pingsConsidered?: number;
  pingsInserted?: number;
  pingsDuplicateInBatch?: number;
  pingsRejectedOdometer?: number;
  pingsMissingTimestamp?: number;
  pingsPruned?: number;
  pruneError?: string;
  error?: string;
};

async function syncAccountPositions(
  account: TrackitAccount,
  supabase: ReturnType<typeof createAdminClient>,
): Promise<AccountResult> {
  try {
    // Last known odometer per vehicle, for the regression clamp below. Empty on
    // the very first run (no pings yet) — then nothing is clamped.
    const { data: lastOdoRows, error: lastOdoError } = await supabase.rpc(
      "latest_vehicle_odometers",
      { p_trackit_account: account.id },
    );
    if (lastOdoError) {
      throw new Error(`latest_vehicle_odometers failed: ${lastOdoError.message}`);
    }
    const lastOdometer = new Map<number, number>(
      ((lastOdoRows ?? []) as Array<{ vehicle_id: number; odometer_km: number }>).map(
        (r) => [r.vehicle_id, r.odometer_km],
      ),
    );

    // Different accounts have independent TRACKiT rate limits; the per-account
    // pacer in trackit/client.ts serialises only the calls sharing this id.
    const vehicles = await getVehiclesForUser(account);

    let missingTimestamp = 0;
    let rejectedOdometer = 0;
    let considered = 0;
    // Keyed by (vehicle_id, recorded_at) — the same key the table is unique on —
    // so a vehicle listed twice in one payload can't break the upsert.
    const rows = new Map<string, Record<string, unknown>>();

    for (const vehicle of vehicles) {
      const pos = parseVehiclePosition(vehicle);

      // recorded_at is NOT NULL and part of the dedup key: a ping without a
      // parseable timestamp can't be stored or resumed from.
      if (!pos.recordedAt) {
        missingTimestamp++;
        continue;
      }

      // Odometer regressed more than 5% vs last known: drop the whole ping as a
      // likely stale/cached read rather than feed detect_stops bad geometry.
      const last = lastOdometer.get(pos.vehicleId);
      if (
        pos.odometerKm != null &&
        last != null &&
        pos.odometerKm < last * ODOMETER_REGRESSION_FLOOR
      ) {
        rejectedOdometer++;
        continue;
      }

      considered++;
      rows.set(`${pos.vehicleId}|${pos.recordedAt}`, {
        trackit_account: account.id,
        vehicle_id: pos.vehicleId,
        plate: pos.plate,
        latitude: pos.latitude,
        longitude: pos.longitude,
        // speed_kmh is an integer column; TRACKiT can report fractional km/h.
        speed_kmh: pos.speedKmh == null ? null : Math.round(pos.speedKmh),
        odometer_km: pos.odometerKm,
        recorded_at: pos.recordedAt,
        trackit_poi_id: pos.trackitPoiId,
        trackit_poi_distance_m: pos.trackitPoiDistanceM,
      });
    }

    const batch = [...rows.values()];

    let pingsInserted = 0;
    if (batch.length > 0) {
      // ignoreDuplicates -> ON CONFLICT DO NOTHING: a vehicle that hasn't moved
      // reports the same (vehicle_id, recorded_at) on every poll, and we want to
      // keep the first-seen row (and its ingested_at), not rewrite it. With
      // ignoreDuplicates the returned rows are exactly the newly inserted ones.
      const { data, error } = await supabase
        .from("vehicle_pings")
        .upsert(batch, {
          onConflict: "trackit_account,vehicle_id,recorded_at",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) {
        throw new Error(`vehicle_pings upsert failed: ${error.message}`);
      }
      pingsInserted = data?.length ?? 0;
    }

    // Retention sweep. Non-fatal: the ingest above is already committed, and a
    // table that's briefly too large is far better than failing the poll.
    let pingsPruned = 0;
    let pruneError: string | undefined;
    {
      const cutoff = new Date(
        Date.now() - PING_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: pruned, error } = await supabase
        .from("vehicle_pings")
        .delete()
        .eq("trackit_account", account.id)
        .lt("recorded_at", cutoff)
        .select("id");
      if (error) pruneError = error.message;
      else pingsPruned = pruned?.length ?? 0;
    }

    return {
      trackitAccount: account.id,
      vehiclesReturned: vehicles.length,
      pingsConsidered: considered,
      pingsInserted,
      pingsDuplicateInBatch: considered - rows.size,
      pingsRejectedOdometer: rejectedOdometer,
      pingsMissingTimestamp: missingTimestamp,
      pingsPruned,
      ...(pruneError ? { pruneError } : {}),
    };
  } catch (err) {
    return {
      trackitAccount: account.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function POST(request: NextRequest) {
  if (!isSyncAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const accounts = getConfiguredAccounts();
  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "no TRACKiT account configured (set TRACKIT_USER / TRACKIT_PASS)" },
      { status: 500 },
    );
  }

  const supabase = createAdminClient();

  // Accounts run concurrently: their TRACKiT rate limits are independent, and
  // each writes its own trackit_account partition so the upserts don't collide.
  const accountResults = await Promise.all(
    accounts.map((account) => syncAccountPositions(account, supabase)),
  );

  const allFailed = accountResults.every((r) => r.error);
  return NextResponse.json(
    { accounts: accountResults },
    { status: allFailed ? 502 : 200 },
  );
}
