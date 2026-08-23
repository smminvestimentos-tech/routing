import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findNearestLocationId, type GeoPoint } from "@/lib/geo";
import {
  getPois,
  getVehiclesForUser,
  getVehicleTravels,
  type TrackitTravel,
} from "@/lib/trackit/client";

// 300s is the max Hobby accepts with Fluid Compute (confirmed: values up to
// 60 are honored exactly — Vercel killed the function at "60 seconds" when
// this was set to 60).
export const maxDuration = 300;

// Only one TRACKiT account/credential pair is wired up today (TRACKIT_USER/TRACKIT_PASS).
// When a second account is added, this becomes one iteration of a loop over
// {account, user, pass} entries, each with its own sync_runs row.
const TRACKIT_ACCOUNT = "default";

// Each vehicleTravels call takes ~15s on TRACKiT's own end regardless of
// caller (confirmed via raw curl timing: DNS/TCP/TLS are all sub-40ms, the
// full ~15s is server-side TTFB) — the ~1.1s pacer floor in
// src/lib/trackit/client.ts is essentially irrelevant next to that. 18
// vehicles * ~15s =~ 270s, leaving ~30s headroom under the 300s maxDuration
// above for network/Supabase overhead.
const DEFAULT_BATCH_SIZE = 18;

// Refresh trackit_pois at most once a day — it's a slow call (thousands of
// POIs) and every second still matters against the batch's time budget, so
// most of the 15-minute cron ticks should skip it entirely.
const POIS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type VehicleError = { vehicleId: number; error: string };

type SyncRun = {
  id: string;
  trackit_account: string;
  status: "running" | "completed" | "failed";
  date_begin: string;
  date_end: string;
  vehicle_ids: number[];
  vehicles_total: number;
  vehicles_processed: number;
  cursor: number;
  travels_upserted: number;
  vehicle_errors: VehicleError[];
};

function formatTrackitDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.SYNC_SECRET;
  if (!secret) return true; // no secret configured: open (local dev only)
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  // TEMPORARY: timing instrumentation to find where the Hobby 10s budget is
  // going. Remove once the bottleneck is identified. fnStart must be local
  // to this invocation — a warm serverless instance reuses module scope
  // across requests, so a module-level timestamp would go stale.
  const fnStart = Date.now();
  const mark = (label: string) => console.log(`[timing] ${label} +${Date.now() - fnStart}ms`);
  mark("function start");

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    runId?: string;
    dateBegin?: string;
    dateEnd?: string;
    batchSize?: number;
  } = {};
  try {
    body = await request.json();
  } catch {
    // no body sent: fall back to defaults below
  }

  const batchSize =
    body.batchSize && body.batchSize > 0 ? body.batchSize : DEFAULT_BATCH_SIZE;

  const supabase = createAdminClient();

  let run: SyncRun;
  let trackitPoisUpserted = 0;

  if (body.runId) {
    const { data, error } = await supabase
      .from("sync_runs")
      .select("*")
      .eq("id", body.runId)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: `sync run not found: ${body.runId}` },
        { status: 404 },
      );
    }
    if (data.status !== "running") {
      return NextResponse.json(
        { error: `sync run ${body.runId} is already ${data.status}` },
        { status: 409 },
      );
    }
    run = data as SyncRun;
    mark("sync_runs lookup by runId done");
  } else {
    // Resume the account's already-open run if there is one, instead of
    // starting a second one — makes it safe to just call this endpoint
    // repeatedly (e.g. from a cron) without tracking runId externally.
    const { data: openRun, error: openRunError } = await supabase
      .from("sync_runs")
      .select("*")
      .eq("trackit_account", TRACKIT_ACCOUNT)
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    mark("open run lookup done");

    if (openRunError) {
      return NextResponse.json(
        { error: `sync_runs lookup failed: ${openRunError.message}` },
        { status: 500 },
      );
    }

    if (openRun) {
      run = openRun as SyncRun;
    } else {
      // New run: refresh trackit_pois (reference only) if stale, then
      // snapshot the vehicle list.
      const { data: metadata, error: metadataFetchError } = await supabase
        .from("sync_metadata")
        .select("pois_synced_at")
        .eq("trackit_account", TRACKIT_ACCOUNT)
        .maybeSingle();
      mark("sync_metadata read done");

      if (metadataFetchError) {
        return NextResponse.json(
          { error: `sync_metadata fetch failed: ${metadataFetchError.message}` },
          { status: 500 },
        );
      }

      const poisStale =
        !metadata?.pois_synced_at ||
        Date.now() - new Date(metadata.pois_synced_at).getTime() > POIS_STALE_AFTER_MS;

      if (poisStale) {
        const pois = await getPois();
        mark("getPois() done");
        trackitPoisUpserted = pois.length;

        if (pois.length > 0) {
          const { error } = await supabase.from("trackit_pois").upsert(
            pois.map((poi) => ({
              trackit_account: TRACKIT_ACCOUNT,
              id_poi_trackit: poi.id,
              name: poi.description ?? null,
              type: poi.type ?? null,
              latitude: poi.latitude ?? null,
              longitude: poi.longitude ?? null,
              updated_at: new Date().toISOString(),
            })),
            { onConflict: "trackit_account,id_poi_trackit" },
          );
          if (error) {
            return NextResponse.json(
              { error: `trackit_pois upsert failed: ${error.message}` },
              { status: 500 },
            );
          }
        }

        const { error: metadataUpsertError } = await supabase
          .from("sync_metadata")
          .upsert(
            { trackit_account: TRACKIT_ACCOUNT, pois_synced_at: new Date().toISOString() },
            { onConflict: "trackit_account" },
          );
        if (metadataUpsertError) {
          return NextResponse.json(
            { error: `sync_metadata upsert failed: ${metadataUpsertError.message}` },
            { status: 500 },
          );
        }
      }

      const vehicles = await getVehiclesForUser();
      mark("getVehiclesForUser() done");
      const vehicleIds = Array.from(new Set(vehicles.map((v) => v.mid)));

      const dateEnd = body.dateEnd ?? formatTrackitDate(new Date());
      const dateBegin =
        body.dateBegin ??
        formatTrackitDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

      const { data: created, error: createError } = await supabase
        .from("sync_runs")
        .insert({
          trackit_account: TRACKIT_ACCOUNT,
          status: "running",
          date_begin: dateBegin,
          date_end: dateEnd,
          vehicle_ids: vehicleIds,
          vehicles_total: vehicleIds.length,
        })
        .select("*")
        .single();

      if (createError || !created) {
        return NextResponse.json(
          { error: `sync_runs insert failed: ${createError?.message}` },
          { status: 500 },
        );
      }
      run = created as SyncRun;
      mark("sync_runs insert done");
    }
  }

  // Business locations for proximity matching — reloaded every batch (cheap
  // internal query) so it reflects the latest CSV import.
  const { data: locationRows, error: locationsError } = await supabase
    .from("locations")
    .select("id, latitude, longitude")
    .not("latitude", "is", null)
    .not("longitude", "is", null);
  mark("locations fetch done");

  if (locationsError) {
    return NextResponse.json(
      { error: `locations fetch failed: ${locationsError.message}` },
      { status: 500 },
    );
  }
  const geoLocations: GeoPoint[] = (locationRows ?? []) as GeoPoint[];

  const batchVehicleIds = run.vehicle_ids.slice(run.cursor, run.cursor + batchSize);
  mark(`vehicle loop start (${batchVehicleIds.length} vehicles)`);

  const batchErrors: VehicleError[] = [];
  const legs: Array<Record<string, unknown>> = [];

  for (const vehicleId of batchVehicleIds) {
    let travels: TrackitTravel[];
    const label = `[timing] getVehicleTravels(${vehicleId})`;
    console.time(label);
    try {
      travels = await getVehicleTravels(vehicleId, run.date_begin, run.date_end);
      console.timeEnd(label);
      mark(`getVehicleTravels(${vehicleId}) done`);
    } catch (err) {
      console.timeEnd(label);
      mark(`getVehicleTravels(${vehicleId}) failed`);
      batchErrors.push({
        vehicleId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const travel of travels) {
      const originPoi = travel.ini?.poi ?? null;
      const destinationPoi = travel.end?.poi ?? null;

      legs.push({
        trackit_account: TRACKIT_ACCOUNT,
        vehicle_id: String(vehicleId),
        travel_date: travel.ymd ?? null,
        origin_id: findNearestLocationId(travel.ini?.lat, travel.ini?.lng, geoLocations),
        destination_id: findNearestLocationId(travel.end?.lat, travel.end?.lng, geoLocations),
        origin_poi_trackit: originPoi,
        destination_poi_trackit: destinationPoi,
        started_at: travel.ini?.timestamp ?? null,
        ended_at: travel.end?.timestamp ?? null,
        duration_seconds: travel.total_drive ?? null,
        distance_km: travel.total_km ?? null,
        avg_speed: travel.avg_speed ?? null,
      });
    }
  }
  mark("vehicle loop done");

  // A travel with no start time can't be placed by the (vehicle_id, started_at)
  // key — drop it rather than risk piling up unmatched null-keyed rows.
  const legsWithStart = legs.filter((leg) => leg.started_at != null);

  // (vehicle_id, started_at) uniquely identifies a travel; collapse any
  // duplicate before sending it, since a single upsert can't hit the same
  // conflict target twice.
  const dedupedLegs = Array.from(
    new Map(legsWithStart.map((leg) => [`${leg.vehicle_id}|${leg.started_at}`, leg])).values(),
  );

  let batchTravelsUpserted = 0;
  if (dedupedLegs.length > 0) {
    const { data, error } = await supabase
      .from("route_legs")
      .upsert(dedupedLegs, { onConflict: "trackit_account,vehicle_id,started_at" })
      .select("id");

    if (error) {
      // Cursor isn't advanced yet, so retrying this same run/batch later
      // (same runId) will simply redo this slice — nothing is lost.
      return NextResponse.json(
        { error: `route_legs upsert failed: ${error.message}`, runId: run.id },
        { status: 500 },
      );
    }
    batchTravelsUpserted = data?.length ?? 0;
  }
  mark("route_legs upsert done");

  const newCursor = run.cursor + batchVehicleIds.length;
  const newVehiclesProcessed = run.vehicles_processed + batchVehicleIds.length;
  const newTravelsUpserted = run.travels_upserted + batchTravelsUpserted;
  const newVehicleErrors = [...run.vehicle_errors, ...batchErrors];
  const isDone = newCursor >= run.vehicles_total;

  const { data: updated, error: updateError } = await supabase
    .from("sync_runs")
    .update({
      cursor: newCursor,
      vehicles_processed: newVehiclesProcessed,
      travels_upserted: newTravelsUpserted,
      vehicle_errors: newVehicleErrors,
      status: isDone ? "completed" : "running",
      completed_at: isDone ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .select("*")
    .single();
  mark("sync_runs final update done");

  if (updateError || !updated) {
    return NextResponse.json(
      { error: `sync_runs update failed: ${updateError?.message}`, runId: run.id },
      { status: 500 },
    );
  }

  mark("function end");
  return NextResponse.json({
    runId: run.id,
    status: updated.status,
    dateBegin: run.date_begin,
    dateEnd: run.date_end,
    vehiclesTotal: run.vehicles_total,
    vehiclesProcessed: newVehiclesProcessed,
    hasMore: !isDone,
    trackitPoisUpserted,
    locationsAvailableForMatching: geoLocations.length,
    travelsUpsertedThisBatch: batchTravelsUpserted,
    travelsUpsertedTotal: newTravelsUpserted,
    duplicateTravelsDroppedThisBatch: legsWithStart.length - dedupedLegs.length,
    travelsMissingStartTimeThisBatch: legs.length - legsWithStart.length,
    vehicleErrors: newVehicleErrors,
  });
}
