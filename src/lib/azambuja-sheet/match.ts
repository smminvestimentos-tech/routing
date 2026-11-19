// Matching engine for the Azambuja delivery sheet (/dashboard/azambuja-sheet).
//
// Pure — no framework, no DB, no xlsx. Same role as src/lib/tfs-sheet/match.ts
// but for a different file layout (one row per ROTA × N_LOJA × TIPO, plate
// always pre-filled) and a simpler rule set. The layout-agnostic pieces
// (codeEq, the clock/window helpers, the formatters, findVehicleSwap) come
// from src/lib/sheet-match/common.ts.
//
// The logic, in order:
//
//   1. Group CONSECUTIVE rows with the same (ROTA, N_LOJA) — a "C" delivery
//      + a "D" devolution listed back to back is ONE physical stop, every row
//      in the group gets the same Chegada/Saída. The same store again later
//      in the route (carga 7001 … regresso 7001) is a separate group/visit.
//
//   2. Per PLATE (one physical vehicle), route by route in sheet order: align
//      the route's store-groups (SEQ order) with that plate's stops for the
//      day IN TIME ORDER (stops ↔ vehicle_pings.plate — all TRACKiT accounts,
//      deduped). Exact code first, yard alternative (7005 for a 7001 row)
//      second; depot/workshop stops not on the sheet are simply skipped. The
//      regresso of one route may share its yard stop with the next route's
//      carga. See the "Sequence-aware assignment" block below → "OK".
//
//   3. A store-group the plate couldn't cover: if we have NO GPS of ours for
//      the planned vehicle across its CICLO window, we can't tell it wasn't
//      there itself — flag "⚠️ Rever manualmente" with a "sem cobertura GPS"
//      note and suggest nothing. Otherwise, if a single leftover stop at that
//      store belongs to a DIFFERENT vehicle (and no rival route on a
//      GPS-tracked vehicle was planned for the same store/window), flag
//      "🔄 Possível troca de viatura" with the suggested plate + times (same
//      detector as the TFS sheet, incl. the "fora da janela" variant).
//
//   4. Whatever is left is "⚠️ Rever manualmente", with the "Real" column
//      showing what our data actually has for that route's plate that day.

import {
  classifyKeptDuration,
  codeEq,
  codeKey,
  type CoLocatedGroups,
  CONFIANCA_COL,
  type DayStop,
  dedupeStops,
  detectImplausibleSpeed,
  detectScheduleConflicts,
  findPlateTypo,
  findVehicleSwap,
  fmtDateTimeLisbon,
  fmtDuration,
  fmtHM,
  haversineKm,
  type ImplausibleKeptReason,
  implausibleKeptNote,
  KEPT,
  lisbonEpoch,
  mergeFragmentedStops,
  minutesBetweenKeptCells,
  noGpsCoverageNote,
  normalizeDateTimeCell,
  normalizePlate,
  normalizeStoreCode,
  parseClockMin,
  parseServiceDay,
  pick,
  PLATE_TYPO,
  plannedPlateHasCoverage,
  plateTypoNote,
  REAL_COL,
  resolveMergedCode,
  REVIEW,
  TRACKIT_FALLBACK,
  type MergedCodeEntry,
  type RouteStore,
  type SheetRecord,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  SWAP_WINDOW_PAD_MIN,
  type SwapRival,
  VV_COL,
  yardAcceptedCodes,
  type WStop,
} from "@/lib/sheet-match/common";
import {
  applyTrackitOutcome,
  tryTrackitFallback,
  type TrackitCandidateMap,
} from "@/lib/sheet-match/trackit-candidates";
import type { PlanLine } from "@/lib/azambuja-sheet/plano";
import type { WarehouseLine } from "@/lib/azambuja-sheet/relatorio";

export {
  CONFIANCA_COL,
  REAL_COL,
  REVIEW,
  KEPT,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
  TRACKIT_FALLBACK,
  dedupeStops,
  mergeFragmentedStops,
  normalizeDateTimeCell,
  parseServiceDay,
};
export type { CoLocatedGroups, DayStop, MergedCodeEntry, SheetRecord };

// Written into every output row so a re-uploaded (already conferido) file
// still carries its service day unambiguously — the sheet name and file name
// are both fragile (a save renames the sheet to "Azambuja", the browser
// appends "(1)" to the file). Day resolution reads this back first.
export const DIA_COL = "Dia Serviço";

// Columns the Azambuja sheet is expected to carry (its own order). Shown in the
// UI for reference; resolution itself is accent/spacing tolerant and also
// accepts the "Nº_LOJA" / "Ciclo" spellings of the transporter export.
export const EXPECTED_COLUMNS = [
  "ROTA",
  "N_LOJA",
  "NOME",
  "MATRICULA",
  "Hora Chegada",
  "Hora Saida",
  "TRANSP.",
  "VIATURA PLANEADO",
  "CICLO",
  "TIPO",
] as const;

export type ResolvedColumns = {
  rotaCol: string;
  codeCol: string;
  nomeCol: string | null;
  plateCol: string;
  cicloCol: string | null;
  /** "VIATURA PLANEADO" — source for the Centro Custo / N_Dedicado fill */
  viaturaPlaneadoCol: string | null;
  /** existing header if found, else the canonical name to add */
  centroCustoCol: string | null;
  /** existing header if found, else the canonical name to add */
  nDedicadoCol: string | null;
  /** our own "Dia Serviço" column, present only on a re-uploaded output */
  diaCol: string | null;
  /** existing header if found, else the canonical name to add */
  chegadaCol: string;
  saidaCol: string;
  errors: string[];
};

export type ViaturaPlaneadaClass = { k: "F" | "D"; l: string };

// VIATURA PLANEADO -> Centro Custo (K) / N_Dedicado (L). Validated against
// Ficheiro_Horários_TFS_12-09-2026.xlsx: 0 discrepancies over 67 distinct
// VIATURA PLANEADO values / 529 rows (2026-09-14).
export function classifyViaturaPlaneada(j: string): ViaturaPlaneadaClass {
  const upper = j.toUpperCase();
  if (upper.startsWith("F") || upper.startsWith("PF")) {
    return { k: "F", l: "" };
  }
  const singleLetterMatch = j.match(/^([A-Za-z])0*(\d+)$/);
  if (singleLetterMatch) {
    return { k: "D", l: singleLetterMatch[2] };
  }
  return { k: "D", l: j };
}

export type MatchSummary = {
  /** data rows considered (blank rows excluded) */
  total: number;
  /** rows linked to a Plano de Cargas line (0 when no plan was uploaded) */
  planRows: number;
  ok: number;
  review: number;
  /** rows that arrived with both times filled and were kept verbatim */
  kept: number;
  /** blank rows passed through untouched */
  passthrough: number;
  /** rows flagged "🔄 Possível troca de viatura" */
  swap: number;
  /** rows flagged "🔄❗ Possível troca (fora da janela)" */
  swapOutOfWindow: number;
  /** rows flagged "🔤 Possível erro de matrícula" (one-char plate slip) */
  plateTypo: number;
  /** rows filled from TRACKiT /vehicleTravels because `stops` had nothing */
  trackitFallback: number;
  /** distinct (ROTA) count and how many matched cleanly */
  routes: number;
  routesOk: number;
  /** Relatório diário do armazém (quando vem no upload) */
  warehouse?: WarehouseSummary;
};

export type WarehouseSummary = {
  /** linhas da folha ligadas a uma linha do relatório */
  linked: number;
  /** rotas com a matrícula corrigida pela do relatório */
  plateFixes: number;
  /** linhas do pátio com hora real no relatório e hora da app: a visita da app contém a carga real */
  agree: number;
  /** …e não contém (vão para Rever) */
  disagree: number;
  /** linhas do pátio com hora real no relatório e sem hora da app */
  blank: number;
};

export type RunMatchArgs = {
  /** Plano de Cargas do mesmo dia (opcional, em memória) — ver plano.ts */
  plan?: readonly PlanLine[];
  /** Relatório diário do armazém (opcional, em memória) — ver relatorio.ts */
  warehouse?: readonly WarehouseLine[];
  day: string; // YYYY-MM-DD
  records: SheetRecord[];
  /** same rows, read with raw:true — Excel serials as numbers (for kept-row
   *  date normalisation). Optional; aligned to `records` by index. */
  rawRecords?: SheetRecord[];
  header: string[];
  cols: ResolvedColumns;
  stops: DayStop[];
  /** every plate our GPS feed has ever seen (normalised) */
  platesWithGps: Set<string>;
  /**
   * normalised plate -> [min, max] epoch-ms of that plate's pings in the
   * loaded window. Gates swap suggestions: a planned vehicle with no coverage
   * around a candidate stop gets "sem cobertura GPS", not a guessed swap.
   */
  pingWindowByPlate: Map<string, { min: number; max: number }>;
  /** every currently active location's code — resolveMergedCode's live set */
  activeCodes?: readonly string[];
  /** inactive, merged location code -> canonical code (locations.merged_into_id) */
  mergedCodes?: readonly MergedCodeEntry[];
  /** same-site co-location groups (locations.colocated_with_id) */
  coLocatedGroups?: CoLocatedGroups;
  /**
   * locations.code -> locations.type ("loja", "armazem", …). Gates the
   * KEPT-row plausibility check's stricter <5min threshold to actual stores —
   * see classifyKeptDuration (common.ts). Missing/unknown code -> no stricter
   * threshold applied (same as today), not an assumption either way.
   */
  codeTypes?: ReadonlyMap<string, string>;
  /** locations.code -> {lat,lng}. Feeds detectImplausibleSpeed (common.ts) —
   *  a code missing here is never speed-checked, not an assumption either way. */
  codeCoords?: ReadonlyMap<string, { lat: number; lng: number }>;
  /**
   * TRACKiT /vehicleTravels-derived fallback candidates, keyed by plate — only
   * consulted for a group `stops` couldn't resolve at all (Step 4 leftover).
   * Omitted (pass 1 / no I/O yet) -> behaves exactly as before this feature
   * existed. See src/lib/sheet-match/trackit-candidates.ts and
   * src/app/api/azambuja-sheet/route.ts's two-pass runMatch() call.
   */
  trackitStopsByPlate?: TrackitCandidateMap;
};

export type RunMatchResult = {
  rows: SheetRecord[];
  header: string[];
  summary: MatchSummary;
  /**
   * Distinct plates that reached the Step 4 leftover with NO
   * trackitStopsByPlate entry to consult (i.e. every plate a caller without
   * that argument would want to fetch /vehicleTravels for, to re-run with it
   * on a second pass). Empty when nothing is eligible — the common case.
   */
  pendingTrackitPlates: string[];
};

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

export function resolveColumns(header: string[]): ResolvedColumns {
  const used = new Set<string>();
  const take = (...targets: string[]) => {
    const c = pick(header, used, targets);
    if (c) used.add(c);
    return c;
  };

  const rotaCol = take("rota", "id rota", "rota id");
  const codeCol = take(
    "n loja",
    "no loja",
    "nloja",
    "numero loja",
    "numero da loja",
    "codigo loja",
    "codigo de loja",
    "cod loja",
    "loja",
  );
  const nomeCol = take("nome", "designacao", "nome da loja", "designacao da loja");
  const plateCol = take("matricula", "matricula da viatura", "matricula viatura");
  const cicloCol = take("ciclo");
  const viaturaPlaneadoCol = take("viatura planeado", "viatura planeada");
  const centroCustoCol = take("centro custo");
  const nDedicadoCol = take("n dedicado", "no dedicado", "num dedicado");
  const diaCol = take(
    "dia servico",
    "dia de servico",
    "data servico",
    "data do servico",
  );
  const chegadaCol = take("hora de chegada", "hora chegada", "chegada");
  const saidaCol = take("hora de saida", "hora saida", "saida");

  const errors: string[] = [];
  if (!rotaCol) errors.push("Falta a coluna «ROTA».");
  if (!codeCol) errors.push("Falta a coluna «N_LOJA».");
  if (!plateCol) errors.push("Falta a coluna «MATRICULA».");

  return {
    rotaCol: rotaCol ?? "",
    codeCol: codeCol ?? "",
    nomeCol,
    plateCol: plateCol ?? "",
    cicloCol,
    viaturaPlaneadoCol,
    centroCustoCol,
    nDedicadoCol,
    diaCol,
    chegadaCol: chegadaCol ?? "Hora Chegada",
    saidaCol: saidaCol ?? "Hora Saida",
    errors,
  };
}

// ---------------------------------------------------------------------------
// CICLO -> planned window
// ---------------------------------------------------------------------------

// CICLO looks like "20:00-1 | 08:00" (start 20:00 the day before, end 08:00),
// "08:00 | 20:00" (same day), "12:30 | 00:30+1" (ends after midnight), or a
// free-text label ("Noturno", "Diurno") we can't use — bar the few in
// FREE_TEXT_CICLO_EQUIVALENTS below, measured and mapped to a real window.

const CICLO_RE =
  /^(\d{1,2}:\d{2})\s*([+-]\d)?\s*\|\s*(\d{1,2}:\d{2})\s*([+-]\d)?$/;

// Free-text CICLO labels that DO have a stable real-world window, measured
// from our own stops (read-only, 6 service days: 09/10/11/18/21/22-09-2026 —
// each route anchored on its own planned STORES, loading = the last planned
// warehouse departure before the first delivery). Mapped to the equivalent
// time-window CICLO so they get the same day-aware window as a written one.
// Values are the observed envelope rounded — NOT padded: groupWindowMs already
// adds CICLO_PAD_MS (3h) on BOTH ends of a "…-1" window, so padding here would
// apply it twice. Checked against the neighbouring service days (no overlap
// with the previous day's end or the next day's loading).
//
//   "Crossdocking peixe" — loading at Salvesen/Peniche 22:39-1 … 04:28
//     (median ~23:04-1), deliveries done by 07:34. Before this, the strict
//     00:00–24:00 day cut the 23:00-1 loading: 14 of the 19 "Rever" 7003 rows
//     of 22/09 had the vehicle AT 7003, located, just the evening before.
//     -> "22:30-1 | 07:30"  (effective 19:30-1 .. 10:30)
//   "Viatura dos Congelados -mantem" — 7001->7002 transfer from 20:44-1,
//     loading 23:33-1, deliveries 01:22 … 07:24 (one route 09:50–11:00).
//     Thin sample: 8 routes, 7 of them the same truck (20-TR-87).
//     -> "20:30-1 | 08:00"  (effective 17:30-1 .. 11:00)
//
// "Noturno" is deliberately NOT here: despite the name it's night LOADING and
// morning/early-afternoon deliveries of the service day itself (median first
// delivery 07:40, last 10:25; ~95% inside 00:00–24:00), which the strict
// service-day default already covers. Other labels: too few routes to fix one.
const FREE_TEXT_CICLO_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
  ["crossdocking peixe", "22:30-1 | 07:30"],
  ["viatura dos congelados -mantem", "20:30-1 | 08:00"],
]);

// Case-, accent- and spacing-insensitive key for FREE_TEXT_CICLO_EQUIVALENTS
// ("Viatura dos Congelados - mantém" == "viatura dos congelados -mantem").
function freeTextCicloKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*-\s*/g, " -")
    .replace(/\s+/g, " ")
    .trim();
}

// Shared parse of a time-window CICLO. Returns the two ends as minutes since
// midnight plus which calendar day each falls on relative to the SERVICE day
// (0 = service day, -1 = the day before, +1 = the day after). null for a
// free-text CICLO — except the labels in FREE_TEXT_CICLO_EQUIVALENTS, read as
// their equivalent window. A wrap with no explicit marker ("20:00 | 08:00") is
// read as starting the previous day, same as an explicit "-1".
function matchCiclo(raw: unknown): {
  startOffsetDays: number;
  startMin: number;
  endOffsetDays: number;
  endMin: number;
} | null {
  const s = String(raw ?? "").trim();
  const m = (FREE_TEXT_CICLO_EQUIVALENTS.get(freeTextCicloKey(s)) ?? s).match(CICLO_RE);
  if (!m) return null;
  const [, iniHM, iniOff, fimHM, fimOff] = m;
  const startMin = parseClockMin(iniHM);
  const endMin = parseClockMin(fimHM);
  if (startMin == null || endMin == null) return null;

  const startsPrevDay = iniOff === "-1";
  const endsNextDay = fimOff === "+1";
  const wrapsWithoutMarker =
    !startsPrevDay && !endsNextDay && startMin > endMin;

  return {
    startOffsetDays: startsPrevDay || wrapsWithoutMarker ? -1 : 0,
    startMin,
    endOffsetDays: endsNextDay ? 1 : 0,
    endMin,
  };
}

