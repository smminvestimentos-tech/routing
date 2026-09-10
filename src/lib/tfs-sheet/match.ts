// Matching engine for the TFS delivery sheet (/dashboard/tfs-sheet).
//
// Pure — no framework, no DB, no xlsx. The route parses the workbook and loads
// `stops` / `vehicle_pings` / `fleet_trucks`, hands the plain data here, and
// writes the result back to a workbook. Keeping it isolated makes the "by
// elimination" logic testable on its own.
//
// Layout-agnostic pieces (store-code equality, clock/window helpers, the
// "HH:MM" formatters, the vehicle-swap detector) live in
// src/lib/sheet-match/common.ts and are shared with the Azambuja matcher.
//
// The logic, in order:
//
//   1. Rows that already carry a plate ("Matrícula da Viatura") are joined
//      straight to that plate's stops for the day, then paired to the stop
//      whose store code matches "Código de Loja". Those stops are consumed.
//
//   2. Rows with no plate look their truck number up in `fleet_trucks`
//      (nº → matrícula) as a *candidate* plate, and are only confirmed if that
//      plate still has an unconsumed stop that day whose store code matches.
//      A plate can also come from the "ID" column (see extractPlateFromId).
//
//   3. Rows whose resolved plate matched no stop: if a *leftover* stop at the
//      right store and a plausible time belongs to a DIFFERENT vehicle — and no
//      rival sheet row on a GPS-tracked vehicle was planned for that same
//      store/window — the row is flagged "🔄 Possível troca de viatura" with
//      the suggested plate + times.
//
//   4. Anything still ambiguous, unmatched, or with no data of ours to back it
//      up is flagged "⚠️ Rever manualmente", and the "Real" column is filled
//      with what our data actually shows for that truck/day (stores + times) so
//      the user can tell a swapped store from a mis-assigned truck from a gap
//      in our tracking.

import {
  codeEq,
  codeKey,
  CONFIANCA_COL,
  type DayStop,
  dedupeStops,
  findPlateTypo,
  findVehicleSwap,
  fmtDuration,
  fmtHM,
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
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
  codeEq,
  dedupeStops,
  fmtHM,
  parseClockMin,
  parseServiceDay,
};
export type { DayStop, SheetRecord };

// The columns the TFS sheet is expected to carry, in its own order. Shown in
// the UI as a reference; matching itself is accent/spacing tolerant.
export const EXPECTED_COLUMNS = [
  "Dia do Serviço",
  "Nº Camião",
  "Matrícula da Viatura",
  "Transportador",
  "Volta da Viatura",
  "Ordem de Entrega",
  "Código de Loja",
  "Designação da Loja",
  "Janela Início",
  "Janela Fim",
  "Hora de Chegada",
  "Hora de Saída",
  "ID",
  "Entreposto",
] as const;

export type ResolvedColumns = {
  dayCol: string;
  truckCol: string | null;
  plateCol: string | null;
  codeCol: string;
  designacaoCol: string | null;
  ordemCol: string | null;
  /** "ID" column — {Transportador}-{Nº}-{Matrícula}-{Volta}ªRota-{Data} */
  idCol: string | null;
  janIniCol: string | null;
  janFimCol: string | null;
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
  /** rows where the ID plate and fleet_trucks plate disagreed */
  discrepancy: number;
  /** rows flagged "🔄 Possível troca de viatura" */
  swap: number;
  /** rows flagged "🔄❗ Possível troca (fora da janela)" */
  swapOutOfWindow: number;
  /** rows flagged "🔤 Possível erro de matrícula" (one-char plate slip) */
  plateTypo: number;
};

export type RunMatchArgs = {
  day: string; // YYYY-MM-DD
  records: SheetRecord[];
  header: string[];
  cols: ResolvedColumns;
  stops: DayStop[];
  /** normalizeTruck(nº) -> normalizePlate(matrícula) */
  fleetByTruck: Map<string, string>;
  /**
   * Every plate that appears in vehicle_pings on ANY day (normalised). Used to
   * decide whether a rival sheet row's vehicle is real competition for a swap
   * suggestion, or a GPS-less ghost to ignore.
   */
  platesWithGps: Set<string>;
  /**
   * normalised plate -> [min, max] epoch-ms of that plate's pings in the
   * loaded day window. Gates swap suggestions: no coverage around a candidate
   * stop -> "sem cobertura GPS", not a guess.
   */
  pingWindowByPlate: Map<string, { min: number; max: number }>;
};

