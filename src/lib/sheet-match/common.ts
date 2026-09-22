// Shared building blocks for the delivery-sheet matchers
// (/dashboard/tfs-sheet and /dashboard/azambuja-sheet).
//
// Pure — no framework, no DB, no xlsx. Each matcher owns its own column
// resolution and per-row bookkeeping; everything that isn't specific to a
// sheet's layout lives here: store-code equality, the clock/window helpers,
// the "HH:MM" formatters, and the vehicle-swap detector (step 3 in both
// matchers), which is the same rule for both fleets.

import { normalizePlate } from "@/lib/fleet/validate";

export const REVIEW = "⚠️ Rever manualmente";
// The input row already carried BOTH arrival and departure — it was resolved
// somewhere else. We keep it verbatim and never run matching on it. Distinct
// from "OK", which is a value WE computed.
export const KEPT = "✅ Já preenchido (mantido)";
export const SWAP = "🔄 Possível troca de viatura";
export const SWAP_OUT_OF_WINDOW = "🔄❗ Possível troca (fora da janela)";
// A distinct category from a swap: the sheet's plate has no GPS of ours at all
// and a single look-alike plate (one character off) actually drove the route.
// The story is "escreveram a matrícula mal", not "trocaram o camião".
export const PLATE_TYPO = "🔤 Possível erro de matrícula";
// A row our own `stops` couldn't resolve at all (no matching real stop),
// filled instead from TRACKiT's /vehicleTravels as a SECOND, weaker source —
// never chosen silently, always its own Confiança value distinct from "OK".
// See src/lib/sheet-match/trackit-candidates.ts for how the candidate is
// derived and src/app/api/{azambuja,tfs}-sheet/route.ts for where it's called.
export const TRACKIT_FALLBACK = "🛰️ TRACKiT (sem paragem nossa) — confirmar";
export const CONFIANCA_COL = "Confiança";
export const REAL_COL = "Real";
// Hidden technical column carrying the PLANNED plate (before any swap/typo
// substitution overwrites the visible Matrícula cell) — written by each
// matcher below, since by the time a row reaches xlsx-out.ts the original
// value may already be gone. xlsx-out.ts positions/hides/widens it the same
// dynamic way as ZZ/YY/XX/WW (its own TECH_COLS), but — unlike those, which
// are synthesized entirely inside xlsx-out.ts from data still present on the
// row — VV's value has to come from here, because match.ts is the only place
// the planned plate still exists pre-substitution. That's also why this one
// constant lives in common.ts rather than next to ZZ/YY/XX/WW in
// xlsx-out.ts: xlsx-out.ts may depend on match.ts's output shape, but
// match.ts must stay "pure, no xlsx" and can't import from xlsx-out.ts.
export const VV_COL = "VV";

// How far outside the planned delivery window a real stop may still be counted
// as "the same visit" when looking for a vehicle swap.
export const SWAP_WINDOW_PAD_MIN = 180;

export type SheetRecord = Record<string, string | number>;

export type DayStop = {
  id: string;
  vehicleId: number;
  /** normalised (upper, no hyphens/spaces); null when no ping told us a plate */
  plate: string | null;
  /** locations.code, raw */
  code: string | null;
  arrivedAt: string; // ISO
  departedAt: string | null; // ISO
};

/** A DayStop plus the matcher's "already handed to a row" flag. */
export type WStop = DayStop & { assigned: boolean };

// Why a plate ELIGIBLE for the TRACKiT fallback (see trackit-candidates.ts)
// was never actually queried — surfaced verbatim in the row's "Real" note
// (trackitSkipNote below) so a reviewer can tell "we tried and found nothing"
// apart from "we didn't even try, and here's why".
export type TrackitSkipReason = {
  skipped: "cap" | "deadline" | "call-failed" | "no-vehicle-id";
};

export function trackitSkipNote(reason: TrackitSkipReason["skipped"]): string {
  switch (reason) {
    case "cap":
      return "TRACKiT não consultado — limite de matrículas por upload atingido.";
    case "deadline":
      return "TRACKiT não consultado — tempo esgotado antes de chegar a esta matrícula.";
    case "call-failed":
      return "TRACKiT não consultado — falha ou tempo excedido a obter os dados.";
    case "no-vehicle-id":
      return "TRACKiT não consultado — não foi possível identificar o veículo TRACKiT desta matrícula.";
  }
}

// How long an OPEN (no departedAt) stop is assumed to last for any interval-
// overlap check — dedupeStops below, and trackit-candidates.ts's
// excludeOverlappingRealStops (a TRACKiT-derived candidate overlapping a real
// stop, open or closed, is excluded — see that module for why). Shared here
// so both never drift apart on what "open" means for overlap purposes.
export const OPEN_STOP_ASSUMED_MS = 2 * 3_600_000;

// The sheet routes read `stops` across ALL trackit_accounts (one shared
// fleet). A vehicle tracked by more than one account has each physical visit
// detected once per account — slightly different arrived/departed each time —
// which would make the positional pairing count twice as many stops as
// stores. Merge, per vehicle, any stops whose time intervals overlap into one.
export function dedupeStops(stops: DayStop[]): DayStop[] {
  const byVehicle = new Map<number, DayStop[]>();
  for (const s of stops) {
    const arr = byVehicle.get(s.vehicleId);
    if (arr) arr.push(s);
    else byVehicle.set(s.vehicleId, [s]);
  }
  const endMs = (s: DayStop) => {
    const start = new Date(s.arrivedAt).getTime();
    return s.departedAt ? new Date(s.departedAt).getTime() : start + OPEN_STOP_ASSUMED_MS;
  };
  const out: DayStop[] = [];
  for (const arr of byVehicle.values()) {
    arr.sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
    let cur: DayStop | null = null;
    let curEnd = 0;
    for (const s of arr) {
      const start = new Date(s.arrivedAt).getTime();
      const end = endMs(s);
      if (cur && start <= curEnd) {
        if (end > curEnd) {
          cur.departedAt = s.departedAt ?? cur.departedAt;
          curEnd = end;
        }
        if (!cur.code && s.code) cur.code = s.code;
      } else {
        cur = { ...s };
        out.push(cur);
        curEnd = end;
      }
    }
  }
  return out;
}

// How close two fragments of a vehicle's stops at the SAME location may sit,
// end-to-start, before they're treated as one continuous visit rather than
// two separate ones. Tuned against the 2026-09 azambuja-2026-09-15-conferido
// audit: 71 sheet rows landed "OK" with an exact 0.0min duration (Chegada ==
// Saída), 57 of them (80%) at code 7001 alone — detect_stops cutting/
// reopening a stop on a >50m GPS reposition inside the same yard, and the
// matcher then pairing the row to whichever fragment happened to sort first
// (often the shortest). 15min is wide enough to re-stitch that kind of
// reposition-triggered split, narrow enough not to fuse two genuinely
// distinct visits to the same warehouse hours apart.
export const FRAGMENT_MERGE_GAP_MIN = 15;