// The absolute bounds of a CICLO shift relative to the service day — used to
// size the stop-query window (see stopQueryWindowMs). null for a free-text
// CICLO. parseCiclo() throws this day info away; this keeps it.
export function cicloSpan(raw: unknown): {
  startOffsetDays: number;
  startMin: number;
  endOffsetDays: number;
  endMin: number;
} | null {
  return matchCiclo(raw);
}

// The service-day slice of a CICLO, for matching. Our stops are queried per
// service day (00:00–24:00 Lisbon), so a cross-midnight cycle is collapsed to
// the part we can actually observe:
//   "…-1 | HH:MM"  -> 00:00 .. HH:MM   (overnight tail on the service day)
//   "HH:MM | …+1"  -> HH:MM .. 23:59   (daytime head on the service day)
// The ±3h swap pad (SWAP_WINDOW_PAD_MIN) absorbs the rest of the slop. Returns
// two "HH:MM" strings, or "" when CICLO isn't a time window.
export function parseCiclo(raw: unknown): { ini: string; fim: string } {
  const sp = matchCiclo(raw);
  if (!sp) return { ini: "", fim: "" };
  const hm = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  if (sp.startOffsetDays < 0) return { ini: "00:00", fim: hm(sp.endMin) };
  if (sp.endOffsetDays > 0) return { ini: hm(sp.startMin), fim: "23:59" };
  return { ini: hm(sp.startMin), fim: hm(sp.endMin) };
}

// ---------------------------------------------------------------------------
// Stop-query window
// ---------------------------------------------------------------------------

const DAY_MIN = 24 * 60;
const CICLO_PAD_MS = 3 * 3_600_000;
// a carga may start this long before its route's window (see
// cargaOverlapsStart in runMatch) — the stops query must reach back as far
export const CARGA_LOOKBACK_MS = 6 * 3_600_000;

// Epoch-ms [lo, hi) bounds a single CICLO's real stops may fall in, on `day`.
//
//   • free-text CICLO ("Noturno", "Diurno") -> the strict service
//     day, 00:00–24:00. (The labels in FREE_TEXT_CICLO_EQUIVALENTS —
//     "Crossdocking peixe", "Viatura dos Congelados -mantem" — are NOT free
//     text here: they're read as their mapped "…-1 | …" window below.) NOTHING outside it — there's no HH:MM at all to bound
//     by, so the calendar day is the only signal we have.
//   • same-day window ("02:00 | 14:00", "11:30 | 23:30") -> also the strict
//     service day. The hours are informative but a same-day route's stops
//     belong to that calendar day; they must not spill into the next.
//   • "…-1 | …"  -> lo reaches the previous calendar day (shift start − pad);
//     hi is bounded by the shift's own end time + pad (NOT end-of-day — a
//     shift documented as ending ~08:00 doesn't get to claim a 13:34 stop
//     just because it's still technically the same service day; 2026-09-11
//     ROTA 185798003 / código 7001 / AD-49-DH: CICLO "20:00-1 | 08:00" wrongly
//     accepted a 10/09 13:34 stop before this fix, 5.5h past end+pad).
//   • "… | …+1"  -> hi reaches the next calendar day (shift end + pad);
//     lo stays at start-of-service-day.
//
// Only a genuinely SAME-day window (no day-crossing marker on EITHER end)
// treats its hours as informative-only and spans the full service day; any
// window that reaches past a calendar boundary has both ends bounded by the
// CICLO's own times (± pad).
//
// depHiMs — how late a stop that ARRIVED inside [loMs, hiMs) may DEPART (see
// stopInWindow). Equal to hiMs everywhere except a "…-1 | …" window ending on
// the service day, where it's the END of the service day: a truck that arrives
// in-window and then parks (real case, 2026-09-23: "Crossdocking peixe"
// AC-99-DS / 03-QA-31 back at Peniche 7007 ~06:30, parked until ~21:20, every
// day) belongs to this route even though it leaves after the shift's end+pad.
// The ARRIVAL stays bounded by hiMs (so the next evening's loading, and the
// 2026-09-11 AD-49-DH 13:34 arrival, are still rejected), and the departure
// still never crosses into the next calendar day.
export function groupWindowMs(
  day: string, // YYYY-MM-DD
  rawCiclo: unknown,
  opts: { padMs?: number } = {},
): { loMs: number; hiMs: number; depHiMs: number } {
  const padMs = opts.padMs ?? CICLO_PAD_MS;
  const dayLo = lisbonEpoch(day, 0);
  const dayHi = lisbonEpoch(day, DAY_MIN);

  const sp = matchCiclo(rawCiclo);
  if (!sp) return { loMs: dayLo, hiMs: dayHi, depHiMs: dayHi };

  const sameDay = sp.startOffsetDays === 0 && sp.endOffsetDays === 0;

  const loMs =
    sp.startOffsetDays < 0
      ? lisbonEpoch(day, sp.startOffsetDays * DAY_MIN + sp.startMin) - padMs
      : dayLo;
  const hiMs = sameDay
    ? dayHi
    : lisbonEpoch(day, sp.endOffsetDays * DAY_MIN + sp.endMin) + padMs;
  const depHiMs =
    sp.startOffsetDays < 0 && sp.endOffsetDays === 0 ? Math.max(hiMs, dayHi) : hiMs;
  return { loMs, hiMs, depHiMs };
}

// Epoch-ms [lo, hi) bounds for the stops/pings query for the whole file: the
// union of every row's groupWindowMs. With only same-day / free-text CICLOs
// this is exactly the service day; a "…-1" pushes lo back, a "…+1" pushes hi
// forward. (There is NO blanket ±skirt any more — that was pulling next-day
// stops into every file.)
export function stopQueryWindowMs(
  day: string, // YYYY-MM-DD
  ciclos: Iterable<unknown>,
  opts: { padMs?: number } = {},
): { loMs: number; hiMs: number } {
  let loMs = lisbonEpoch(day, 0);
  let hiMs = lisbonEpoch(day, DAY_MIN);
  for (const raw of ciclos) {
    const w = groupWindowMs(day, raw, opts);
    if (w.loMs < loMs) loMs = w.loMs;
    if (w.hiMs > hiMs) hiMs = w.hiMs;
  }
  return { loMs, hiMs };
}

// Does a stop fit ENTIRELY inside [loMs, hiMs)? Its arrival must be in range
// AND its departure must not cross hiMs. So a same-day / free-text route (whose
// window is the strict service day) can't claim a stop that spills past
// midnight — a 09/09 23:04 → 10/09 00:10 visit goes to manual review, not "OK"
// with a 10/09 departure. A stop with no departure recorded is judged on its
// arrival alone. `depHiMs` (default hiMs) lets the DEPARTURE run later than
// the arrival bound — groupWindowMs's depHiMs, only ever wider for a "…-1 | …"
// window, and never past the end of the service day.
export function stopInWindow(
  arrivedAt: string,
  departedAt: string | null,
  loMs: number,
  hiMs: number,
  depHiMs: number = hiMs,
): boolean {
  const a = new Date(arrivedAt).getTime();
  if (!Number.isFinite(a) || a < loMs || a >= hiMs) return false;
  if (departedAt == null) return true;
  const d = new Date(departedAt).getTime();
  return !Number.isFinite(d) || d < depHiMs;
}

// normalizeDateTimeCell moved to sheet-match/common.ts (2026-09-22) — it's now
// also the source-of-truth duration parser for the KEPT-row plausibility
// check, shared with the TFS matcher. Re-exported below for existing callers
// (scripts/test-azambuja-window.ts).

// ---------------------------------------------------------------------------
// Safety check: one ROTA, one service day
// ---------------------------------------------------------------------------

// The matcher groups rows by (ROTA, N_LOJA) and assumes a route belongs to
// exactly one service day. ROTA is a global, monotonically-increasing id from
// the transporter's planner (observed disjoint per day: 05/08 ids ≈ 1.855e8,
// 09/09 ≈ 1.858e8), so this should never fire in practice — it catches a file
// that mixed two days (e.g. two "conferido" outputs pasted together), which
// would otherwise be matched silently against whichever day won resolution.
//
// Only meaningful when the file carries our per-row «Dia Serviço» column (a
// raw transporter export has no per-row date and is one day by construction).
export function findRotaDayConflicts(
  records: SheetRecord[],
  rotaCol: string,
  diaCol: string | null,
): { rota: string; days: string[] }[] {
  if (!diaCol || !rotaCol) return [];
  const byRota = new Map<string, Set<string>>();
  for (const r of records) {
    const rota = String(r[rotaCol] ?? "").trim();
    const d = parseServiceDay(r[diaCol]);
    if (!rota || !d) continue;
    let set = byRota.get(rota);
    if (!set) byRota.set(rota, (set = new Set<string>()));
    set.add(d);
  }
  return [...byRota.entries()]
    .filter(([, days]) => days.size > 1)
    .map(([rota, days]) => ({ rota, days: [...days].sort() }));
}

// ---------------------------------------------------------------------------
// Day resolution (the sheet has no service-day column)
// ---------------------------------------------------------------------------