export type RunMatchResult = {
  rows: SheetRecord[];
  header: string[];
  summary: MatchSummary;
};

// ---------------------------------------------------------------------------
// Small helpers (TFS-specific)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// nº do camião: upper, alphanumerics only, no leading zeros. Applied on both
// sides so "07" in the sheet finds "7" in fleet_trucks.
export function normalizeTruck(raw: string): string {
  return String(raw)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^0+(?=.)/, "");
}

// The "ID" column is {Transportador}-{Nº}-{Matrícula}-{Volta}ªRota-{Data}.
// The transportador can itself contain spaces or hyphens ("TFS ALGARVE"), so
// the only safe way to isolate the plate is to anchor on the Nº Camião (which
// we already have as its own column) and read the alphanumeric run right after
// it. Returns the normalised plate, or null when the ID doesn't parse.
export function extractPlateFromId(
  id: unknown,
  truckNumber: string,
): string | null {
  if (id == null) return null;
  const s = String(id).trim();
  const truck = String(truckNumber).trim();
  if (!s || !truck) return null;

  // tolerate leading zeros on either side ("025" vs "25")
  const anchor = `-\\s*0*${escapeRegExp(truck.replace(/^0+(?=\d)/, ""))}\\s*-\\s*`;
  // primary: plate sits between the Nº anchor and the "-{volta}ªRota" tail.
  // The plate segment is non-greedy and tolerates an internal space/hyphen
  // ("12-HU92" -> "12HU92"); normalizePlate strips those. The trailing
  // "-{digits}...Rota" is a hard right boundary, so the lazy match can't
  // overrun. [^0-9A-Za-z\s]{0,3} soaks up the "ª" ordinal literally-free.
  const precise = new RegExp(
    `${anchor}([A-Za-z0-9][A-Za-z0-9 -]{2,12}?[A-Za-z0-9])\\s*-\\s*\\d+\\s*[^0-9A-Za-z\\s]{0,3}\\s*Rota`,
    "i",
  );
  // fallback: just the alphanumeric run right after the Nº anchor.
  const loose = new RegExp(`${anchor}([A-Za-z0-9]{5,8})\\s*-`, "i");

  const m = s.match(precise) ?? s.match(loose);
  if (!m) return null;
  const plate = normalizePlate(m[1]);
  return plate.length >= 5 && plate.length <= 9 ? plate : null;
}

// The sheet must be a single service day (see the request). Returns the day, or
// an error message describing why not.
export function collectServiceDay(
  records: SheetRecord[],
  dayCol: string,
): { day: string } | { error: string } {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const r of records) {
    const raw = r[dayCol];
    if (raw == null || String(raw).trim() === "") continue;
    const d = parseServiceDay(raw);
    if (!d) {
      bad.push(String(raw));
      continue;
    }
    seen.add(d);
  }
  if (seen.size === 0) {
    return {
      error: bad.length
        ? `Não consegui interpretar nenhuma data em «Dia do Serviço» (ex.: «${bad[0]}»).`
        : "A coluna «Dia do Serviço» está vazia.",
    };
  }
  if (seen.size > 1) {
    return {
      error: `A folha tem ${seen.size} dias de serviço (${[...seen]
        .sort()
        .join(", ")}). Carrega um dia de cada vez.`,
    };
  }
  return { day: [...seen][0] };
}

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

  const dayCol = take(
    "dia do servico",
    "data do servico",
    "dia servico",
    "data servico",
    "dia",
  );
  const plateCol = take(
    "matricula da viatura",
    "matricula viatura",
    "matricula",
  );
  const truckCol = take(
    "n camiao",
    "no camiao",
    "numero do camiao",
    "numero camiao",
    "nr camiao",
    "camiao",
  );
  const codeCol = take(
    "codigo de loja",
    "codigo loja",
    "cod loja",
    "codigo da loja",
    "codigo",
  );
  const designacaoCol = take(
    "designacao da loja",
    "designacao loja",
    "designacao",
    "nome da loja",
  );
  const ordemCol = take("ordem de entrega", "ordem entrega", "ordem");
  const janIniCol = take("janela inicio", "janela ini", "inicio janela");
  const janFimCol = take("janela fim", "janela fim loja", "fim janela");
  const chegadaCol = take("hora de chegada", "hora chegada", "chegada");
  const saidaCol = take("hora de saida", "hora saida", "saida");
  const idCol = take("id");

  const errors: string[] = [];
  if (!dayCol) errors.push("Falta a coluna «Dia do Serviço».");
  if (!codeCol) errors.push("Falta a coluna «Código de Loja».");
  if (!plateCol && !truckCol) {
    errors.push(
      "Falta «Matrícula da Viatura» e «Nº Camião» — é preciso pelo menos uma.",
    );
  }

  return {
    dayCol: dayCol ?? "",
    truckCol,
    plateCol,
    codeCol: codeCol ?? "",
    designacaoCol,
    ordemCol,
    idCol,
    janIniCol,
    janFimCol,
    chegadaCol: chegadaCol ?? "Hora de Chegada",
    saidaCol: saidaCol ?? "Hora de Saída",
    errors,
  };
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