// Collapse sequential same-vehicle, same-location DayStop fragments that sit
// within `padMin` of each other (previous departedAt -> next arrivedAt) into
// one "effective" stop: arrivedAt = earliest fragment's, departedAt = latest
// fragment's. Must run AFTER dedupeStops (which merges cross-TRACKiT-account
// duplicates of the SAME ping stream, keyed only on time overlap) and BEFORE
// any candidate selection, so every downstream step — positional pairing,
// swap detection, plate-typo corroboration, the "Real" caption — sees one
// real visit instead of N artificial fragments.
//
// Keyed on EXACT code equality (normalizeStoreCode), not the fuzzy
// codeEq/co-location matching used for sheet<->stop matching: stitching
// fragments of what was always the same stop is a much safer call than
// merging two co-located-but-distinct sites, which is a different feature.
// Grouped by vehicleId (the physical GPS-tracked truck), not plate — plate
// can be null or per-account-attributed oddly, vehicleId never is. A stop
// with no code at all is left untouched: with nothing to key it to, there's
// no location a neighbouring fragment could safely be said to belong to.
//
// A single isolated stop with nothing nearby (e.g. a genuine one-off 0min
// pass-through at a warehouse) is returned unchanged — this never invents a
// duration, it only re-joins fragments that already exist close together.
//
// NEVER bridges a Lisbon calendar-day boundary, in either direction: a
// fragment that already straddles midnight on its own is left completely
// alone (it can't absorb a neighbour, and nothing can merge into it), and a
// same-day fragment is never fused into a run that would push it across
// midnight. That's not fragmentation — it's the exact shape the day/CICLO
// window logic in each matcher (stopInWindow, groupWindowMs) exists to
// scrutinise separately (same-day route vs. an explicit "+1" continuation).
// Regression: azambuja CICLO "02:00 | 14:00" at 7005 with a genuine 23:59
// in-day 0min stop sitting inside the window of a SEPARATE 23:24->00:12
// (next day) artifact at the same code/vehicle — merging them would have
// laundered the rejected next-day stop into a seemingly-clean OK row.
export function mergeFragmentedStops(
  stops: DayStop[],
  padMin: number = FRAGMENT_MERGE_GAP_MIN,
): DayStop[] {
  const byKey = new Map<string, DayStop[]>();
  const out: DayStop[] = [];
  for (const s of stops) {
    if (!s.code) {
      out.push(s);
      continue;
    }
    const key = `${s.vehicleId}::${normalizeStoreCode(s.code).toUpperCase()}`;
    const arr = byKey.get(key);
    if (arr) arr.push(s);
    else byKey.set(key, [s]);
  }
  const padMs = padMin * 60_000;
  for (const group of byKey.values()) {
    group.sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
    let cur: DayStop | null = null;
    // Conservative on an open (still-ongoing) fragment: without a real
    // departedAt we don't know when it truly ends, so its end is estimated as
    // its own arrivedAt (the minimum, never invented) — that can only make
    // the gap to the next fragment look LARGER, never trigger a merge that
    // isn't backed by an actual observed gap.
    let curEndMs = -Infinity;
    for (const s of group) {
      const startMs = new Date(s.arrivedAt).getTime();
      const sEnd = s.departedAt ?? s.arrivedAt;
      const endMs = new Date(sEnd).getTime();
      const sSpansDays = lisbonDayOf(s.arrivedAt) !== lisbonDayOf(sEnd);
      if (sSpansDays) {
        // Isolate it completely: emit as-is, and break the chain so a
        // following same-day fragment doesn't merge into it either.
        out.push(s);
        cur = null;
        curEndMs = -Infinity;
        continue;
      }
      const canExtend =
        cur != null &&
        startMs - curEndMs <= padMs &&
        lisbonDayOf(cur.arrivedAt) === lisbonDayOf(sEnd);
      if (cur && canExtend) {
        if (endMs > curEndMs) {
          cur.departedAt = s.departedAt ?? cur.departedAt;
          curEndMs = endMs;
        }
      } else {
        cur = { ...s };
        out.push(cur);
        curEndMs = endMs;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const pad2 = (n: number | string) => String(n).padStart(2, "0");

export function deburr(s: string): string {
  // Strip combining diacritical marks (U+0300–U+036F) so "Camião" ~ "camiao".
  let out = "";
  for (const ch of s.normalize("NFD")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue;
    out += ch;
  }
  return out;
}

export function normHeader(s: string): string {
  return deburr(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Store code equality. Store codes here are "{optional letter prefix}{digits}"
// ("E25", "B97", "133") or a merged/composite code ("B97-E72", "H96-B37").
// Normalise a store code: handles string, number (e.g. 94), strips Excel float
// suffixes (".0"), trims whitespace.
export function normalizeStoreCode(v: unknown): string {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/\.0+$/, "");
  return s;
}

// Co-located / same-site equivalence groups.
// Physical sites that house multiple logical, INDEPENDENT, active locations
// (e.g. a store + its attached cross-dock platform, close enough that GPS
// proximity stop-detection can't reliably tell them apart). Any code in a
// group is considered an exact same-site match for any other code in the
// group. Unlike a merge (locations.merged_into_id), no location here is
// deactivated or absorbed — both keep their own identity; only matching
// treats them as interchangeable.
//
// Sourced from locations.colocated_with_id (see migration 0034) — configurable
// from /dashboard/locations, not a code deploy. Built once per request by the
// API route (see coLocatedGroupsFromLocations in each route.ts) and threaded
// through runMatch. Empty groups list = no co-location active (e.g. in a test
// that doesn't care).
export type CoLocatedGroups = ReadonlyArray<ReadonlySet<string>>;

// Builds CoLocatedGroups from the `locations` table's own
// (id, code, colocated_with_id) rows — one hop only, star topology (see
// migration 0034): a location's group is itself + whatever hub it points to
// (colocated_with_id) + every other location pointing at that same hub. A row
// with no colocated_with_id and nothing pointing at it forms no group at all
// (dropped — codeEq/codeKey treat "no group" the same as "group of one").
// Shared by both /api/tfs-sheet and /api/azambuja-sheet so the two routes
// can't drift on how they read the same column.
export function coLocatedGroupsFromLocations(
  rows: readonly { id: string; code: string; colocated_with_id: string | null }[],
): CoLocatedGroups {
  const byId = new Map(rows.map((l) => [l.id, l]));
  const membersByHub = new Map<string, Set<string>>();
  for (const l of rows) {
    const hubId = l.colocated_with_id ?? l.id;
    const hub = byId.get(hubId);
    if (!hub) continue; // dangling FK — ignore defensively
    let set = membersByHub.get(hubId);
    if (!set) membersByHub.set(hubId, (set = new Set([hub.code])));
    set.add(l.code);
  }
  return [...membersByHub.values()].filter((s) => s.size > 1);
}

// Check whether code a and code b are equal under standard base rules:
// - case-insensitive
// - same letter prefix + same digits ignoring leading zeros ("A5" == "A05", "01" == "1")
// - base segment of composite code ("B97" == "B97-E72")
export function codeBaseEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const x = normalizeStoreCode(a).toUpperCase();
  const y = normalizeStoreCode(b).toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;

  const seg = (v: string) => v.match(/^([A-Z]*)0*(\d+)$/);
  const mx = seg(x);
  const my = seg(y);
  if (mx && my && mx[1] === my[1] && mx[2] === my[2]) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(`${short}-`) || long.startsWith(`${short}/`)) return true;

  return false;
}

export function findSameSiteGroup(
  code: string | null | undefined,
  groups: CoLocatedGroups,
): ReadonlySet<string> | null {
  if (!code) return null;
  const s = normalizeStoreCode(code).toUpperCase();
  for (const group of groups) {
    for (const member of group) {
      if (codeBaseEq(member, s)) return group;
    }
  }
  return null;
}

export function areSameSite(
  a: string | null | undefined,
  b: string | null | undefined,
  groups: CoLocatedGroups,
): boolean {
  if (!a || !b) return false;
  const groupA = findSameSiteGroup(a, groups);
  if (!groupA) return false;
  const sB = normalizeStoreCode(b).toUpperCase();
  for (const member of groupA) {
    if (codeBaseEq(member, sB)) return true;
  }
  return false;
}

export function canonicalSiteCode(
  code: string | null | undefined,
  groups: CoLocatedGroups,
): string {
  if (!code) return "";
  const norm = normalizeStoreCode(code);
  const group = findSameSiteGroup(norm, groups);
  if (group) {
    // Return the primary/first representative of the group (its hub — see
    // coLocatedGroupsFromLocations, which always inserts the hub's own code
    // first into the Set).
    return [...group][0];
  }
  return norm;
}

// Store code equality with same-site / co-location support. `groups` comes
// from the DB (locations.colocated_with_id) via coLocatedGroupsFromLocations
// — pass [] where co-location doesn't apply (e.g. a test that doesn't care).
export function codeEq(
  a: string | null | undefined,
  b: string | null | undefined,
  groups: CoLocatedGroups,
): boolean {
  if (a == null || b == null) return false;
  const x = normalizeStoreCode(a).toUpperCase();
  const y = normalizeStoreCode(b).toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;

  // 1. Same-site co-location group match (e.g. store <=> its platform)
  if (areSameSite(x, y, groups)) return true;

  // 2. Base code equality (same prefix + digits, or composite code segment)
  return codeBaseEq(x, y);
}

export function codeKey(code: string, groups: CoLocatedGroups): string {
  const norm = normalizeStoreCode(code);
  const canonical = canonicalSiteCode(norm, groups);
  const k = canonical.trim().replace(/^0+(?=.)/, "").toLowerCase();
  return k || "(sem código)";
}

// One inactive, merged location's code -> its canonical (merged_into_id)
// location's code. Built by the caller from `locations` (active, merged_into_id).
export type MergedCodeEntry = { code: string; canonicalCode: string };

// Sheets sometimes still carry a store code we've since merged into a
// canonical location (0019, 0030, 0031) — the planning system that generates them
// lags behind our locations table. Resolve it to the canonical code before any
// codeEq comparison against stops, so a visit now attributed to the canonical
// location still matches the sheet's row for the old code. Only kicks in when
// the raw code doesn't already match a currently active location — this never
// overrides a genuine live code, even a coincidental one.
export function resolveMergedCode(
  raw: unknown,
  activeCodes: readonly string[],
  merged: readonly MergedCodeEntry[],
  groups: CoLocatedGroups,
): string {
  const norm = normalizeStoreCode(raw);
  if (!norm) return norm;

  // If the raw code directly matches a currently active location (exact or base code,
  // without co-location grouping), keep it verbatim.
  if (activeCodes.some((c) => codeBaseEq(c, norm))) return norm;

  // Check merged/alias list (handles string/int and codeBaseEq)
  const hit = merged.find((m) => codeBaseEq(m.code, norm) || codeEq(m.code, norm, groups));
  return hit ? hit.canonicalCode : norm;
}

const HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// ISO timestamp -> "HH:MM" in Portugal wall-clock. "" for null/invalid.
export function fmtHM(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return HM.format(d);
}

// en-CA formats as YYYY-MM-DD directly — used only to compare Lisbon
// CALENDAR days (mergeFragmentedStops' midnight-boundary guard), never to
// build a display string.
const LISBON_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// ISO timestamp -> its Lisbon wall-clock calendar day ("YYYY-MM-DD").
function lisbonDayOf(iso: string): string {
  return LISBON_YMD.format(new Date(iso));
}

const DMY_HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// ISO timestamp -> "DD-MM-YYYY HH:MM" in Portugal wall-clock. "" for
// null/invalid. Used for sheets whose delivery cycles cross midnight (Azambuja),
// where a bare "HH:MM" is ambiguous about which calendar day it belongs to.
export function fmtDateTimeLisbon(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p: Record<string, string> = {};
  for (const part of DMY_HM.formatToParts(d)) p[part.type] = part.value;
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

// A clock value -> minutes since midnight. Handles "HH:MM", an Excel day
// fraction (0.5417 -> 13:00, as number or string), and a bare hour ("13").
// null when it can't be read.
export function parseClockMin(v: unknown): number | null {
  if (v == null || v === "") return null;
  const asFraction = (n: number): number | null => {
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 1) return Math.round(n * 1440);
    if (n > 1 && n < 24) return Math.round(n * 60);
    return null;
  };
  if (typeof v === "number") return asFraction(v);
  const s = String(v).trim();
  const hm = s.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const min = Number(hm[1]) * 60 + Number(hm[2]);
    return min >= 0 && min < 1440 ? min : null;
  }
  return asFraction(Number(s.replace(",", ".")));
}

// Minutes between two "DD/MM/YYYY HH:MM" or "DD-MM-YYYY HH:MM" strings
// (b - a), or null if either doesn't match that shape. Both separators are
// accepted so a re-uploaded "conferido" file (written with "-") and an
// older export or transporter pre-fill (written with "/") both round-trip.
function minutesBetweenDMYHM(a: string, b: string): number | null {
  const parse = (s: string) => {
    const m = s
      .trim()
      .match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const [, d, mo, y, h, mi] = m;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  };
  const ta = parse(a);
  const tb = parse(b);
  if (ta == null || tb == null) return null;
  return (tb - ta) / 60_000;
}

// Render a Chegada/Saída cell as "DD-MM-YYYY HH:MM" (wall-clock — NO timezone
// shift). Prefers the Excel serial from the workbook's raw pass (unambiguous);
// falls back to parsing our own "DD-MM-YYYY HH:MM" (or the older "/"
// separator), a "DD/MM/YY[YY] [HH:MM]" string (also accepting "." as the date
// separator and a trailing "AM"/"PM"), or "HH:MM" alone (attached to
// `serviceDay`). Unparseable input is returned unchanged.
//
// Shared by both matchers: originally Azambuja-only (kept rows are re-rendered
// in this format there), but also the "source of truth" duration parser for
// the KEPT-row plausibility check in both matchers (see
// minutesBetweenKeptCells below) — deliberately reused rather than a
// narrower parser of its own, so a shape THIS function already reads cleanly
// (2-digit year, "." separator, 12h clock, an Excel datetime serial) can never
// again defeat the plausibility check the way it did for BG-75-IP, 2026-09-21
// (see classifyKeptDuration).
export function normalizeDateTimeCell(
  display: string,
  raw: unknown,
  serviceDay: string, // YYYY-MM-DD
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (y: number, mo: number, d: number, h: number, mi: number) =>
    `${pad(d)}-${pad(mo)}-${y} ${pad(h)}:${pad(mi)}`;

  const serial =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))
        ? Number(raw)
        : null;
  if (serial != null && serial > 1 && serial < 200_000) {
    const dt = new Date(
      Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000),
    );
    return fmt(
      dt.getUTCFullYear(),
      dt.getUTCMonth() + 1,
      dt.getUTCDate(),
      dt.getUTCHours(),
      dt.getUTCMinutes(),
    );
  }

  const s = display.trim();
  if (!s) return "";

  const dmy = s.match(
    /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2}))?\s*(AM|PM)?/i,
  );
  if (dmy) {
    const [, dd, mm, yy, hh, mi, ap] = dmy;
    let year = Number(yy);
    if (year < 100) year += 2000;
    let hour = hh ? Number(hh) : 0;
    if (ap) {
      const up = ap.toUpperCase();
      if (up === "PM" && hour < 12) hour += 12;
      if (up === "AM" && hour === 12) hour = 0;
    }
    return fmt(year, Number(mm), Number(dd), hour, mi ? Number(mi) : 0);
  }

  const hm = s.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const [y, mo, d] = serviceDay.split("-").map(Number);
    return fmt(y, mo, d, Number(hm[1]), Number(hm[2]));
  }

  return display;
}

