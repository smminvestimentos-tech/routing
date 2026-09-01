import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { TrajetosClient, type Trip } from "./trajetos-client";
import {
  todayInLisbon,
  resolveRange,
  addDaysYmd,
  lisbonDayStartISO,
  MAX_PLAUSIBLE_TRAVEL_SECONDS,
  MAX_PLAUSIBLE_TRAVEL_HOURS,
} from "../_server";

// Internal tool, no auth yet. Operational data — always render fresh.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Trajetos recentes — Dashboard",
};

export default async function TrajetosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const today = todayInLisbon();
  const { fromYmd, toYmd } = resolveRange(sp, today);

  const supabase = createAdminClient();

  const tripsRes = await supabase
    .from("v_recent_trips")
    .select(
      "vehicle_id, vehicle_plate, origin_name, destination_name, origin_code, destination_code, departed_at, arrived_at, travel_seconds, leg_km, destination_duration_minutes",
    )
    // Trips between known locations only — both ends must be a matched location.
    .not("origin_location_id", "is", null)
    .not("destination_location_id", "is", null)
    // Date range on arrived_at: [start of `from` day, start of the day after `to`).
    .gte("arrived_at", lisbonDayStartISO(fromYmd))
    .lt("arrived_at", lisbonDayStartISO(addDaysYmd(toYmd, 1)))
    .order("arrived_at", { ascending: false })
    // A day / week of trips is bounded; cap high just as a guard.
    .limit(2000);

  // Drop implausibly long trips but keep a count so the page can note it.
  const allTrips = (tripsRes.data ?? []) as Trip[];
  const trips = allTrips.filter(
    (t) =>
      t.travel_seconds == null ||
      t.travel_seconds <= MAX_PLAUSIBLE_TRAVEL_SECONDS,
  );

  return (
    <TrajetosClient
      trips={trips}
      tripsError={tripsRes.error?.message ?? null}
      implausibleExcluded={allTrips.length - trips.length}
      implausibleThresholdHours={MAX_PLAUSIBLE_TRAVEL_HOURS}
      filterFrom={fromYmd}
      filterTo={toYmd}
      today={today}
    />
  );
}
