// Non-client helpers shared by the /dashboard server components (the hub page
// and the three section pages). Kept out of _shared.tsx because that file is
// "use client" — a Server Component must not import runtime values from a
// client module.

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sanity cap for "Trajetos recentes". A legitimate warehouse↔store delivery
// never takes this long; anything above it is almost certainly an artefact of a
// gap in the position feed (two real stops glued into one "trip" because the
// stop between them had too few pings to be detected).
export const MAX_PLAUSIBLE_TRAVEL_SECONDS = 6 * 3600;
export const MAX_PLAUSIBLE_TRAVEL_HOURS = MAX_PLAUSIBLE_TRAVEL_SECONDS / 3600;

// Day boundaries are anchored to Portugal, not the server's UTC.
export function todayInLisbon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(
    new Date(),
  );
}

export function addDaysYmd(ymd: string, n: number): string {
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
export function lisbonDayStartISO(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = lisbonOffsetMinutes(new Date(guess));
  return new Date(guess - off * 60000).toISOString();
}

// ?from=&to= -> validated YMD range, defaulting to `today` for either end.
export function resolveRange(
  sp: Record<string, string | string[] | undefined>,
  today: string,
): { fromYmd: string; toYmd: string } {
  const rawFrom =
    typeof sp.from === "string" && YMD_RE.test(sp.from) ? sp.from : null;
  const rawTo = typeof sp.to === "string" && YMD_RE.test(sp.to) ? sp.to : null;
  return { fromYmd: rawFrom ?? today, toYmd: rawTo ?? today };
}

// A closed stop joined to its (optional) matched location, flattened for the
// "Paragens" table/export. Used by both paragens/page.tsx and the hub.
export type StopRow = {
  id: string;
  arrived_at: string;
  departed_at: string | null;
  duration_minutes: number | null;
  ping_count: number;
  // "carga" | "estacionamento" — see stop_kind_of() (migration 0017).
  stop_kind: string | null;
  location_code: string | null;
  location_name: string | null;
  location_type: string | null;
};

type StopEmbedRow = {
  id: string;
  arrived_at: string;
  departed_at: string | null;
  duration_minutes: number | null;
  ping_count: number;
  stop_kind: string | null;
  location: {
    code: string | null;
    name: string | null;
    type: string | null;
  } | null;
};

export function flattenStops(data: unknown): StopRow[] {
  return ((data ?? []) as StopEmbedRow[]).map((s) => ({
    id: s.id,
    arrived_at: s.arrived_at,
    departed_at: s.departed_at,
    duration_minutes: s.duration_minutes,
    ping_count: s.ping_count,
    stop_kind: s.stop_kind ?? null,
    location_code: s.location?.code ?? null,
    location_name: s.location?.name ?? null,
    location_type: s.location?.type ?? null,
  }));
}
