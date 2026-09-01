import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardHubClient } from "./dashboard-hub-client";
import type { Trip } from "./trajetos/trajetos-client";
import type { MatrixRow } from "./matriz/matriz-client";
import type { DwellStatRow } from "./paragens/paragens-client";
import type { RouteEstimateRow } from "./rotas/rotas-client";
import {
  todayInLisbon,
  addDaysYmd,
  lisbonDayStartISO,
  flattenStops,
  MAX_PLAUSIBLE_TRAVEL_SECONDS,
} from "./_server";
import { DEFAULT_MARGIN_PERCENT } from "@/lib/margins";

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

  const [
    tripsRes,
    matrixRes,
    stopsRes,
    dwellRes,
    routesRes,
    marginsRes,
    settingsRes,
    platesRes,
  ] = await Promise.all([
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
        "id, vehicle_id, arrived_at, departed_at, duration_minutes, ping_count, stop_kind, location:locations(code, name, type)",
      )
      .eq("status", "closed")
      .gte("arrived_at", fromISO)
      .lt("arrived_at", toISO)
      .order("arrived_at", { ascending: false })
      .limit(3000),
    supabase
      .from("v_location_dwell_stats")
      .select(
        "location_id, location_code, location_name, location_type, stop_kind, stop_count, avg_duration_minutes, median_duration_minutes, min_duration_minutes, max_duration_minutes",
      )
      .order("stop_count", { ascending: false })
      .limit(1000),
    supabase
      .from("v_route_estimates")
      .select(
        "origin_location_id, destination_location_id, origin_code, origin_name, destination_code, destination_name, trip_count, avg_travel_minutes, origin_load_minutes, destination_load_minutes",
      )
      .order("trip_count", { ascending: false })
      .limit(2000),
    supabase
      .from("route_margins")
      .select("origin_location_id, destination_location_id, margin_percent"),
    supabase
      .from("dashboard_settings")
      .select("default_margin_percent")
      .eq("id", true)
      .maybeSingle(),
    supabase.from("latest_vehicle_plate").select("vehicle_id, plate"),
  ]);

  const plateByVehicle: Record<number, string | null> = {};
  for (const p of platesRes.data ?? []) plateByVehicle[p.vehicle_id] = p.plate;

  const routeOverrides: Record<string, number> = {};
  for (const m of marginsRes.data ?? []) {
    routeOverrides[`${m.origin_location_id}|${m.destination_location_id}`] =
      Number(m.margin_percent);
  }

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
      stops={flattenStops(stopsRes.data, plateByVehicle)}
      dwellStats={(dwellRes.data ?? []) as DwellStatRow[]}
      routes={(routesRes.data ?? []) as RouteEstimateRow[]}
      routeOverrides={routeOverrides}
      defaultMargin={
        settingsRes.data?.default_margin_percent != null
          ? Number(settingsRes.data.default_margin_percent)
          : DEFAULT_MARGIN_PERCENT
      }
      anyError={
        tripsRes.error?.message ??
        matrixRes.error?.message ??
        stopsRes.error?.message ??
        dwellRes.error?.message ??
        routesRes.error?.message ??
        null
      }
    />
  );
}
