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
//   1. Group rows by (ROTA, N_LOJA). The same store listed twice in a route
//      (a "C" delivery + a "D" devolution, or two "C" lines) is ONE physical
//      stop — every row in the group gets the same Chegada/Saída.
//
//   2. Per PLATE (a plate is one physical vehicle; if it runs two routes those
//      are just earlier/later legs of one run): take that plate's stops for the
//      day from OUR data (stops ↔ vehicle_pings.plate — all TRACKiT accounts,
//      deduped; vehicle_id is company-wide and it's one shared fleet). For each
//      store-group, in sheet order, claim the earliest still-unassigned stop of
//      that plate whose location code matches (codeEq) → "OK". The plate's
//      depot/workshop stops (not on the sheet) and out-of-order driving are
//      simply ignored. Same principle as the TFS matcher.
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
  codeEq,
  codeKey,
  CONFIANCA_COL,
  type DayStop,
  dedupeStops,
  findPlateTypo,
  findVehicleSwap,
  fmtDateTimeLisbon,
  fmtDuration,
  fmtHM,
  KEPT,
  lisbonEpoch,
  noGpsCoverageNote,
  normalizePlate,
  parseClockMin,
  parseServiceDay,
  pick,
  PLATE_TYPO,
  plannedPlateHasCoverage,
  plateTypoNote,
  REAL_COL,
  REVIEW,
  type RouteStore,
  type SheetRecord,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  SWAP_WINDOW_PAD_MIN,
  type SwapRival,
  type WStop,
} from "@/lib/sheet-match/common";

export {
  CONFIANCA_COL,
  REAL_COL,
  REVIEW,
  KEPT,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
  dedupeStops,
  parseServiceDay,
};
export type { DayStop, SheetRecord };

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
  /** our own "Dia Serviço" column, present only on a re-uploaded output */
  diaCol: string | null;
  /** existing header if found, else the canonical name to add */
  chegadaCol: string;
  saidaCol: string;
  errors: string[];
};

export type MatchSummary = {
  /** data rows considered (blank rows excluded) */
  total: number;
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
  /** distinct (ROTA) count and how many matched cleanly */
  routes: number;
  routesOk: number;
};

export type RunMatchArgs = {
  day: string; // YYYY-MM-DD
  records: SheetRecord[];
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
};

