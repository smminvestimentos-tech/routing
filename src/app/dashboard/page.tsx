import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DashboardClient,
  type Trip,
  type MatrixRow,
} from "./dashboard-client";

// Internal tool, no auth yet (see the request). Operational data — always
// render fresh, never cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard — Trajetos",
};

export default async function DashboardPage() {
  const supabase = createAdminClient();

  const [tripsRes, matrixRes] = await Promise.all([
    supabase
      .from("v_recent_trips")
      .select(
        "vehicle_id, origin_name, destination_name, departed_at, arrived_at, travel_seconds, leg_km",
      )
      // Section 1 is store↔store↔warehouse trips — both ends must be a known location.
      .not("origin_location_id", "is", null)
      .not("destination_location_id", "is", null)
      .order("arrived_at", { ascending: false })
      .limit(100),
    supabase
      .from("v_location_pair_matrix")
      .select(
        "source, origin_name, destination_name, trip_count, avg_duration_seconds, median_duration_seconds, avg_distance_km",
      )
      .order("trip_count", { ascending: false })
      .limit(500),
  ]);

  return (
    <DashboardClient
      trips={(tripsRes.data ?? []) as Trip[]}
      tripsError={tripsRes.error?.message ?? null}
      matrix={(matrixRes.data ?? []) as MatrixRow[]}
      matrixError={matrixRes.error?.message ?? null}
    />
  );
}
