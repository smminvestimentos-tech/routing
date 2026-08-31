import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getVehiclesForUser, parseVehiclePosition } from "@/lib/trackit/client";

// One GET /api/vehiclesForUser call for the whole fleet plus one bulk upsert —
// nothing here is per-vehicle, so this stays comfortably under a minute even
// with retries. (Contrast /api/sync/travels, which is ~15s *per vehicle*.)
export const maxDuration = 60;

// Only one TRACKiT account/credential pair is wired up today (TRACKIT_USER /
// TRACKIT_PASS). When a second account is added this becomes one iteration of
// a loop over {account, user, pass} entries.
const TRACKIT_ACCOUNT = "default";

// A new odometer reading more than 5% below the vehicle's last known value is
// treated as a corrupted/cached TRACKiT read and the whole ping is dropped
// (see 0007_vehicle_pings.sql). 0.95 matches the reference implementation.
const ODOMETER_REGRESSION_FLOOR = 0.95;

// vehicle_pings is append-only and detect_stops rescans it every run, so old
// rows are pure cost. Any ping older than this is well past every vehicle's
// resume point (which tracks the last stop — days old at most), so it can be
// pruned on each ingest to keep the table bounded.
const PING_RETENTION_DAYS = 30;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.SYNC_SECRET;
  if (!secret) return true; // no secret configured: open (local dev only)
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Last known odometer per vehicle, for the regression clamp below. Empty on
  // the very first run (no pings yet) — then nothing is clamped.
  const { data: lastOdoRows, error: lastOdoError } = await supabase.rpc(
    "latest_vehicle_odometers",
    { p_trackit_account: TRACKIT_ACCOUNT },
  );
  if (lastOdoError) {
    return NextResponse.json(
      { error: `latest_vehicle_odometers failed: ${lastOdoError.message}` },
      { status: 500 },
    );
  }
  const lastOdometer = new Map<number, number>(
    ((lastOdoRows ?? []) as Array<{ vehicle_id: number; odometer_km: number }>).map(
      (r) => [r.vehicle_id, r.odometer_km],
    ),
  );

  let vehicles;
  try {
    vehicles = await getVehiclesForUser();
  } catch (err) {
    return NextResponse.json(
      {
        error: `vehiclesForUser failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

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
      trackit_account: TRACKIT_ACCOUNT,
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
      return NextResponse.json(
        { error: `vehicle_pings upsert failed: ${error.message}` },
        { status: 500 },
      );
    }
    pingsInserted = data?.length ?? 0;
  }

  // Retention sweep. Non-fatal: the ingest above is already committed, and a
  // table that's briefly too large is far better than failing the poll.
  let pingsPruned = 0;
  let pruneError: string | null = null;
  {
    const cutoff = new Date(
      Date.now() - PING_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: pruned, error } = await supabase
      .from("vehicle_pings")
      .delete()
      .eq("trackit_account", TRACKIT_ACCOUNT)
      .lt("recorded_at", cutoff)
      .select("id");
    if (error) pruneError = error.message;
    else pingsPruned = pruned?.length ?? 0;
  }

  return NextResponse.json({
    trackitAccount: TRACKIT_ACCOUNT,
    vehiclesReturned: vehicles.length,
    pingsConsidered: considered,
    pingsInserted,
    pingsDuplicateInBatch: considered - rows.size,
    pingsRejectedOdometer: rejectedOdometer,
    pingsMissingTimestamp: missingTimestamp,
    pingsPruned,
    ...(pruneError ? { pruneError } : {}),
  });
}
