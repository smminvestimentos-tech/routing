import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { CamioesClient, type FleetTruck } from "./camioes-client";

// Internal tool, no auth yet (same as the rest of /dashboard). Master data —
// always render fresh so edits show up immediately after router.refresh().
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Camiões — Dashboard",
};

const COLUMNS = "id, truck_number, plate, updated_at";

export default async function CamioesPage() {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("fleet_trucks")
    .select(COLUMNS)
    .order("truck_number", { ascending: true });

  return (
    <CamioesClient
      trucks={(data ?? []) as FleetTruck[]}
      loadError={error?.message ?? null}
    />
  );
}