// Minutes between two already-filled Chegada/Saída cells, for the KEPT-row
// plausibility check (see classifyKeptDuration below). Routes BOTH cells
// through normalizeDateTimeCell first — the same, more permissive parser the
// write-back path already trusts to reshape these exact cells — then diffs
// the two normalised "DD-MM-YYYY HH:MM" strings with minutesBetweenDMYHM.
//
// This replaces an earlier, narrower parser (minutesBetweenTimeCells, fixed
// "DD/MM/YYYY HH:MM" or bare "HH:MM" only) that returned null — "can't tell"
// — for a shape normalizeDateTimeCell already reads correctly (2-digit year,
// "." separator, 12h clock, an Excel serial). That null was then treated as
// "plausible, trust it" by the caller, which is what actually let 6 real
// deliveries through as a false "mantido" for BG-75-IP, 2026-09-21: the
// duration WAS calculable, just not by that narrower parser. Fixed here at
// the source (a single, shared, better parser) rather than by loosening the
// caller's fail-open branch alone — see classifyKeptDuration for that half of
// the fix.
//
// null when either cell doesn't normalise to a full date+time (an entirely
// unparseable cell, or a bare "HH:MM" with no `serviceDay` to anchor it to —
// normalizeDateTimeCell needs a non-empty serviceDay for that fallback).
export function minutesBetweenKeptCells(
  chegadaDisplay: string,
  saidaDisplay: string,
  chegadaRaw: unknown,
  saidaRaw: unknown,
  serviceDay: string,
): number | null {
  const a = normalizeDateTimeCell(chegadaDisplay, chegadaRaw, serviceDay);
  const b = normalizeDateTimeCell(saidaDisplay, saidaRaw, serviceDay);
  return minutesBetweenDMYHM(a, b);
}

