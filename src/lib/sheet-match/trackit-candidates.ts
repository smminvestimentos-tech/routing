// TRACKiT /vehicleTravels fallback candidates for the delivery-sheet matchers
// (tfs-sheet, azambuja-sheet) — used ONLY when our own `stops` couldn't
// resolve a row (see route.ts's two-pass runMatch() call). Pure — no I/O, no
// Supabase, no TRACKiT client — everything here receives already-fetched
// data. Validated against real data in this same investigation (see
// scripts/compare-vehicletravels-vs-stops.ts, compare-3way-bg96id-20260921.ts,
// compare-location-candidates.ts): the location-matching algorithm below
// agrees with our own `stops` in 43/44 real cases where both found something;
// the gap here is coverage (short stops `stops` misses, long warehouse
// dwells it over-merges), which is exactly what this module recovers.
//
// Deliberately reads ONLY timestamps + lat/lng from a travel — never
// TRACKiT's own `fractal` (free-text reverse-geocode, confirmed unreliable
// in the dense Azambuja/Vila Nova da Rainha warehouse cluster — it mislabels
// 7001/7005 as "Torrestir", a real but different nearby place) or `poi`
// (sparse, and several ids don't even exist in our own trackit_pois).

import {
  codeEq,
  type CoLocatedGroups,
  type DayStop,
  fmtHM,
  OPEN_STOP_ASSUMED_MS,
  trackitSkipNote,
  TRACKIT_FALLBACK,
  type TrackitSkipReason,
  REVIEW,
  type WStop,
} from "@/lib/sheet-match/common";

// ---------------------------------------------------------------------------
// Raw /vehicleTravels shapes this module actually reads. Intentionally
// narrower than TrackitTravel (src/lib/trackit/http.ts) — no `poi`, no
// `fractal` typed in at all, so a future edit can't casually start reading
// them here without also removing this comment.
// ---------------------------------------------------------------------------

export type RawTravelPoint = {
  timestampUTC?: string | null;
  lat?: number | null;
  lng?: number | null;
};
export type RawTravel = {
  ini?: RawTravelPoint | null;
  end?: RawTravelPoint | null;
};

export type LocationForMatch = {
  id: string;
  code: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  active: boolean;
};

