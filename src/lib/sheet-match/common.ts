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
export const SWAP = "🔄 Possível troca de viatura";
export const SWAP_OUT_OF_WINDOW = "🔄❗ Possível troca (fora da janela)";
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
//
//  - exact, case-insensitive
//  - same letter prefix + same digits ignoring leading zeros: "A5" == "A05",
//    "01" == "1". A *different* letter is a different store, so "B97" != "E97"
//    (an earlier digits-only rule wrongly matched those).
//  - one code is the "-"/"/" base segment of the other: "B97" == "B97-E72"
//    (the sheet uses the base, our locations row carries the merged code).
export function codeEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const x = String(a).trim().toUpperCase();
  const y = String(b).trim().toUpperCase();
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

export function codeKey(code: string): string {
  const k = code.trim().replace(/^0+(?=.)/, "").toLowerCase();
  return k || "(sem código)";
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

/**
 * Returns a swap suggestion for `plate` at store `code`, or null when there
 * isn't a single unambiguous leftover stop to point at. Does NOT mutate — the
 * caller marks `result.suggStop.assigned` once it commits the suggestion.
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
  /** plates our GPS feed has ever seen (this fleet) */
  platesWithGps: Set<string>;
  padMin?: number;
}): SwapResult | null {
  const { plate, code, planIni, planFim, stops, rivals, platesWithGps } = params;
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

// Re-exported so matchers can normalise plates without a second import.
export { normalizePlate };
