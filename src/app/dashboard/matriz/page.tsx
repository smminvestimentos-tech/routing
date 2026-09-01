import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { MatrizClient, type MatrixRow } from "./matriz-client";

// Internal tool, no auth yet. Operational data — always render fresh.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Matriz tempo / km — Dashboard",
};

export default async function MatrizPage() {
  const supabase = createAdminClient();

  // No date filter here (as before): the matrix aggregates all history.
  const matrixRes = await supabase
    .from("v_location_pair_matrix")
    .select(
      "source, origin_name, destination_name, origin_code, destination_code, trip_count, avg_duration_seconds, median_duration_seconds, avg_distance_km",
    )
    .order("trip_count", { ascending: false })
    .limit(500);

  return (
    <MatrizClient
      matrix={(matrixRes.data ?? []) as MatrixRow[]}
      matrixError={matrixRes.error?.message ?? null}
    />
  );
}