// ---------------------------------------------------------------------------
// matchStopLocationTs — faithful TS port of match_stop_location() (SQL):
//   select l.id from unnest(buffer) b join locations l
//     on l.active and haversine(b, l) <= l.radius_meters
//   group by l.id order by count(*) desc, haversine(centroid, l) asc, l.id asc
//   limit 1
// (supabase/migrations/0009_detect_stops.sql, revised by 0036 to add
// `l.active`). Same rule, same tie-break — only the buffer is thinner here
// (1-2 points from a travel's boundary, vs detect_stops' dense ping buffer).
// ---------------------------------------------------------------------------

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function matchStopLocationTs(
  buffer: Array<{ lat: number; lng: number }>,
  centroidLat: number,
  centroidLng: number,
  locations: readonly LocationForMatch[],
): LocationForMatch | null {
  let best: LocationForMatch | null = null;
  let bestCount = -1;
  let bestDist = Infinity;
  for (const l of locations) {
    if (!l.active) continue;
    const count = buffer.filter(
      (b) => haversineMeters(b.lat, b.lng, l.latitude, l.longitude) <= l.radius_meters,
    ).length;
    if (count === 0) continue;
    const dist = haversineMeters(centroidLat, centroidLng, l.latitude, l.longitude);
    const better =
      count > bestCount ||
      (count === bestCount && dist < bestDist) ||
      (count === bestCount && dist === bestDist && (!best || l.id < best.id));
    if (better) {
      best = l;
      bestCount = count;
      bestDist = dist;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// deriveTravelDayStops — one candidate "stop" per gap between consecutive
// travels: cur.end (arrival) -> next.ini (departure).
//
//   • Dropped if the gap is under MIN_GAP_MINUTES (same floor
//     close_and_persist_stop uses in 0009_detect_stops.sql) — too short to
//     be a real, separately-reportable visit.
//   • Dropped unless BOTH ends of the gap independently resolve (via
//     matchStopLocationTs, single-point buffer each) to the SAME location —
//     a gap whose two ends disagree (or either is unresolved) is the classic
//     shape of a GPS signal-loss jump, not a stable dwell, and must not be
//     offered as a candidate stop.
// ---------------------------------------------------------------------------

export const MIN_GAP_MINUTES = 1;

function toMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const ms = new Date(`${v.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function deriveTravelDayStops(
  travels: readonly RawTravel[],
  vehicleId: number,
  plate: string,
  locations: readonly LocationForMatch[],
): WStop[] {
  const sorted = travels
    .filter((t) => t.ini?.timestampUTC && t.end?.timestampUTC)
    .slice()
    .sort((a, b) => a.ini!.timestampUTC!.localeCompare(b.ini!.timestampUTC!));

  const out: WStop[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const gapStartMs = toMs(cur.end?.timestampUTC);
    const gapEndMs = toMs(next.ini?.timestampUTC);
    if (gapStartMs == null || gapEndMs == null) continue;
    if ((gapEndMs - gapStartMs) / 60_000 < MIN_GAP_MINUTES) continue;

    const arrLat = cur.end?.lat;
    const arrLng = cur.end?.lng;
    const depLat = next.ini?.lat;
    const depLng = next.ini?.lng;
    if (arrLat == null || arrLng == null || depLat == null || depLng == null) continue;

    const arrivalLoc = matchStopLocationTs([{ lat: arrLat, lng: arrLng }], arrLat, arrLng, locations);
    const departureLoc = matchStopLocationTs([{ lat: depLat, lng: depLng }], depLat, depLng, locations);
    if (!arrivalLoc || !departureLoc || arrivalLoc.id !== departureLoc.id) continue;

    out.push({
      id: `trackit:${vehicleId}:${i}`,
      vehicleId,
      plate,
      code: arrivalLoc.code,
      arrivedAt: new Date(gapStartMs).toISOString(),
      departedAt: new Date(gapEndMs).toISOString(),
      assigned: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// excludeOverlappingRealStops — a TRACKiT-derived candidate whose interval
// overlaps ANY real stop of the same vehicle that day (assigned to a row or
// not) is almost certainly describing the SAME physical visit our own `stops`
// already knows about, just at a different/nearby location — most visibly in
// the Azambuja warehouse cluster where one long real dwell gets fragmented
// (supabase/migrations/0040/0041). Such a candidate is dropped before it's
// ever offered to a sheet row.
// ---------------------------------------------------------------------------

function intervalEndMs(s: Pick<DayStop, "arrivedAt" | "departedAt">): number {
  const start = new Date(s.arrivedAt).getTime();
  return s.departedAt ? new Date(s.departedAt).getTime() : start + OPEN_STOP_ASSUMED_MS;
}

function intervalsOverlap(
  a: Pick<DayStop, "arrivedAt" | "departedAt">,
  b: Pick<DayStop, "arrivedAt" | "departedAt">,
): boolean {
  const aStart = new Date(a.arrivedAt).getTime();
  const bStart = new Date(b.arrivedAt).getTime();
  return aStart < intervalEndMs(b) && bStart < intervalEndMs(a);
}

export function excludeOverlappingRealStops(
  candidates: readonly WStop[],
  realStopsForVehicle: readonly DayStop[],
): WStop[] {
  return candidates.filter(
    (c) => !realStopsForVehicle.some((real) => intervalsOverlap(c, real)),
  );
}

// ---------------------------------------------------------------------------
// tryTrackitFallback / applyTrackitOutcome — shared outcome logic for BOTH
// matchers' leftover step. `fitsWindow` is supplied by the caller because
// tfs-sheet and azambuja-sheet use genuinely different window representations
// (absolute epoch-ms day-aware bounds vs. minutes-since-midnight ± pad) —
// see azambuja-sheet/match.ts's stopInWindow vs. common.ts's inWindow/
// widenWindow.
//
// Unicidade nos dois sentidos: a candidate is claimed (`.assigned = true`)
// the moment exactly one available match is found — callers iterate their
// leftover rows in a stable, deterministic order (sheet order), so a
// candidate that would also fit a LATER row is already gone by the time that
// later row is checked, and gets the "claimed" outcome instead of being
// reused. Nothing outside this function ever mutates `.assigned`.
// ---------------------------------------------------------------------------

// The Map route.ts builds for pass 2 of runMatch(): a plate absent from the
// Map means "never eligible" (not-attempted); an array means "attempted,
// here are the candidates" (possibly empty -> no-match); a TrackitSkipReason
// means "was eligible, deliberately not queried" (cap/deadline/error/etc).
export type TrackitCandidateMap = ReadonlyMap<string, WStop[] | TrackitSkipReason>;

export type TrackitAttemptOutcome =
  | { kind: "resolved"; stop: WStop }
  | { kind: "claimed" }
  | { kind: "ambiguous" }
  | { kind: "no-match" }
  | { kind: "skipped"; reason: TrackitSkipReason["skipped"] }
  | { kind: "not-attempted" };

export function tryTrackitFallback(
  plate: string | null,
  code: string | null,
  fitsWindow: (stop: WStop) => boolean,
  trackitStopsByPlate: TrackitCandidateMap | undefined,
  coLocatedGroups: CoLocatedGroups,
): TrackitAttemptOutcome {
  if (!plate || !code || !trackitStopsByPlate || !trackitStopsByPlate.has(plate)) {
    return { kind: "not-attempted" };
  }
  const entry = trackitStopsByPlate.get(plate)!;
  if (!Array.isArray(entry)) return { kind: "skipped", reason: entry.skipped };

  const sameCodeAndWindow = entry.filter((s) => codeEq(s.code, code, coLocatedGroups) && fitsWindow(s));
  if (sameCodeAndWindow.length === 0) return { kind: "no-match" };

  const available = sameCodeAndWindow.filter((s) => !s.assigned);
  if (available.length === 0) return { kind: "claimed" };
  if (available.length > 1) return { kind: "ambiguous" };

  available[0].assigned = true;
  return { kind: "resolved", stop: available[0] };
}

function appendNote(base: string, extra: string): string {
  return base ? `${base} ${extra}` : extra;
}

export type TrackitOutcomeApplied = {
  conf: typeof TRACKIT_FALLBACK | typeof REVIEW;
  note: string;
  stop: WStop | null;
};

export function applyTrackitOutcome(
  outcome: TrackitAttemptOutcome,
  baseNote: string,
): TrackitOutcomeApplied {
  switch (outcome.kind) {
    case "resolved":
      return {
        conf: TRACKIT_FALLBACK,
        stop: outcome.stop,
        note:
          `TRACKiT (vehicleTravels): ${outcome.stop.code} ` +
          `${fmtHM(outcome.stop.arrivedAt)}–${fmtHM(outcome.stop.departedAt) || "?"} ` +
          `— sem paragem nossa correspondente; confirma antes de aceitar.`,
      };
    case "claimed":
      return {
        conf: REVIEW,
        stop: null,
        note: appendNote(
          baseNote,
          "TRACKiT deu uma correspondência plausível, mas já foi atribuída a outra linha desta folha.",
        ),
      };
    case "ambiguous":
      return {
        conf: REVIEW,
        stop: null,
        note: appendNote(
          baseNote,
          "TRACKiT deu mais de uma correspondência plausível — não escolhido automaticamente.",
        ),
      };
    case "no-match":
      return {
        conf: REVIEW,
        stop: null,
        note: appendNote(baseNote, "TRACKiT consultado, sem correspondência clara."),
      };
    case "skipped":
      return { conf: REVIEW, stop: null, note: appendNote(baseNote, trackitSkipNote(outcome.reason)) };
    case "not-attempted":
      return { conf: REVIEW, stop: null, note: baseNote };
  }
}

// ---------------------------------------------------------------------------
// Best-effort, module-level (warm-instance-only) cache for the raw
// /vehicleTravels response per (account, vehicleId, dateBegin, dateEnd) —
// same "state lives on the module while the Lambda instance is warm" pattern
// already used by the pacer (nextRequestAt) in src/lib/trackit/http.ts. Never
// a correctness requirement: a cold instance or an expired entry just means
// route.ts calls TRACKiT again. The actual fetch stays in route.ts (this
// module has no TRACKiT/Supabase imports by design) — these two functions
// only hold the Map.
// ---------------------------------------------------------------------------

export const TRAVELS_CACHE_TTL_MS = 5 * 60_000;

const travelsCache = new Map<string, { travels: RawTravel[]; fetchedAt: number }>();

export function travelsCacheKey(account: string, vehicleId: number, dateBegin: string, dateEnd: string): string {
  return `${account}:${vehicleId}:${dateBegin}:${dateEnd}`;
}

export function getCachedTravels(key: string): RawTravel[] | null {
  const hit = travelsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > TRAVELS_CACHE_TTL_MS) {
    travelsCache.delete(key);
    return null;
  }
  return hit.travels;
}

export function setCachedTravels(key: string, travels: RawTravel[]): void {
  travelsCache.set(key, { travels, fetchedAt: Date.now() });
}
