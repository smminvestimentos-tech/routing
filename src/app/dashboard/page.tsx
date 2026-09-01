import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardHubClient } from "./dashboard-hub-client";
import type { Trip } from "./trajetos/trajetos-client";
import type { MatrixRow } from "./matriz/matriz-client";
import {
  todayInLisbon,
  addDaysYmd,
  lisbonDayStartISO,
  flattenStops,
  MAX_PLAUSIBLE_TRAVEL_SECONDS,
} from "./_server";

// Internal tool, no auth yet. Navigation hub for the three sections; it still
// fetches all three (at today's range) so "Exportar tudo" can build the
// combined workbook.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const supabase = createAdminClient();
  const today = todayInLisbon();
  const fromISO = lisbonDayStartISO(today);
  const toISO = lisbonDayStartISO(addDaysYmd(today, 1));

  const [tripsRes, matrixRes, stopsRes] = await Promise.all([
    supabase
      .from("v_recent_trips")
      .select(
        "vehicle_id, vehicle_plate, origin_name, destination_name, origin_code, destination_code, departed_at, arrived_at, travel_seconds, leg_km, destination_duration_minutes",
      )
      .not("origin_location_id", "is", null)
      .not("destination_location_id", "is", null)
      .gte("arrived_at", fromISO)
      .lt("arrived_at", toISO)
      .order("arrived_at", { ascending: false })
      .limit(2000),
    supabase
      .from("v_location_pair_matrix")
      .select(
        "source, origin_name, destination_name, origin_code, destination_code, trip_count, avg_duration_seconds, median_duration_seconds, avg_distance_km",
      )
      .order("trip_count", { ascending: false })
      .limit(500),
    supabase
      .from("stops")
      .select(
        "id, arrived_at, departed_at, duration_minutes, ping_count, location:locations(code, name, type)",
      )
      .eq("status", "closed")
      .gte("arrived_at", fromISO)
      .lt("arrived_at", toISO)
      .order("arrived_at", { ascending: false })
      .limit(3000),
  ]);

  // Same sanity cut as /dashboard/trajetos so the export matches the page.
  const trips = ((tripsRes.data ?? []) as Trip[]).filter(
    (t) =>
      t.travel_seconds == null ||
      t.travel_seconds <= MAX_PLAUSIBLE_TRAVEL_SECONDS,
  );

  return (
    <DashboardHubClient
      trips={trips}
      matrix={(matrixRes.data ?? []) as MatrixRow[]}
      stops={flattenStops(stopsRes.data)}
      anyError={
        tripsRes.error?.message ??
        matrixRes.error?.message ??
        stopsRes.error?.message ??
        null
      }
    />
  );
}