// The transporter export names its first sheet "route-<batch>-<YYYYMMDD><HHMMSS>-<n>"
// and the file is usually "Ficheiro DD-MM-YYYY.xlsx". Try the sheet name first
// (unambiguous YYYYMMDD), then the filename.
export function resolveDay(
  sheetName: string | undefined,
  fileName: string | undefined,
): string | null {
  const sn = String(sheetName ?? "").match(/(\d{4})(\d{2})(\d{2})\d{6}/);
  if (sn) {
    const day = `${sn[1]}-${sn[2]}-${sn[3]}`;
    if (parseServiceDay(day)) return day;
  }
  const fn = String(fileName ?? "").match(/(\d{1,2})[-.\/](\d{1,2})[-.\/](\d{4})/);
  if (fn) {
    const day = parseServiceDay(`${fn[1]}/${fn[2]}/${fn[3]}`);
    if (day) return day;
  }
  const iso = String(fileName ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

type Work = {
  idx: number;
  out: SheetRecord;
  empty: boolean;
  /** input row already had BOTH times — keep verbatim, skip all matching */
  kept: boolean;
  rota: string;
  code: string;
  designacao: string;
  rawPlate: string;
  /** normalised plate, or null for "n/a" / blank */
  plate: string | null;
  planIni: string;
  planFim: string;
  /** the CICLO cell, verbatim (for the day-aware stop window) */
  rawCiclo: string;
  /** the (ROTA, N_LOJA) store-group this row belongs to */
  groupKey: string;
  /** from the Plano de Cargas, when uploaded */
  planArrMs: number | null;
  planDepMs: number | null;
  carga: number;
  conf:
    | ""
    | "OK"
    | typeof REVIEW
    | typeof KEPT
    | typeof SWAP
    | typeof SWAP_OUT_OF_WINDOW
    | typeof PLATE_TYPO
    | typeof TRACKIT_FALLBACK;
  real: string;
  /** set when input Chegada/Saída were rejected as an implausible pre-fill */
  placeholderNote: string;
  swapPlate: string | null;
  assignedStop: WStop | null;
  /** kept rows only: their Chegada/Saída as epoch-ms (Lisbon wall-clock) */
  keptArrMs: number | null;
  keptDepMs: number | null;
  /** linha do relatório do armazém ligada a esta (quando vem no upload) */
  wh: WarehouseLine | null;
};

// "DD-MM-YYYY HH:MM[:SS]" (normalizeDateTimeCell's output, Lisbon wall-clock)
// -> epoch ms, or null.
function dmyhmEpoch(s: string): number | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return lisbonEpoch(`${m[3]}-${m[2]}-${m[1]}`, +m[4] * 60 + +m[5]) + (m[6] ? +m[6] * 1000 : 0);
}

type StoreGroup = {
  key: string;
  rota: string;
  code: string;
  designacao: string;
  plate: string | null;
  planIni: string;
  planFim: string;
  rawCiclo: string;
  /** [lo, hi) epoch-ms a real stop for this group may fall in (day-aware) */
  winLoMs: number;
  winHiMs: number;
  /** latest departure for a stop that arrived in [winLoMs, winHiMs) */
  winDepHiMs: number;
  order: number; // first row index, for sheet order
  /** Plano de Cargas: hora prevista de chegada (1.ª linha) e paletes (máx.) */
  planArrMs: number | null;
  carga: number;
  rows: Work[];
  assignedStop: WStop | null;
  conf: Work["conf"];
  /** bounds on the stop's ARRIVAL from the route's kept delivery rows */
  anchorLoMs: number;
  anchorHiMs: number;
  /** first / last row of its route (carga / regresso) */
  isHead: boolean;
  isTail: boolean;
};

const PLAN_WINDOW_MS = 4 * 3_600_000;
// coluna de saída com as horas reais do relatório do armazém (só quando vem)
export const ARMAZEM_COL = "Armazém";
// Relatório do armazém: a visita GPS escolhida tem de tocar na hora real da
// carga com esta folga (relógios / cais registado uns minutos depois).
const WH_PAD_MS = 30 * 60_000;
function whRealWindow(code: string, l: WarehouseLine): { lo: number; hi: number; a: number; b: number } | null {
  const is7003 = /^7003/.test(code);
  const a = is7003 ? (l.portaInMs ?? l.iniMs) : l.iniMs;
  if (a == null) return null;
  const b = (is7003 ? (l.portaOutMs ?? l.fimMs) : l.fimMs) ?? a;
  return { lo: a - WH_PAD_MS, hi: b + WH_PAD_MS, a, b };
}
// Kept (hand-filled) delivery rows are order anchors for the rest of their
// route: a row listed after one can't take a stop that arrived before it, and
// vice versa. Slack for clock rounding / a stop recorded a bit early.
const ANCHOR_SLACK_MS = 10 * 60_000;
// A kept row claims the GPS stops at its own code that overlap its interval
// (± this pad) so no other row re-uses the same physical visit.
const KEPT_CLAIM_PAD_MS = 5 * 60_000;

// Espera pelo cais (análise 07-11/16-11-2026). Dentro do pátio da Azambuja o
// camião passa no portão (pino 7001), espera na zona a norte do 7001 (sem
// local) e só depois encosta à doca. A Chegada de uma carga é a ENTRADA no
// pátio: anda-se para trás a partir da paragem da doca enquanto as paragens
// anteriores forem do pátio e estiverem a ≤ YARD_CHAIN_GAP_MIN umas das outras.
const YARD_CHAIN_GAP_MIN = 20;
// paragem sem local "no pátio" = a esta distância de um pino do pátio
const YARD_NEAR_KM = 0.4;
// chegada com mais do que isto de antecedência sobre a hora planeada -> Rever
const EARLY_ARRIVAL_REVIEW_MIN = 60;
// ...e só se a espera ANTES da hora planeada passar disto
const EARLY_WAIT_REVIEW_MIN = 30;
// sem plano, espera acima disto -> Rever
const LONG_WAIT_REVIEW_MIN = 120;
// Zonas do pátio sem local na base que NÃO são espera — interrompem a cadeia
// até serem criadas como locais (passam então a ter código próprio):
//   parque: estacionamento/pernoita a sul (mediana 3h45, até 16h)
// (as docas SO do 7001 já são locais: 7001-SON / 7001-SOS, migração 0044)
const YARD_NON_WAIT_ZONES: ReadonlyArray<{ lat: number; lng: number; km: number }> = [
  { lat: 39.041782, lng: -8.920121, km: 0.045 },
];
// A stop with no location code counts as part of a gate touch's visit only if
// it is this close to the row's own pin AND nearer to it than to any other
// location (7001/7005/7003 are independent — never borrow a neighbour's dock).
const UNCODED_NEAR_KM = 0.35;
// Duração típica das cargas no pátio (relatório do armazém 05-11 e 29-09:
// 7001 mediana 37–48 min, 7005 17–24 min) e folga para "estadia longa".
const LOAD_MIN_7001 = 45;
const LOAD_MIN_7005 = 20;
const LONG_STAY_EXTRA_MIN = 60;
// 7001 + 7005 numa só visita: parte do 7005 (relatório 05-11: 7001 ≈ 58%).
const SHARE_7005 = 0.42;
// a 7001 GPS piece after the 7005 dock counts as the 7001 load (GPS split) only
// from this long — shorter is the exit touch (18-11 47-LF-63: 7005 03:00–04:45,
// 7001 04:50–04:55; real 7005 03:50, 7001 04:01–04:25 at the 7005 docks)
const GPS_SPLIT_7001_MIN = 10;
// paragens seguidas na zona 7001/7005 com intervalos até isto = uma visita
const YARD_VISIT_GAP_MIN = 20; // = YARD_CHAIN_GAP_MIN (espera)
// Docas 54-59 (pino 7005) servem também o 7001 (relatório do armazém 05-11/
// 29-09): a linha 7001 aceita uma paragem no 7005 (pontua abaixo do código
// exato). O contrário não: o 7005 só carrega nas docas 54-59.
// 7005 carrega nas docas 54-59, que o GPS também regista como 7001-SON/SOS
// (relatório 05-11: 25× 7005, 10× SON, 3× SOS) — nunca no pino 7001 (leste).
const servesDocks7005 = (s: DayStop & { parts?: { code: string | null }[] }): boolean =>
  /^7001-SO[NS]$/i.test(s.code ?? "") || !!s.parts?.some((p) => /^(7005|7001-SO[NS])$/i.test(p.code ?? ""));
const sharedDockAlt = (code: string): readonly string[] =>
  /^7001/.test(code) ? ["7005"] : yardAcceptedCodes(code);
// Regresso: primeira chegada ao pátio (até REGRESSO_YARD_KM do pino 7001, inclui
// 7003 e o parque) nas REGRESSO_MAX_H horas a seguir à última entrega.
const REGRESSO_YARD_KM = 0.6;
const REGRESSO_MAX_H = 8;
// Linha do pátio com estadia maior que isto (viatura parada) → Rever.
const YARD_LONG_REVIEW_H = 6;
const REGRESSO_DEFAULT_MIN = 15;
const REGRESSO_PARKED_EXTRA_MIN = 45;
const UNCODED_CHAIN_GAP_MIN = 15;

// One physical visit to the 7001/7005 area = the run
// of consecutive stops there (gate touch + dock + uncoded stops beside the
// docks) with gaps <= gapMin. 7003 is a separate site and is never merged.
function mergeYardVisits<T extends DayStop & { assigned: boolean }>(
  stops: T[],
  codeCoords: ReadonlyMap<string, { lat: number; lng: number }>,
  gapMin: number,
): T[] {
  const p7001 = codeCoords.get("7001");
  const p7005 = codeCoords.get("7005");
  const p7003 = codeCoords.get("7003");
  const inArea = (s: T) => {
    if (s.code) return /^700[15]/.test(s.code);
    if (s.lat == null || s.lng == null || !p7001 || !p7005) return false;
    if (YARD_NON_WAIT_ZONES.some((z) => haversineKm(s.lat!, s.lng!, z.lat, z.lng) <= z.km)) return false;
    const d = Math.min(haversineKm(s.lat, s.lng, p7001.lat, p7001.lng), haversineKm(s.lat, s.lng, p7005.lat, p7005.lng));
    const d3 = p7003 ? haversineKm(s.lat, s.lng, p7003.lat, p7003.lng) : Infinity;
    return d <= UNCODED_NEAR_KM && d < d3;
  };
  const dur = (s: T) => (s.departedAt ? Date.parse(s.departedAt) : Date.parse(s.arrivedAt)) - Date.parse(s.arrivedAt);
  const byPlate = new Map<string, T[]>();
  const out: T[] = [];
  for (const s of stops) {
    if (!s.plate) out.push(s);
    else (byPlate.get(s.plate) ?? byPlate.set(s.plate, []).get(s.plate)!).push(s);
  }
  for (const list of byPlate.values()) {
    list.sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
    let run: T[] = [];
    const flush = () => {
      if (run.length === 0) return;
      if (run.length === 1) out.push(run[0]);
      else {
        const longest = [...run].sort((a, b) => dur(b) - dur(a))[0];
        const coded = [...run].filter((s) => s.code).sort((a, b) => dur(b) - dur(a))[0];
        const end = Math.max(...run.map((s) => Date.parse(s.departedAt ?? s.arrivedAt)));
        out.push({
          ...longest,
          code: longest.code ?? coded?.code ?? "7001",
          arrivedAt: run[0].arrivedAt,
          departedAt: new Date(end).toISOString(),
          parts: run.map((x) => ({ code: x.code, a: Date.parse(x.arrivedAt), d: Date.parse(x.departedAt ?? x.arrivedAt) })),
        });
      }
      run = [];
    };
    for (const s of list) {
      if (!inArea(s)) {
        flush();
        out.push(s);
        continue;
      }
      const last = run[run.length - 1];
      if (last) {
        const lastEnd = Math.max(...run.map((x) => Date.parse(x.departedAt ?? x.arrivedAt)));
        if ((Date.parse(s.arrivedAt) - lastEnd) / 60000 > gapMin) flush();
      }
      run.push(s);
    }
    flush();
  }
  return out;
}

export function runMatch(args: RunMatchArgs): RunMatchResult {
  const { day, records, rawRecords, header, cols, platesWithGps } = args;
  const pingWindowByPlate = args.pingWindowByPlate ?? new Map();
  const activeCodes = args.activeCodes ?? [];
  const mergedCodes = args.mergedCodes ?? [];
  const coLocatedGroups = args.coLocatedGroups ?? [];
  const codeTypes = args.codeTypes ?? new Map<string, string>();
  const codeCoords = args.codeCoords ?? new Map<string, { lat: number; lng: number }>();
  const sheetCodes = new Set(
    records.map((r) => normalizeStoreCode(r[cols.codeCol]).toUpperCase()).filter(Boolean),
  );
  // Re-stitch detect_stops fragments (same vehicle, same location, small gap)
  // into one effective stop BEFORE any candidate selection below — see
  // mergeFragmentedStops in common.ts for why.
  let stops: WStop[] = mergeFragmentedStops(args.stops).map((s) => ({
    ...s,
    assigned: false,
  }));
  stops = mergeYardVisits(stops, codeCoords, YARD_VISIT_GAP_MIN);

  // Candidate pool for the plate-typo check: plates with real GPS stops today.
  const platesWithDayStops = new Set<string>();
  for (const s of stops) if (s.plate) platesWithDayStops.add(s.plate);

  const diaCol = cols.diaCol ?? DIA_COL;
  const centroCustoColOut = cols.centroCustoCol ?? "Centro Custo";
  const nDedicadoColOut = cols.nDedicadoCol ?? "N_Dedicado";
  const outHeader = [...header];
  for (const c of [diaCol, cols.chegadaCol, cols.saidaCol, CONFIANCA_COL, REAL_COL]) {
    if (!outHeader.includes(c)) outHeader.push(c);
  }
  if (args.warehouse && args.warehouse.length > 0 && !outHeader.includes(ARMAZEM_COL)) outHeader.push(ARMAZEM_COL);
  if (cols.viaturaPlaneadoCol) {
    for (const c of [centroCustoColOut, nDedicadoColOut]) {
      if (!outHeader.includes(c)) outHeader.push(c);
    }
  }

  const works: Work[] = records.map((r, idx) => {
    const rota = String(r[cols.rotaCol] ?? "").trim();
    const rawCode = normalizeStoreCode(r[cols.codeCol]);
    const code = resolveMergedCode(rawCode, activeCodes, mergedCodes, coLocatedGroups);
    const designacao = cols.nomeCol
      ? String(r[cols.nomeCol] ?? "").trim()
      : "";
    const rawPlate = String(r[cols.plateCol] ?? "").trim();
    const empty = !rota && !code && !rawPlate && !designacao;

    const npRaw = normalizePlate(rawPlate);
    const plate =
      npRaw && rawPlate.toLowerCase() !== "n/a" && npRaw.length >= 4
        ? npRaw
        : null;

    const rawCiclo = cols.cicloCol ? String(r[cols.cicloCol] ?? "").trim() : "";
    const ciclo = parseCiclo(rawCiclo);

    // Row already carries BOTH times in the uploaded file -> resolved elsewhere;
    // keep it verbatim and skip grouping + every matching step.
    const rawChegada = String(r[cols.chegadaCol] ?? "").trim();
    const rawSaida = String(r[cols.saidaCol] ?? "").trim();
    const bothFilled = !empty && rawChegada !== "" && rawSaida !== "";
    // A same-value (or reversed) Chegada/Saída is never a real visit — our own
    // GPS-derived stops never close in zero minutes (fleet-wide audit,
    // 2026-09) — so that shape is almost certainly the transporter's planning
    // system pre-filling both cells with a placeholder for a store that
    // hasn't actually been delivered yet. Treat it as NOT kept: fall through
    // to normal matching against our real stops, same as a blank row.
    //
    // durMin/implausibleReason: see classifyKeptDuration (common.ts) — FAIL
    // CLOSED. A duration we can't even calculate (null) is treated as
    // implausible, not plausible — the inverse of the original fa26052 rule,
    // which trusted a null duration by default and is how BG-75-IP's
    // 21-09-2026 burst (452/446/447/454/453/455 — a real, distinct delivery
    // each, ~08:34-13:29) got written back as a fake same-minute "mantido".
    const chegadaRaw = rawRecords?.[idx]?.[cols.chegadaCol];
    const saidaRaw = rawRecords?.[idx]?.[cols.saidaCol];
    const durMin = bothFilled
      ? minutesBetweenKeptCells(rawChegada, rawSaida, chegadaRaw, saidaRaw, day)
      : null;
    const implausibleReason: ImplausibleKeptReason | null = bothFilled
      ? classifyKeptDuration(durMin, codeTypes.get(code) ?? null)
      : null;
    const implausible = implausibleReason != null;
    const kept = bothFilled && !implausible;
    const placeholderNote = implausibleReason
      ? implausibleKeptNote(rawChegada, rawSaida, implausibleReason, durMin)
      : "";

    const out: SheetRecord = { ...r };
    if (cols.viaturaPlaneadoCol) {
      const rawViatura = String(r[cols.viaturaPlaneadoCol] ?? "").trim();
      if (rawViatura) {
        const { k, l } = classifyViaturaPlaneada(rawViatura);
        out[centroCustoColOut] = k;
        out[nDedicadoColOut] = l;
      }
    }

    return {
      idx,
      out,
      empty,
      kept,
      rota,
      code,
      designacao,
      rawPlate,
      plate,
      planIni: ciclo.ini,
      planFim: ciclo.fim,
      rawCiclo,
      groupKey: `${rota} ${codeKey(code, coLocatedGroups)}`,
      planArrMs: null,
      planDepMs: null,
      carga: 0,
      conf: kept ? KEPT : "",
      real: "",
      placeholderNote,
      swapPlate: null,
      assignedStop: null,
      keptArrMs: kept ? dmyhmEpoch(normalizeDateTimeCell(rawChegada, chegadaRaw, day)) : null,
      keptDepMs: kept ? dmyhmEpoch(normalizeDateTimeCell(rawSaida, saidaRaw, day)) : null,
      wh: null,
    };
  });

  // Plano de Cargas -> each sheet row: same ROTA, same code, in SEQ order
  // (n-th row of code X in the route <-> n-th plan line of code X).
  let planMatched = 0;
  if (args.plan && args.plan.length > 0) {
    const byRota = new Map<string, PlanLine[]>();
    for (const pl of args.plan) {
      const arr = byRota.get(pl.rota) ?? [];
      arr.push(pl);
      byRota.set(pl.rota, arr);
    }
    for (const arr of byRota.values()) arr.sort((a, b) => a.seq - b.seq);
    const used = new Set<PlanLine>();
    for (const w of works) {
      if (w.empty || !w.rota || !w.code) continue;
      const pl = (byRota.get(w.rota) ?? []).find(
        (x) => !used.has(x) && normalizeStoreCode(x.code).toUpperCase() === w.code.toUpperCase(),
      );
      if (!pl) continue;
      used.add(pl);
      w.planArrMs = pl.arrMs;
      w.planDepMs = pl.depMs;
      w.carga = pl.tipo === "C" ? pl.carga : 0;
      planMatched++;
    }
  }

  // Relatório diário do armazém -> each sheet row: same ROTA, same code, in
  // SEQ order (as the plan above). Only informs: real plate per route, which
  // GPS visit holds the real load, and the «Armazém» comparison column.
  const warehouse = args.warehouse && args.warehouse.length > 0 ? args.warehouse : null;
  const whPlateByRota = new Map<string, string>();
  let whLinked = 0;
  if (warehouse) {
    const byRota = new Map<string, WarehouseLine[]>();
    for (const l of warehouse) (byRota.get(l.rota) ?? byRota.set(l.rota, []).get(l.rota)!).push(l);
    for (const [rota, arr] of byRota) {
      arr.sort((a, b) => a.seq - b.seq);
      const tally = new Map<string, number>();
      for (const l of arr) if (l.plate) tally.set(l.plate, (tally.get(l.plate) ?? 0) + 1);
      const best = [...tally].sort((a, b) => b[1] - a[1])[0];
      if (best) whPlateByRota.set(rota, best[0]);
    }
    const used = new Set<WarehouseLine>();
    for (const w of works) {
      if (w.empty || !w.rota || !w.code) continue;
      const l = (byRota.get(w.rota) ?? []).find(
        (x) => !used.has(x) && normalizeStoreCode(x.code).toUpperCase() === w.code.toUpperCase(),
      );
      if (!l) continue;
      used.add(l);
      w.wh = l;
      whLinked++;
    }
  }

  // A store-group is a run of CONSECUTIVE rows with the same (ROTA, code): a
  // C + D pair listed back to back is one physical visit. The same code
  // appearing again later in the route (carga 7001 … regresso 7001) is a
  // DIFFERENT visit and gets its own group (before 2026-11 both 7001 rows of
  // a route shared one group and were filled from the same/earliest stops).
  {
    let prevKey = "";
    let run = 0;
    for (const w of works) {
      if (w.empty) continue;
      const k = `${w.rota} ${codeKey(w.code, coLocatedGroups)}`;
      if (k !== prevKey) run++;
      prevKey = k;
      w.groupKey = `${k} #${run}`;
    }
  }

  // ----- build (ROTA, N_LOJA) store-groups, in sheet order -----
  // "kept" rows (both times already filled on input) are left out of grouping
  // entirely — no stop is claimed for them, no swap/typo logic touches them.
  const groupMap = new Map<string, StoreGroup>();
  for (const w of works) {
    if (w.empty || w.kept) continue;
    let g = groupMap.get(w.groupKey);
    if (!g) {
      g = {
        key: w.groupKey,
        rota: w.rota,
        code: w.code,
        designacao: w.designacao,
        plate: w.plate,
        planIni: w.planIni,
        planFim: w.planFim,
        rawCiclo: w.rawCiclo,
        winLoMs: 0,
        winHiMs: 0,
        winDepHiMs: 0,
        order: w.idx,
        planArrMs: w.planArrMs,
        carga: 0,
        rows: [],
        assignedStop: null,
        conf: "",
        anchorLoMs: -Infinity,
        anchorHiMs: Infinity,
        isHead: false,
        isTail: false,
      };
      groupMap.set(w.groupKey, g);
    }
    g.rows.push(w);
    if (w.carga > g.carga) g.carga = w.carga;
    if (g.planArrMs == null && w.planArrMs != null) g.planArrMs = w.planArrMs;
    // a later row in the group may carry the plate/ciclo the first one lacked
    if (!g.plate && w.plate) g.plate = w.plate;
    if (!g.planIni && w.planIni) g.planIni = w.planIni;
    if (!g.planFim && w.planFim) g.planFim = w.planFim;
    if (!g.rawCiclo && w.rawCiclo) g.rawCiclo = w.rawCiclo;
    if (!g.designacao && w.designacao) g.designacao = w.designacao;
  }
  const groups = [...groupMap.values()];

  // Day-aware stop window per group: strict service day for same-day / free-text
  // CICLOs; only an explicit "…-1" / "…+1" reaches a neighbouring calendar day.
  for (const g of groups) {
    const { loMs, hiMs, depHiMs } = groupWindowMs(day, g.rawCiclo);
    g.winLoMs = loMs;
    g.winHiMs = hiMs;
    g.winDepHiMs = depHiMs;
    // With a planned time, the plan decides the window (± 4h), not the CICLO:
    // 07-11 "01:00 | 13:00" routes were planned to load at 22:47 the evening
    // before — outside the CICLO's same-day window, so every row went "Rever".
    if (g.planArrMs != null) {
      g.winLoMs = g.planArrMs - PLAN_WINDOW_MS;
      g.winHiMs = g.planArrMs + PLAN_WINDOW_MS;
      g.winDepHiMs = g.winHiMs + PLAN_WINDOW_MS;
    }
  }

  // Order anchors (ficheiro 16-11-2026: 36 linhas do pátio fora de ordem). The
  // sequence DP below only orders the rows it matches itself; a hand-filled
  // (kept) delivery was invisible to it, so a route whose deliveries were all
  // kept had its "regresso 7001" take the earliest free yard stop — usually
  // the carga, hours BEFORE the deliveries (186376999: regresso 05:10, entrega
  // 11:37). Only deliveries/pick-ups anchor (not armazém/CD rows): the yard
  // rows 7005/7001/7003 are loaded in any order, whatever the sheet lists.
  const isYardType = (code: string) => {
    const t = codeTypes.get(code);
    return t === "armazem" || t === "centro_distribuicao";
  };
  // per route, the sheet index of its first non-yard row (kept or not) — the
  // carga block is every yard row before it
  const firstNonYardIdx = new Map<string, number>();
  for (const w of works) {
    if (w.empty || !w.rota || !w.code || isYardType(w.code)) continue;
    if (!firstNonYardIdx.has(w.rota)) firstNonYardIdx.set(w.rota, w.idx);
  }
  {
    const anchors = new Map<string, { idx: number; arr: number; dep: number }[]>();
    const rowsByRota = new Map<string, number[]>();
    for (const w of works) {
      if (w.empty || !w.rota) continue;
      const ix = rowsByRota.get(w.rota) ?? [];
      ix.push(w.idx);
      rowsByRota.set(w.rota, ix);
      if (!w.kept || w.keptArrMs == null || !w.code || isYardType(w.code)) continue;
      const arr = anchors.get(w.rota) ?? [];
      arr.push({ idx: w.idx, arr: w.keptArrMs, dep: w.keptDepMs ?? w.keptArrMs });
      anchors.set(w.rota, arr);
    }
    for (const g of groups) {
      const firstIdx = g.rows[0].idx;
      const lastIdx = g.rows[g.rows.length - 1].idx;
      const ix = rowsByRota.get(g.rota) ?? [];
      g.isHead = ix.length > 0 && firstIdx === ix[0];
      g.isTail = ix.length > 0 && lastIdx === ix[ix.length - 1];
      // only yard rows (carga/regresso) are bounded: deliveries are sometimes
      // listed out of time order (16-11 186376933: 433 11:50 antes de 411 11:03)
      if (!isYardType(g.code)) continue;
      for (const a of anchors.get(g.rota) ?? []) {
        if (a.idx < firstIdx) g.anchorLoMs = Math.max(g.anchorLoMs, a.dep - ANCHOR_SLACK_MS);
        else if (a.idx > lastIdx) g.anchorHiMs = Math.min(g.anchorHiMs, a.arr + ANCHOR_SLACK_MS);
      }
    }
  }

  // ----- group store-groups by ROTA, and let a plate-less group inherit its
  // route's plate (the sheet carries one MATRICULA per route) -----
  const routeMap = new Map<string, StoreGroup[]>();
  for (const g of groups) {
    const arr = routeMap.get(g.rota);
    if (arr) arr.push(g);
    else routeMap.set(g.rota, [g]);
  }
  for (const routeGroups of routeMap.values()) {
    const routePlate = routeGroups.find((g) => g.plate)?.plate ?? null;
    if (routePlate) for (const g of routeGroups) if (!g.plate) g.plate = routePlate;
  }

  // ----- Matrícula real do relatório do armazém -----
  // The warehouse writes down the truck that actually loaded (18-11: ~10% of
  // routes differ from the sheet's MATRICULA, e.g. 03-QA-37 → 03-QA-31). When
  // that truck is one of ours, the whole route follows it.
  const whPlateFixes = new Map<string, { from: string | null; to: string }>();
  {
    const platesWithStops = new Set<string>();
    for (const s of stops) if (s.plate) platesWithStops.add(s.plate);
    for (const [rota, rg] of routeMap) {
      const real = whPlateByRota.get(rota);
      const planned = rg.find((g) => g.plate)?.plate ?? null;
      if (!real || real === planned || !platesWithStops.has(real)) continue;
      whPlateFixes.set(rota, { from: planned, to: real });
      for (const g of rg) g.plate = real;
    }
  }

  // ----- Troca de viatura ao nível da rota -----
  // The planned truck has NO stop at any of the route's delivery stores in
  // their windows, while exactly one other truck visited most of them: that
  // truck did the route (relatório 29-09: 17/103 rotas com outra matrícula).
  // The yard rows then follow it too — a per-store swap can never resolve
  // 7001/7005/7003, where dozens of trucks stop every night.
  const routeSwaps = new Map<string, { from: string; to: string; n: number; of: number }>();
  {
    const platesStops = new Map<string, WStop[]>();
    for (const s of stops) if (s.plate) (platesStops.get(s.plate) ?? platesStops.set(s.plate, []).get(s.plate)!).push(s);
    type Del = { code: string; lo: number; hi: number; depHi: number };
    const delsOf = (rota: string): Del[] => {
      const out: Del[] = [];
      for (const w of works) {
        if (w.rota !== rota || w.empty || !w.code || isYardType(w.code)) continue;
        if (w.kept && w.keptArrMs != null) {
          const pad = 30 * 60_000;
          out.push({ code: w.code, lo: w.keptArrMs - pad, hi: (w.keptDepMs ?? w.keptArrMs) + pad, depHi: (w.keptDepMs ?? w.keptArrMs) + pad });
        } else {
          const g = groupMap.get(w.groupKey);
          if (g) out.push({ code: w.code, lo: g.winLoMs, hi: g.winHiMs, depHi: g.winDepHiMs });
        }
      }
      return out;
    };
    const hits = (plate: string, dels: Del[]) => {
      const ss = platesStops.get(plate) ?? [];
      return new Set(
        dels
          .filter((d) => ss.some((s) => codeEq(s.code, d.code, coLocatedGroups) && stopInWindow(s.arrivedAt, s.departedAt, d.lo, d.hi, d.depHi)))
          .map((d) => d.code),
      ).size;
    };
    const span = (dels: Del[]) => [Math.min(...dels.map((d) => d.lo)), Math.max(...dels.map((d) => d.hi))];
    const plannedOf = new Map<string, string>();
    for (const [rota, rg] of routeMap) {
      const p = rg.find((g) => g.plate)?.plate;
      if (p) plannedOf.set(rota, p);
    }
    for (const [rota, rg] of routeMap) {
      const P = plannedOf.get(rota);
      const dels = delsOf(rota);
      const nCodes = new Set(dels.map((d) => d.code)).size;
      // only a truck of ours that did something else that day; an unknown
      // plate is a typo case (findPlateTypo, Step 3)
      if (!P || whPlateFixes.has(rota) || whPlateByRota.has(rota) || nCodes === 0 || !platesWithGps.has(P) || hits(P, dels) > 0) continue;
      let best: string | null = null;
      let bestN = 0;
      let tie = false;
      for (const Q of platesStops.keys()) {
        if (Q === P) continue;
        const n = hits(Q, dels);
        if (n > bestN) [best, bestN, tie] = [Q, n, false];
        else if (n === bestN && n > 0) tie = true;
      }
      if (!best || tie || bestN < Math.max(1, Math.ceil(nCodes / 2))) continue;
      // the other truck isn't busy with a route of its own at the same time
      const [lo, hi] = span(dels);
      const busy = [...plannedOf].some(([r2, p2]) => {
        if (r2 === rota || p2 !== best) return false;
        const d2 = delsOf(r2);
        if (d2.length === 0) return false;
        const [lo2, hi2] = span(d2);
        return lo2 <= hi && hi2 >= lo && hits(best!, d2) > 0;
      });
      if (busy) continue;
      routeSwaps.set(rota, { from: P, to: best, n: bestN, of: nCodes });
      for (const g of rg) g.plate = best;
    }
  }

  const stopsForPlate = (plate: string) =>
    stops
      .filter((s) => s.plate === plate)
      .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));

  const describeReal = (plate: string | null): string => {
    if (!plate) return "";
    const ss = stopsForPlate(plate);
    if (ss.length === 0)
      return `Sem paragens nossas para ${plate} em ${day}.`;
    return ss
      .map(
        (s) =>
          `${s.code ?? "?"} ${fmtHM(s.arrivedAt)}–${fmtHM(s.departedAt) || "?"}`,
      )
      .join("; ");
  };

  const setGroup = (
    g: StoreGroup,
    conf: Work["conf"],
    stop: WStop | null,
    real: string,
    swapPlate: string | null = null,
  ) => {
    g.conf = conf;
    g.assignedStop = stop;
    for (const w of g.rows) {
      w.conf = conf;
      w.assignedStop = stop;
      w.real = real;
      w.swapPlate = swapPlate;
    }
  };

  // ----- Step 1/2: match each store-group to a stop BY STORE CODE, per PLATE -----
  //
  // A plate is one physical vehicle. Its real GPS stops for the day include
  // depot/workshop stops that aren't on the sheet — those are simply left
  // over. The store-groups are aligned to the stops IN ORDER (see below).
  const byPlate = new Map<string, StoreGroup[]>();
  for (const g of groups) {
    if (!g.plate) {
      setGroup(g, REVIEW, null, "Rota sem matrícula na folha.");
      continue;
    }
    const arr = byPlate.get(g.plate);
    if (arr) arr.push(g);
    else byPlate.set(g.plate, [g]);
  }

  // Sequence-aware assignment (2026-11, ficheiro 07-11-2026). The old pass
  // took, per store-group, the EARLIEST unassigned stop at that code — order
  // ignored. On a plate running 2+ routes that let a route's final "regresso
  // 7001" grab a yard stop from BEFORE the route even started (e.g. 186315796:
  // regresso planeado 11:08, preenchido 06-11 17:30), and since the regresso
  // of route N and the carga of route N+1 are usually ONE physical yard visit,
  // every later 7001 row on that plate slid by one stop (91 linhas fora de
  // ordem nesse dia).
  //
  // Now, per plate, routes are taken in sheet order and each route's
  // store-groups are aligned to the plate's stops IN TIME ORDER (the sheet
  // lists a route's stores in SEQ order — 125/127 rotas no 07-11, the other
  // two only tie on SEQ). A small DP per route: maximise matched groups; exact
  // code beats the yard's accepted alternative (YARD_ACCEPTS); among equal
  // solutions the earliest compatible stop wins. A stop may be shared ONCE:
  //   • by two consecutive groups of the same route (7005+7001 west dock, a
  //     co-located pair), or
  //   • by a route's FIRST group and the previous route's LAST group on the
  //     same plate, exact same code only (regresso → carga seguinte). Different
  //     routes never share through the yard alternative (bug 201/Vialonga).
  // Kept rows claim their physical visit (16-11: 186377185 regresso 7001 got
  // 00:15–00:40, the very stop the operator had already written as that
  // route's own carga 00:17–00:42). A claimed stop stays available ONLY to the
  // carga/regresso of ANOTHER route at the exact same code — the one legitimate
  // sharing (regresso de uma rota = carga da seguinte, mesma paragem).
  const keptClaim = new Map<WStop, string>();
  for (const w of works) {
    if (!w.kept || !w.plate || !w.code || w.keptArrMs == null) continue;
    const lo = w.keptArrMs - KEPT_CLAIM_PAD_MS;
    const hi = (w.keptDepMs ?? w.keptArrMs) + KEPT_CLAIM_PAD_MS;
    for (const s of stops) {
      if (s.plate !== w.plate || s.assigned || keptClaim.has(s)) continue;
      if (!codeEq(s.code, w.code, coLocatedGroups)) continue;
      const a = Date.parse(s.arrivedAt);
      const d = s.departedAt ? Date.parse(s.departedAt) : a;
      if (a <= hi && d >= lo) keptClaim.set(s, w.rota);
    }
  }

  // Relatório do armazém: the real yard time of a group (7001/7005 = carga no
  // cais; 7003 = portaria, else cais), padded — see WH_PAD_MS.
  const whWindow = (g: StoreGroup): { lo: number; hi: number } | null => {
    if (!/^700[135]/.test(g.code)) return null;
    const l = g.rows.find((w) => w.wh)?.wh;
    return l ? whRealWindow(g.code, l) : null;
  };
  const visitOverlaps = (s: WStop, ww: { lo: number; hi: number }) => {
    const a = Date.parse(s.arrivedAt);
    const d = Date.parse(s.departedAt ?? s.arrivedAt);
    return a <= ww.hi && d >= ww.lo;
  };
  /** the stop may serve the group as far as the warehouse time goes */
  const whOk = (g: StoreGroup, s: WStop) => {
    const ww = whWindow(g);
    return !ww || visitOverlaps(s, ww);
  };
  /** minutes between the real start (portaria/cais) and the stop; 0 = inside */
  const whDevMin = (g: StoreGroup, s: WStop): number | null => {
    const l = /^700[135]/.test(g.code) ? g.rows.find((w) => w.wh)?.wh : null;
    const win = l ? whRealWindow(g.code, l) : null;
    if (!win) return null;
    const a = Date.parse(s.arrivedAt);
    const d = Date.parse(s.departedAt ?? s.arrivedAt);
    return win.a >= a && win.a <= d ? 0 : Math.min(Math.abs(win.a - a), Math.abs(win.a - d)) / 60_000;
  };

  // Carga (yard row before the route's first delivery) of a route whose window
  // starts at the service day (same-day/free-text CICLO): the truck often
  // starts loading before midnight — a yard visit that ARRIVED up to
  // CARGA_LOOKBACK_MS before the window and is still there at its start counts
  // (18-11: 02:00|14:00 AN-38-VF 7005 23:10, 01:00|13:00 BC-88-TC visit from
  // 22:40, Partenariados BB-17-GA 23:10 — all blank before).
  const cargaOverlapsStart = (g: StoreGroup, s: WStop): boolean => {
    if (!isYardType(g.code) || !(g.order < (firstNonYardIdx.get(g.rota) ?? Infinity))) return false;
    const a = Date.parse(s.arrivedAt);
    const d = Date.parse(s.departedAt ?? s.arrivedAt);
    return a < g.winLoMs && a >= g.winLoMs - CARGA_LOOKBACK_MS && d > g.winLoMs && d < g.winDepHiMs;
  };

  const SCORE_EXACT = 1000;
  const SCORE_YARD_ALT = 990;
  const SCORE_SHARED = 980;
  // Plano de Cargas (quando vem no upload):
  //  • uma paragem a mais de PLAN_MAX_DEV_MIN da hora prevista não serve;
  //  • entre paragens possíveis, ganha a mais próxima da hora prevista;
  //  • uma CARGA (paletes > 0) prefere uma paragem com permanência; se só
  //    houver um toque (< MIN_LOAD_DWELL_MIN) a linha vai para "Rever".
  const PLAN_MAX_DEV_MIN = 240;
  const MIN_LOAD_DWELL_MIN = 5;
  const SCORE_TOUCH_PENALTY = 100;
  const SCORE_STORE_BONUS = 50;
  const dwellMin = (s: WStop) =>
    s.departedAt ? (Date.parse(s.departedAt) - Date.parse(s.arrivedAt)) / 60000 : Infinity;
  const planDevMin = (g: StoreGroup, s: WStop) =>
    g.planArrMs == null ? null : Math.abs(Date.parse(s.arrivedAt) - g.planArrMs) / 60000;

  for (const [plate, plateGroups] of byPlate) {
    plateGroups.sort((a, b) => a.order - b.order);
    const plateStops = stops
      .filter((s) => s.plate === plate)
      .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
    const m = plateStops.length;
    const sharedOnce = new Set<WStop>();

    const routeOrder: string[] = [];
    const routeGroups = new Map<string, StoreGroup[]>();
    for (const g of plateGroups) {
      if (!g.code) {
        setGroup(g, REVIEW, null, describeReal(plate));
        continue;
      }
      let arr = routeGroups.get(g.rota);
      if (!arr) {
        routeGroups.set(g.rota, (arr = []));
        routeOrder.push(g.rota);
      }
      arr.push(g);
    }
    if (m === 0) continue;

    // Routes of one plate in TIME order where the sheet tells us the time (a
    // kept row, or the plan), not sheet order: 16-11 50-JG-95 lists 186377850
    // (cargas 08:14) before 186377945 (cargas 02:39), so 850's blank 7005 took
    // 945's 02:50 visit. Untimed routes keep their sheet position.
    {
      const timeOf = (rota: string): number | null => {
        let t: number | null = null;
        for (const w of works) {
          if (w.rota !== rota || w.plate !== plate) continue;
          const x = w.keptArrMs ?? w.planArrMs;
          if (x != null && (t == null || x < t)) t = x;
        }
        return t;
      };
      const times = new Map(routeOrder.map((r) => [r, timeOf(r)]));
      const timed = routeOrder.filter((r) => times.get(r) != null);
      const sorted = [...timed].sort((a, b) => times.get(a)! - times.get(b)!);
      let j = 0;
      for (let i = 0; i < routeOrder.length; i++) {
        if (times.get(routeOrder[i]) != null) routeOrder[i] = sorted[j++];
      }
      // A later route's yard rows can't take a stop from before the previous
      // route's last kept delivery (16-11 50-JG-95: 186377850's carga 7001 took
      // 02:34, before 186377945 — the earlier route — had even left).
      let floor = -Infinity;
      for (const rota of routeOrder) {
        for (const g of routeGroups.get(rota) ?? []) {
          if (isYardType(g.code)) g.anchorLoMs = Math.max(g.anchorLoMs, floor);
        }
        for (const w of works) {
          if (w.rota !== rota || w.plate !== plate || !w.kept || !w.code || isYardType(w.code)) continue;
          const t = w.keptDepMs ?? w.keptArrMs;
          if (t != null) floor = Math.max(floor, t - ANCHOR_SLACK_MS);
        }
      }
    }

    // last group of the previous route on this plate, and the stop it took
    let prevTail: { g: StoreGroup; stop: WStop } | null = null;

    for (const rota of routeOrder) {
      const G = routeGroups.get(rota)!;
      const n = G.length;

      // 0 = incompatible, else the base score of matching group i to stop k
      const compat: number[][] = G.map((g) => {
        const alt = sharedDockAlt(g.code);
        return plateStops.map((s) => {
          if (s.assigned) return 0;
          // with the warehouse's real time, the visit must contain it (± pad)
          // — it replaces the CICLO window, which the real loads often miss
          const ww = whWindow(g);
          if (ww) {
            if (!visitOverlaps(s, ww)) return 0;
          } else if (!stopInWindow(s.arrivedAt, s.departedAt, g.winLoMs, g.winHiMs, g.winDepHiMs) && !cargaOverlapsStart(g, s)) {
            return 0;
          }
          const arrMs = Date.parse(s.arrivedAt);
          if (arrMs < g.anchorLoMs || arrMs > g.anchorHiMs) return 0;
          const claimer = keptClaim.get(s);
          if (
            claimer != null &&
            !(claimer !== g.rota && (g.isHead || g.isTail) && codeEq(s.code, g.code, coLocatedGroups))
          ) {
            return 0;
          }
          const dev = planDevMin(g, s);
          if (dev != null && dev > PLAN_MAX_DEV_MIN) return 0;
          let base = 0;
          // a merged yard visit counts as exact when ANY of its parts has the
          // row's code (18-11 AD-49-DH: 7001 toque 02:25 + 7005 02:35–03:00
          // was labelled 7005, so the 7001 regresso skipped it for 03:15)
          const partsExact = (s as WStop & { parts?: { code: string | null }[] }).parts?.some((p) =>
            codeEq(p.code, g.code, coLocatedGroups),
          );
          if (codeEq(s.code, g.code, coLocatedGroups) || partsExact) base = SCORE_EXACT;
          else if (alt.some((c) => codeEq(s.code, c, coLocatedGroups))) base = SCORE_YARD_ALT;
          else if (/^7005/.test(g.code) && servesDocks7005(s)) base = SCORE_YARD_ALT;
          if (base > 0 && g.carga > 0 && dwellMin(s) < MIN_LOAD_DWELL_MIN) base -= SCORE_TOUCH_PENALTY;
          // with the same number of matches, a solution that places a STORE
          // wins over one that places one more yard row: the yard is visited
          // all the time, a store stop is unambiguous (18-11 39-XR-38: carga
          // 7001 took 17-11 18:20 + regresso 07:19 instead of 12 at 10:04 and
          // carga 07:19; real 07:17)
          if (base > 0 && !/^700[135]/.test(g.code) && !isYardType(g.code)) base += SCORE_STORE_BONUS;
          return base;
        });
      });
      // regresso → carga: the previous route's tail stop, if this route's
      // first group is the exact same code and it hasn't been shared yet
      let headShareK = -1;
      if (
        prevTail &&
        !sharedOnce.has(prevTail.stop) &&
        ((codeEq(prevTail.stop.code, G[0].code, coLocatedGroups) &&
          codeEq(prevTail.g.code, G[0].code, coLocatedGroups)) ||
          (
            // only a REGRESSO (after the route's deliveries) hands its visit
            // to the next route's carga — never a carga to another carga
            [...works].some((w) => w.rota === prevTail!.g.rota && w.code && !/^700[135]/.test(w.code) && !isYardType(w.code) && w.idx < prevTail!.g.order) &&
            /^700[15]/.test(prevTail.g.code) &&
            /^700[15]/.test(G[0].code) &&
            /^700[15]/.test(prevTail.stop.code ?? ""))) &&
        stopInWindow(prevTail.stop.arrivedAt, prevTail.stop.departedAt, G[0].winLoMs, G[0].winHiMs, G[0].winDepHiMs) &&
        whOk(G[0], prevTail.stop) &&
        Date.parse(prevTail.stop.arrivedAt) >= G[0].anchorLoMs &&
        Date.parse(prevTail.stop.arrivedAt) <= G[0].anchorHiMs
      ) {
        headShareK = plateStops.indexOf(prevTail.stop);
      }

      // dp state: (last used stop L ∈ -1..m-1, f = L may still be shared
      // by the next group of this route) -> index (L + 1) * 2 + f
      const W = (m + 1) * 2;
      type Back = { prev: number; kind: "skip" | "match" | "share" | "head"; k: number };
      let dp = new Array<number>(W).fill(-Infinity);
      dp[0] = 0;
      const backs: Back[][] = [];
      for (let i = 0; i < n; i++) {
        const nd = new Array<number>(W).fill(-Infinity);
        const nb: Back[] = new Array(W);
        const relax = (st: number, v: number, b: Back) => {
          if (v > nd[st]) {
            nd[st] = v;
            nb[st] = b;
          }
        };
        for (let st = 0; st < W; st++) {
          const v = dp[st];
          if (v === -Infinity) continue;
          const L = (st >> 1) - 1;
          const f = st & 1;
          // skipping a group ends the "may be shared" chance: only CONSECUTIVE
          // groups share a stop (18-11 51-JG-01: regresso shared the carga visit
          // across the skipped delivery 368 and both cargas went blank)
          relax(st & ~1, v, { prev: st, kind: "skip", k: -1 });
          if (f === 1 && L >= 0 && compat[i][L] > 0) {
            // L was taken by group i-1 on this path; share it once
            relax((L + 1) * 2, v + SCORE_SHARED, { prev: st, kind: "share", k: L });
          }
          if (i === 0 && L === -1 && headShareK >= 0) {
            relax((headShareK + 1) * 2, v + SCORE_SHARED, { prev: st, kind: "head", k: headShareK });
          }
          // tie-break (always < the 10-point gap between score tiers): with a
          // plan, closeness to the planned arrival; without, earliest stop
          let skipped = 0;
          for (let k = L + 1; k < m; k++) {
            const c = compat[i][k];
            if (c > 0) {
              const wd = whDevMin(G[i], plateStops[k]);
              const dev = planDevMin(G[i], plateStops[k]);
              const pen = wd != null ? Math.min(9, wd / 10) : dev != null ? Math.min(9, dev / 30) : skipped;
              relax((k + 1) * 2 + 1, v + c - pen, { prev: st, kind: "match", k });
              skipped++;
            }
          }
        }
        dp = nd;
        backs.push(nb);
      }
      let bestSt = 0;
      for (let st = 0; st < W; st++) if (dp[st] > dp[bestSt]) bestSt = st;
      const pickK: number[] = new Array(n).fill(-1);
      const kinds: Back["kind"][] = new Array(n).fill("skip");
      for (let i = n - 1, st = bestSt; i >= 0; i--) {
        const bk = backs[i][st];
        pickK[i] = bk.k;
        kinds[i] = bk.kind;
        st = bk.prev;
      }

      // A route's head (the carga) takes the LATEST compatible stop before the
      // next pick, not the earliest: a truck that sat at the yard since the
      // afternoon starts loading at the end of that wait (07-11: AD-49-DH,
      // 06-11 17:30 parado vs 07:07 carga real da 186315796). Single-row heads
      // only — a repeated code keeps its rows on distinct, earliest stops.
      if (
        kinds[0] === "match" &&
        G[0].planArrMs == null && // with a plan, closeness to the planned time already decided
        whWindow(G[0]) == null && // …or the warehouse's real time
        G[0].rows.length === 1 &&
        !(n > 1 && kinds[1] === "share")
      ) {
        // bounded by the route's next pick; a route with nothing else matched
        // keeps the earliest (no evidence of when the loading ended)
        const nextK = pickK.slice(1).find((k) => k >= 0) ?? -1;
        for (let k = nextK - 1; k > pickK[0]; k--) {
          if (compat[0][k] >= compat[0][pickK[0]]) {
            pickK[0] = k;
            break;
          }
        }
      }

      // Carga block: the route's leading run of yard rows (7005/7001/7003 …)
      // is loaded in whatever order the docks allow, not the order the sheet
      // lists them (16-11: 186378400 lists 7005, 7003 but GPS is 7003 00:45 →
      // 7005 02:20; the ordered DP could only keep one of the two). Re-assign
      // the block's rows without the order constraint, among the stops before
      // the route's next pick: real dwell over a gate touch, then (with a plan)
      // nearest the planned time, else the latest.
      {
        let b = 0;
        const blockEnd = firstNonYardIdx.get(rota) ?? Infinity;
        while (b < n && isYardType(G[b].code) && G[b].order < blockEnd) b++;
        const plain = kinds
          .slice(0, b)
          .every((k) => k === "match" || k === "skip" || k === "share" || k === "head");
        if (b >= 2 && plain) {
          const upper = pickK.slice(b).find((k) => k >= 0) ?? m;
          const cands = (i: number) => {
            const out: number[] = [];
            for (let k = 0; k < upper; k++) if (compat[i][k] > 0) out.push(k);
            return out;
          };
          const better = (i: number, k: number, cur: number) => {
            if (compat[i][k] !== compat[i][cur]) return compat[i][k] > compat[i][cur];
            const wk = whDevMin(G[i], plateStops[k]);
            const wc = whDevMin(G[i], plateStops[cur]);
            if (wk != null && wc != null && wk !== wc) return wk < wc;
            const dk = dwellMin(plateStops[k]) >= MIN_LOAD_DWELL_MIN;
            const dc = dwellMin(plateStops[cur]) >= MIN_LOAD_DWELL_MIN;
            if (dk !== dc) return dk;
            const pk = planDevMin(G[i], plateStops[k]);
            const pc = planDevMin(G[i], plateStops[cur]);
            if (pk != null && pc != null && pk !== pc) return pk < pc;
            return k > cur;
          };
          const used = new Set<number>();
          const order = [...Array(b).keys()].sort((x, y) => cands(x).length - cands(y).length);
          const usedBy = new Map<number, number>();
          const shared = new Set<number>();
          const sharedHeadCodes = new Set<string>();
          const pairable = (i: number, j: number) =>
            /^700[15]/.test(G[i].code) &&
            /^700[15]/.test(G[j].code) &&
            G[i].code.slice(0, 4) !== G[j].code.slice(0, 4);
          for (const i of order) {
            let best = -1;
            for (const k of cands(i)) if (!used.has(k) && (best < 0 || better(i, k, best))) best = k;
            // 7005 + 7001 load at the same (shared) docks: one GPS visit may
            // serve both — split later
            if (
              best < 0 &&
              headShareK >= 0 &&
              /^700[15]/.test(G[i].code) &&
              ![...usedBy].some(([k, j]) => k === headShareK && G[j].code.slice(0, 4) === G[i].code.slice(0, 4)) &&
              !sharedHeadCodes.has(G[i].code.slice(0, 4))
            ) {
              const s = plateStops[headShareK];
              if (
                stopInWindow(s.arrivedAt, s.departedAt, G[i].winLoMs, G[i].winHiMs, G[i].winDepHiMs) &&
                whOk(G[i], s) &&
                (planDevMin(G[i], s) ?? 0) <= PLAN_MAX_DEV_MIN
              ) {
                best = headShareK;
                sharedHeadCodes.add(G[i].code.slice(0, 4));
              }
            }
            if (best < 0) {
              for (const k of cands(i)) {
                const j = usedBy.get(k);
                if (j != null && !shared.has(k) && pairable(i, j) && (best < 0 || better(i, k, best))) best = k;
              }
              if (best >= 0) shared.add(best);
            }
            pickK[i] = best;
            kinds[i] = best >= 0 ? "match" : "skip";
            if (best >= 0) {
              used.add(best);
              if (!usedBy.has(best)) usedBy.set(best, i);
            }
          }
          // O armazém carrega SEMPRE o 7005 antes do 7001 (relatórios 05-11,
          // 29-09, 18-11). Um 7001 vizinho do 7005 numa visita ANTES da dele,
          // ou depois de outra carga da rota (7003) que já vem a seguir ao
          // 7005, é a visita errada: as duas cargas ficam na visita do 7005
          // (dividida no Step 2a) e a outra visita fica livre para as rotas
          // seguintes da viatura (18-11 77-MB-49: 7001 da 186391084 em 04:35,
          // real 10:35; a 186394322 ficava sem a sua carga das 04:36).
          // Se o 7005 só tem um toque e o 7001 tem permanência, junta-se o
          // 7005 à visita do 7001 (18-11 50-JG-92).
          for (let i = 0; i < b; i++) {
            if (!/^7005/.test(G[i].code) || pickK[i] < 0) continue;
            for (const j of [i - 1, i + 1]) {
              if (j < 0 || j >= b || !/^7001/.test(G[j].code) || pickK[j] < 0 || pickK[j] === pickK[i]) continue;
              const k5 = pickK[i], k1 = pickK[j];
              const between = k1 > k5 && pickK.slice(0, b).some((k, x) => x !== i && x !== j && k > k5 && k < k1);
              if (k1 > k5 && !between) continue;
              const touch5 = dwellMin(plateStops[k5]) < MIN_LOAD_DWELL_MIN;
              if (touch5 && dwellMin(plateStops[k1]) >= MIN_LOAD_DWELL_MIN) {
                if (whOk(G[i], plateStops[k1])) pickK[i] = k1;
              } else if (whOk(G[j], plateStops[k5])) pickK[j] = k5;
            }
          }
        }
      }

      // write back. Extra rows in a group (same store listed twice in a row)
      // take the next free compatible stops before the following pick, else
      // share the group's stop (C + D pair = one physical visit).
      for (let i = 0; i < n; i++) {
        const g = G[i];
        if (pickK[i] < 0) continue; // -> Step 3/4
        const k0 = pickK[i];
        const stop = plateStops[k0];
        // A planned load with only a gate touch: the dwell is often a stop with
        // NO location code right next to it (docked just outside the pin). Join
        // it when it's close to this row's own location and nearer to it than
        // to any other one; otherwise don't write a 0-min "carga".
        if (g.carga > 0 && dwellMin(stop) < MIN_LOAD_DWELL_MIN) {
          const own = codeCoords.get(g.code);
          // nearest among the locations THIS sheet uses (7001/7005/7003/…),
          // so a generic site pin that no row references can't veto the join
          const nearestCode = (s: WStop): { code: string; km: number } | null => {
            if (s.lat == null || s.lng == null) return null;
            let best: { code: string; km: number } | null = null;
            for (const [c, xy] of codeCoords) {
              if (!sheetCodes.has(c.toUpperCase())) continue;
              const km = haversineKm(s.lat, s.lng, xy.lat, xy.lng);
              if (!best || km < best.km) best = { code: c, km };
            }
            return best;
          };
          const joinable = (s: WStop | undefined, other: WStop): s is WStop => {
            if (!s || s.assigned || s.code || !own) return false;
            const gap =
              Date.parse(s.arrivedAt) >= Date.parse(other.arrivedAt)
                ? (Date.parse(s.arrivedAt) - Date.parse(other.departedAt ?? other.arrivedAt)) / 60000
                : (Date.parse(other.arrivedAt) - Date.parse(s.departedAt ?? s.arrivedAt)) / 60000;
            if (gap > UNCODED_CHAIN_GAP_MIN) return false;
            const n = nearestCode(s);
            return n != null && n.km <= UNCODED_NEAR_KM && codeEq(n.code, g.code, coLocatedGroups);
          };
          const parts = [stop];
          const before = plateStops[k0 - 1];
          const after = plateStops[k0 + 1];
          if (joinable(before, stop)) parts.unshift(before);
          if (joinable(after, stop)) parts.push(after);
          const arr = Math.min(...parts.map((s) => Date.parse(s.arrivedAt)));
          const dep = Math.max(...parts.map((s) => Date.parse(s.departedAt ?? s.arrivedAt)));
          if (parts.length > 1 && (dep - arr) / 60000 >= MIN_LOAD_DWELL_MIN) {
            for (const s of parts) s.assigned = true;
            const visit: WStop = {
              ...stop,
              arrivedAt: new Date(arr).toISOString(),
              departedAt: new Date(dep).toISOString(),
              assigned: true,
            };
            for (const w of g.rows) {
              w.conf = "OK";
              w.assignedStop = visit;
              w.real =
                `Carga: toque no ${stop.code ?? g.code} às ${fmtHM(stop.arrivedAt)} + paragem sem ` +
                `local junto ao ${g.code} (permanência total ${Math.round((dep - arr) / 60000)} min).`;
            }
            g.conf = "OK";
            g.assignedStop = visit;
            continue;
          }
          setGroup(
            g,
            REVIEW,
            null,
            `Carga prevista (${g.carga} paletes) mas o GPS só tem um toque de ` +
              `${Math.max(0, Math.round(dwellMin(stop)))} min no ${stop.code ?? g.code} às ` +
              `${fmtHM(stop.arrivedAt)} — sem permanência para a carga; confirmar.` +
              [before, after]
                .filter((x): x is WStop => !!x && !x.code)
                .map((x) => {
                  const n = nearestCode(x);
                  const dOwn =
                    own && x.lat != null && x.lng != null
                      ? Math.round(haversineKm(x.lat, x.lng, own.lat, own.lng) * 1000)
                      : null;
                  return (
                    ` [paragem sem local ${fmtHM(x.arrivedAt)}–${fmtHM(x.departedAt) || "?"}: ` +
                    (x.lat == null
                      ? "sem coordenadas"
                      : `${dOwn ?? "?"} m do ${g.code}` +
                        (n ? `, mais perto de ${n.code} (${Math.round(n.km * 1000)} m)` : "")) +
                    "]"
                  );
                })
                .join(""),
          );
          continue;
        }
        let note = "";
        if (kinds[i] === "share") {
          sharedOnce.add(stop);
          note = `Paragem partilhada com a linha ${G[i - 1].code} da mesma rota.`;
        } else if (kinds[i] === "head" && prevTail) {
          sharedOnce.add(stop);
          note = `Mesma paragem que o regresso da rota ${prevTail.g.rota} (regresso → carga seguinte).`;
        } else if (keptClaim.has(stop)) {
          note =
            `Mesma paragem que a linha ${g.code} já preenchida na rota ${keptClaim.get(stop)} ` +
            `(${g.isTail ? "regresso → carga seguinte" : "regresso anterior → esta carga"}).`;
        } else if (!codeEq(stop.code, g.code, coLocatedGroups)) {
          note = `Paragem na doca ${stop.code} (oeste) — aceite para ${g.code}, mesmo pátio.`;
        }
        stop.assigned = true;
        const nextK = pickK.slice(i + 1).find((k) => k >= 0 && k !== k0) ?? m;
        let cursor = k0;
        [...g.rows]
          .sort((a, b) => a.idx - b.idx)
          .forEach((w, r) => {
            let st = stop;
            if (r > 0) {
              for (let k = cursor + 1; k < nextK; k++) {
                if (compat[i][k] > 0 && !plateStops[k].assigned) {
                  st = plateStops[k];
                  st.assigned = true;
                  cursor = k;
                  break;
                }
              }
            }
            w.conf = "OK";
            w.assignedStop = st;
            w.real = st === stop ? note : "";
          });
        g.conf = "OK";
        g.assignedStop = stop;
      }

      const lastI = n - 1;
      // only a real regresso (the route's LAST row — not a carga followed by
      // kept deliveries) can be shared with the next route's carga
      prevTail =
        pickK[lastI] >= 0 && G[lastI].isTail ? { g: G[lastI], stop: plateStops[pickK[lastI]] } : null;
    }
  }

  // 7001/7005/7003 are always the yard, even without a location type
  const isYardCode = (code: string) => isYardType(code) || /^700[135]/.test(code);
  const firstDeliveryIdx = new Map<string, number>();
  for (const w of works) {
    if (w.empty || !w.rota || !w.code || isYardCode(w.code)) continue;
    if (!firstDeliveryIdx.has(w.rota)) firstDeliveryIdx.set(w.rota, w.idx);
  }

  // ----- Step 2a: a visit to the 7001/7005 docks -> carga times -----
  // A visit (mergeYardVisits) = gate touch + espera + doca(s) [+ toque de saída].
  //  • Saída = saída do pátio (fim da visita);
  //  • Chegada da 1.ª carga = entrada no pátio (a espera pelo cais conta),
  //    com as mesmas regras de "Rever" do Step 2b (chegada muito antecipada);
  //  • 7005 + 7001 na mesma visita (docas 54-59 servem as duas; o armazém
  //    carrega sempre 7005 primeiro e 7001 logo a seguir — relatório 05-11:
  //    66/66 rotas, intervalo mediano 0 min): se o GPS separa as duas docas,
  //    usa-se esse corte; senão divide-se o tempo de cais (7001 ≈ 58%);
  //  • estadia longa (parado horas antes de carregar): a carga TERMINA quando
  //    sai (29-09/05-11: erro mediano 6–7 min ancorado no fim);
  //  • regresso da rota anterior na mesma visita: fica no início.
  const noWaitWalk = new Set<StoreGroup>();
  {
    type Part = { code: string | null; a: number; d: number };
    const visits = new Map<string, StoreGroup[]>();
    const inCarga = (g: StoreGroup) => (firstDeliveryIdx.get(g.rota) ?? Infinity) > g.order;
    // 7005 + 7001 seguidos no bloco de carga e só a 7005 ficou com paragem: o
    // DP não deixa duas linhas na mesma paragem, mas as docas 54-59 servem as
    // duas (armazém: 7005 primeiro, 7001 logo a seguir) → o 7001 entra na
    // mesma visita e a divisão abaixo trata o tempo de cais.
    for (const g of groups) {
      if (g.conf !== "OK" || !g.assignedStop || !g.plate || !/^7005/.test(g.code) || !inCarga(g)) continue;
      // …ou o 7001 ficou num toque (<5 min) ANTES do 7005 — o armazém carrega
      // sempre 7005 primeiro (16-11 47-LF-63: 7001 09:05–09:05, 7005 09:15–10:10)
      const t5 = Date.parse(g.assignedStop.arrivedAt);
      const t5End = Date.parse(g.assignedStop.departedAt ?? g.assignedStop.arrivedAt);
      // …ou o 7001 ficou numa visita ANTES do 7005 (impossível: 18-11 77-MB-49
      // 7001 04:35 / 7005 10:19, real 7005 10:22 → 7001 10:35), ou bem depois
      // dele com outra carga da rota (7003) pelo meio (18-11 72-XR-33: 7005
      // 09:20–10:23, 7003 10:34, 7001 14:30; real 7001 09:39–10:29).
      const wrongVisit = (h: StoreGroup) => {
        const s = h.assignedStop;
        if (!s || s.id === g.assignedStop!.id) return false;
        const a = Date.parse(s.arrivedAt);
        if (a < t5) return true;
        return a > t5End + 30 * 60_000 && groups.some((o) =>
          o.rota === g.rota && o !== g && o !== h && o.conf === "OK" && o.assignedStop && inCarga(o) &&
          Date.parse(o.assignedStop.arrivedAt) >= t5End && Date.parse(o.assignedStop.arrivedAt) < a);
      };
      const mate = groups.find(
        (h) =>
          h !== g && h.rota === g.rota && h.plate === g.plate && /^7001/.test(h.code) &&
          (!h.assignedStop || (h.conf === "OK" && wrongVisit(h))) &&
          !h.rows.some((w) => w.kept) && inCarga(h) && Math.abs(h.order - g.order) === 1 &&
          whOk(h, g.assignedStop!),
      );
      if (!mate) continue;
      // o 7005 ficou num toque e o 7001 numa visita com permanência: é essa a
      // visita das duas cargas (18-11 50-JG-92: 7005 toque 12:59 depois do
      // 7003, 7001 11:39–12:25; real 7005 11:44, 7001 12:14–13:20)
      const dwellOf = (s: WStop) => Date.parse(s.departedAt ?? s.arrivedAt) - Date.parse(s.arrivedAt);
      if (
        mate.assignedStop && dwellOf(g.assignedStop) < MIN_LOAD_DWELL_MIN * 60_000 &&
        dwellOf(mate.assignedStop) >= MIN_LOAD_DWELL_MIN * 60_000
      ) {
        if (!whOk(g, mate.assignedStop)) continue;
        g.assignedStop = mate.assignedStop;
        for (const w of g.rows) w.assignedStop = mate.assignedStop;
        continue;
      }
      mate.conf = "OK";
      mate.assignedStop = g.assignedStop;
      for (const w of mate.rows) {
        w.conf = "OK";
        w.assignedStop = g.assignedStop;
      }
    }
    for (const g of groups) {
      if (g.conf !== "OK" || !g.assignedStop || !g.plate || !/^700[15]/.test(g.code)) continue;
      const k = `${g.plate}|${g.assignedStop.id}|${g.assignedStop.arrivedAt}`;
      const vs = visits.get(k) ?? visits.set(k, []).get(k)!;
      if (!vs.includes(g)) vs.push(g);
    }
    const isDwell = (p: Part) => p.d - p.a >= MIN_LOAD_DWELL_MIN * 60_000;
    const iso = (t: number) => new Date(t).toISOString();
    for (const gs of visits.values()) {
      const stop = gs[0].assignedStop!;
      const t0 = Date.parse(stop.arrivedAt);
      const t1 = Date.parse(stop.departedAt ?? stop.arrivedAt);
      // loads = rows of the latest route in the visit (its carga block, or a
      // 7005+7001 pair mid-route); rows of an earlier route = its regresso
      const lastRota = gs.reduce((a, b) => (b.order > a.order ? b : a)).rota;
      const prior = gs.filter((g) => g.rota !== lastRota);
      const loads = gs
        .filter((g) => g.rota === lastRota)
        .sort((a, b) => (/^7005/.test(a.code) ? 0 : 1) - (/^7005/.test(b.code) ? 0 : 1) || a.order - b.order);
      if (loads.length === 0 || prior.length > 1 || loads.length > 2) continue;
      if (loads.length === 1 && prior.length === 0 && !inCarga(loads[0])) continue; // lone regresso
      if (
        loads.length === 2 &&
        (loads[0].rota !== loads[1].rota || loads[0].code.slice(0, 4) === loads[1].code.slice(0, 4))
      ) {
        continue;
      }
      const parts: Part[] = (stop as WStop & { parts?: Part[] }).parts ?? [{ code: stop.code, a: t0, d: t1 }];
      const dwellParts = parts.filter(isDwell);
      // Saída = saída do pátio (fim da visita, incl. toque no portão) — como a
      // Chegada é a entrada; no 7003 o fim da paragem GPS = saída na portaria
      const tEnd = t1;

      const need =
        loads.reduce((acc, g) => acc + (/^7005/.test(g.code) ? LOAD_MIN_7005 : LOAD_MIN_7001), 0) * 60_000;
      // regresso + one carga in a normal visit: keep sharing the whole stop
      // (Step 2b writes "Viatura já no pátio")
      if (prior.length === 1 && loads.length === 1 && tEnd - t0 <= need + LONG_STAY_EXTRA_MIN * 60_000) continue;

      const segs: [StoreGroup, number, number][] = [];
      let cursor = t0;
      for (const g of prior) {
        const w = g.rows.find((r) => r.planArrMs != null && r.planDepMs != null);
        const dur = Math.max(w ? w.planDepMs! - w.planArrMs! : 0, REGRESSO_DEFAULT_MIN * 60_000);
        const end = Math.min(tEnd, cursor + Math.min(dur, (tEnd - t0) / 3));
        segs.push([g, cursor, end]);
        cursor = end;
      }
      // cais = first dwell piece from here on
      const dock = dwellParts.find((p) => p.d > cursor);
      let loadStart = dock ? Math.max(cursor, dock.a) : cursor;
      let long = false;
      if (tEnd - loadStart > need + LONG_STAY_EXTRA_MIN * 60_000) {
        loadStart = tEnd - need;
        long = true;
      }
      let gpsSplit = false;
      if (loads.length === 2) {
        // estadia longa: o GPS ainda pode mostrar a doca do 7005 seguida da do
        // 7001 — usa a ÚLTIMA paragem 7005 com uma doca 7001 a seguir (18-11
        // CG-53-PT: 7005 05:14–06:13, SON 06:30–08:24; real 05:40–06:10 /
        // 06:10–08:25 — ancorar no fim dava 7005 até 07:58)
        let i5 = -1;
        let p1: Part | undefined;
        for (let j = 0; j < parts.length; j++) {
          const p = parts[j];
          if (!/^7005/.test(p.code ?? "") || !isDwell(p) || p.d <= (long ? cursor : loadStart)) continue;
          const nx = parts.slice(j + 1).find((q) => /^7001/.test(q.code ?? "") && q.d - q.a >= GPS_SPLIT_7001_MIN * 60_000);
          if (nx || i5 < 0) {
            i5 = j;
            p1 = nx;
          }
          if (!long) break;
        }
        if (p1) {
          gpsSplit = true;
          if (long) {
            long = false;
            loadStart = Math.max(cursor, parts[i5].a);
          }
          segs.push([loads[0], loadStart, parts[i5].d], [loads[1], p1.a, tEnd]);
        } else {
          const cut = Math.min(
            tEnd,
            Math.max(loadStart, Math.round((loadStart + SHARE_7005 * (tEnd - loadStart)) / 60_000) * 60_000),
          );
          segs.push([loads[0], loadStart, cut], [loads[1], cut, tEnd]);
        }
      } else segs.push([loads[0], loadStart, tEnd]);

      // Chegada da 1.ª carga: entrada no pátio (a espera conta), salvo se a
      // viatura já lá estava (regresso da rota anterior na mesma visita)
      const first = loads[0];
      const firstSeg = segs.find((x) => x[0] === first)!;
      let conf: Work["conf"] = "OK";
      const notes: string[] = [];
      // Step 2b still walks back over EARLIER separate stops when this visit
      // itself holds no waiting time (first load starts at the visit start)
      const decided = prior.length > 0 || long || t0 < firstSeg[1];
      if (prior.length) {
        notes.push(`Viatura já no pátio (regresso da rota ${prior[0].rota}); cais às ${fmtHM(iso(firstSeg[1]))}.`);
      } else if (t0 < firstSeg[1]) {
        const dockAt = firstSeg[1];
        const wait = Math.round((dockAt - t0) / 60_000);
        const plan = first.planArrMs;
        const vsPlan =
          plan != null
            ? ` (${dockAt >= plan ? "+" : ""}${Math.round((dockAt - plan) / 60_000)} min vs planeado ${fmtHM(iso(plan))})`
            : "";
        notes.push(`Entrada no pátio ${fmtHM(stop.arrivedAt)} · espera ${wait} min · cais ${fmtHM(iso(dockAt))}${vsPlan}.`);
        const before = plan != null ? Math.round((Math.min(dockAt, plan) - t0) / 60_000) : 0;
        if (plan != null && t0 < plan - EARLY_ARRIVAL_REVIEW_MIN * 60_000 && before >= EARLY_WAIT_REVIEW_MIN) {
          conf = REVIEW;
          notes.push(
            `Chegou ${Math.round((plan - t0) / 60_000)} min antes da hora planeada — ` +
              `${before} min da espera são antes dessa hora; confirmar se contam.`,
          );
        } else if (plan == null && wait > LONG_WAIT_REVIEW_MIN) {
          conf = REVIEW;
          notes.push(`Espera longa (sem plano de cargas) — confirmar.`);
        }
        firstSeg[1] = t0;
      }
      if (long) {
        notes.push(
          `Estadia longa: carga${loads.length > 1 ? "s" : ""} no fim da estadia ` +
            `(~${Math.round(need / 60_000)} min antes da saída ${fmtHM(iso(tEnd))}).`,
        );
      }
      if (loads.length === 2) {
        notes.push(
          gpsSplit
            ? `7005 e 7001 separados pelo GPS.`
            : `7005 + 7001 numa só paragem (docas partilhadas): 7005 primeiro, depois 7001 ` +
                `(~${Math.round(SHARE_7005 * 100)}% / ${Math.round((1 - SHARE_7005) * 100)}% do tempo de cais).`,
        );
      }
      const note = notes.join(" ");
      for (const [g, a, b] of segs) {
        if (inCarga(g) && (g !== first || decided)) noWaitWalk.add(g);
        const v: WStop = { ...stop, arrivedAt: iso(a), departedAt: iso(b), assigned: true };
        g.assignedStop = v;
        if (g === first) g.conf = conf;
        for (const w of g.rows) {
          if (w.assignedStop?.id !== stop.id) continue;
          w.assignedStop = v;
          if (g === first) w.conf = conf;
          w.real = g.rota === lastRota
            ? note
            : `Regresso: início da visita ao pátio ${fmtHM(stop.arrivedAt)}–${fmtHM(iso(tEnd))} ` +
              `(a seguir carga da rota ${loads[0].rota}).`;
        }
      }
    }
  }

  // ----- Step 2c: regresso ao pátio ainda sem hora -----
  // The route's last row (regresso 7001/7003) left blank by the DP: the truck
  // often comes back to ANOTHER part of the yard (7003, 7005, parque sem
  // local) or hours after the plan (entregas atrasadas, fora da janela ±4h).
  // Regresso = primeira chegada ao pátio depois da última entrega da rota.
  {
    const pin = codeCoords.get("7001");
    const inYard = (s: WStop) =>
      s.code
        ? /^700[135]/.test(s.code)
        : s.lat != null && s.lng != null && !!pin && haversineKm(s.lat, s.lng, pin.lat, pin.lng) <= REGRESSO_YARD_KM;
    for (const g of groups) {
      if (g.conf !== "" || g.assignedStop || !g.plate || !g.isTail || !isYardCode(g.code)) continue;
      const fn = firstDeliveryIdx.get(g.rota);
      if (fn == null || g.order < fn) continue;
      let lastDel = -Infinity;
      for (const w of works) {
        if (w.rota !== g.rota || isYardCode(w.code) || w.idx > g.order) continue;
        const t = w.kept
          ? w.keptDepMs ?? w.keptArrMs
          : w.conf === "OK" && w.assignedStop
            ? Date.parse(w.assignedStop.departedAt ?? w.assignedStop.arrivedAt)
            : null;
        if (t != null && t > lastDel) lastDel = t;
      }
      if (lastDel === -Infinity) continue;
      // se outra rota da mesma viatura acaba depois desta e antes da paragem,
      // o regresso é dela (16-11 BB-54-EX: rota acabou 01:25, apanhava o
      // regresso das 10:00 da rota seguinte) — ver também Step 2d
      const otherEnds: number[] = [];
      {
        const m = new Map<string, number>();
        for (const h of groups) {
          if (h.plate !== g.plate || h.rota === g.rota || isYardCode(h.code) || h.conf !== "OK" || !h.assignedStop) continue;
          const t = Date.parse(h.assignedStop.departedAt ?? h.assignedStop.arrivedAt);
          if (t > (m.get(h.rota) ?? -Infinity)) m.set(h.rota, t);
        }
        otherEnds.push(...m.values());
      }
      const ww = whWindow(g);
      const cand = stopsForPlate(g.plate).find((s) => {
        const a = Date.parse(s.arrivedAt);
        if (ww && !visitOverlaps(s, ww)) return false;
        return (
          a >= lastDel - ANCHOR_SLACK_MS && a <= lastDel + REGRESSO_MAX_H * 3_600_000 && a <= g.anchorHiMs && inYard(s) &&
          !otherEnds.some((t) => t > lastDel && t < a)
        );
      });
      if (!cand) continue;
      const a = Date.parse(cand.arrivedAt);
      const d = Date.parse(cand.departedAt ?? cand.arrivedAt);
      const w0 = g.rows.find((r) => r.planArrMs != null && r.planDepMs != null);
      const planDur = w0 ? Math.max(0, w0.planDepMs! - w0.planArrMs!) : 0;
      const cap = Math.max(planDur, REGRESSO_DEFAULT_MIN * 60_000);
      const parked = d - a > cap + REGRESSO_PARKED_EXTRA_MIN * 60_000;
      const v: WStop = { ...cand, departedAt: new Date(parked ? a + cap : d).toISOString(), assigned: true };
      cand.assigned = true;
      // a mesma visita já é a carga de OUTRA rota (regresso → carga seguinte):
      // o regresso fica no início e a carga começa a seguir, como no Step 2a
      // (18-11 77-MB-49: regresso 186394322 e 7005/7001 da 186391084 todos
      // 10:19–…, sobrepostos)
      const sharers = groups.filter(
        (h) => h !== g && h.plate === g.plate && h.rota !== g.rota && h.conf === "OK" &&
          h.assignedStop?.id === cand.id && isYardCode(h.code) && !h.rows.some((w) => w.kept),
      );
      let sharedNote = "";
      if (sharers.length) {
        const segEnd = Math.round((a + Math.min(cap, (d - a) / 3)) / 60_000) * 60_000;
        v.departedAt = new Date(segEnd).toISOString();
        for (const h of sharers) {
          const hs = h.assignedStop!;
          if (Date.parse(hs.arrivedAt) >= segEnd || Date.parse(hs.departedAt ?? hs.arrivedAt) <= segEnd) continue;
          const nv: WStop = { ...hs, arrivedAt: new Date(segEnd).toISOString() };
          h.assignedStop = nv;
          for (const w of h.rows) {
            if (w.assignedStop?.id !== hs.id) continue;
            w.assignedStop = nv;
            w.real = `Viatura já no pátio (regresso da rota ${g.rota} ${fmtHM(cand.arrivedAt)}); carga às ${fmtHM(nv.arrivedAt)}.`;
          }
        }
        sharedNote = ` A seguir, carga da rota ${sharers[0].rota} na mesma visita.`;
      }
      const note =
        `Regresso: primeira chegada ao pátio depois da última entrega (${fmtHM(new Date(lastDel).toISOString())}) — ` +
        `${cand.code ?? "paragem sem local junto ao pátio"} ${fmtHM(cand.arrivedAt)}–${fmtHM(cand.departedAt)}` +
        (sharers.length ? "." + sharedNote : parked ? `; viatura ficou parada, Saída = chegada + ${Math.round(cap / 60000)} min.` : ".");
      g.conf = "OK";
      g.assignedStop = v;
      for (const w of g.rows) {
        w.conf = "OK";
        w.assignedStop = v;
        w.real = note;
      }
    }
  }

  // ----- Step 2b: espera pelo cais conta na Chegada das cargas -----
  {
    const yardPins = [...codeCoords]
      .filter(([c]) => isYardType(c) && sheetCodes.has(c.toUpperCase()))
      .map(([, xy]) => xy);
    const inNonWaitZone = (s: WStop) =>
      s.lat != null &&
      s.lng != null &&
      YARD_NON_WAIT_ZONES.some((z) => haversineKm(s.lat!, s.lng!, z.lat, z.lng) <= z.km);
    const isWaitStop = (s: WStop): boolean => {
      // a merged yard visit (mergeYardVisits) is waiting when every piece is a
      // gate touch or an uncoded stop (zona de espera) — no dock dwell inside
      const parts = (s as WStop & { parts?: { code: string | null; a: number; d: number }[] }).parts;
      if (parts) {
        return parts.every(
          (p) => !p.code || (isYardCode(p.code) && p.d - p.a < MIN_LOAD_DWELL_MIN * 60_000),
        );
      }
      // a coded yard stop counts only as a gate/dock touch; a real dwell at a
      // dock that no row claimed is some other load, not waiting
      if (s.code) {
        if (codeTypes.get(s.code) === "espera") return true;
        return isYardType(s.code) && dwellMin(s) < MIN_LOAD_DWELL_MIN;
      }
      if (s.lat == null || s.lng == null || inNonWaitZone(s)) return false;
      return yardPins.some((p) => haversineKm(s.lat!, s.lng!, p.lat, p.lng) <= YARD_NEAR_KM);
    };
    // which routes hold each physical stop (OK rows + kept rows' claims)
    const holders = new Map<string, Set<string>>();
    const hold = (id: string, rota: string) => {
      const set = holders.get(id) ?? new Set<string>();
      set.add(rota);
      holders.set(id, set);
    };
    for (const w of works) if (w.conf === "OK" && w.assignedStop) hold(w.assignedStop.id, w.rota);
    for (const [s, rota] of keptClaim) hold(s.id, rota);

    const heads = groups
      .filter(
        (g) =>
          g.conf === "OK" &&
          g.assignedStop &&
          g.plate &&
          isYardType(g.code) &&
          firstNonYardIdx.has(g.rota) &&
          g.order < firstNonYardIdx.get(g.rota)!,
      )
      .sort((a, b) => a.assignedStop!.arrivedAt.localeCompare(b.assignedStop!.arrivedAt));

    const seenRoute = new Set<string>();
    for (const g of heads) {
      if (noWaitWalk.has(g)) {
        seenRoute.add(g.rota);
        continue;
      }
      const dock = g.assignedStop!;
      const firstOfRoute = !seenRoute.has(g.rota);
      seenRoute.add(g.rota);
      const ps = stopsForPlate(g.plate!);
      const k = ps.findIndex((s) => s.id === dock.id);
      if (k < 0) continue;
      const dockArr = Date.parse(dock.arrivedAt);
      let entry = dockArr;
      // the dock stop itself shared with another route (regresso → carga):
      // the truck was already there, nothing to walk back
      let otherRoute: string | null =
        [...(holders.get(dock.id) ?? [])].find((r) => r !== g.rota) ?? null;
      for (let j = k - 1; j >= 0 && !otherRoute; j--) {
        const s = ps[j];
        const sArr = Date.parse(s.arrivedAt);
        if (sArr >= entry) continue; // part of the dock visit itself (joined fragment)
        const gap = (entry - Date.parse(s.departedAt ?? s.arrivedAt)) / 60000;
        if (gap > YARD_CHAIN_GAP_MIN) break;
        const h = holders.get(s.id);
        if (h) {
          const other = [...h].find((r) => r !== g.rota);
          if (other) otherRoute = other;
          break; // another row's stop (this route's or the previous one's)
        }
        if (!isWaitStop(s)) break;
        entry = sArr;
      }

      const planNote = (refMs: number) => {
        if (g.planArrMs == null) return "";
        const d = Math.round((refMs - g.planArrMs) / 60000);
        return ` (${d >= 0 ? "+" : ""}${d} min vs planeado ${fmtHM(new Date(g.planArrMs).toISOString())})`;
      };
      let conf: Work["conf"] = "OK";
      let note = "";
      if (otherRoute) {
        // já estava no pátio desde o regresso da rota anterior: sem momento
        // real que marque o início da espera — Chegada fica a do cais
        if (g.planArrMs != null && dockArr > g.planArrMs) {
          note =
            `Viatura já no pátio (rota ${otherRoute}); cais às ${fmtHM(dock.arrivedAt)}, ` +
            `${Math.round((dockArr - g.planArrMs) / 60000)} min depois da hora planeada.`;
        }
      } else if (entry < dockArr) {
        const wait = Math.round((dockArr - entry) / 60000);
        note =
          `${firstOfRoute ? "Entrada no pátio" : "Espera desde"} ${fmtHM(new Date(entry).toISOString())} · espera ${wait} min · ` +
          `cais ${fmtHM(dock.arrivedAt)}${planNote(dockArr)}.`;
        const before =
          g.planArrMs != null ? Math.round((Math.min(dockArr, g.planArrMs) - entry) / 60000) : 0;
        if (
          g.planArrMs != null &&
          entry < g.planArrMs - EARLY_ARRIVAL_REVIEW_MIN * 60_000 &&
          before >= EARLY_WAIT_REVIEW_MIN
        ) {
          conf = REVIEW;
          note +=
            ` Chegou ${Math.round((g.planArrMs - entry) / 60000)} min antes da hora planeada — ` +
            `${before} min da espera são antes dessa hora; confirmar se contam.`;
        } else if (g.planArrMs == null && wait > LONG_WAIT_REVIEW_MIN) {
          conf = REVIEW;
          note += ` Espera longa (sem plano de cargas) — confirmar.`;
        }
        const visit: WStop = { ...dock, arrivedAt: new Date(entry).toISOString() };
        g.assignedStop = visit;
        for (const w of g.rows) if (w.assignedStop?.id === dock.id) w.assignedStop = visit;
      }
      if (!note) continue;
      g.conf = conf;
      for (const w of g.rows) {
        w.conf = conf;
        w.real = w.real ? `${w.real} ${note}` : note;
      }
    }
  }

  // A stop already accounted for by a hand-filled (kept) row is that row's
  // visit — never a "swap" candidate for another route (16-11: 186376676/38
  // got AD-70-DF 04:49, the visit its own route 186376648 already lists).
  for (const s of keptClaim.keys()) s.assigned = true;

  // ----- Step 2d: verificações finais nas linhas do pátio -----
  //  • regresso depois da 1.ª entrega da rota seguinte da mesma viatura é
  //    impossível (16-11 BB-54-EX: rota acabou 01:25, regresso às 10:00 da
  //    rota seguinte) → sem hora;
  //  • estadia no pátio > YARD_LONG_REVIEW_H (viatura parada; 16-11 AD-76-DF
  //    00:00–23:00) → Rever, mantendo as horas como sugestão.
  {
    const isFixed = (g: StoreGroup) => g.rows.some((w) => w.kept);
    for (const g of groups) {
      if (!isYardCode(g.code) || g.conf !== "OK" || !g.assignedStop || !g.plate || isFixed(g)) continue;
      const fn = firstDeliveryIdx.get(g.rota);
      if (g.isTail && fn != null && g.order > fn) {
        let lastDel = -Infinity;
        for (const h of groups) {
          if (h.rota !== g.rota || isYardCode(h.code) || h.conf !== "OK" || !h.assignedStop) continue;
          const t = Date.parse(h.assignedStop.departedAt ?? h.assignedStop.arrivedAt);
          if (t > lastDel) lastDel = t;
        }
        // outra rota da mesma viatura que ACABA depois desta e antes da
        // paragem → o regresso é dela (rotas intercaladas, p.ex. vaivém
        // 405↔12 da AT-45-AC: fica com a rota que acaba mais tarde)
        const lastDelOther = new Map<string, number>();
        for (const h of groups) {
          if (h.plate !== g.plate || h.rota === g.rota || isYardCode(h.code) || h.conf !== "OK" || !h.assignedStop) continue;
          const t = Date.parse(h.assignedStop.departedAt ?? h.assignedStop.arrivedAt);
          if (t > (lastDelOther.get(h.rota) ?? -Infinity)) lastDelOther.set(h.rota, t);
        }
        const arr = Date.parse(g.assignedStop.arrivedAt);
        const owned = [...lastDelOther.values()].some((t) => t > lastDel && t < arr);
        if (lastDel > -Infinity && owned) {
          setGroup(g, "", null, "");
          continue;
        }
      }
      const a = Date.parse(g.assignedStop.arrivedAt);
      const d = Date.parse(g.assignedStop.departedAt ?? g.assignedStop.arrivedAt);
      // fora de ordem face às entregas da PRÓPRIA rota (carga depois da 1.ª
      // entrega / regresso antes da última) → Rever, hora fica como sugestão
      // (17-11: 75-XR-31, AC-41-DT, AZ-98-BH — rotas da mesma viatura trocadas)
      if (fn != null) {
        let firstDel = Infinity;
        let lastDel = -Infinity;
        for (const h of groups) {
          if (h.rota !== g.rota || isYardCode(h.code) || h.conf !== "OK" || !h.assignedStop) continue;
          firstDel = Math.min(firstDel, Date.parse(h.assignedStop.arrivedAt));
          lastDel = Math.max(lastDel, Date.parse(h.assignedStop.departedAt ?? h.assignedStop.arrivedAt));
        }
        const slack = 5 * 60_000;
        const bad =
          g.order < fn ? firstDel < Infinity && a > firstDel + slack : g.isTail && lastDel > -Infinity && a < lastDel - slack;
        if (bad) {
          const note =
            `${g.order < fn ? "Carga" : "Regresso"} fora de ordem: ${fmtHM(g.assignedStop.arrivedAt)} vs entregas da rota ` +
            `${fmtHM(new Date(firstDel).toISOString())}–${fmtHM(new Date(lastDel).toISOString())} — ` +
            `confirmar (a viatura pode ter feito as rotas noutra ordem).`;
          g.conf = REVIEW;
          for (const w of g.rows) {
            w.conf = REVIEW;
            w.real = w.real ? `${w.real} ${note}` : note;
          }
          continue;
        }
      }
      if (d - a > YARD_LONG_REVIEW_H * 3_600_000) {
        const note =
          `Viatura ${Math.round((d - a) / 3_600_000)} h parada no pátio (${fmtHM(g.assignedStop.arrivedAt)}–` +
          `${fmtHM(g.assignedStop.departedAt)}) — confirmar a hora real da carga/regresso.`;
        g.conf = REVIEW;
        for (const w of g.rows) {
          w.conf = REVIEW;
          w.real = w.real ? `${w.real} ${note}` : note;
        }
      }
    }
  }

  // ----- Step 3: vehicle-swap suggestion for uncovered store-groups -----
  const rivalRows: SwapRival[] = groups.map((g) => ({
    code: g.code,
    planIni: g.planIni,
    planFim: g.planFim,
    plate: g.plate,
    label: `rota ${g.rota}`,
    assignedStop: g.assignedStop,
  }));

  const storeLabel = (g: StoreGroup) =>
    g.designacao ? `${g.code} (${g.designacao})` : g.code;

  // Each ROTA's planned stores, in sheet order — the run a look-alike plate has
  // to corroborate for a "🔤 Possível erro de matrícula".
  const routeStoresByRota = new Map<string, RouteStore[]>();
  for (const [rota, rg] of routeMap) {
    routeStoresByRota.set(
      rota,
      [...rg]
        .sort((a, b) => a.order - b.order)
        .filter((x) => x.code)
        .map((x) => ({ code: x.code, planIni: x.planIni, planFim: x.planFim })),
    );
  }

  for (const g of groups) {
    if (g.conf !== "" || !g.plate || !g.code || g.assignedStop) continue;

    // No GPS of ours covering this vehicle's planned window (CICLO) -> we can't
    // tell if it made the stop itself, so don't guess a swap.
    if (
      !plannedPlateHasCoverage(
        pingWindowByPlate.get(g.plate) ?? null,
        day,
        g.planIni,
        g.planFim,
        SWAP_WINDOW_PAD_MIN,
      )
    ) {
      // Plate not in our GPS feed at all — maybe a one-character transcription
      // slip for a look-alike plate that really drove this route today.
      if (!platesWithGps.has(g.plate)) {
        const typo = findPlateTypo({
          plate: g.plate,
          code: g.code,
          planIni: g.planIni,
          planFim: g.planFim,
          routeStores: routeStoresByRota.get(g.rota) ?? [],
          stops,
          candidatePlates: platesWithDayStops,
          coLocatedGroups,
        });
        if (
          typo &&
          stopInWindow(
            typo.suggStop.arrivedAt,
            typo.suggStop.departedAt,
            g.winLoMs,
            g.winHiMs,
            g.winDepHiMs,
          )
        ) {
          typo.suggStop.assigned = true;
          setGroup(
            g,
            PLATE_TYPO,
            typo.suggStop,
            plateTypoNote(g.plate, typo.suggPlate, typo.run, "MATRICULA da folha"),
            typo.suggPlate,
          );
          continue;
        }
      }
      setGroup(g, REVIEW, null, noGpsCoverageNote(g.plate, platesWithGps.has(g.plate)));
      continue;
    }

    const sw = findVehicleSwap({
      plate: g.plate,
      code: g.code,
      planIni: g.planIni,
      planFim: g.planFim,
      stops,
      rivals: rivalRows.filter((r) => r.label !== `rota ${g.rota}`),
      platesWithGps,
      plannedPlateGpsSpan: pingWindowByPlate.get(g.plate) ?? null,
      coLocatedGroups,
    });
    if (!sw) continue;

    if (sw.kind === "no-gps-coverage") {
      setGroup(g, REVIEW, null, sw.note);
      continue;
    }

    // The candidate stop must fit this route's calendar day(s) — a same-day /
    // free-text CICLO never reaches into the next day (see groupWindowMs).
    if (
      !stopInWindow(
        sw.suggStop.arrivedAt,
        sw.suggStop.departedAt,
        g.winLoMs,
        g.winHiMs,
        g.winDepHiMs,
      )
    ) {
      continue;
    }

    sw.suggStop.assigned = true;
    const timing =
      sw.outOfWindow && sw.win
        ? ` (fora da janela planeada${sw.plannedLabel ? ` ${sw.plannedLabel}` : ""}, ` +
          `~${fmtDuration(sw.outsideBy)} além da margem de ±3h)`
        : "";
    const real =
      `Rota ${g.rota} planeada com ${g.plate}, mas ${sw.suggPlate} esteve em ` +
      `${storeLabel(g)} às ${fmtHM(sw.suggStop.arrivedAt)}–` +
      `${fmtHM(sw.suggStop.departedAt) || "?"}${timing}.` +
      (sw.ghost
        ? ` Nota: ${sw.ghost.label} também estava planeada para esta loja/janela, ` +
          `mas o veículo ${sw.ghost.plate} não tem dados GPS — não é alternativa real.`
        : "") +
      (sw.outOfWindow
        ? " ⚠️ Fora do intervalo habitual — confirma com cuidado antes de aceitar."
        : " Confirma antes de aceitar.");

    setGroup(
      g,
      sw.outOfWindow ? SWAP_OUT_OF_WINDOW : SWAP,
      sw.suggStop,
      real,
      sw.suggPlate,
    );
  }

  // ----- Step 4: leftovers -----
  // A group with no plate at all was already resolved to REVIEW back in Step
  // 1 (`if (!g.plate) { setGroup(g, REVIEW, ...); continue; }`), so every
  // group reaching here with g.conf === "" already has BOTH g.plate and
  // g.code set — the `g.plate ?` guard below is defensive, not load-bearing.
  //
  // This is exactly "our stops resolved nothing for this group" — the one
  // case eligible for the TRACKiT /vehicleTravels fallback (see
  // trackit-candidates.ts). trackitStopsByPlate is undefined on pass 1 (no
  // I/O yet), so tryTrackitFallback always reports "not-attempted" there —
  // behaviour is byte-identical to before this feature existed; the plate is
  // recorded in pendingTrackitPlates so route.ts knows to fetch it for pass 2.
  const pendingTrackitPlates = new Set<string>();
  for (const g of groups) {
    if (g.conf !== "") continue;
    if (!g.plate) {
      setGroup(g, REVIEW, null, "Sem matrícula utilizável para esta rota.");
      continue;
    }
    const baseNote = describeReal(g.plate);
    const outcome = tryTrackitFallback(
      g.plate,
      g.code,
      (s) => stopInWindow(s.arrivedAt, s.departedAt, g.winLoMs, g.winHiMs, g.winDepHiMs),
      args.trackitStopsByPlate,
      coLocatedGroups,
    );
    if (outcome.kind === "not-attempted") pendingTrackitPlates.add(g.plate);
    const applied = applyTrackitOutcome(outcome, baseNote);
    setGroup(g, applied.conf, applied.stop, applied.note);
  }

  // ----- write back -----
  let ok = 0;
  let review = 0;
  let kept = 0;
  let passthrough = 0;
  let swap = 0;
  let swapOutOfWindow = 0;
  let plateTypo = 0;
  let whAgree = 0;
  let whDisagree = 0;
  let whBlank = 0;
  // «Armazém»: what the warehouse recorded for this row, and whether our yard
  // visit (entrada → saída do pátio) contains the real load. The sheet keeps
  // the yard entry/exit; the warehouse time only checks it.
  const compareWarehouse = (
    w: Work,
  ): { text: string; verdict: "none" | "info" | "agree" | "disagree" | "blank"; note: string } => {
    const l = w.wh;
    if (!l) return { text: "", verdict: "none", note: "" };
    const hh = (ms: number | null) => (ms == null ? "?" : fmtHM(new Date(ms).toISOString()));
    const bits: string[] = [];
    if (l.portaInMs != null) bits.push(`Portaria ${hh(l.portaInMs)}–${hh(l.portaOutMs)}`);
    if (l.iniMs != null) bits.push(`Cais${l.cais ? " " + l.cais : ""} ${hh(l.iniMs)}–${hh(l.fimMs)}`);
    if (l.plate) bits.push(`Matrícula ${l.plate}`);
    const text = bits.join(" · ");
    const win = /^700[135]/.test(w.code) && !w.kept ? whRealWindow(w.code, l) : null;
    if (!win) return { text, verdict: "info", note: "" };
    if (!w.assignedStop) {
      return {
        text,
        verdict: "blank",
        note: `Armazém: ${hh(win.a)}–${hh(win.b)} — sem visita GPS ao pátio a essa hora.`,
      };
    }
    const a = Date.parse(w.assignedStop.arrivedAt);
    const d = Date.parse(w.assignedStop.departedAt ?? w.assignedStop.arrivedAt);
    if (a <= win.hi && d >= win.lo) return { text, verdict: "agree", note: "" };
    return {
      text,
      verdict: "disagree",
      note: `Hora fora da carga real do armazém (${hh(win.a)}–${hh(win.b)}) — confirmar.`,
    };
  };
  let trackitFallback = 0;
  for (const w of works) {
    // Stamp the service day on every row (blank ones included) so a
    // re-uploaded output is never ambiguous about which day it is.
    w.out[diaCol] = day;
    if (w.empty) {
      if (!(CONFIANCA_COL in w.out)) w.out[CONFIANCA_COL] = "";
      if (!(REAL_COL in w.out)) w.out[REAL_COL] = "";
      passthrough++;
      continue;
    }
    // Row that arrived with both times filled: keep the VALUES the user gave,
    // but re-render Chegada/Saída in our "DD-MM-YYYY HH:MM" format so the whole
    // sheet is visually consistent (the transporter / Excel may hand us
    // "9/8/26", 2-digit year, M/D order, an Excel serial…). Seconds survive
    // only when the cell already had them (a re-uploaded "conferido" file of
    // our own GPS output) — never invented for a transporter-typed value.
    // MATRICULA is left untouched. Only «Dia Serviço» + the two derived
    // columns are also written.
    if (w.kept) {
      const raw = rawRecords?.[w.idx];
      w.out[cols.chegadaCol] = normalizeDateTimeCell(
        String(w.out[cols.chegadaCol] ?? ""),
        raw?.[cols.chegadaCol],
        day,
      );
      w.out[cols.saidaCol] = normalizeDateTimeCell(
        String(w.out[cols.saidaCol] ?? ""),
        raw?.[cols.saidaCol],
        day,
      );
      // all times in the sheet share one shape, DD-MM-YYYY HH:MM:SS: a
      // hand-typed HH:MM gets ":00" (the Confiança column already tells it
      // apart from a GPS time — the user asked for a uniform format)
      for (const c of [cols.chegadaCol, cols.saidaCol]) {
        const v = String(w.out[c] ?? "");
        if (/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/.test(v)) w.out[c] = `${v}:00`;
      }
      w.out[CONFIANCA_COL] = KEPT;
      w.out[REAL_COL] = "";
      // Kept rows never go through grouping (no swap/typo logic touches
      // them), so there's no g.plate to inherit from — the row's own
      // resolved plate IS the planned one.
      w.out[VV_COL] = w.plate ?? "";
      if (warehouse) w.out[ARMAZEM_COL] = compareWarehouse(w).text;
      kept++;
      continue;
    }
    // Always (re)write the two time columns so the output reflects only our
    // matching: "DD-MM-YYYY HH:MM:SS" (Lisbon, the GPS's real seconds) when a
    // stop was matched, blank
    // otherwise. Full date + time — not bare HH:MM like the TFS sheet —
    // because Azambuja cycles cross midnight, so the hour alone is ambiguous
    // about the day. This mirrors the transporter's own pre-filled cells
    // (e.g. "08/09/2026 20:58"). A stale pre-filled value on a "Rever" row
    // would just be misleading — the Real column carries our data instead.
    if (w.assignedStop) {
      w.out[cols.chegadaCol] = fmtDateTimeLisbon(w.assignedStop.arrivedAt);
      w.out[cols.saidaCol] = fmtDateTimeLisbon(w.assignedStop.departedAt);
    } else {
      w.out[cols.chegadaCol] = "";
      w.out[cols.saidaCol] = "";
    }
    // On a swap suggestion, or a one-character plate-typo correction, replace
    // the sheet's plate with the suggested one (same as the TFS sheet).
    // Otherwise leave MATRICULA as the transporter wrote it.
    if (
      (w.conf === SWAP ||
        w.conf === SWAP_OUT_OF_WINDOW ||
        w.conf === PLATE_TYPO) &&
      w.swapPlate &&
      cols.plateCol
    ) {
      w.out[cols.plateCol] = w.swapPlate;
    }
    // Planned plate, captured BEFORE the substitution above — g.plate (not
    // w.plate) because a row with a blank own MATRICULA can inherit its
    // group's/route's plate (see the sibling/route inheritance in the
    // group-building step above), and findVehicleSwap itself treats g.plate
    // as "the planned vehicle" for detecting a swap in the first place.
    const rs = routeSwaps.get(w.rota);
    if (rs && w.conf === "OK") {
      w.conf = SWAP;
      w.swapPlate = rs.to;
      w.real =
        `Rota planeada com ${rs.from}, que não tem paragens em nenhuma loja da rota; ${rs.to} esteve em ` +
        `${rs.n}/${rs.of} lojas da rota nas horas previstas — troca de viatura provável, confirmar.` +
        (w.real ? ` ${w.real}` : "");
      if (cols.plateCol) w.out[cols.plateCol] = rs.to;
    }
    w.out[VV_COL] = rs ? rs.from : (groupMap.get(w.groupKey)?.plate ?? w.plate) ?? "";
    // Relatório do armazém: matrícula real + comparação com a hora da carga
    const wf = whPlateFixes.get(w.rota);
    if (wf) {
      if (cols.plateCol) w.out[cols.plateCol] = wf.to;
      w.out[VV_COL] = wf.from ?? "";
      w.real =
        `Matrícula corrigida pelo relatório do armazém: ${wf.to} (folha: ${wf.from ?? "sem matrícula"}).` +
        (w.real ? ` ${w.real}` : "");
    }
    if (warehouse) {
      const cmp = compareWarehouse(w);
      w.out[ARMAZEM_COL] = cmp.text;
      if (cmp.verdict === "disagree") {
        whDisagree++;
        w.conf = REVIEW;
        w.real = (w.real ? `${w.real} ` : "") + cmp.note;
      } else if (cmp.verdict === "agree") whAgree++;
      else if (cmp.verdict === "blank") {
        whBlank++;
        w.real = (w.real ? `${w.real} ` : "") + cmp.note;
      }
    }
    w.out[CONFIANCA_COL] = w.conf || REVIEW;
    // A row whose input Chegada/Saída were rejected as an implausible pre-fill
    // (see placeholderNote above) always carries that explanation — prepended
    // ahead of whatever the normal match produced, even "OK" (a real stop was
    // found; the note documents that the file's own value was overridden).
    w.out[REAL_COL] = w.placeholderNote
      ? w.placeholderNote + (w.real ? ` ${w.real}` : "")
      : w.real || "";

    if (w.conf === "OK") ok++;
    else if (w.conf === SWAP) swap++;
    else if (w.conf === SWAP_OUT_OF_WINDOW) swapOutOfWindow++;
    else if (w.conf === PLATE_TYPO) plateTypo++;
    else if (w.conf === TRACKIT_FALLBACK) trackitFallback++;
    else review++;
  }

  // 5th visual signaling rule: detect physical schedule overlaps between rows
  // of the same route & plate at different store codes (not co-located/merged).
  // Stamps conflict warning in REAL_COL; leaves times and Confiança untouched.
  detectScheduleConflicts({
    items: works
      .filter((w) => !w.empty)
      .map((w) => ({
        idx: w.idx,
        out: w.out,
        route: String(w.out[cols.rotaCol] ?? w.rota ?? "").trim(),
        plate: cols.plateCol
          ? String(w.out[cols.plateCol] ?? "")
          : w.swapPlate || w.plate,
        code: w.code,
        name: cols.nomeCol ? String(w.out[cols.nomeCol] ?? "") : undefined,
      })),
    chegadaCol: cols.chegadaCol,
    saidaCol: cols.saidaCol,
    defaultDay: day,
    coLocatedGroups,
  });

  // 6th visual signaling rule: physical speed plausibility between a
  // vehicle's own CONSECUTIVE stops, day-wide (every route/leg together, not
  // scoped to one route like the conflict rule above). Stamps a distinct
  // warning in REAL_COL; leaves times and Confiança untouched.
  detectImplausibleSpeed({
    items: works
      .filter((w) => !w.empty)
      .map((w) => ({
        idx: w.idx,
        out: w.out,
        plate: cols.plateCol
          ? String(w.out[cols.plateCol] ?? "")
          : w.swapPlate || w.plate,
        code: w.code,
      })),
    chegadaCol: cols.chegadaCol,
    saidaCol: cols.saidaCol,
    defaultDay: day,
    coLocatedGroups,
    codeCoords,
  });

  const routesOk = [...routeMap.values()].filter(
    (rg) => rg.length > 0 && rg.every((g) => g.conf === "OK"),
  ).length;

  return {
    rows: works.map((w) => w.out),
    header: outHeader,
    summary: {
      planRows: planMatched,
      total: ok + review + kept + swap + swapOutOfWindow + plateTypo + trackitFallback,
      ok,
      review,
      kept,
      passthrough,
      swap,
      swapOutOfWindow,
      plateTypo,
      trackitFallback,
      routes: routeMap.size,
      routesOk,
      ...(warehouse
        ? {
            warehouse: {
              linked: whLinked,
              plateFixes: whPlateFixes.size,
              agree: whAgree,
              disagree: whDisagree,
              blank: whBlank,
            },
          }
        : {}),
    },
    pendingTrackitPlates: [...pendingTrackitPlates],
  };
}