type Work = {
  idx: number;
  out: SheetRecord;
  empty: boolean;
  /** resolved candidate plate (normalised) */
  plate: string | null;
  //  sheet  — plate came from the "Matrícula da Viatura" column
  //  id     — extracted from the "ID" column (authoritative, TFS-assigned)
  //  fleet  — looked up in fleet_trucks by nº (a hint, may be stale)
  //  discrepancy — ID and fleet_trucks disagreed; not resolved on purpose
  //  none   — no plate anywhere
  source: "sheet" | "id" | "fleet" | "discrepancy" | "none";
  rawTruck: string;
  rawPlate: string;
  code: string;
  designacao: string;
  ordem: number;
  planIni: string | number;
  planFim: string | number;
  /** set when source === "discrepancy" */
  idPlate: string | null;
  fleetPlate: string | null;
  /** suggested plate when conf === SWAP / SWAP_OUT_OF_WINDOW / PLATE_TYPO */
  swapPlate: string | null;
  conf:
    | ""
    | "OK"
    | typeof REVIEW
    | typeof SWAP
    | typeof SWAP_OUT_OF_WINDOW
    | typeof PLATE_TYPO;
  real: string;
  assignedStop: WStop | null;
};

export function runMatch(args: RunMatchArgs): RunMatchResult {
  const { day, records, header, cols, fleetByTruck, platesWithGps } = args;
  const pingWindowByPlate = args.pingWindowByPlate ?? new Map();
  const stops: WStop[] = args.stops.map((s) => ({ ...s, assigned: false }));

  const outHeader = [...header];
  for (const c of [cols.chegadaCol, cols.saidaCol, CONFIANCA_COL, REAL_COL]) {
    if (!outHeader.includes(c)) outHeader.push(c);
  }

  const works: Work[] = records.map((r, idx) => {
    const out: SheetRecord = { ...r };
    const rawPlate = cols.plateCol
      ? String(r[cols.plateCol] ?? "").trim()
      : "";
    const rawTruck = cols.truckCol
      ? String(r[cols.truckCol] ?? "").trim()
      : "";
    const code = String(r[cols.codeCol] ?? "").trim();
    const designacao = cols.designacaoCol
      ? String(r[cols.designacaoCol] ?? "").trim()
      : "";
    const empty = !rawPlate && !rawTruck && !code && !designacao;

    let plate: string | null = null;
    let source: Work["source"] = "none";
    let idPlate: string | null = null;
    let fleetPlate: string | null = null;

    if (rawPlate) {
      const np = normalizePlate(rawPlate);
      if (np) {
        plate = np;
        source = "sheet";
      }
    }

    if (!plate && rawTruck) {
      idPlate = cols.idCol
        ? extractPlateFromId(r[cols.idCol], rawTruck)
        : null;
      fleetPlate = fleetByTruck.get(normalizeTruck(rawTruck)) ?? null;

      if (idPlate && fleetPlate && idPlate !== fleetPlate) {
        // both sources have an opinion and they differ — refuse to guess
        source = "discrepancy";
      } else if (idPlate) {
        plate = idPlate; // wins even when it agrees with fleet_trucks
        source = "id";
      } else if (fleetPlate) {
        plate = fleetPlate;
        source = "fleet";
      }
    }

    const ordemDigits = cols.ordemCol
      ? String(r[cols.ordemCol] ?? "").replace(/[^\d]/g, "")
      : "";
    const ordem = ordemDigits ? Number(ordemDigits) : idx + 1;

    return {
      idx,
      out,
      empty,
      plate,
      source,
      rawTruck,
      rawPlate,
      code,
      designacao,
      ordem,
      planIni: cols.janIniCol
        ? (r[cols.janIniCol] as string | number) ?? ""
        : "",
      planFim: cols.janFimCol
        ? (r[cols.janFimCol] as string | number) ?? ""
        : "",
      idPlate,
      fleetPlate,
      swapPlate: null,
      conf: "",
      real: "",
      assignedStop: null,
    };
  });

  const stopsForPlate = (plate: string) =>
    stops
      .filter((s) => s.plate === plate)
      .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));

  // What our data shows for this truck/day — the "Real" column.
  const describeReal = (plate: string | null): string => {
    if (!plate) return "";
    const ss = stopsForPlate(plate);
    if (ss.length === 0) return `Sem paragens nossas para ${plate} em ${day}.`;
    return ss
      .map(
        (s) =>
          `${s.code ?? "?"} ${fmtHM(s.arrivedAt)}–${fmtHM(s.departedAt) || "?"}`,
      )
      .join("; ");
  };

  // Pair a plate's rows to its remaining code-matching stops, in time order.
  const assignGroup = (groupWorks: Work[]) => {
    const plate = groupWorks[0].plate;
    if (!plate) return;

    const byCode = new Map<string, Work[]>();
    for (const w of groupWorks) {
      const k = codeKey(w.code);
      const arr = byCode.get(k);
      if (arr) arr.push(w);
      else byCode.set(k, [w]);
    }

    for (const gw of byCode.values()) {
      const rowsG = [...gw].sort((a, b) => a.ordem - b.ordem || a.idx - b.idx);
      const code = rowsG[0].code;
      const stopsG = stops
        .filter((s) => !s.assigned && s.plate === plate && codeEq(s.code, code))
        .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
      const clean = stopsG.length > 0 && stopsG.length === rowsG.length;

      rowsG.forEach((w, i) => {
        const st = stopsG[i] ?? null;
        if (st) {
          st.assigned = true;
          w.assignedStop = st;
          if (clean) {
            w.conf = "OK";
          } else {
            w.conf = REVIEW;
            w.real = describeReal(plate);
          }
        } else {
          w.conf = REVIEW;
          w.real = describeReal(plate);
        }
      });
    }
  };

  const groupByPlate = (predicate: (w: Work) => boolean) => {
    const m = new Map<string, Work[]>();
    for (const w of works) {
      if (w.empty || w.conf || !w.plate || !predicate(w)) continue;
      const arr = m.get(w.plate);
      if (arr) arr.push(w);
      else m.set(w.plate, [w]);
    }
    return m;
  };

  // Step 1 — rows with a trusted plate: from the sheet column, or extracted
  // from the ID string (TFS-assigned, authoritative).
  for (const gw of groupByPlate(
    (w) => w.source === "sheet" || w.source === "id",
  ).values()) {
    assignGroup(gw);
  }
  // Step 2 — rows relying on fleet_trucks; only unconsumed stops are eligible.
  for (const gw of groupByPlate((w) => w.source === "fleet").values()) {
    assignGroup(gw);
  }

  // Step 3 — "possível troca de viatura". A row whose resolved plate matched no
  // stop, but a leftover stop at the right store and a plausible time belongs
  // to a *different* vehicle. Tuned on the 07/09 case: camião 206 planned as
  // BM94RL for E89, but BN20PG is the one that actually stopped there.
  const storeLabel = (w: Work) =>
    w.designacao ? `${w.code} (${w.designacao})` : w.code;

  // Candidate pool for the plate-typo check: plates with real GPS stops today.
  const platesWithDayStops = new Set<string>();
  for (const s of stops) if (s.plate) platesWithDayStops.add(s.plate);

  // Each truck's planned stores, in delivery order — the run a look-alike plate
  // has to corroborate for a "🔤 Possível erro de matrícula".
  const routeStoresByTruck = new Map<string, RouteStore[]>();
  {
    const acc = new Map<string, { s: RouteStore; ordem: number; idx: number }[]>();
    for (const w of works) {
      if (w.empty || !w.rawTruck || !w.code) continue;
      const arr = acc.get(w.rawTruck) ?? [];
      arr.push({
        s: { code: w.code, planIni: w.planIni, planFim: w.planFim },
        ordem: w.ordem,
        idx: w.idx,
      });
      acc.set(w.rawTruck, arr);
    }
    for (const [truck, arr] of acc) {
      arr.sort((a, b) => a.ordem - b.ordem || a.idx - b.idx);
      routeStoresByTruck.set(truck, arr.map((x) => x.s));
    }
  }

  for (const w of works) {
    if (
      w.empty ||
      w.assignedStop ||
      !w.plate ||
      !w.code ||
      w.source === "discrepancy" ||
      (w.conf !== "" && w.conf !== REVIEW)
    ) {
      continue;
    }

    // No GPS of ours covering this vehicle's planned delivery window -> we
    // can't tell if it made the stop itself, so don't guess a swap.
    if (
      !plannedPlateHasCoverage(
        pingWindowByPlate.get(w.plate) ?? null,
        day,
        w.planIni,
        w.planFim,
        SWAP_WINDOW_PAD_MIN,
      )
    ) {
      // The extracted plate isn't in our GPS feed at all — not a real vehicle
      // we just failed to follow. Try a one-character transcription slip: a
      // single look-alike plate that genuinely drove this route today.
      if (!platesWithGps.has(w.plate)) {
        const typo = findPlateTypo({
          plate: w.plate,
          code: w.code,
          planIni: w.planIni,
          planFim: w.planFim,
          routeStores: routeStoresByTruck.get(w.rawTruck) ?? [],
          stops,
          candidatePlates: platesWithDayStops,
        });
        if (typo) {
          w.conf = PLATE_TYPO;
          w.swapPlate = typo.suggPlate;
          typo.suggStop.assigned = true;
          w.assignedStop = typo.suggStop;
          w.real = plateTypoNote(
            w.plate,
            typo.suggPlate,
            typo.run,
            w.source === "id"
              ? "coluna ID"
              : w.source === "fleet"
                ? "fleet_trucks"
                : "folha",
          );
          continue;
        }
      }
      w.conf = REVIEW;
      w.real = noGpsCoverageNote(w.plate, platesWithGps.has(w.plate));
      continue;
    }

    const rivals: SwapRival[] = works
      .filter((c) => c !== w && !c.empty)
      .map((c) => ({
        code: c.code,
        planIni: c.planIni,
        planFim: c.planFim,
        plate: c.plate,
        label: c.rawTruck,
        assignedStop: c.assignedStop,
      }));

    const sw = findVehicleSwap({
      plate: w.plate,
      code: w.code,
      planIni: w.planIni,
      planFim: w.planFim,
      stops,
      rivals,
      platesWithGps,
      plannedPlateGpsSpan: pingWindowByPlate.get(w.plate) ?? null,
    });
    if (!sw) continue;

    if (sw.kind === "no-gps-coverage") {
      w.conf = REVIEW;
      w.real = sw.note;
      continue;
    }

    w.conf = sw.outOfWindow ? SWAP_OUT_OF_WINDOW : SWAP;
    w.swapPlate = sw.suggPlate;
    sw.suggStop.assigned = true;
    w.assignedStop = sw.suggStop;

    const timing =
      sw.outOfWindow && sw.win
        ? ` (fora da janela planeada${sw.plannedLabel ? ` ${sw.plannedLabel}` : ""}, ` +
          `~${fmtDuration(sw.outsideBy)} além da margem de ±3h)`
        : "";

    w.real =
      `Camião ${w.rawTruck} planeado como ${w.plate}, mas ${sw.suggPlate} ` +
      `esteve em ${storeLabel(w)} às ${fmtHM(sw.suggStop.arrivedAt)}–` +
      `${fmtHM(sw.suggStop.departedAt) || "?"}${timing}.` +
      (sw.ghost
        ? ` Nota: ${sw.ghost.label || "outra linha"} também estava planeado ` +
          `para esta loja/janela, mas o veículo ${sw.ghost.plate} não tem dados ` +
          `GPS — não é uma alternativa real.`
        : "") +
      (sw.outOfWindow
        ? " ⚠️ Fora do intervalo habitual — confirma com cuidado antes de aceitar."
        : " Confirma antes de aceitar.");
  }

  // Step 4 — whatever is left.
  for (const w of works) {
    if (w.empty || w.conf) continue;
    w.conf = REVIEW;
    if (w.source === "discrepancy") {
      w.real =
        `Matrícula divergente para o camião ${w.rawTruck}: ` +
        `ID indica ${w.idPlate}, fleet_trucks indica ${w.fleetPlate}. ` +
        `ID ${w.idPlate}: ${describeReal(w.idPlate)} | ` +
        `fleet ${w.fleetPlate}: ${describeReal(w.fleetPlate)}`;
    } else if (w.source === "none") {
      if (w.rawTruck && !w.rawPlate) {
        w.real = `Camião «${w.rawTruck}» sem matrícula (nem no ID, nem em fleet_trucks).`;
      } else if (!w.rawTruck && !w.rawPlate) {
        w.real = "Linha sem nº de camião nem matrícula.";
      } else {
        w.real = describeReal(w.plate);
      }
    } else {
      w.real = describeReal(w.plate);
    }
  }

  // Write the derived columns back.
  let ok = 0;
  let review = 0;
  let passthrough = 0;
  let discrepancy = 0;
  let swap = 0;
  let swapOutOfWindow = 0;
  let plateTypo = 0;
  for (const w of works) {
    if (w.empty) {
      if (!(CONFIANCA_COL in w.out)) w.out[CONFIANCA_COL] = "";
      if (!(REAL_COL in w.out)) w.out[REAL_COL] = "";
      passthrough++;
      continue;
    }
    // Rewrite the day cell as an unambiguous YYYY-MM-DD. On the way in the
    // "Dia do Serviço" cell is an Excel date serial; SheetJS would render it
    // back as a locale-dependent "9/7/26" that can't be re-parsed reliably, so
    // a processed file couldn't be fed through again. All data rows belong to
    // `day` by construction (multi-day files are rejected upstream).
    if (cols.dayCol) w.out[cols.dayCol] = day;
    // Write back whatever plate we resolved (sheet column, ID, or fleet_trucks)
    // — including on "Rever manualmente" rows where a plate was identified but
    // matched no stop. On a swap suggestion, write the SUGGESTED plate instead.
    // Not on "discrepancy" (w.plate is null there on purpose) or "none".
    const plateOut =
      (w.conf === SWAP ||
        w.conf === SWAP_OUT_OF_WINDOW ||
        w.conf === PLATE_TYPO) &&
      w.swapPlate
        ? w.swapPlate
        : w.plate;
    if (cols.plateCol && plateOut) w.out[cols.plateCol] = plateOut;
    if (w.assignedStop) {
      w.out[cols.chegadaCol] = fmtHM(w.assignedStop.arrivedAt);
      w.out[cols.saidaCol] = fmtHM(w.assignedStop.departedAt);
    }
    w.out[CONFIANCA_COL] = w.conf || REVIEW;
    w.out[REAL_COL] = w.real || "";
    if (w.conf === "OK") ok++;
    else if (w.conf === SWAP) swap++;
    else if (w.conf === SWAP_OUT_OF_WINDOW) swapOutOfWindow++;
    else if (w.conf === PLATE_TYPO) plateTypo++;
    else review++;
    if (w.source === "discrepancy") discrepancy++;
  }

  return {
    rows: works.map((w) => w.out),
    header: outHeader,
    summary: {
      total: ok + review + swap + swapOutOfWindow + plateTypo,
      ok,
      review,
      passthrough,
      discrepancy,
      swap,
      swapOutOfWindow,
      plateTypo,
    },
  };
}
