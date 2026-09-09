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
//      day from OUR data (stops ↔ vehicle_pings.plate — all TRACKiT accounts;
//      vehicle_id is company-wide and it's one shared fleet), sort them by
//      arrival, and pair them positionally to the plate's store-groups in sheet
//      order. When the stop count matches the store count and the codes line
//      up, those groups are "OK"; otherwise "⚠️ Rever manualmente".
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
  findVehicleSwap,
  fmtDateTimeLisbon,
  fmtDuration,
  fmtHM,
  noGpsCoverageNote,
  normalizePlate,
  parseClockMin,
  parseServiceDay,
  pick,
  plannedPlateHasCoverage,
  REAL_COL,
  REVIEW,
  type SheetRecord,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  SWAP_WINDOW_PAD_MIN,
  type SwapRival,
  type WStop,
} from "@/lib/sheet-match/common";

export { CONFIANCA_COL, REAL_COL, REVIEW, SWAP, SWAP_OUT_OF_WINDOW, parseServiceDay };
export type { DayStop, SheetRecord };

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
  /** blank rows passed through untouched */
  passthrough: number;
  /** rows flagged "🔄 Possível troca de viatura" */
  swap: number;
  /** rows flagged "🔄❗ Possível troca (fora da janela)" */
  swapOutOfWindow: number;
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
//
// Our stops are queried for the service day only (00:00–24:00 Lisbon), so we
// collapse a cross-midnight cycle to the part we can actually observe:
//   "…-1 | HH:MM"  -> 00:00 .. HH:MM   (overnight tail on the service day)
//   "HH:MM | …+1"  -> HH:MM .. 23:59   (daytime head on the service day)
// The ±3h swap pad (SWAP_WINDOW_PAD_MIN) absorbs the rest of the slop. Returns
// two "HH:MM" strings, or "" when CICLO isn't a time window.
export function parseCiclo(raw: unknown): { ini: string; fim: string } {
  const s = String(raw ?? "").trim();
  const m = s.match(
    /^(\d{1,2}:\d{2})\s*([+-]\d)?\s*\|\s*(\d{1,2}:\d{2})\s*([+-]\d)?$/,
  );
  if (!m) return { ini: "", fim: "" };
  const [, iniHM, iniOff, fimHM, fimOff] = m;
  const iniMin = parseClockMin(iniHM);
  const fimMin = parseClockMin(fimHM);
  if (iniMin == null || fimMin == null) return { ini: "", fim: "" };

  const startsPrevDay = iniOff === "-1";
  const endsNextDay = fimOff === "+1";
  const wrapsWithoutMarker = !startsPrevDay && !endsNextDay && iniMin > fimMin;

  if (startsPrevDay || wrapsWithoutMarker) return { ini: "00:00", fim: fimHM };
  if (endsNextDay) return { ini: iniHM, fim: "23:59" };
  return { ini: iniHM, fim: fimHM };
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
  conf: "" | "OK" | typeof REVIEW | typeof SWAP | typeof SWAP_OUT_OF_WINDOW;
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

  const outHeader = [...header];
  for (const c of [cols.chegadaCol, cols.saidaCol, CONFIANCA_COL, REAL_COL]) {
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

    return {
      idx,
      out: { ...r },
      empty,
      rota,
      code,
      designacao,
      rawPlate,
      plate,
      planIni: ciclo.ini,
      planFim: ciclo.fim,
      groupKey: `${rota} ${codeKey(code)}`,
      conf: "",
      real: "",
      swapPlate: null,
      assignedStop: null,
    };
  });

  // ----- build (ROTA, N_LOJA) store-groups, in sheet order -----
  const groupMap = new Map<string, StoreGroup>();
  for (const w of works) {
    if (w.empty) continue;
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

  // ----- Step 1/2: positional pairing, per PLATE -----
  //
  // A plate is one physical vehicle with one timeline of stops for the day. If
  // it runs two routes in the sheet, those routes' stores are just earlier and
  // later legs of the same run — pooling the store-groups by plate (kept in
  // sheet order) and pairing them against that plate's stops (in time order)
  // handles a multi-route vehicle without the first route eating all its stops.
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

    const pairCount = Math.min(plateGroups.length, plateStops.length);
    // "clean" = every store-group got a stop, every stop got a store-group, and
    // no positional pair has two codes that clearly disagree.
    let codesLineUp = true;
    for (let i = 0; i < pairCount; i++) {
      const g = plateGroups[i];
      const s = plateStops[i];
      if (g.code && s.code && !codeEq(g.code, s.code)) codesLineUp = false;
    }
    const clean =
      plateGroups.length === plateStops.length &&
      plateStops.length > 0 &&
      codesLineUp;

    for (let i = 0; i < pairCount; i++) {
      const g = plateGroups[i];
      const s = plateStops[i];
      s.assigned = true;
      setGroup(g, clean ? "OK" : REVIEW, s, clean ? "" : describeReal(plate));
    }
    // leftover store-groups (more stores than stops seen) stay conf === "" for
    // step 3.
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
  let passthrough = 0;
  let swap = 0;
  let swapOutOfWindow = 0;
  for (const w of works) {
    if (w.empty) {
      if (!(CONFIANCA_COL in w.out)) w.out[CONFIANCA_COL] = "";
      if (!(REAL_COL in w.out)) w.out[REAL_COL] = "";
      passthrough++;
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
    // On a swap suggestion, replace the sheet's plate with the suggested one
    // (same as the TFS sheet). Otherwise leave MATRICULA as the transporter
    // wrote it.
    if (
      (w.conf === SWAP || w.conf === SWAP_OUT_OF_WINDOW) &&
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
    else review++;
  }

  const routesOk = [...routeMap.values()].filter(
    (rg) => rg.length > 0 && rg.every((g) => g.conf === "OK"),
  ).length;

  return {
    rows: works.map((w) => w.out),
    header: outHeader,
    summary: {
      total: ok + review + swap + swapOutOfWindow,
      ok,
      review,
      passthrough,
      swap,
      swapOutOfWindow,
      routes: routeMap.size,
      routesOk,
    },
  };
}