// Minimum plausible minutes for a KEPT (Chegada/Saída pre-filled) row at a
// STORE ("loja") — the same 5-minute threshold as the 🟣 short-stop VISUAL
// rule in xlsx-out.ts, reused here for consistency rather than invented fresh.
// Deliberately NOT applied to 'armazem' / 'centro_distribuicao' (migration
// 0035: a real, near-stationary warehouse touch legitimately closes in 0min —
// close_and_persist_stop's own zero-duration floor for those types), nor to
// any other/unknown location type (no fleet-wide evidence there yet — default
// to the loose >0 rule rather than invent an unverified one), nor to our own
// GPS-matched "OK" rows (already validated by the real stop-detection, not
// this heuristic).
export const LOJA_MIN_PLAUSIBLE_DURATION_MIN = 5;

export type ImplausibleKeptReason =
  | "unparseable" // duration not calculable at all (see minutesBetweenKeptCells)
  | "non_positive" // Saída <= Chegada — the original BG-75-IP shape
  | "too_short_for_store"; // 0 < duration < 5min at a 'loja'

// Classifies a KEPT-candidate row's duration as implausible (an upstream
// placeholder, not a confirmed visit) or plausible (trust it). null durMin —
// "can't tell" — is now itself implausible: FAIL-CLOSED, not fail-open. The
// original bug (fa26052) was fail-open here: `durMin != null && durMin <= 0`
// let a null (unparseable) duration slip through as "plausible" by default,
// which is exactly how BG-75-IP's 21-09-2026 burst (452/446/447/454/453/455)
// got kept verbatim as fake deliveries.
export function classifyKeptDuration(
  durMin: number | null,
  locationType: string | null | undefined,
): ImplausibleKeptReason | null {
  if (durMin == null) return "unparseable";
  if (durMin <= 0) return "non_positive";
  if (locationType === "loja" && durMin < LOJA_MIN_PLAUSIBLE_DURATION_MIN) {
    return "too_short_for_store";
  }
  return null;
}

// Caption for a row whose input Chegada/Saída were rejected as an implausible
// pre-fill rather than trusted as KEPT — see classifyKeptDuration for the 3
// reasons this fires.
export function implausibleKeptNote(
  rawChegada: string,
  rawSaida: string,
  reason: ImplausibleKeptReason,
  durMin: number | null,
): string {
  const why =
    reason === "unparseable"
      ? "não foi possível calcular a duração (formato de data/hora não reconhecido)"
      : reason === "too_short_for_store"
        ? `duração demasiado curta para uma loja (${durMin}min, mínimo ${LOJA_MIN_PLAUSIBLE_DURATION_MIN}min)`
        : "sem duração real";
  return (
    `Ficheiro trazia Chegada e Saída já preenchidas mas ${why} ` +
    `(${rawChegada} → ${rawSaida}) — provável placeholder do sistema de ` +
    `planeamento, não uma entrega confirmada. Tratada como não confirmada ` +
    `e sujeita ao emparelhamento normal.`
  );
}

export type TimeWindow = { lo: number; hi: number };

// Planned window widened by `padMin` on each side. null when neither end reads
// (caller then treats it as "no constraint").
export function widenWindow(
  iniV: unknown,
  fimV: unknown,
  padMin: number,
): TimeWindow | null {
  const lo = parseClockMin(iniV);
  const hi = parseClockMin(fimV);
  if (lo == null && hi == null) return null;
  return { lo: (lo ?? hi!) - padMin, hi: (hi ?? lo!) + padMin };
}

export const inWindow = (min: number, w: TimeWindow | null) =>
  w == null || (min >= w.lo && min <= w.hi);

export const windowsOverlap = (a: TimeWindow | null, b: TimeWindow | null) =>
  a == null || b == null || (a.lo <= b.hi && b.lo <= a.hi);

