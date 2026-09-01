import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { ParagensClient, type DwellStatRow } from "./paragens-client";
import {
  todayInLisbon,
  resolveRange,
  addDaysYmd,
  lisbonDayStartISO,
  flattenStops,
} from "../_server";

// Internal tool, no auth yet. Operational data — always render fresh.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Paragens — Dashboard",
};

export default async function ParagensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const today = todayInLisbon();
  const { fromYmd, toYmd } = resolveRange(sp, today);

  const supabase = createAdminClient();

  const [stopsRes, dwellRes, platesRes] = await Promise.all([
    // Closed stops in the date window, with their matched location (null when
    // the stop didn't match a known location).
    supabase
      .from("stops")
      .select(
        "id, vehicle_id, arrived_at, departed_at, duration_minutes, ping_count, stop_kind, location:locations(code, name, type)",
      )
      .eq("status", "closed")
      .gte("arrived_at", lisbonDayStartISO(fromYmd))
      .lt("arrived_at", lisbonDayStartISO(addDaysYmd(toYmd, 1)))
      .order("arrived_at", { ascending: false })
      .limit(3000),
    // Dwell stats per location + classification — all closed stops, no date
    // filter (like the trip matrix).
    supabase
      .from("v_location_dwell_stats")
      .select(
        "location_id, location_code, location_name, location_type, stop_kind, stop_count, avg_duration_minutes, median_duration_minutes, min_duration_minutes, max_duration_minutes",
      )
      .order("stop_count", { ascending: false })
      .limit(1000),
    supabase.from("latest_vehicle_plate").select("vehicle_id, plate"),
  ]);

  const plateByVehicle: Record<number, string | null> = {};
  for (const p of platesRes.data ?? []) plateByVehicle[p.vehicle_id] = p.plate;

  return (
    <ParagensClient
      stops={flattenStops(stopsRes.data, plateByVehicle)}
      stopsError={stopsRes.error?.message ?? null}
      dwellStats={(dwellRes.data ?? []) as DwellStatRow[]}
      dwellStatsError={dwellRes.error?.message ?? null}
      filterFrom={fromYmd}
      filterTo={toYmd}
      today={today}
    />
  );
}
