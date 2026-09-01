import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { ParagensClient } from "./paragens-client";
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

  // Closed stops in the date window, with their matched location (null when the
  // stop didn't match a known location).
  const stopsRes = await supabase
    .from("stops")
    .select(
      "id, arrived_at, departed_at, duration_minutes, ping_count, location:locations(code, name, type)",
    )
    .eq("status", "closed")
    .gte("arrived_at", lisbonDayStartISO(fromYmd))
    .lt("arrived_at", lisbonDayStartISO(addDaysYmd(toYmd, 1)))
    .order("arrived_at", { ascending: false })
    .limit(3000);

  return (
    <ParagensClient
      stops={flattenStops(stopsRes.data)}
      stopsError={stopsRes.error?.message ?? null}
      filterFrom={fromYmd}
      filterTo={toYmd}
      today={today}
    />
  );
}
