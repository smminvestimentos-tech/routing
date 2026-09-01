import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DashboardClient,
  type Trip,
  type MatrixRow,
  type StopRow,
} from "./dashboard-client";

// Internal tool, no auth yet (see the request). Operational data — always
// render fresh, never cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard — Trajetos",
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sanity cap for section 1. A legitimate warehouse↔store delivery never takes
// this long; anything above it is almost certainly an artefact of a gap in the
// position feed (two real stops glued into one "trip" because the stop between
// them had too few pings to be detected). Excluded from the list, but counted
// and surfaced on the page so the data-quality issue isn't hidden.
const MAX_PLAUSIBLE_TRAVEL_SECONDS = 6 * 3600;
const MAX_PLAUSIBLE_TRAVEL_HOURS = MAX_PLAUSIBLE_TRAVEL_SECONDS / 3600;

// "Recent trips" day boundaries are anchored to Portugal, not the server's UTC.
function todayInLisbon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(
    new Date(),
  );
}

function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function lisbonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUTC = Date.UTC(
    g("year"),
    g("month") - 1,
    g("day"),
    g("hour"),
    g("minute"),
    g("second"),
  );
  return Math.round((asUTC - at.getTime()) / 60000);
}

// Midnight (Lisbon wall-clock) of the given calendar date, as a UTC ISO string.
function lisbonDayStartISO(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = lisbonOffsetMinutes(new Date(guess));
  return new Date(guess - off * 60000).toISOString();
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const today = todayInLisbon();
  const rawFrom = typeof sp.from === "string" && YMD_RE.test(sp.from) ? sp.from : null;
  const rawTo = typeof sp.to === "string" && YMD_RE.test(sp.to) ? sp.to : null;
  // No params -> "today" (from 00:00 today, Lisbon, through now).
  const fromYmd = rawFrom ?? today;
  const toYmd = rawTo ?? today;

  const supabase = createAdminClient();

  const fromISO = lisbonDayStartISO(fromYmd);
  const toISO = lisbonDayStartISO(addDaysYmd(toYmd, 1));

  const [tripsRes, matrixRes, stopsRes] = await Promise.all([
    supabase
      .from("v_recent_trips")
      .select(
        "vehicle_id, vehicle_plate, origin_name, destination_name, origin_code, destination_code, departed_at, arrived_at, travel_seconds, leg_km, destination_duration_minutes",
      )
      // Section 1 is store↔store↔warehouse trips — both ends must be a known location.
      .not("origin_location_id", "is", null)
      .not("destination_location_id", "is", null)
      // Date range on arrived_at: [start of `from` day, start of the day after `to`).
      .gte("arrived_at", fromISO)
      .lt("arrived_at", toISO)
      .order("arrived_at", { ascending: false })
      // A day / week of trips is bounded; cap high just as a guard.
      .limit(2000),
    supabase
      .from("v_location_pair_matrix")
      .select(
        "source, origin_name, destination_name, origin_code, destination_code, trip_count, avg_duration_seconds, median_duration_seconds, avg_distance_km",
      )
      .order("trip_count", { ascending: false })
      .limit(500),
    // "Paragens" section: closed stops in the same date window, with their
    // matched location (null when the stop didn't match a known location).
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

  // Drop implausibly long trips (see MAX_PLAUSIBLE_TRAVEL_SECONDS) but keep a
  // count so the dashboard can note that it happened.
  const allTrips = (tripsRes.data ?? []) as Trip[];
  const trips = allTrips.filter(
    (t) =>
      t.travel_seconds == null ||
      t.travel_seconds <= MAX_PLAUSIBLE_TRAVEL_SECONDS,
  );
  const implausibleExcluded = allTrips.length - trips.length;

  // Flatten the embedded location onto each stop row for the table/export.
  type StopQueryRow = {
    id: string;
    arrived_at: string;
    departed_at: string | null;
    duration_minutes: number | null;
    ping_count: number;
    location: { code: string | null; name: string | null; type: string | null } | null;
  };
  const stops = ((stopsRes.data ?? []) as unknown as StopQueryRow[]).map((s) => ({
    id: s.id,
    arrived_at: s.arrived_at,
    departed_at: s.departed_at,
    duration_minutes: s.duration_minutes,
    ping_count: s.ping_count,
    location_code: s.location?.code ?? null,
    location_name: s.location?.name ?? null,
    location_type: s.location?.type ?? null,
  })) satisfies StopRow[];

  return (
    <DashboardClient
      trips={trips}
      tripsError={tripsRes.error?.message ?? null}
      implausibleExcluded={implausibleExcluded}
      implausibleThresholdHours={MAX_PLAUSIBLE_TRAVEL_HOURS}
      matrix={(matrixRes.data ?? []) as MatrixRow[]}
      matrixError={matrixRes.error?.message ?? null}
      stops={stops}
      stopsError={stopsRes.error?.message ?? null}
      filterFrom={fromYmd}
      filterTo={toYmd}
      today={today}
    />
  );
}
