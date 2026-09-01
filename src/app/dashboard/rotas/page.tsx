import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { RotasClient, type RouteEstimateRow } from "./rotas-client";
import { DEFAULT_MARGIN_PERCENT } from "@/lib/margins";

// Internal tool, no auth yet. Operational data — always render fresh.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rotas — Dashboard",
};

const ROUTE_COLUMNS =
  "origin_location_id, destination_location_id, origin_code, origin_name, destination_code, destination_name, trip_count, avg_travel_minutes, origin_load_minutes, destination_load_minutes";

export default async function RotasPage() {
  const supabase = createAdminClient();

  const [routesRes, marginsRes, settingsRes] = await Promise.all([
    supabase
      .from("v_route_estimates")
      .select(ROUTE_COLUMNS)
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
  ]);

  const initialOverrides: Record<string, number> = {};
  for (const m of marginsRes.data ?? []) {
    initialOverrides[`${m.origin_location_id}|${m.destination_location_id}`] =
      Number(m.margin_percent);
  }

  return (
    <RotasClient
      routes={(routesRes.data ?? []) as RouteEstimateRow[]}
      routesError={routesRes.error?.message ?? null}
      initialOverrides={initialOverrides}
      initialDefaultMargin={
        settingsRes.data?.default_margin_percent != null
          ? Number(settingsRes.data.default_margin_percent)
          : DEFAULT_MARGIN_PERCENT
      }
    />
  );
}