export type RunMatchResult = {
  rows: SheetRecord[];
  header: string[];
  summary: MatchSummary;
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
// free-text label ("Noturno", "Crossdocking peixe") we can't use.

const CICLO_RE =
  /^(\d{1,2}:\d{2})\s*([+-]\d)?\s*\|\s*(\d{1,2}:\d{2})\s*([+-]\d)?$/;

// Shared parse of a time-window CICLO. Returns the two ends as minutes since
// midnight plus which calendar day each falls on relative to the SERVICE day
// (0 = service day, -1 = the day before, +1 = the day after). null for a
// free-text CICLO. A wrap with no explicit marker ("20:00 | 08:00") is read as
// starting the previous day, same as an explicit "-1".
function matchCiclo(raw: unknown): {
  startOffsetDays: number;
  startMin: number;
  endOffsetDays: number;
  endMin: number;
} | null {
  const m = String(raw ?? "").trim().match(CICLO_RE);
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

// Epoch-ms [lo, hi) bounds for the stops/pings query on a given service day.
//
// Base: the strict service day skirted by `skirtMs` on each side (evening
// starts, past-midnight finishes). On top of that, any CICLO whose shift
// *starts the previous calendar day* ("…-1 | …") or *ends the next one*
// ("… | …+1") pushes the bound out to that real shift day + `padMs`, so an
// early overnight start ("18:00-1 …", 6h before midnight) isn't clipped by a
// fixed skirt. Free-text CICLOs contribute nothing (the base skirt still
// applies).
export function stopQueryWindowMs(
  day: string, // YYYY-MM-DD
  ciclos: Iterable<unknown>,
  opts: { skirtMs?: number; padMs?: number } = {},
): { loMs: number; hiMs: number } {
  const skirtMs = opts.skirtMs ?? 4 * 3_600_000;
  const padMs = opts.padMs ?? 3 * 3_600_000;

  let loMs = lisbonEpoch(day, 0) - skirtMs;
  let hiMs = lisbonEpoch(day, 24 * 60) + skirtMs;

  for (const raw of ciclos) {
    const sp = matchCiclo(raw);
    if (!sp) continue;
    if (sp.startOffsetDays < 0) {
      const t = lisbonEpoch(day, sp.startOffsetDays * 24 * 60 + sp.startMin) - padMs;
      if (t < loMs) loMs = t;
    }
    if (sp.endOffsetDays > 0) {
      const t = lisbonEpoch(day, sp.endOffsetDays * 24 * 60 + sp.endMin) + padMs;
      if (t > hiMs) hiMs = t;
    }
  }
  return { loMs, hiMs };
}

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
  /** the (ROTA, N_LOJA) store-group this row belongs to */
  groupKey: string;
  conf:
    | ""
    | "OK"
    | typeof REVIEW
    | typeof KEPT
    | typeof SWAP
    | typeof SWAP_OUT_OF_WINDOW
    | typeof PLATE_TYPO;
  real: string;
  swapPlate: string | null;
  assignedStop: WStop | null;
};

type StoreGroup = {
  key: string;
  rota: string;
  code: string;
  designacao: string;
  plate: string | null;
  planIni: string;
  planFim: string;
  order: number; // first row index, for sheet order
  rows: Work[];
  assignedStop: WStop | null;
  conf: Work["conf"];
};

export function runMatch(args: RunMatchArgs): RunMatchResult {
  const { day, records, header, cols, platesWithGps } = args;
  const pingWindowByPlate = args.pingWindowByPlate ?? new Map();
  const stops: WStop[] = args.stops.map((s) => ({ ...s, assigned: false }));

  // Candidate pool for the plate-typo check: plates with real GPS stops today.
  const platesWithDayStops = new Set<string>();
  for (const s of stops) if (s.plate) platesWithDayStops.add(s.plate);

  const diaCol = cols.diaCol ?? DIA_COL;
  const outHeader = [...header];
  for (const c of [diaCol, cols.chegadaCol, cols.saidaCol, CONFIANCA_COL, REAL_COL]) {
    if (!outHeader.includes(c)) outHeader.push(c);
  }

  const works: Work[] = records.map((r, idx) => {
    const rota = String(r[cols.rotaCol] ?? "").trim();
    const code = String(r[cols.codeCol] ?? "").trim();
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

    const ciclo = cols.cicloCol ? parseCiclo(r[cols.cicloCol]) : { ini: "", fim: "" };

    // Row already carries BOTH times in the uploaded file -> resolved elsewhere;
    // keep it verbatim and skip grouping + every matching step.
    const kept =
      !empty &&
      String(r[cols.chegadaCol] ?? "").trim() !== "" &&
      String(r[cols.saidaCol] ?? "").trim() !== "";

    return {
      idx,
      out: { ...r },
      empty,
      kept,
      rota,
      code,
      designacao,
      rawPlate,
      plate,
      planIni: ciclo.ini,
      planFim: ciclo.fim,
      groupKey: `${rota} ${codeKey(code)}`,
      conf: kept ? KEPT : "",
      real: "",
      swapPlate: null,
      assignedStop: null,
    };
  });

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
        order: w.idx,
        rows: [],
        assignedStop: null,
        conf: "",
      };
      groupMap.set(w.groupKey, g);
    }
    g.rows.push(w);
    // a later row in the group may carry the plate/ciclo the first one lacked
    if (!g.plate && w.plate) g.plate = w.plate;
    if (!g.planIni && w.planIni) g.planIni = w.planIni;
    if (!g.planFim && w.planFim) g.planFim = w.planFim;
    if (!g.designacao && w.designacao) g.designacao = w.designacao;
  }
  const groups = [...groupMap.values()];

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
  // depot/workshop stops that aren't on the sheet, and the sheet's row order
  // isn't the driving order — so a positional zip doesn't work. Instead, for
  // each store-group (in sheet order) take the earliest still-unassigned stop
  // of that plate whose location code matches (codeEq). Extra stops are simply
  // left over; order doesn't matter. Same principle as the TFS matcher.
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

  for (const [plate, plateGroups] of byPlate) {
    plateGroups.sort((a, b) => a.order - b.order);
    const plateStops = stops
      .filter((s) => s.plate === plate)
      .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));

    for (const g of plateGroups) {
      if (!g.code) {
        setGroup(g, REVIEW, null, describeReal(plate));
        continue;
      }
      const hit = plateStops.find((s) => !s.assigned && codeEq(s.code, g.code));
      if (hit) {
        hit.assigned = true;
        setGroup(g, "OK", hit, "");
      }
      // no code match -> leave conf === "" for step 3 (swap) / step 4 (review)
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
        });
        if (typo) {
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
    });
    if (!sw) continue;

    if (sw.kind === "no-gps-coverage") {
      setGroup(g, REVIEW, null, sw.note);
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
  for (const g of groups) {
    if (g.conf !== "") continue;
    setGroup(
      g,
      REVIEW,
      null,
      g.plate
        ? describeReal(g.plate)
        : "Sem matrícula utilizável para esta rota.",
    );
  }

  // ----- write back -----
  let ok = 0;
  let review = 0;
  let kept = 0;
  let passthrough = 0;
  let swap = 0;
  let swapOutOfWindow = 0;
  let plateTypo = 0;
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
    // Row that arrived with both times filled: keep Chegada/Saída/MATRICULA
    // exactly as they came in. Only «Dia Serviço» (stamped above) and the two
    // derived columns are written.
    if (w.kept) {
      w.out[CONFIANCA_COL] = KEPT;
      w.out[REAL_COL] = "";
      kept++;
      continue;
    }
    // Always (re)write the two time columns so the output reflects only our
    // matching: "DD/MM/YYYY HH:MM" (Lisbon) when a stop was matched, blank
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
    w.out[CONFIANCA_COL] = w.conf || REVIEW;
    w.out[REAL_COL] = w.real || "";

    if (w.conf === "OK") ok++;
    else if (w.conf === SWAP) swap++;
    else if (w.conf === SWAP_OUT_OF_WINDOW) swapOutOfWindow++;
    else if (w.conf === PLATE_TYPO) plateTypo++;
    else review++;
  }

  const routesOk = [...routeMap.values()].filter(
    (rg) => rg.length > 0 && rg.every((g) => g.conf === "OK"),
  ).length;

  return {
    rows: works.map((w) => w.out),
    header: outHeader,
    summary: {
      total: ok + review + kept + swap + swapOutOfWindow + plateTypo,
      ok,
      review,
      kept,
      passthrough,
      swap,
      swapOutOfWindow,
      plateTypo,
      routes: routeMap.size,
      routesOk,
    },
  };
}
