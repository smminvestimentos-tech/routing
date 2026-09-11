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
export const CONFIANCA_COL = "Confiança";
export const REAL_COL = "Real";

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
    // treat an open stop as ~2h long for overlap purposes
    return s.departedAt ? new Date(s.departedAt).getTime() : start + 2 * 3600_000;
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

// Normalise a store code: handles string, number (e.g. 94), strips Excel float
// suffixes (".0"), trims whitespace.
export function normalizeStoreCode(v: unknown): string {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/\.0+$/, "");
  return s;
}

// Co-located / same-site equivalence groups.
// Physical sites that house multiple logical locations / codes (e.g. store + warehouse
// sharing the same address/coordinates, or legacy codes used in planning sheets).
// Any code in a group is considered an exact same-site match for any other code in the group.
//
// Group 1 — Albufeira:
//   - 'B78': Loja Albufeira (GPS proximity stop detection tags visits under this code)
//   - 'AUCHAN-06': Armazém Albufeira / Plataforma Albufeira (same physical site & coords)
//   - '94': Legacy code for Armazém Albufeira still used in transport planning sheets
export const SAME_SITE_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["B78", "94", "AUCHAN-06"]),
];

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
): ReadonlySet<string> | null {
  if (!code) return null;
  const s = normalizeStoreCode(code).toUpperCase();
  for (const group of SAME_SITE_GROUPS) {
    for (const member of group) {
      if (codeBaseEq(member, s)) return group;
    }
  }
  return null;
}

export function areSameSite(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const groupA = findSameSiteGroup(a);
  if (!groupA) return false;
  const sB = normalizeStoreCode(b).toUpperCase();
  for (const member of groupA) {
    if (codeBaseEq(member, sB)) return true;
  }
  return false;
}

export function canonicalSiteCode(code: string | null | undefined): string {
  if (!code) return "";
  const norm = normalizeStoreCode(code);
  const group = findSameSiteGroup(norm);
  if (group) {
    // Return the primary/first representative of the group (e.g. "B78" for Albufeira)
    return [...group][0];
  }
  return norm;
}

// Store code equality with same-site / co-location support.
export function codeEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const x = normalizeStoreCode(a).toUpperCase();
  const y = normalizeStoreCode(b).toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;

  // 1. Same-site co-location group match (e.g. B78 <=> 94 <=> AUCHAN-06)
  if (areSameSite(x, y)) return true;

  // 2. Base code equality (same prefix + digits, or composite code segment)
  return codeBaseEq(x, y);
}

export function codeKey(code: string): string {
  const norm = normalizeStoreCode(code);
  const canonical = canonicalSiteCode(norm);
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
// location still matches the sheet's row for the old code.
export function resolveMergedCode(
  raw: unknown,
  activeCodes: readonly string[],
  merged: readonly MergedCodeEntry[],
): string {
  const norm = normalizeStoreCode(raw);
  if (!norm) return norm;

  // If the raw code directly matches a currently active location (exact or base code,
  // without co-location grouping), keep it verbatim.
  if (activeCodes.some((c) => codeBaseEq(c, norm))) return norm;

  // Check merged/alias list (handles string/int and codeBaseEq)
  const hit = merged.find((m) => codeBaseEq(m.code, norm) || codeEq(m.code, norm));
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

const DMY_HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// ISO timestamp -> "DD/MM/YYYY HH:MM" in Portugal wall-clock. "" for
// null/invalid. Used for sheets whose delivery cycles cross midnight (Azambuja),
// where a bare "HH:MM" is ambiguous about which calendar day it belongs to.
export function fmtDateTimeLisbon(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p: Record<string, string> = {};
  for (const part of DMY_HM.formatToParts(d)) p[part.type] = part.value;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
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
  } = params;
  const padMin = params.padMin ?? SWAP_WINDOW_PAD_MIN;
  const win = widenWindow(planIni, planFim, padMin);

  // leftover stops at this store, by another vehicle, at a plausible time
  const windowed = stops.filter(
    (s) =>
      !s.assigned &&
      s.plate != null &&
      s.plate !== plate &&
      codeEq(s.code, code) &&
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
        codeEq(s.code, code),
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
      codeEq(c.code, code) &&
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
}): PlateTypoResult | null {
  const { plate, code, planIni, planFim, routeStores, stops, candidatePlates } =
    params;
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
        codeEq(s.code, rs.code) &&
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
    (s) => codeEq(s.code, code) && inWindow(arrivalMin(s), win),
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
