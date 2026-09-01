import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocationsClient, type Location } from "./locations-client";

// Internal tool, no auth yet (same as the rest of /dashboard). Master data —
// always render fresh so edits show up immediately after router.refresh().
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Locations — Dashboard",
};

const COLUMNS =
  "id, code, arp2_code, name, type, address, locality, latitude, longitude, radius_meters, updated_at";

export default async function LocationsPage() {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("locations")
    .select(COLUMNS)
    .order("code", { ascending: true });

  return (
    <LocationsClient
      locations={(data ?? []) as Location[]}
      loadError={error?.message ?? null}
    />
  );
}