// Minutes-since-midnight -> "HH:MM", wrapping into 0..1439 first (a widened
// window's lo/hi can spill past midnight in either direction).
export function minToHM(min: number): string {
  const wrapped = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

// How far `min` (arrival, minutes since midnight) sits outside `w` (already
// widened by the swap pad) — 0 when inside. Used to caption an out-of-window
// swap suggestion with "~12h25" style text.
export function minutesOutside(min: number, w: TimeWindow): number {
  if (min < w.lo) return w.lo - min;
  if (min > w.hi) return min - w.hi;
  return 0;
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0 && m > 0) return `${h}h${pad2(m)}`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

// A stop's Portugal wall-clock arrival as minutes since midnight (-1 if unknown).
export function arrivalMin(s: Pick<WStop, "arrivedAt">): number {
  const hm = fmtHM(s.arrivedAt).match(/^(\d{2}):(\d{2})$/);
  return hm ? Number(hm[1]) * 60 + Number(hm[2]) : -1;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Lisbon wall-clock offset (minutes east of UTC) at a given instant. Same
// technique as app/dashboard/_server.ts, duplicated here to keep this module
// framework-free.
function lisbonOffsetMin(at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(at);
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const asUTC = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((asUTC - at.getTime()) / 60000);
}

// Epoch ms for "YYYY-MM-DD" + minutes-since-midnight, read as Lisbon wall-clock.
// `minOfDay` may be negative or ≥ 1440 to reach into the previous / next day.
export function lisbonEpoch(day: string, minOfDay: number): number {
  const [y, mo, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0) + minOfDay * 60000;
  return guess - lisbonOffsetMin(new Date(guess)) * 60000;
}

// The message stamped on a row whose planned vehicle we can't corroborate.
export function noGpsCoverageNote(plate: string, everSeen: boolean): string {
  return everSeen
    ? `Sem cobertura GPS para ${plate} no período desta entrega ` +
        `(temos posições dessa viatura noutras alturas, não aqui) — ` +
        `não dá para confirmar se a fez; sem sugestão de troca.`
    : `Sem cobertura GPS para ${plate} (nenhum dado GPS registado) — ` +
        `sem sugestão de troca.`;
}

// Does the planned vehicle's ping span overlap its planned delivery window
// (widened by `padMin`) on the service day? `span` is [min,max] epoch-ms of
// that plate's pings in the loaded data. Returns true when we can't tell (no
// planned window) so a missing CICLO/Janela never over-flags; false when the
// plate has no pings at all.
export function plannedPlateHasCoverage(
  span: { min: number; max: number } | null,
  day: string,
  planIni: string | number,
  planFim: string | number,
  padMin: number,
): boolean {
  if (!span) return false;
  const loMin = parseClockMin(planIni);
  const hiMin = parseClockMin(planFim);
  if (loMin == null && hiMin == null) return true;
  const padMs = padMin * 60000;
  const lo = lisbonEpoch(day, loMin ?? hiMin!) - padMs;
  const hi = lisbonEpoch(day, hiMin ?? loMin!) + padMs;
  return span.max >= lo && span.min <= hi;
}

// A date-ish cell -> YYYY-MM-DD. Handles ISO, DD/MM/YYYY, DD-MM-YY, JS Date,
// and Excel serial numbers.
export function parseServiceDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : isoDate(v);
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 20000 && v < 80000) {
      return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000));
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2})$/);
  if (m) return `20${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : isoDate(d);
}

// ---------------------------------------------------------------------------
// Column resolution (shared picker)
// ---------------------------------------------------------------------------

// Match `targets` (already normHeader-normalised) against the still-unused
// headers, in three widening passes: exact, word-boundary prefix, substring.
export function pick(
  header: string[],
  used: Set<string>,
  targets: string[],
): string | null {
  const cands = header
    .filter((h) => !used.has(h))
    .map((h) => [h, normHeader(h)] as const);
  for (const t of targets) {
    const hit = cands.find(([, n]) => n === t);
    if (hit) return hit[0];
  }
  for (const t of targets) {
    const hit = cands.find(
      ([, n]) => n.startsWith(`${t} `) || t.startsWith(`${n} `),
    );
    if (hit) return hit[0];
  }
  for (const t of targets) {
    const hit = cands.find(([, n]) => n.includes(t));
    if (hit) return hit[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vehicle-swap detection
// ---------------------------------------------------------------------------
//
// Shared step 3 for both matchers: a sheet row whose resolved plate matched no
// stop, but a *leftover* stop at the right store and a plausible time belongs
// to a DIFFERENT vehicle — and no rival sheet row on a GPS-tracked vehicle was
// planned for that same store/window. Tuned on the TFS 07/09 and 08/09 cases
// (see the comments inside).

export type SwapRival = {
  code: string;
  planIni: string | number;
  planFim: string | number;
  /** the rival row's resolved plate (normalised), or null */
  plate: string | null;
  /** human label for the "planning ghost" note (nº camião, rota, …) */
  label: string;
  /** the stop this rival is already matched to, if any */
  assignedStop: WStop | null;
};

export type SwapResult = {
  kind: "swap";
  outOfWindow: boolean;
  suggPlate: string;
  suggStop: WStop;
  /** planned window widened by the swap pad; null when the row had no window */
  win: TimeWindow | null;
  /** planned window as "HH:MM–HH:MM" for captions, or null */
  plannedLabel: string | null;
  /** minutes the suggested stop sits outside `win` (0 unless outOfWindow) */
  outsideBy: number;
  /** a rival planned here whose vehicle has no GPS of ours — a planning ghost */
  ghost: { label: string; plate: string } | null;
};

// The planned vehicle has no GPS of ours covering this delivery, so we can't
// tell whether it made the stop itself — no swap is suggested, the row goes to
// manual review with `note`.
export type SwapNoCoverage = {
  kind: "no-gps-coverage";
  note: string;
};

/**
 * Returns a swap suggestion for `plate` at store `code`; a "no-gps-coverage"
 * marker when the planned vehicle can't be corroborated; or null when there
 * isn't a single unambiguous leftover stop to point at. Does NOT mutate — the
 * caller marks `result.suggStop.assigned` once it commits a swap.
 */
export function findVehicleSwap(params: {
  /** the row's resolved plate, which matched no stop of its own */
  plate: string;
  code: string;
  planIni: string | number;
  planFim: string | number;
  /** all of the day's stops (the `assigned` flag is read, not written) */
  stops: WStop[];
  /** every other sheet row, for the "real rival" check */
  rivals: SwapRival[];
  /** plates our GPS feed has ever seen (all fleets, any day) */
  platesWithGps: Set<string>;
  /**
   * [min, max] epoch-ms of the PLANNED plate's own pings in the loaded window,
   * or null if it has none. A swap is only suggested when this span (padded by
   * `padMin`) covers the candidate stop's time — otherwise we had no eyes on
   * the planned vehicle then and whoever else was nearby is a coincidence.
   */
  plannedPlateGpsSpan: { min: number; max: number } | null;
  padMin?: number;
  /** same-site co-location groups (locations.colocated_with_id); [] if none */
  coLocatedGroups: CoLocatedGroups;
}): SwapResult | SwapNoCoverage | null {
  const {
    plate,
    code,
    planIni,
    planFim,
    stops,
    rivals,
    platesWithGps,
    plannedPlateGpsSpan,
    coLocatedGroups,
  } = params;
  const padMin = params.padMin ?? SWAP_WINDOW_PAD_MIN;
  const win = widenWindow(planIni, planFim, padMin);

  // leftover stops at this store, by another vehicle, at a plausible time
  const windowed = stops.filter(
    (s) =>
      !s.assigned &&
      s.plate != null &&
      s.plate !== plate &&
      codeEq(s.code, code, coLocatedGroups) &&
      inWindow(arrivalMin(s), win),
  );

  // Nothing inside the padded window — before giving up, check whether exactly
  // one unassigned stop exists at this store/day regardless of time. A real
  // swap can land hours off the planned slot; pursue it only when there is
  // still a single, unambiguous leftover, and flag it more loudly.
  let candidates = windowed;
  let outOfWindow = false;
  if (candidates.length === 0) {
    const anyTime = stops.filter(
      (s) =>
        !s.assigned &&
        s.plate != null &&
        s.plate !== plate &&
        codeEq(s.code, code, coLocatedGroups),
    );
    if (anyTime.length === 0) return null;
    candidates = anyTime;
    outOfWindow = true;
  }

  const suggPlates = [...new Set(candidates.map((s) => s.plate as string))];
  if (suggPlates.length !== 1) return null; // >1 verifiable candidate -> review
  const suggPlate = suggPlates[0];
  const suggStops = candidates.filter((s) => s.plate === suggPlate);
  if (suggStops.length !== 1) return null; // same vehicle, 2 visits -> ambiguous
  const suggStop = suggStops[0];

  // Would we even have seen the planned vehicle at this store? If our GPS for
  // it doesn't reach the candidate stop's time (padded), we can't say it
  // wasn't there — pointing at whoever else happened to stop nearby would be a
  // coincidence, not evidence. Bail to manual review with a "no coverage" note.
  const stopT = new Date(suggStop.arrivedAt).getTime();
  const padMs = padMin * 60_000;
  const covered =
    plannedPlateGpsSpan != null &&
    Number.isFinite(stopT) &&
    stopT >= plannedPlateGpsSpan.min - padMs &&
    stopT <= plannedPlateGpsSpan.max + padMs;
  if (!covered) {
    return {
      kind: "no-gps-coverage",
      note: noGpsCoverageNote(plate, platesWithGps.has(plate)),
    };
  }

  // rival sheet rows planned for the same store in an overlapping window
  const rivalMatches = rivals.filter(
    (c) =>
      !!c.code &&
      codeEq(c.code, code, coLocatedGroups) &&
      windowsOverlap(win, widenWindow(c.planIni, c.planFim, padMin)),
  );
  // real competition = a rival whose resolved plate is a GPS-tracked vehicle
  // (other than the one we're suggesting) that could plausibly ALSO be the one
  // behind suggStop. A rival on a GPS-less vehicle is a planning ghost —
  // ignore it. And a rival already matched to its own real stop isn't
  // competing for suggStop at all.
  const realRivals = rivalMatches.filter(
    (c) =>
      c.plate &&
      c.plate !== suggPlate &&
      platesWithGps.has(c.plate) &&
      (!c.assignedStop || c.assignedStop === suggStop),
  );
  if (realRivals.length > 0) return null; // can't attribute the visit -> review

  const ghostRow = rivalMatches.find(
    (c) => c.plate && !platesWithGps.has(c.plate),
  );

  const planIniMin = parseClockMin(planIni);
  const planFimMin = parseClockMin(planFim);
  const plannedLabel =
    planIniMin != null || planFimMin != null
      ? `${planIniMin != null ? minToHM(planIniMin) : "?"}–${planFimMin != null ? minToHM(planFimMin) : "?"}`
      : null;

  return {
    kind: "swap",
    outOfWindow,
    suggPlate,
    suggStop,
    win,
    plannedLabel,
    // win is non-null whenever outOfWindow is true: a null window never fails
    // the padded check above, so it never falls through to the unrestricted
    // search.
    outsideBy: outOfWindow && win ? minutesOutside(arrivalMin(suggStop), win) : 0,
    ghost: ghostRow?.plate ? { label: ghostRow.label, plate: ghostRow.plate } : null,
  };
}

// ---------------------------------------------------------------------------
// Plate-transcription-error detection
// ---------------------------------------------------------------------------
//
// Shared step, tried only when a row's extracted plate has NO GPS of ours
// anywhere (a plate we've never tracked — so it can't be a real vehicle that
// simply wasn't followed that day). Distinct from findVehicleSwap: here we
// believe the planned vehicle IS the one that drove, only its plate was
// mistyped by a single character on the sheet.

// How many of a route's planned stores, back to back, a look-alike plate must
// actually have visited (right store code + a plausible arrival) before we call
// the sheet's plate a one-character slip rather than a real vehicle.
export const PLATE_TYPO_MIN_RUN = 3;

/** One planned store of the route under test, in delivery order. */
export type RouteStore = {
  code: string;
  planIni: string | number;
  planFim: string | number;
};

export type PlateTypoResult = {
  kind: "plate-typo";
  /** the look-alike plate that does have GPS and drove the route */
  suggPlate: string;
  /** that plate's stop corroborating THIS row's store (arrival/departure) */
  suggStop: WStop;
  /** how many of the route's stores in a row `suggPlate` covered */
  run: number;
};

// True when `a` and `b` are exactly one edit apart — one substitution, one
// insertion, or one deletion. Zero edits (equal strings) is false. Inputs are
// already normalised plates (upper, no hyphens/spaces).
export function isEditDistance1(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }

  // Lengths differ by one: the shorter must sit inside the longer with a single
  // gap (the one inserted / deleted character).
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}

/**
 * The row's extracted plate has no GPS of ours at all. Before giving up: is
 * there exactly one GPS-tracked plate a single character away from it that also
 * *drove this route* that day — a run of at least `minRun` of the route's
 * planned stores, back to back, each with a real stop of that plate at the
 * matching code and a plausible arrival, in delivery order? If so it's almost
 * certainly a transcription slip on the sheet, not a swapped truck.
 *
 * `code`/`planIni`/`planFim` are THIS row's store; it must itself be one of the
 * corroborated stores, so the row gets real arrival/departure times. Pure — the
 * caller marks `suggStop.assigned` once it commits.
 */
export function findPlateTypo(params: {
  /** the row's extracted plate (normalised); has no GPS of ours anywhere */
  plate: string;
  /** this row's store code + planned window */
  code: string;
  planIni: string | number;
  planFim: string | number;
  /** the whole route's planned stores, in delivery order */
  routeStores: RouteStore[];
  /** all of the day's stops */
  stops: WStop[];
  /** plates that have real GPS stops on the service day (the candidate pool) */
  candidatePlates: Set<string>;
  padMin?: number;
  minRun?: number;
  /** same-site co-location groups (locations.colocated_with_id); [] if none */
  coLocatedGroups: CoLocatedGroups;
}): PlateTypoResult | null {
  const {
    plate,
    code,
    planIni,
    planFim,
    routeStores,
    stops,
    candidatePlates,
    coLocatedGroups,
  } = params;
  const padMin = params.padMin ?? SWAP_WINDOW_PAD_MIN;
  const minRun = params.minRun ?? PLATE_TYPO_MIN_RUN;

  if (plate.length < 4) return null;
  // Need a run of stores to lean on — a one-store "route" can't corroborate.
  const route = routeStores.filter((r) => r.code);
  if (route.length < 2) return null;

  // Candidate pool: plates with real GPS this day, exactly one character off.
  const near = [...candidatePlates].filter(
    (p) => p !== plate && isEditDistance1(p, plate),
  );
  if (near.length !== 1) return null;
  const suggPlate = near[0];

  const suggStops = stops
    .filter((s) => s.plate === suggPlate)
    .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  if (suggStops.length === 0) return null;

  // Longest back-to-back run of route stores that `suggPlate` covered, walking
  // both lists forward so the corroboration also respects delivery order.
  const used = new Set<WStop>();
  let bestRun = 0;
  let run = 0;
  let cursorT = -Infinity;
  for (const rs of route) {
    const win = widenWindow(rs.planIni, rs.planFim, padMin);
    const hit = suggStops.find(
      (s) =>
        !used.has(s) &&
        codeEq(s.code, rs.code, coLocatedGroups) &&
        inWindow(arrivalMin(s), win) &&
        new Date(s.arrivedAt).getTime() >= cursorT,
    );
    if (hit) {
      used.add(hit);
      cursorT = new Date(hit.arrivedAt).getTime();
      run += 1;
      if (run > bestRun) bestRun = run;
    } else {
      run = 0;
    }
  }
  if (bestRun < 2 || bestRun < Math.min(minRun, route.length)) return null;

  // This row's own store must be corroborated too, so the row gets real times.
  const win = widenWindow(planIni, planFim, padMin);
  const suggStop = suggStops.find(
    (s) => codeEq(s.code, code, coLocatedGroups) && inWindow(arrivalMin(s), win),
  );
  if (!suggStop) return null;

  return { kind: "plate-typo", suggPlate, suggStop, run: bestRun };
}

// Caption stamped on the "Real" column of a 🔤 row. `origin` says where the
// mistyped plate was read from ("coluna ID", "MATRICULA da folha", …).
export function plateTypoNote(
  extractedPlate: string,
  suggPlate: string,
  run: number,
  origin: string,
): string {
  return (
    `Matrícula ${extractedPlate}${origin ? ` (${origin})` : ""} não tem dados ` +
    `GPS nossos. ${suggPlate} — a 1 caractere de diferença — fez esta rota ` +
    `(${run} lojas seguidas conferem: código de loja + hora plausível). ` +
    `Provável erro de transcrição na matrícula, não troca de viatura. ` +
    `Confirma antes de aceitar.`
  );
}

// Re-exported so matchers can normalise plates without a second import.
export { normalizePlate };

// ---------------------------------------------------------------------------
// Schedule overlap / conflict detection (5th visual rule: dark gray)
// ---------------------------------------------------------------------------

// Parse a Chegada/Saída cell string into epoch ms (Lisbon wall-clock).
// Tolerant of "DD/MM/YYYY HH:MM" or "DD-MM-YYYY HH:MM" (either separator —
// our own export used "/" before, "-" now, and a re-uploaded file may carry
// either), bare "HH:MM", or ISO timestamp.
export function parseTimeCellToEpochMs(
  v: unknown,
  defaultDay?: string,
): number | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const dmyMatch = s.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})$/,
  );
  if (dmyMatch) {
    const [, d, mo, y, h, mi] = dmyMatch;
    const ymd = `${y}-${pad2(mo)}-${pad2(d)}`;
    return lisbonEpoch(ymd, Number(h) * 60 + Number(mi));
  }
  const hmMatch = s.match(/^(\d{1,2}):(\d{2})/);
  if (hmMatch) {
    const min = Number(hmMatch[1]) * 60 + Number(hmMatch[2]);
    const day = defaultDay || "2000-01-01";
    return lisbonEpoch(day, min);
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  return null;
}

// Extract clean "HH:MM" display time for the note caption.
export function fmtTimeCellForNote(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  const m = s.match(/\b(\d{1,2}:\d{2})\b/);
  return m ? m[1] : s;
}

// Format the conflict note stamped on the "Real" column.
export function scheduleConflictNote(params: {
  otherCode: string;
  otherName?: string | null;
  otherChegada: string;
  otherSaida: string;
}): string {
  const { otherCode, otherName, otherChegada, otherSaida } = params;
  const tChegada = fmtTimeCellForNote(otherChegada);
  const tSaida = fmtTimeCellForNote(otherSaida);
  const times = `${tChegada}–${tSaida}`;
  const label = otherName && otherName.trim() !== otherCode.trim()
    ? `${otherCode} (${otherName.trim()}, ${times})`
    : `${otherCode} (${times})`;
  return `⚠️ Conflito: sobrepõe-se à linha ${label} — mesma viatura, horários fisicamente incompatíveis. Confirma qual está correto.`;
}

export type DetectScheduleConflictItem = {
  idx: number;
  out: SheetRecord;
  route: string;
  plate: string | null;
  code: string;
  name?: string;
};

/**
 * Flags physical schedule conflicts between rows of the same route and same
 * vehicle plate with different, non-co-located store codes.
 * Pure in terms of schedule values: only annotates `REAL_COL` with the conflict
 * warning note; never touches Chegada, Saída, or Confiança.
 */
export function detectScheduleConflicts(params: {
  items: DetectScheduleConflictItem[];
  chegadaCol: string;
  saidaCol: string;
  defaultDay: string;
  coLocatedGroups: CoLocatedGroups;
}): void {
  const { items, chegadaCol, saidaCol, defaultDay, coLocatedGroups } = params;

  type ParsedItem = DetectScheduleConflictItem & {
    plate: string;
    startMs: number;
    effEndMs: number;
    chegadaStr: string;
    saidaStr: string;
  };

  const parsed: ParsedItem[] = [];
  for (const it of items) {
    if (!it.plate || !it.code) continue;
    const chegadaStr = String(it.out[chegadaCol] ?? "").trim();
    const saidaStr = String(it.out[saidaCol] ?? "").trim();
    if (!chegadaStr || !saidaStr) continue;

    const startMs = parseTimeCellToEpochMs(chegadaStr, defaultDay);
    const endMs = parseTimeCellToEpochMs(saidaStr, defaultDay);
    if (startMs == null || endMs == null) continue;

    // Reject inverted intervals where departure is strictly before arrival.
    if (endMs < startMs) continue;

    // Minimum 1 min effective duration so a 0-min pass-through during another
    // stop is correctly caught as overlapping, without catching adjacent stops.
    const effEndMs = Math.max(endMs, startMs + 60_000);
    parsed.push({
      ...it,
      plate: it.plate,
      startMs,
      effEndMs,
      chegadaStr,
      saidaStr,
    });
  }

  // Group by (plate, route)
  const byGroup = new Map<string, ParsedItem[]>();
  for (const it of parsed) {
    const normPlate = normalizePlate(it.plate);
    if (!normPlate) continue;
    const routeKey = it.route.trim().toLowerCase() || "(sem-rota)";
    const key = `${normPlate}::${routeKey}`;
    const list = byGroup.get(key);
    if (list) list.push(it);
    else byGroup.set(key, [it]);
  }

  const conflictsByItem = new Map<ParsedItem, ParsedItem[]>();

  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        // 1. Must be different store codes and NOT co-located/merged.
        if (codeEq(a.code, b.code, coLocatedGroups)) continue;

        // 2. Physical overlap: startA < effEndB && startB < effEndA
        if (a.startMs < b.effEndMs && b.startMs < a.effEndMs) {
          let listA = conflictsByItem.get(a);
          if (!listA) conflictsByItem.set(a, (listA = []));
          listA.push(b);

          let listB = conflictsByItem.get(b);
          if (!listB) conflictsByItem.set(b, (listB = []));
          listB.push(a);
        }
      }
    }
  }

  // Stamp notes on conflicting items
  for (const [it, rivals] of conflictsByItem.entries()) {
    const notes = rivals.map((r) =>
      scheduleConflictNote({
        otherCode: r.code,
        otherName: r.name,
        otherChegada: r.chegadaStr,
        otherSaida: r.saidaStr,
      }),
    );
    const combinedNote = notes.join(" ");
    const existing = String(it.out[REAL_COL] ?? "").trim();
    it.out[REAL_COL] = existing
      ? `${combinedNote} ${existing}`
      : combinedNote;
  }
}

// ---------------------------------------------------------------------------
// Physical speed plausibility between consecutive stops (6th visual rule:
// distinct blue, xlsx-out.ts) — 2026-09-22.
//
// Different in kind from the schedule-conflict rule above: that one catches
// two OVERLAPPING windows on the same ROUTE. This one catches two
// NON-overlapping stops, anywhere in the vehicle's whole DAY (any route, any
// leg), whose travel time between them is physically impossible — Saída_A ->
// Chegada_B implies a speed no truck can sustain. Applies to every row
// regardless of how its times got there (OK / mantido / accepted suggestion)
// — a same-vehicle same-day pair is either physically possible or it isn't,
// independent of which matching path produced each half of it.
// ---------------------------------------------------------------------------

// Great-circle distance in km. A local copy rather than importing
// src/lib/geo.ts's (unexported, meters-based) helper — this file is pure, no
// DB/framework, and promises to stay self-contained.
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// No truck in this fleet can sustain more than this between two stops —
// confirmed with the user, 2026-09-22 (the rule's own spec initially named
// both 50 and 80; 50 is the one that stuck).
export const MAX_PLAUSIBLE_SPEED_KMH = 50;

// Caption stamped on the "Real" column of both rows in an implausible-speed
// pair. `code`/`otherCode` are in chronological order (code = the EARLIER
// stop, otherCode = the LATER one) — always the same order on both flagged
// rows, unlike scheduleConflictNote's "the other one" phrasing, so the two
// notes read identically wherever they land.
export function implausibleSpeedNote(params: {
  code: string;
  otherCode: string;
  distanceKm: number;
  minutes: number;
  speedKmh: number;
}): string {
  const { code, otherCode, distanceKm, minutes, speedKmh } = params;
  return (
    `⚠️ Velocidade implausível: ${distanceKm.toFixed(1)}km entre ${code} e ` +
    `${otherCode} em ${Math.round(minutes)}min (${speedKmh.toFixed(1)}km/h) — ` +
    `camião não pode exceder ${MAX_PLAUSIBLE_SPEED_KMH}km/h. Confirma os horários.`
  );
}

export type DetectImplausibleSpeedItem = {
  idx: number;
  out: SheetRecord;
  plate: string | null;
  code: string;
};

/**
 * Flags physically-impossible travel between a vehicle's own CONSECUTIVE
 * stops, day-wide (not scoped to one route, unlike detectScheduleConflicts).
 * Pure in terms of schedule/geometry: only annotates `REAL_COL`; never
 * touches Chegada, Saída, or Confiança.
 */
export function detectImplausibleSpeed(params: {
  items: DetectImplausibleSpeedItem[];
  chegadaCol: string;
  saidaCol: string;
  defaultDay: string;
  coLocatedGroups: CoLocatedGroups;
  /** locations.code -> {lat,lng}. A code missing here is never checked —
   *  no unverified assumption, same stance as codeTypes elsewhere. */
  codeCoords: ReadonlyMap<string, { lat: number; lng: number }>;
  maxSpeedKmh?: number;
}): void {
  const {
    items,
    chegadaCol,
    saidaCol,
    defaultDay,
    coLocatedGroups,
    codeCoords,
  } = params;
  const maxSpeedKmh = params.maxSpeedKmh ?? MAX_PLAUSIBLE_SPEED_KMH;

  type ParsedItem = DetectImplausibleSpeedItem & {
    plate: string;
    startMs: number;
    endMs: number;
  };

  const parsed: ParsedItem[] = [];
  for (const it of items) {
    if (!it.plate || !it.code) continue;
    const chegadaStr = String(it.out[chegadaCol] ?? "").trim();
    const saidaStr = String(it.out[saidaCol] ?? "").trim();
    if (!chegadaStr || !saidaStr) continue;

    const startMs = parseTimeCellToEpochMs(chegadaStr, defaultDay);
    const endMs = parseTimeCellToEpochMs(saidaStr, defaultDay);
    if (startMs == null || endMs == null || endMs < startMs) continue;

    const normPlate = normalizePlate(it.plate);
    if (!normPlate) continue;

    parsed.push({ ...it, plate: normPlate, startMs, endMs });
  }

  // Group by plate ONLY — day-wide, every route/leg together, unlike the
  // (plate, route) grouping the schedule-conflict rule uses above.
  const byPlate = new Map<string, ParsedItem[]>();
  for (const it of parsed) {
    const list = byPlate.get(it.plate);
    if (list) list.push(it);
    else byPlate.set(it.plate, [it]);
  }

  type Visit = {
    code: string;
    startMs: number;
    endMs: number;
    rows: ParsedItem[];
  };

  for (const group of byPlate.values()) {
    // Collapse sheet rows that share ONE physical visit (same site, same
    // exact window — e.g. Azambuja's C+D pair sharing one Chegada/Saída) so
    // "consecutive" is judged between VISITS, not raw rows: otherwise only
    // whichever row happened to land next to the boundary in sort order
    // would get flagged, leaving its group-mates untouched.
    const visits: Visit[] = [];
    for (const it of group) {
      const existing = visits.find(
        (v) =>
          v.startMs === it.startMs &&
          v.endMs === it.endMs &&
          codeEq(v.code, it.code, coLocatedGroups),
      );
      if (existing) existing.rows.push(it);
      else visits.push({ code: it.code, startMs: it.startMs, endMs: it.endMs, rows: [it] });
    }
    visits.sort((a, b) => a.startMs - b.startMs);

    for (let i = 0; i + 1 < visits.length; i++) {
      const a = visits[i];
      const b = visits[i + 1];

      // Same site (incl. co-located/merged) -> zero distance, never a
      // speed problem, no matter how far apart in time.
      if (codeEq(a.code, b.code, coLocatedGroups)) continue;

      const availableMin = (b.startMs - a.endMs) / 60_000;
      // <=0: overlapping or out-of-order across two different routes/legs —
      // a different anomaly (not "too fast", genuinely no available time to
      // divide by). Out of scope for this rule; left unflagged here.
      if (availableMin <= 0) continue;

      const coordA = codeCoords.get(a.code);
      const coordB = codeCoords.get(b.code);
      if (!coordA || !coordB) continue;

      const distanceKm = haversineKm(coordA.lat, coordA.lng, coordB.lat, coordB.lng);
      // Rounded to 1 decimal BEFORE the threshold check, same precision the
      // note displays — a genuine exactly-at-the-limit case (e.g. distance
      // and time both round real-world numbers) must never get flagged over
      // floating-point noise in the haversine trig (order of 1e-13 km/h) that
      // the user would never see reflected in the note anyway.
      const speedKmh = Math.round((distanceKm / (availableMin / 60)) * 10) / 10;
      if (speedKmh <= maxSpeedKmh) continue;

      const note = implausibleSpeedNote({
        code: a.code,
        otherCode: b.code,
        distanceKm,
        minutes: availableMin,
        speedKmh,
      });
      for (const row of [...a.rows, ...b.rows]) {
        const existing = String(row.out[REAL_COL] ?? "").trim();
        row.out[REAL_COL] = existing ? `${note} ${existing}` : note;
      }
    }
  }
}
