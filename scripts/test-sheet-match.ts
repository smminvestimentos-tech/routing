// Synthetic checks for the shared sheet-match logic:
//   - "✅ Já preenchido (mantido)": a row that arrives with both times filled is
//     kept verbatim, no matching run on it.
//   - "🔤 Possível erro de matrícula": a one-character transcription slip in an
//     extracted plate (distinct from a vehicle swap).
//
//   npm run test:sheet-match
//
// Pure, no DB — feeds hand-built rows + stops through the matchers and asserts
// on the result. The headline case is the real 09/09 one: the TFS sheet's ID
// column says 32OG34, but 32-OG-64 actually drove camião 526's route
// (E16 Azambuja -> E66 Samora Correia -> B77 Benavente), one digit off.

import {
  resolveColumns as resolveTfsColumns,
  runMatch as runTfsMatch,
  KEPT,
  PLATE_TYPO,
  REVIEW,
  type DayStop,
  type SheetRecord,
} from "@/lib/tfs-sheet/match";
import {
  resolveColumns as resolveAzColumns,
  runMatch as runAzMatch,
} from "@/lib/azambuja-sheet/match";
import {
  classifyKeptDuration,
  codeEq,
  codeKey,
  type CoLocatedGroups,
  findPlateTypo,
  FRAGMENT_MERGE_GAP_MIN,
  haversineKm,
  isEditDistance1,
  LOJA_MIN_PLAUSIBLE_DURATION_MIN,
  MAX_PLAUSIBLE_SPEED_KMH,
  MAX_PLAUSIBLE_SPEED_LONG_KMH,
  LONG_DISTANCE_KM,
  getMaxPlausibleSpeedKmh,
  mergeFragmentedStops,
  minutesBetweenKeptCells,
  normalizeDateTimeCell,
  resolveMergedCode,
} from "@/lib/sheet-match/common";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`FAIL   ${name}`, extra ?? "");
  }
}

const iso = (hhmm: string) => `2026-09-09T${hhmm}:00+01:00`;
const day = "2026-09-09";

// ---------------------------------------------------------------------------
// isEditDistance1
// ---------------------------------------------------------------------------
ok("subst: 32OG64 ~ 32OG34", isEditDistance1("32OG64", "32OG34"));
ok("equal -> false", !isEditDistance1("32OG64", "32OG64"));
ok("two substitutions -> false", !isEditDistance1("32OG64", "32AG34"));
ok("insertion: 32OG634 ~ 32OG34", isEditDistance1("32OG634", "32OG34"));
ok("deletion: 32OG4 ~ 32OG34", isEditDistance1("32OG4", "32OG34"));
ok("length gap of 2 -> false", !isEditDistance1("32OG", "32OG34"));
ok("first-char substitution", isEditDistance1("A2OG34", "32OG34"));

// ---------------------------------------------------------------------------
// TFS sheet — camião 526, route E16 -> E66 -> B77, plate only in the ID column.
// ---------------------------------------------------------------------------
const tfsHeader = [
  "Dia do Serviço",
  "Nº Camião",
  "Matrícula da Viatura",
  "Ordem de Entrega",
  "Código de Loja",
  "Designação da Loja",
  "Janela Início",
  "Janela Fim",
  "Hora de Chegada",
  "Hora de Saída",
  "ID",
];
const tfsRow = (
  ordem: number,
  code: string,
  desig: string,
  ini: string,
  fim: string,
): SheetRecord => ({
  "Dia do Serviço": day,
  "Nº Camião": "526",
  "Matrícula da Viatura": "",
  "Ordem de Entrega": String(ordem),
  "Código de Loja": code,
  "Designação da Loja": desig,
  "Janela Início": ini,
  "Janela Fim": fim,
  "Hora de Chegada": "",
  "Hora de Saída": "",
  ID: "TFS-526-32OG34-1ªRota-09/09/2026",
});
const tfsRecords: SheetRecord[] = [
  tfsRow(1, "E16", "Azambuja", "08:00", "10:00"),
  tfsRow(2, "E66", "Samora Correia", "09:00", "11:00"),
  tfsRow(3, "B77", "Benavente", "10:00", "12:00"),
];
const tfsCols = resolveTfsColumns(tfsHeader);

// 32OG64 hit all three, same order, plausible times; plus a depot stop and an
// unrelated vehicle as noise.
const tfsStops: DayStop[] = [
  { id: "s1", vehicleId: 1, plate: "32OG64", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
  { id: "s2", vehicleId: 1, plate: "32OG64", code: "E66", arrivedAt: iso("09:20"), departedAt: iso("09:45") },
  { id: "s3", vehicleId: 1, plate: "32OG64", code: "B77", arrivedAt: iso("10:25"), departedAt: iso("10:52") },
  { id: "s4", vehicleId: 1, plate: "32OG64", code: "Z99", arrivedAt: iso("07:00"), departedAt: iso("07:20") },
  { id: "s5", vehicleId: 2, plate: "99XX99", code: "E16", arrivedAt: iso("15:00"), departedAt: iso("15:30") },
];
const pingWindow = new Map<string, { min: number; max: number }>([
  ["32OG64", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }],
]);

const res = runTfsMatch({
  day,
  records: tfsRecords,
  header: tfsHeader,
  cols: tfsCols,
  stops: tfsStops,
  fleetByTruck: new Map(), // the ID string is the only plate source
  platesWithGps: new Set(["32OG64", "99XX99", "11AA11"]), // NOT 32OG34
  pingWindowByPlate: pingWindow,
});

console.log("\nTFS summary:", JSON.stringify(res.summary));
for (const r of res.rows) {
  console.log(
    `  ${r["Código de Loja"]}: ${r["Confiança"]} | mat=${r["Matrícula da Viatura"]} | ` +
      `${r["Hora de Chegada"]}-${r["Hora de Saída"]}`,
  );
}

ok("TFS: 3 rows flagged 🔤", res.summary.plateTypo === 3, res.summary);
ok("TFS: nothing left in review / swap", res.summary.review === 0 && res.summary.swap === 0 && res.summary.swapOutOfWindow === 0);
ok("TFS: every row conf === PLATE_TYPO", res.rows.every((r) => r["Confiança"] === PLATE_TYPO));
ok("TFS: plate corrected to 32OG64 on every row", res.rows.every((r) => r["Matrícula da Viatura"] === "32OG64"));
ok(
  "TFS: times filled from 32OG64 stops",
  res.rows[0]["Hora de Chegada"] === "08:12" && res.rows[2]["Hora de Chegada"] === "10:25",
  res.rows.map((r) => r["Hora de Chegada"]),
);

// Negative — two GPS-tracked look-alikes -> ambiguous -> no suggestion.
{
  const r = runTfsMatch({
    day, records: tfsRecords, header: tfsHeader, cols: tfsCols,
    stops: [
      ...tfsStops,
      { id: "s6", vehicleId: 3, plate: "32OG44", code: "E16", arrivedAt: iso("08:15"), departedAt: iso("08:35") },
    ],
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64", "32OG44"]),
    pingWindowByPlate: pingWindow,
  });
  ok("TFS: two candidates -> 0 typo, 3 review", r.summary.plateTypo === 0 && r.summary.review === 3, r.summary);
}

// Negative — candidate only corroborates one store (< 3 in a row).
{
  const r = runTfsMatch({
    day, records: tfsRecords, header: tfsHeader, cols: tfsCols,
    stops: [
      { id: "t1", vehicleId: 1, plate: "32OG64", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
      { id: "t2", vehicleId: 1, plate: "32OG64", code: "Z98", arrivedAt: iso("09:20"), departedAt: iso("09:45") },
    ],
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64"]),
    pingWindowByPlate: pingWindow,
  });
  ok("TFS: weak corroboration -> 0 typo", r.summary.plateTypo === 0, r.summary);
}

// Negative — the extracted plate itself has GPS: it's a real vehicle, not a typo.
{
  const r = runTfsMatch({
    day, records: tfsRecords, header: tfsHeader, cols: tfsCols, stops: tfsStops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64", "32OG34"]),
    pingWindowByPlate: new Map([
      ["32OG34", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }],
      ...pingWindow,
    ]),
  });
  ok("TFS: extracted plate has GPS -> 0 typo", r.summary.plateTypo === 0, r.summary);
}

// ---------------------------------------------------------------------------
// findPlateTypo — direct unit check on the run threshold.
// ---------------------------------------------------------------------------
{
  const routeStores = [
    { code: "E16", planIni: "08:00", planFim: "10:00" },
    { code: "E66", planIni: "09:00", planFim: "11:00" },
    { code: "B77", planIni: "10:00", planFim: "12:00" },
  ];
  const wstops = tfsStops.map((s) => ({ ...s, assigned: false }));
  const t = findPlateTypo({
    plate: "32OG34",
    code: "E16",
    planIni: "08:00",
    planFim: "10:00",
    routeStores,
    stops: wstops,
    candidatePlates: new Set(["32OG64"]),
    coLocatedGroups: [],
  });
  ok("findPlateTypo: suggests 32OG64, run 3", t?.suggPlate === "32OG64" && t?.run === 3, t);

  const none = findPlateTypo({
    plate: "32OG34",
    code: "E16",
    planIni: "08:00",
    planFim: "10:00",
    routeStores: [routeStores[0]], // single-store route can't corroborate
    stops: wstops,
    candidatePlates: new Set(["32OG64"]),
    coLocatedGroups: [],
  });
  ok("findPlateTypo: single-store route -> null", none === null, none);
}

// ---------------------------------------------------------------------------
// Azambuja sheet — MATRICULA pre-filled with the typo, one row per store.
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azRow = (code: string, nome: string): SheetRecord => ({
    ROTA: "R1",
    N_LOJA: code,
    NOME: nome,
    MATRICULA: "32-OG-34",
    "Hora Chegada": "",
    "Hora Saida": "",
    CICLO: "08:00 | 20:00",
    TIPO: "C",
  });
  const azRecords = [
    azRow("E16", "Azambuja"),
    azRow("E66", "Samora Correia"),
    azRow("B77", "Benavente"),
  ];
  const azCols = resolveAzColumns(azHeader);
  const azStops: DayStop[] = [
    { id: "a1", vehicleId: 1, plate: "32OG64", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
    { id: "a2", vehicleId: 1, plate: "32OG64", code: "E66", arrivedAt: iso("09:20"), departedAt: iso("09:45") },
    { id: "a3", vehicleId: 1, plate: "32OG64", code: "B77", arrivedAt: iso("10:25"), departedAt: iso("10:52") },
  ];
  const r = runAzMatch({
    day,
    records: azRecords,
    header: azHeader,
    cols: azCols,
    stops: azStops,
    platesWithGps: new Set(["32OG64"]),
    pingWindowByPlate: new Map(),
  });
  console.log("\nAzambuja summary:", JSON.stringify(r.summary));
  ok("Azambuja: 3 rows flagged 🔤", r.summary.plateTypo === 3, r.summary);
  ok("Azambuja: MATRICULA corrected to 32OG64", r.rows.every((x) => x["MATRICULA"] === "32OG64"));
}

// ---------------------------------------------------------------------------
// "✅ Já preenchido (mantido)" — a row with BOTH times on input is kept as-is,
// no matching, and it wins even over what would otherwise be a 🔤 suggestion.
// ---------------------------------------------------------------------------
{
  // Same TFS scenario as above (ID 32OG34, 32OG64 drove it), but the middle
  // row (E66) arrives already filled — and with values we must NOT touch.
  const recs = [
    tfsRow(1, "E16", "Azambuja", "08:00", "10:00"),
    { ...tfsRow(2, "E66", "Samora Correia", "09:00", "11:00"), "Hora de Chegada": "07:03", "Hora de Saída": "07:19" },
    tfsRow(3, "B77", "Benavente", "10:00", "12:00"),
  ];
  const r = runTfsMatch({
    day, records: recs, header: tfsHeader, cols: tfsCols, stops: tfsStops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64", "99XX99"]),
    pingWindowByPlate: pingWindow,
  });
  console.log("\nTFS (kept middle row) summary:", JSON.stringify(r.summary));
  ok("TFS kept: summary.kept === 1", r.summary.kept === 1, r.summary);
  ok("TFS kept: middle row conf === KEPT", r.rows[1]["Confiança"] === KEPT, r.rows[1]["Confiança"]);
  ok(
    "TFS kept: middle row times untouched",
    r.rows[1]["Hora de Chegada"] === "07:03" && r.rows[1]["Hora de Saída"] === "07:19",
    [r.rows[1]["Hora de Chegada"], r.rows[1]["Hora de Saída"]],
  );
  ok("TFS kept: middle row plate untouched (blank)", r.rows[1]["Matrícula da Viatura"] === "");
  ok("TFS kept: middle row Real blank", r.rows[1]["Real"] === "");
  ok("TFS kept: other two rows still 🔤", r.rows[0]["Confiança"] === PLATE_TYPO && r.rows[2]["Confiança"] === PLATE_TYPO, [r.rows[0]["Confiança"], r.rows[2]["Confiança"]]);
  ok("TFS kept: total counts the kept row", r.summary.total === 3, r.summary);
}
{
  // Azambuja: one store already filled -> kept, the other two still matched OK.
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const mk = (code: string, ch = "", sa = ""): SheetRecord => ({
    ROTA: "R1", N_LOJA: code, NOME: code, MATRICULA: "12-AB-34",
    "Hora Chegada": ch, "Hora Saida": sa, CICLO: "08:00 | 20:00", TIPO: "C",
  });
  const azRecords = [
    mk("E16"),
    mk("E66", "05/09/2026 07:00", "05/09/2026 07:20"),
    mk("B77"),
  ];
  const azCols = resolveAzColumns(azHeader);
  const azStops: DayStop[] = [
    { id: "b1", vehicleId: 9, plate: "12AB34", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
    { id: "b2", vehicleId: 9, plate: "12AB34", code: "E66", arrivedAt: iso("09:20"), departedAt: iso("09:45") },
    { id: "b3", vehicleId: 9, plate: "12AB34", code: "B77", arrivedAt: iso("10:25"), departedAt: iso("10:52") },
  ];
  const r = runAzMatch({
    day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
    platesWithGps: new Set(["12AB34"]),
    pingWindowByPlate: new Map(),
  });
  console.log("Azambuja (kept one store) summary:", JSON.stringify(r.summary));
  ok("Azambuja kept: summary.kept === 1", r.summary.kept === 1, r.summary);
  ok("Azambuja kept: E66 conf === KEPT", r.rows[1]["Confiança"] === KEPT, r.rows[1]["Confiança"]);
  ok(
    "Azambuja kept: E66 times untouched",
    r.rows[1]["Hora Chegada"] === "05-09-2026 07:00" && r.rows[1]["Hora Saida"] === "05-09-2026 07:20",
  );
  ok("Azambuja kept: E16 + B77 matched OK", r.rows[0]["Confiança"] === "OK" && r.rows[2]["Confiança"] === "OK", [r.rows[0]["Confiança"], r.rows[2]["Confiança"]]);
}

// ---------------------------------------------------------------------------
// Implausible pre-fill (Chegada === Saída, or Saída < Chegada) must NEVER be
// trusted as "kept" — the 2026-09 BG-75-IP bug: the transporter's own sheet
// arrives with both cells already filled to the same placeholder value for a
// store that wasn't actually delivered. Real GPS closes never take 0 minutes.
// ---------------------------------------------------------------------------
{
  // TFS: E16 arrives pre-filled 09:00=09:00 (placeholder) but 12AB34 really
  // stopped there at 08:12-08:40 -> must resolve to that real stop, OK, with
  // the placeholder documented in Real. E66 arrives reversed (09:40 -> 09:20,
  // garbage) with NO real stop backing it -> must go to REVIEW, never keep
  // 09:40/09:20 verbatim.
  const recs = [
    { ...tfsRow(1, "E16", "Azambuja", "08:00", "10:00"), "Matrícula da Viatura": "12AB34", "Hora de Chegada": "09:00", "Hora de Saída": "09:00" },
    { ...tfsRow(2, "E66", "Samora Correia", "09:00", "11:00"), "Matrícula da Viatura": "12AB34", "Hora de Chegada": "09:40", "Hora de Saída": "09:20" },
  ];
  const stops: DayStop[] = [
    { id: "z1", vehicleId: 42, plate: "12AB34", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
  ];
  const r = runTfsMatch({
    day, records: recs, header: tfsHeader, cols: tfsCols, stops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["12AB34"]),
    pingWindowByPlate: new Map([["12AB34", { min: new Date(iso("00:00")).getTime(), max: new Date(iso("23:59")).getTime() }]]),
  });
  console.log("\nTFS (implausible pre-fill) summary:", JSON.stringify(r.summary));
  ok("TFS implausible: summary.kept === 0", r.summary.kept === 0, r.summary);
  ok("TFS implausible: E16 resolved OK from real stop, not the 09:00 placeholder", r.rows[0]["Confiança"] === "OK" && r.rows[0]["Hora de Chegada"] === "08:12" && r.rows[0]["Hora de Saída"] === "08:40", r.rows[0]);
  ok("TFS implausible: E16 Real documents the override", typeof r.rows[0]["Real"] === "string" && (r.rows[0]["Real"] as string).includes("09:00"), r.rows[0]["Real"]);
  ok("TFS implausible: E66 (no real stop, reversed times) -> REVIEW, not kept verbatim", r.rows[1]["Confiança"] === REVIEW && r.rows[1]["Hora de Chegada"] === "" && r.rows[1]["Hora de Saída"] === "", r.rows[1]);
  ok("TFS implausible: E66 Real documents the rejected placeholder", typeof r.rows[1]["Real"] === "string" && (r.rows[1]["Real"] as string).includes("09:40"), r.rows[1]["Real"]);
}
{
  // Azambuja: same shape, full "DD/MM/YYYY HH:MM" pre-fill this sheet uses.
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const mk = (rota: string, code: string, ch = "", sa = ""): SheetRecord => ({
    ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: "12-AB-34",
    "Hora Chegada": ch, "Hora Saida": sa, CICLO: "08:00 | 20:00", TIPO: "C",
  });
  const azRecords = [
    mk("R1", "E16", "09/09/2026 11:54", "09/09/2026 11:54"), // placeholder, real stop exists
    mk("R2", "E66", "09/09/2026 14:43", "09/09/2026 14:43"), // placeholder, NO real stop -> review
  ];
  const azCols = resolveAzColumns(azHeader);
  const azStops: DayStop[] = [
    { id: "z2", vehicleId: 43, plate: "12AB34", code: "E16", arrivedAt: iso("08:30"), departedAt: iso("09:02") },
  ];
  const r = runAzMatch({
    day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
    platesWithGps: new Set(["12AB34"]),
    pingWindowByPlate: new Map([["12AB34", { min: new Date(iso("00:00")).getTime(), max: new Date(iso("23:59")).getTime() }]]),
  });
  console.log("Azambuja (implausible pre-fill) summary:", JSON.stringify(r.summary));
  ok("Azambuja implausible: summary.kept === 0", r.summary.kept === 0, r.summary);
  ok(
    "Azambuja implausible: E16 resolved OK from real stop, not the 11:54 placeholder",
    r.rows[0]["Confiança"] === "OK" && r.rows[0]["Hora Chegada"] !== "09/09/2026 11:54",
    r.rows[0],
  );
  ok("Azambuja implausible: E66 (no real stop) -> REVIEW, times blanked, not 14:43/14:43", r.rows[1]["Confiança"] === REVIEW && r.rows[1]["Hora Chegada"] === "" && r.rows[1]["Hora Saida"] === "", r.rows[1]);
  ok("Azambuja implausible: E66 Real documents the rejected placeholder", typeof r.rows[1]["Real"] === "string" && (r.rows[1]["Real"] as string).includes("14:43"), r.rows[1]["Real"]);
}

// ---------------------------------------------------------------------------
// classifyKeptDuration / minutesBetweenKeptCells — regression coverage for
// the fail-open gap behind BG-75-IP's 2026-09-21 RECURRENCE (a regression of
// the fa26052 fix, not a fresh bug): the plausibility check used a narrower
// date parser (minutesBetweenTimeCells) than the one the write-back path
// already trusted to reshape these exact cells (normalizeDateTimeCell). A
// cell shape the wider parser read cleanly but the narrower one could not
// came back durMin=null, and the OLD rule (`durMin != null && durMin <= 0`)
// treated null as "plausible, trust it" — fail-open. 452/446/447/454/453/455
// all landed on "✅ Já preenchido (mantido)" that way despite being 6 real,
// distinct deliveries (confirmed via Transpogest, ~08:34-13:29), each on the
// input sheet as a same-minute Chegada=Saída placeholder.
// ---------------------------------------------------------------------------
{
  const SVC = "2026-09-21";
  // The 4 shapes normalizeDateTimeCell reads correctly (and the write-back
  // path already relied on) but the old narrower parser returned null for —
  // each written as the exact same-value placeholder BG-75-IP arrived with.
  const placeholderShapes: Array<[string, string]> = [
    ["2-digit year (\"21-09-26 14:14\")", "21-09-26 14:14"],
    ["\".\" date separator (\"21.09.2026 14:14\")", "21.09.2026 14:14"],
    ["M/D + AM/PM, no raw serial (\"9/21/26 2:14 PM\")", "9/21/26 2:14 PM"],
  ];
  for (const [label, cell] of placeholderShapes) {
    const durMin = minutesBetweenKeptCells(cell, cell, undefined, undefined, SVC);
    ok(`minutesBetweenKeptCells reads ${label} — was null under the old parser`, durMin === 0, durMin);
    ok(`classifyKeptDuration rejects ${label} (Chegada === Saída)`, classifyKeptDuration(durMin, null) === "non_positive", durMin);
  }

  // Excel serial: an earlier report in this investigation claimed
  // normalizeDateTimeCell mis-decoded a serial as the wrong calendar day
  // ("06-09-2026" for what should have been "21-09-2026") — that turned out
  // to be a WRONG TEST FIXTURE (serial 46271 really is 2026-09-06, not
  // 2026-09-21), not a parser bug. Verified here against the CORRECT serial
  // for 2026-09-21 14:14, so this doesn't go unchecked a second time.
  const serial21Sep1414 =
    (Date.UTC(2026, 8, 21, 14, 14) - Date.UTC(1899, 11, 30)) / 86_400_000;
  ok(
    "Excel serial decodes to the right calendar day (2026-09-21, not 09-06)",
    normalizeDateTimeCell(String(serial21Sep1414), serial21Sep1414, SVC) === "21-09-2026 14:14",
    normalizeDateTimeCell(String(serial21Sep1414), serial21Sep1414, SVC),
  );
  const durSerial = minutesBetweenKeptCells(
    String(serial21Sep1414), String(serial21Sep1414), serial21Sep1414, serial21Sep1414, SVC,
  );
  ok("minutesBetweenKeptCells reads the Excel-serial placeholder (0min)", durSerial === 0, durSerial);
  ok("classifyKeptDuration rejects the Excel-serial placeholder", classifyKeptDuration(durSerial, null) === "non_positive");

  // A cell shape genuinely NEITHER parser can read -> durMin stays null ->
  // FAIL CLOSED (implausible), never the old fail-open "trust it" default.
  const garbage = minutesBetweenKeptCells(
    "mais ou menos ao almoço", "mais ou menos ao almoço", undefined, undefined, SVC,
  );
  ok("minutesBetweenKeptCells: truly unparseable -> null", garbage === null, garbage);
  ok("classifyKeptDuration: null duration -> 'unparseable' (fail-closed, not fail-open)", classifyKeptDuration(garbage, null) === "unparseable");
}

// ---------------------------------------------------------------------------
// classifyKeptDuration — the 5th rule (2026-09-22 fix): duration < 5min at a
// 'loja' is ALSO implausible, same threshold as the 🟣 short-stop VISUAL rule
// (xlsx-out.ts). NOT applied to 'armazem'/'centro_distribuicao' (0035: a real
// near-stationary warehouse touch legitimately closes in 0min), nor to an
// unresolved/unknown location type (no evidence there yet).
// ---------------------------------------------------------------------------
{
  ok("classifyKeptDuration: 4min at a loja -> too_short_for_store", classifyKeptDuration(4, "loja") === "too_short_for_store");
  ok(
    `classifyKeptDuration: exactly ${LOJA_MIN_PLAUSIBLE_DURATION_MIN}min at a loja -> plausible (strict <5 boundary)`,
    classifyKeptDuration(LOJA_MIN_PLAUSIBLE_DURATION_MIN, "loja") === null,
  );
  ok("classifyKeptDuration: 1min at an armazem -> plausible (0035 exception)", classifyKeptDuration(1, "armazem") === null);
  ok("classifyKeptDuration: 1min at a centro_distribuicao -> plausible (0035 exception)", classifyKeptDuration(1, "centro_distribuicao") === null);
  ok("classifyKeptDuration: 1min, unresolved/unknown type -> plausible (no unverified assumption)", classifyKeptDuration(1, null) === null);
  ok("classifyKeptDuration: 0min anywhere -> non_positive regardless of type", classifyKeptDuration(0, "armazem") === "non_positive");
}

// ---------------------------------------------------------------------------
// End-to-end regression — BG-75-IP, 2026-09-21 (real rota 185884946/47/48):
// 6 distinct store deliveries (452/446/447/454/453/455), each with its own
// GPS-confirmed time spread across the morning, all landed in the uploaded
// file as a same-minute Chegada=Saída placeholder — in the SAME upload,
// Plataforma Maia (7004, an armazém pass-through) legitimately closing in
// minutes. Both must be told apart correctly. (Reproduced on this test
// file's fixed `day`/`iso()`, not the literal 2026-09-21 — the store codes,
// shapes and vehicle are the real reported ones.)
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const rota = "185884946";
  const mk = (code: string, ch: string, sa: string): SheetRecord => ({
    ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: "BG-75-IP",
    "Hora Chegada": ch, "Hora Saida": sa, CICLO: "Noturno", TIPO: "D",
  });
  const lojaCodes = ["452", "446", "447", "454", "453", "455"];
  const records: SheetRecord[] = [
    mk("7004", "09-09-2026 14:10", "09-09-2026 14:14"), // Plataforma Maia (armazém), legit 4min
    ...lojaCodes.map((c) => mk(c, "09-09-2026 14:14", "09-09-2026 14:14")),
  ];
  const azCols = resolveAzColumns(azHeader);
  // Real GPS: Plataforma Maia's own short touch, plus the 6 stores' ACTUAL
  // distinct times, spread across the morning (per the Transpogest cross-check
  // in the original report).
  const stops: DayStop[] = [
    { id: "w0", vehicleId: 75, plate: "BG75IP", code: "7004", arrivedAt: iso("14:10"), departedAt: iso("14:14") },
    { id: "w1", vehicleId: 75, plate: "BG75IP", code: "452", arrivedAt: iso("08:34"), departedAt: iso("08:52") },
    { id: "w2", vehicleId: 75, plate: "BG75IP", code: "446", arrivedAt: iso("09:15"), departedAt: iso("09:33") },
    { id: "w3", vehicleId: 75, plate: "BG75IP", code: "447", arrivedAt: iso("10:02"), departedAt: iso("10:20") },
    { id: "w4", vehicleId: 75, plate: "BG75IP", code: "454", arrivedAt: iso("11:10"), departedAt: iso("11:28") },
    { id: "w5", vehicleId: 75, plate: "BG75IP", code: "453", arrivedAt: iso("12:40"), departedAt: iso("12:58") },
    { id: "w6", vehicleId: 75, plate: "BG75IP", code: "455", arrivedAt: iso("13:11"), departedAt: iso("13:29") },
  ];
  const codeTypes = new Map<string, string>([
    ["7004", "armazem"],
    ...lojaCodes.map((c): [string, string] => [c, "loja"]),
  ]);
  const r = runAzMatch({
    day, records, header: azHeader, cols: azCols, stops,
    platesWithGps: new Set(["BG75IP"]),
    pingWindowByPlate: new Map([["BG75IP", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }]]),
    codeTypes,
  });
  console.log("\nAzambuja (BG-75-IP real regression) summary:", JSON.stringify(r.summary));
  const byCode = new Map(r.rows.map((row) => [String(row["N_LOJA"]), row]));

  ok("BG-75-IP regression: Plataforma Maia (armazém, 4min) stays KEPT", byCode.get("7004")?.["Confiança"] === KEPT, byCode.get("7004"));
  for (const c of lojaCodes) {
    const row = byCode.get(c)!;
    ok(`BG-75-IP regression: loja ${c} NOT kept as the fake 14:14 placeholder`, row["Confiança"] !== KEPT, row);
    ok(`BG-75-IP regression: loja ${c} resolves OK from its OWN real GPS stop`, row["Confiança"] === "OK" && row["Hora Chegada"] !== "09-09-2026 14:14", row);
  }
  ok("BG-75-IP regression: summary.kept === 1 (only the legitimate armazém row)", r.summary.kept === 1, r.summary);
}

// ---------------------------------------------------------------------------
// New threshold specifically (not just the old <=0 rule): a 'loja' row with a
// TECHNICALLY POSITIVE but <5min duration must ALSO be rejected — the same
// duration at an 'armazem' code, same upload, must NOT be. Proves the new
// rule is what's catching this shape, not just the pre-existing durMin<=0 one.
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const mk = (code: string, ch: string, sa: string): SheetRecord => ({
    ROTA: "R-threshold", N_LOJA: code, NOME: code, MATRICULA: "BG-75-IP",
    "Hora Chegada": ch, "Hora Saida": sa, CICLO: "Noturno", TIPO: "D",
  });
  const records: SheetRecord[] = [
    mk("7004", "09-09-2026 14:10", "09-09-2026 14:14"), // armazém, 4min -> legit
    mk("452", "09-09-2026 14:14", "09-09-2026 14:18"), // loja, 4min -> too short
  ];
  const azCols = resolveAzColumns(azHeader);
  const stops: DayStop[] = [
    { id: "x0", vehicleId: 75, plate: "BG75IP", code: "7004", arrivedAt: iso("14:10"), departedAt: iso("14:14") },
    { id: "x1", vehicleId: 75, plate: "BG75IP", code: "452", arrivedAt: iso("08:34"), departedAt: iso("08:52") },
  ];
  const codeTypes = new Map([["7004", "armazem"], ["452", "loja"]]);
  const r = runAzMatch({
    day, records, header: azHeader, cols: azCols, stops,
    platesWithGps: new Set(["BG75IP"]),
    pingWindowByPlate: new Map([["BG75IP", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }]]),
    codeTypes,
  });
  const byCode = new Map(r.rows.map((row) => [String(row["N_LOJA"]), row]));
  ok("threshold: armazém 4min (durMin > 0) stays KEPT — 0035 exception", byCode.get("7004")?.["Confiança"] === KEPT, byCode.get("7004"));
  ok("threshold: loja 4min (durMin > 0, would pass the OLD <=0 rule) is NOT kept", byCode.get("452")?.["Confiança"] !== KEPT, byCode.get("452"));
  ok("threshold: loja 4min resolves OK from its own real GPS stop instead", byCode.get("452")?.["Confiança"] === "OK" && byCode.get("452")?.["Hora Chegada"] !== "09-09-2026 14:14", byCode.get("452"));
}

// ---------------------------------------------------------------------------
// Same fail-open gap, symmetric fix on the TFS matcher (tfs-sheet/match.ts) —
// not just Azambuja. A 2-digit-year placeholder must be rejected there too.
// ---------------------------------------------------------------------------
{
  const recs = [
    { ...tfsRow(1, "E16", "Azambuja", "08:00", "10:00"), "Matrícula da Viatura": "12AB34", "Hora de Chegada": "21-09-26 14:14", "Hora de Saída": "21-09-26 14:14" },
  ];
  const stops: DayStop[] = [
    { id: "y1", vehicleId: 90, plate: "12AB34", code: "E16", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
  ];
  const r = runTfsMatch({
    day, records: recs, header: tfsHeader, cols: tfsCols, stops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["12AB34"]),
    pingWindowByPlate: new Map([["12AB34", { min: new Date(iso("00:00")).getTime(), max: new Date(iso("23:59")).getTime() }]]),
  });
  ok("TFS: 2-digit-year placeholder is NOT kept (old parser returned null -> was kept)", r.rows[0]["Confiança"] !== KEPT, r.rows[0]);
  ok("TFS: 2-digit-year placeholder resolves OK from the real stop instead", r.rows[0]["Confiança"] === "OK" && r.rows[0]["Hora de Chegada"] === "08:12", r.rows[0]);
}

// ---------------------------------------------------------------------------
// resolveMergedCode — 0030: sheet still names a merged-away location.
// ---------------------------------------------------------------------------
{
  const activeCodes = ["206", "01", "7091"];
  const merged = [
    { code: "AUCHAN-4", canonicalCode: "206" },
    { code: "7092", canonicalCode: "206" },
    { code: "7001", canonicalCode: "01" },
    { code: "AUCHAN-03", canonicalCode: "7091" },
    { code: "201", canonicalCode: "7091" },
  ];
  ok(
    "resolveMergedCode: merged code -> canonical",
    resolveMergedCode("AUCHAN-4", activeCodes, merged, []) === "206",
  );
  ok(
    "resolveMergedCode: another merged code, same canonical",
    resolveMergedCode("7092", activeCodes, merged, []) === "206",
  );
  ok(
    "resolveMergedCode: already-active code -> unchanged",
    resolveMergedCode("206", activeCodes, merged, []) === "206",
  );
  ok(
    "resolveMergedCode: unknown code -> unchanged",
    resolveMergedCode("Z999", activeCodes, merged, []) === "Z999",
  );
  ok(
    "resolveMergedCode: empty -> unchanged",
    resolveMergedCode("", activeCodes, merged, []) === "",
  );
}

// End-to-end: the TFS sheet's "Código de Loja" still says "AUCHAN-4", but the
// stop is recorded against the now-canonical "206" (post-0030 merge). Without
// resolution this would fall to review; with it, it matches cleanly. Plate
// comes straight from the sheet's own column — no ID-parsing noise.
{
  const rows: SheetRecord[] = [
    {
      "Dia do Serviço": day,
      "Nº Camião": "",
      "Matrícula da Viatura": "32OG64",
      "Ordem de Entrega": "1",
      "Código de Loja": "AUCHAN-4",
      "Designação da Loja": "Armazém Torres Novas",
      "Janela Início": "08:00",
      "Janela Fim": "10:00",
      "Hora de Chegada": "",
      "Hora de Saída": "",
      ID: "",
    },
  ];
  const stops: DayStop[] = [
    { id: "m1", vehicleId: 1, plate: "32OG64", code: "206", arrivedAt: iso("08:12"), departedAt: iso("08:40") },
  ];
  const withoutResolution = runTfsMatch({
    day, records: rows, header: tfsHeader, cols: tfsCols, stops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64"]),
    pingWindowByPlate: new Map([["32OG64", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }]]),
  });
  ok(
    "merge resolution OFF: AUCHAN-4 vs 206 -> does not match",
    withoutResolution.summary.ok === 0,
    withoutResolution.summary,
  );

  const withResolution = runTfsMatch({
    day, records: rows, header: tfsHeader, cols: tfsCols, stops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["32OG64"]),
    pingWindowByPlate: new Map([["32OG64", { min: Date.parse(iso("06:00")), max: Date.parse(iso("20:00")) }]]),
    activeCodes: ["206"],
    mergedCodes: [{ code: "AUCHAN-4", canonicalCode: "206" }],
  });
  ok(
    "merge resolution ON: AUCHAN-4 resolves to 206 -> matches OK",
    withResolution.summary.ok === 1,
    withResolution.summary,
  );
  ok(
    "merge resolution ON: original sheet cell stays 'AUCHAN-4' (not overwritten)",
    withResolution.rows[0]["Código de Loja"] === "AUCHAN-4",
    withResolution.rows[0]["Código de Loja"],
  );
}

// ---------------------------------------------------------------------------
// Same-site co-location (locations.colocated_with_id, migration 0034) —
// Albufeira's B78 <=> 94 <=> AUCHAN-06 group, built the way the API routes
// build it from the DB (coLocatedGroupsFromLocations), not a code constant.
// ---------------------------------------------------------------------------
{
  // Mirrors migration 0034's backfill: AUCHAN-06 is the hub, B78 and 94 both
  // point their colocated_with_id at it.
  const albufeiraGroups: CoLocatedGroups = [new Set(["AUCHAN-06", "B78", "94"])];

  // 1. codeEq bidirectional equivalence
  ok("Albufeira same-site: '94' == 'B78'", codeEq("94", "B78", albufeiraGroups));
  ok("Albufeira same-site: 'B78' == '94'", codeEq("B78", "94", albufeiraGroups));
  ok("Albufeira same-site: 'AUCHAN-06' == 'B78'", codeEq("AUCHAN-06", "B78", albufeiraGroups));
  ok("Albufeira same-site: 'B78' == 'AUCHAN-06'", codeEq("B78", "AUCHAN-06", albufeiraGroups));
  ok("Albufeira same-site: '94' == 'AUCHAN-06'", codeEq("94", "AUCHAN-06", albufeiraGroups));
  ok("Albufeira same-site: 'AUCHAN-06' == '94'", codeEq("AUCHAN-06", "94", albufeiraGroups));
  ok("Albufeira same-site: number 94 == 'B78'", codeEq(94 as unknown as string, "B78", albufeiraGroups));
  ok("Albufeira same-site: '094' == 'B78'", codeEq("094", "B78", albufeiraGroups));
  ok("Albufeira same-site: '94.0' == 'B78'", codeEq("94.0", "B78", albufeiraGroups));
  ok("Albufeira same-site: ' 94 ' == 'B78'", codeEq(" 94 ", "B78", albufeiraGroups));
  ok("No co-location groups -> '94' != 'B78'", !codeEq("94", "B78", []));

  // 2. codeKey canonical site key
  ok("Albufeira codeKey: '94' == 'B78'", codeKey("94", albufeiraGroups) === codeKey("B78", albufeiraGroups));
  ok(
    "Albufeira codeKey: 'AUCHAN-06' == 'B78'",
    codeKey("AUCHAN-06", albufeiraGroups) === codeKey("B78", albufeiraGroups),
  );

  // 3. resolveMergedCode with active/merged list
  const activeList = ["B78", "AUCHAN-06", "01", "206"];
  const mergedList = [
    { code: "94", canonicalCode: "AUCHAN-06" },
    { code: "AUCHAN-4", canonicalCode: "206" },
  ];
  ok(
    "resolveMergedCode: '94' (string) resolves to AUCHAN-06",
    resolveMergedCode("94", activeList, mergedList, albufeiraGroups) === "AUCHAN-06",
  );
  ok(
    "resolveMergedCode: 94 (number) resolves to AUCHAN-06",
    resolveMergedCode(94, activeList, mergedList, albufeiraGroups) === "AUCHAN-06",
  );
  ok(
    "resolveMergedCode: 'B78' stays B78 (active)",
    resolveMergedCode("B78", activeList, mergedList, albufeiraGroups) === "B78",
  );
  ok(
    "resolveMergedCode: 'AUCHAN-06' stays AUCHAN-06 (active)",
    resolveMergedCode("AUCHAN-06", activeList, mergedList, albufeiraGroups) === "AUCHAN-06",
  );

  // 4. End-to-end TFS matching: planned 94, GPS detected as B78 (caminhão 280)
  const tfs280Rows: SheetRecord[] = [
    {
      "Dia do Serviço": day,
      "Nº Camião": "280",
      "Matrícula da Viatura": "28-RN-74",
      "Ordem de Entrega": "1",
      "Código de Loja": "94",
      "Designação da Loja": "Armazém Albufeira",
      "Janela Início": "02:00",
      "Janela Fim": "04:00",
      "Hora de Chegada": "",
      "Hora de Saída": "",
      ID: "",
    },
  ];
  const tfs280Stops: DayStop[] = [
    {
      id: "alb-stop-1",
      vehicleId: 280,
      plate: "28RN74",
      code: "B78",
      arrivedAt: iso("02:48"),
      departedAt: iso("03:23"),
    },
  ];
  const tfs280Res = runTfsMatch({
    day,
    records: tfs280Rows,
    header: tfsHeader,
    cols: tfsCols,
    stops: tfs280Stops,
    fleetByTruck: new Map([["280", "28RN74"]]),
    platesWithGps: new Set(["28RN74"]),
    pingWindowByPlate: new Map([["28RN74", { min: Date.parse(iso("01:00")), max: Date.parse(iso("10:00")) }]]),
    activeCodes: activeList,
    mergedCodes: mergedList,
    coLocatedGroups: albufeiraGroups,
  });

  ok("TFS 280: summary.ok === 1", tfs280Res.summary.ok === 1, tfs280Res.summary);
  ok("TFS 280: row Confiança === OK", tfs280Res.rows[0]["Confiança"] === "OK");
  ok("TFS 280: row Hora de Chegada === '02:48'", tfs280Res.rows[0]["Hora de Chegada"] === "02:48");
  ok("TFS 280: row Hora de Saída === '03:23'", tfs280Res.rows[0]["Hora de Saída"] === "03:23");
  ok("TFS 280: row Real is empty on OK", tfs280Res.rows[0]["Real"] === "");

  // 5. End-to-end TFS matching: planned with integer 94
  const tfs285Rows: SheetRecord[] = [
    {
      "Dia do Serviço": day,
      "Nº Camião": "285",
      "Matrícula da Viatura": "28-RN-75",
      "Ordem de Entrega": "1",
      "Código de Loja": 94 as unknown as string,
      "Designação da Loja": "Armazém Albufeira",
      "Janela Início": "06:00",
      "Janela Fim": "08:00",
      "Hora de Chegada": "",
      "Hora de Saída": "",
      ID: "",
    },
  ];
  const tfs285Stops: DayStop[] = [
    {
      id: "alb-stop-2",
      vehicleId: 285,
      plate: "28RN75",
      code: "B78",
      arrivedAt: iso("06:25"),
      departedAt: iso("07:30"),
    },
  ];
  const tfs285Res = runTfsMatch({
    day,
    records: tfs285Rows,
    header: tfsHeader,
    cols: tfsCols,
    stops: tfs285Stops,
    fleetByTruck: new Map([["285", "28RN75"]]),
    platesWithGps: new Set(["28RN75"]),
    pingWindowByPlate: new Map([["28RN75", { min: Date.parse(iso("05:00")), max: Date.parse(iso("12:00")) }]]),
    activeCodes: activeList,
    mergedCodes: mergedList,
    coLocatedGroups: albufeiraGroups,
  });

  ok("TFS 285 (int 94): summary.ok === 1", tfs285Res.summary.ok === 1, tfs285Res.summary);
  ok("TFS 285 (int 94): row Confiança === OK", tfs285Res.rows[0]["Confiança"] === "OK");
  ok("TFS 285 (int 94): row Chegada === '06:25'", tfs285Res.rows[0]["Hora de Chegada"] === "06:25");
  ok("TFS 285 (int 94): row Saída === '07:30'", tfs285Res.rows[0]["Hora de Saída"] === "07:30");

  // 6. Reverse: planned B78, GPS stop tagged AUCHAN-06
  const tfsRevRows: SheetRecord[] = [
    {
      "Dia do Serviço": day,
      "Nº Camião": "280",
      "Matrícula da Viatura": "28-RN-74",
      "Ordem de Entrega": "1",
      "Código de Loja": "B78",
      "Designação da Loja": "Loja Albufeira",
      "Janela Início": "02:00",
      "Janela Fim": "04:00",
      "Hora de Chegada": "",
      "Hora de Saída": "",
      ID: "",
    },
  ];
  const tfsRevStops: DayStop[] = [
    {
      id: "alb-stop-3",
      vehicleId: 280,
      plate: "28RN74",
      code: "AUCHAN-06",
      arrivedAt: iso("02:48"),
      departedAt: iso("03:23"),
    },
  ];
  const tfsRevRes = runTfsMatch({
    day,
    records: tfsRevRows,
    header: tfsHeader,
    cols: tfsCols,
    stops: tfsRevStops,
    fleetByTruck: new Map([["280", "28RN74"]]),
    platesWithGps: new Set(["28RN74"]),
    pingWindowByPlate: new Map([["28RN74", { min: Date.parse(iso("01:00")), max: Date.parse(iso("10:00")) }]]),
    activeCodes: activeList,
    mergedCodes: mergedList,
    coLocatedGroups: albufeiraGroups,
  });
  ok("TFS reverse (planned B78, GPS AUCHAN-06): summary.ok === 1", tfsRevRes.summary.ok === 1);
  ok("TFS reverse: row Confiança === OK", tfsRevRes.rows[0]["Confiança"] === "OK");
  ok("TFS reverse: row Chegada === '02:48'", tfsRevRes.rows[0]["Hora de Chegada"] === "02:48");
}

// ---------------------------------------------------------------------------
// Almada (12 <=> 7030) — new colocated_with_id case (migration 0034). The
// sheet's own store-code cell must NEVER change to the other member of the
// group: matching accepts either code's stops, but the row keeps saying
// exactly what it said on input.
// ---------------------------------------------------------------------------
{
  const almadaGroups: CoLocatedGroups = [new Set(["12", "7030"])];

  // TFS: row planned as loja '12', but the real GPS stop got location-matched
  // to '7030' (Plataforma Almada) — the exact AT-45-AC pattern investigated
  // 2026-09-11.
  const tfsAlmadaRows: SheetRecord[] = [
    {
      "Dia do Serviço": day,
      "Nº Camião": "927",
      "Matrícula da Viatura": "AT-45-AC",
      "Ordem de Entrega": "1",
      "Código de Loja": "12",
      "Designação da Loja": "Almada",
      "Janela Início": "06:00",
      "Janela Fim": "08:00",
      "Hora de Chegada": "",
      "Hora de Saída": "",
      ID: "",
    },
  ];
  const tfsAlmadaStops: DayStop[] = [
    { id: "alm-1", vehicleId: 927, plate: "AT45AC", code: "7030", arrivedAt: iso("06:29"), departedAt: iso("06:49") },
  ];
  const tfsAlmadaArgs = {
    day,
    records: tfsAlmadaRows,
    header: tfsHeader,
    cols: tfsCols,
    stops: tfsAlmadaStops,
    fleetByTruck: new Map(),
    platesWithGps: new Set(["AT45AC"]),
    pingWindowByPlate: new Map([["AT45AC", { min: Date.parse(iso("05:00")), max: Date.parse(iso("10:00")) }]]),
  };

  const withoutColocation = runTfsMatch(tfsAlmadaArgs);
  ok(
    "Almada TFS: WITHOUT colocated group -> does not match (12 != 7030)",
    withoutColocation.summary.ok === 0,
    withoutColocation.summary,
  );

  const withColocation = runTfsMatch({ ...tfsAlmadaArgs, coLocatedGroups: almadaGroups });
  ok("Almada TFS: WITH colocated group -> matches OK", withColocation.summary.ok === 1, withColocation.summary);
  ok(
    "Almada TFS: 'Código de Loja' cell stays '12' (never rewritten to 7030)",
    withColocation.rows[0]["Código de Loja"] === "12",
    withColocation.rows[0]["Código de Loja"],
  );
  ok(
    "Almada TFS: times come from the real (7030) stop",
    withColocation.rows[0]["Hora de Chegada"] === "06:29" && withColocation.rows[0]["Hora de Saída"] === "06:49",
    withColocation.rows[0],
  );

  // Azambuja: same shape, the other direction — planned N_LOJA '7030', real
  // stop matched to '12'.
  const azAlmadaHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azAlmadaRecords: SheetRecord[] = [
    {
      ROTA: "R9",
      N_LOJA: "7030",
      NOME: "Plataforma Almada",
      MATRICULA: "AT-45-AC",
      "Hora Chegada": "",
      "Hora Saida": "",
      CICLO: "06:00 | 08:00",
      TIPO: "C",
    },
  ];
  const azAlmadaCols = resolveAzColumns(azAlmadaHeader);
  const azAlmadaStops: DayStop[] = [
    { id: "alm-2", vehicleId: 927, plate: "AT45AC", code: "12", arrivedAt: iso("06:29"), departedAt: iso("06:49") },
  ];
  const azAlmadaArgs = {
    day,
    records: azAlmadaRecords,
    header: azAlmadaHeader,
    cols: azAlmadaCols,
    stops: azAlmadaStops,
    platesWithGps: new Set(["AT45AC"]),
    pingWindowByPlate: new Map([["AT45AC", { min: Date.parse(iso("05:00")), max: Date.parse(iso("10:00")) }]]),
  };

  const azWithout = runAzMatch(azAlmadaArgs);
  ok(
    "Almada Azambuja: WITHOUT colocated group -> does not match",
    azWithout.summary.ok === 0,
    azWithout.summary,
  );

  const azWith = runAzMatch({ ...azAlmadaArgs, coLocatedGroups: almadaGroups });
  ok("Almada Azambuja: WITH colocated group -> matches OK", azWith.summary.ok === 1, azWith.summary);
  ok(
    "Almada Azambuja: 'N_LOJA' cell stays '7030' (never rewritten to 12)",
    azWith.rows[0]["N_LOJA"] === "7030",
    azWith.rows[0]["N_LOJA"],
  );
}

// ---------------------------------------------------------------------------
// mergeFragmentedStops — direct unit tests. Backs the 2026-09
// azambuja-2026-09-15-conferido fragmentation bug: 71 sheet rows landed "OK"
// with an exact 0.0min duration (Chegada === Saída), 57 of them (80%) at
// código 7001 alone — detect_stops cutting/reopening a stop on a >50m GPS
// reposition inside the same yard, with the matcher then pairing the row to
// whichever fragment sorted first (often the shortest).
// ---------------------------------------------------------------------------
{
  const f = (
    id: string,
    vehicleId: number,
    code: string | null,
    arr: string,
    dep: string | null,
  ): DayStop => ({
    id,
    vehicleId,
    plate: "40TT01",
    code,
    arrivedAt: iso(arr),
    departedAt: dep ? iso(dep) : null,
  });

  // 1. Two 0min fragments 5min apart -> merged into one spanning both.
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, "7001", "07:58", "07:58"),
      f("g2", 1, "7001", "08:03", "08:03"),
    ]);
    ok("mergeFragmentedStops: 2 fragments 5min apart -> 1 effective stop", merged.length === 1, merged);
    ok(
      "mergeFragmentedStops: effective stop spans earliest arrival to latest departure",
      merged[0]?.arrivedAt === iso("07:58") && merged[0]?.departedAt === iso("08:03"),
      merged[0],
    );
  }

  // 2. Exactly at the threshold -> still merges (<=, not <).
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, "7001", "07:00", "07:00"),
      f("g2", 1, "7001", `07:${String(FRAGMENT_MERGE_GAP_MIN).padStart(2, "0")}`, "07:20"),
    ]);
    ok(`mergeFragmentedStops: gap === ${FRAGMENT_MERGE_GAP_MIN}min (boundary) -> merges`, merged.length === 1, merged);
  }

  // 3. Just past the threshold -> two genuinely separate stops kept.
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, "7001", "07:00", "07:00"),
      f("g2", 1, "7001", "07:16", "07:20"),
    ]);
    ok("mergeFragmentedStops: gap > threshold -> NOT merged (2 stops kept)", merged.length === 2, merged);
  }

  // 4. Chain of 3 fragments, each within the gap of its neighbour -> all fold
  // into ONE effective stop even though fragment 1 -> 3 alone would exceed it.
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, "7001", "07:58", "07:58"),
      f("g2", 1, "7001", "08:03", "08:03"),
      f("g3", 1, "7001", "08:09", "08:31"),
    ]);
    ok("mergeFragmentedStops: 3-fragment chain -> 1 effective stop", merged.length === 1, merged);
    ok(
      "mergeFragmentedStops: chain spans 07:58 -> 08:31 (33min, plausible)",
      merged[0]?.arrivedAt === iso("07:58") && merged[0]?.departedAt === iso("08:31"),
      merged[0],
    );
  }

  // 5. Same code, DIFFERENT vehicle, close in time -> never merged across vehicles.
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, "7001", "07:58", "07:58"),
      f("g2", 2, "7001", "08:00", "08:00"),
    ]);
    ok("mergeFragmentedStops: different vehicleId -> never merged", merged.length === 2, merged);
  }

  // 6. No code at all -> passed through untouched, never merged with anything.
  {
    const merged = mergeFragmentedStops([
      f("g1", 1, null, "07:58", "07:58"),
      f("g2", 1, null, "08:00", "08:00"),
    ]);
    ok("mergeFragmentedStops: stops without a code are passed through untouched", merged.length === 2, merged);
  }

  // 7. Isolated single stop (código 94 shape: a genuine one-off 0min
  // pass-through, nothing nearby) -> returned unchanged, duration stays 0.
  {
    const merged = mergeFragmentedStops([f("g1", 1, "94", "10:00", "10:00")]);
    ok(
      "mergeFragmentedStops: isolated 0min stop (código 94) stays 0min — never invents a duration",
      merged.length === 1 && merged[0].arrivedAt === merged[0].departedAt,
      merged[0],
    );
  }

  // 8. NEVER bridges a Lisbon calendar-day boundary — regression for the
  // azambuja "02:00 | 14:00" / 7005 case (test-azambuja-window.ts): a stop
  // that itself straddles midnight (23:24 -> 00:12 next day) sits right next
  // to a genuine in-day 0min stop (23:59). Fusing them would launder the
  // ambiguous next-day departure into what looks like one clean, in-window
  // visit — each matcher's own day/CICLO logic must keep judging the
  // midnight-crossing one on its own, unmerged.
  {
    const iso2 = (day: "09" | "10", hhmm: string) => `2026-09-${day}T${hhmm}:00+01:00`;
    const spans: DayStop = { id: "s2", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso2("09", "23:24"), departedAt: iso2("10", "00:12") };
    const inDay: DayStop = { id: "s2b", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso2("09", "23:59"), departedAt: iso2("09", "23:59") };
    const merged = mergeFragmentedStops([spans, inDay]);
    ok(
      "mergeFragmentedStops: a midnight-crossing fragment is never fused with a neighbouring in-day one",
      merged.length === 2 &&
        merged.some((m) => m.id === "s2" && m.departedAt === spans.departedAt) &&
        merged.some((m) => m.id === "s2b" && m.departedAt === inDay.departedAt),
      merged,
    );
  }

  // 9. Two same-day fragments close together, near (but not crossing)
  // midnight, still merge normally — the guard is about the DAY boundary,
  // not proximity to midnight itself.
  {
    const iso2 = (day: "09" | "10", hhmm: string) => `2026-09-${day}T${hhmm}:00+01:00`;
    const merged = mergeFragmentedStops([
      { id: "n1", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso2("09", "23:40"), departedAt: iso2("09", "23:40") },
      { id: "n2", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso2("09", "23:52"), departedAt: iso2("09", "23:59") },
    ]);
    ok(
      "mergeFragmentedStops: two same-day fragments near midnight still merge normally",
      merged.length === 1 && merged[0].arrivedAt === iso2("09", "23:40") && merged[0].departedAt === iso2("09", "23:59"),
      merged,
    );
  }
}

// ---------------------------------------------------------------------------
// End-to-end: the código 7001 fragmentation bug, reproduced through the real
// matchers (not just the unit-level merge). Azambuja hits the sharper version
// directly — match.ts's "candidates.length >= g.rows.length" branch zips
// fragments positionally onto sheet rows in arrival order and simply leaves
// any extra fragment unassigned, so a single row facing 2+ fragments always
// got the earliest (often shortest, sometimes 0min) one. TFS's own positional
// zip (assignGroup) would instead have sent these to REVIEW outright (raw
// fragment count != row count). After the shared pre-merge fix, both resolve
// to one clean OK row with the real, non-zero duration.
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);

  // Case 1 — 3 fragments (2 of them exactly 0min) cut by a yard reposition.
  {
    const azRecords: SheetRecord[] = [
      { ROTA: "185798003", N_LOJA: "7001", NOME: "Plataforma Azambuja", MATRICULA: "40-TT-01", "Hora Chegada": "", "Hora Saida": "", CICLO: "07:00 | 09:00", TIPO: "C" },
    ];
    const azStops: DayStop[] = [
      { id: "frag1", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("07:58"), departedAt: iso("07:58") },
      { id: "frag2", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("08:03"), departedAt: iso("08:03") },
      { id: "frag3", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("08:09"), departedAt: iso("08:31") },
    ];
    const r = runAzMatch({
      day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
      platesWithGps: new Set(["40TT01"]),
      pingWindowByPlate: new Map(),
    });
    ok("7001 fragmentation case 1 (Azambuja): row matches OK", r.rows[0]["Confiança"] === "OK", r.rows[0]);
    ok(
      "7001 fragmentation case 1 (Azambuja): merged duration 07:58 -> 08:31, NOT 0.0min",
      r.rows[0]["Hora Chegada"] === "09-09-2026 07:58:00" && r.rows[0]["Hora Saida"] === "09-09-2026 08:31:00",
      [r.rows[0]["Hora Chegada"], r.rows[0]["Hora Saida"]],
    );
  }

  // Case 2 — 2 fragments, first exactly 0min.
  {
    const azRecords: SheetRecord[] = [
      { ROTA: "185798010", N_LOJA: "7001", NOME: "Plataforma Azambuja", MATRICULA: "41-UU-02", "Hora Chegada": "", "Hora Saida": "", CICLO: "05:00 | 07:00", TIPO: "C" },
    ];
    const azStops: DayStop[] = [
      { id: "frag4", vehicleId: 702, plate: "41UU02", code: "7001", arrivedAt: iso("05:44"), departedAt: iso("05:44") },
      { id: "frag5", vehicleId: 702, plate: "41UU02", code: "7001", arrivedAt: iso("05:51"), departedAt: iso("06:12") },
    ];
    const r = runAzMatch({
      day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
      platesWithGps: new Set(["41UU02"]),
      pingWindowByPlate: new Map(),
    });
    ok(
      "7001 fragmentation case 2 (Azambuja): OK, merged duration 05:44 -> 06:12",
      r.rows[0]["Confiança"] === "OK" && r.rows[0]["Hora Chegada"] === "09-09-2026 05:44:00" && r.rows[0]["Hora Saida"] === "09-09-2026 06:12:00",
      r.rows[0],
    );
  }

  // Case 3 — 3 fragments, all three exactly/near 0min individually.
  {
    const azRecords: SheetRecord[] = [
      { ROTA: "185798044", N_LOJA: "7001", NOME: "Plataforma Azambuja", MATRICULA: "42-VV-03", "Hora Chegada": "", "Hora Saida": "", CICLO: "13:00 | 15:00", TIPO: "C" },
    ];
    const azStops: DayStop[] = [
      { id: "frag6", vehicleId: 703, plate: "42VV03", code: "7001", arrivedAt: iso("13:20"), departedAt: iso("13:20") },
      { id: "frag7", vehicleId: 703, plate: "42VV03", code: "7001", arrivedAt: iso("13:25"), departedAt: iso("13:25") },
      { id: "frag8", vehicleId: 703, plate: "42VV03", code: "7001", arrivedAt: iso("13:28"), departedAt: iso("13:44") },
    ];
    const r = runAzMatch({
      day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
      platesWithGps: new Set(["42VV03"]),
      pingWindowByPlate: new Map(),
    });
    ok(
      "7001 fragmentation case 3 (Azambuja): OK, merged duration 13:20 -> 13:44",
      r.rows[0]["Confiança"] === "OK" && r.rows[0]["Hora Chegada"] === "09-09-2026 13:20:00" && r.rows[0]["Hora Saida"] === "09-09-2026 13:44:00",
      r.rows[0],
    );
  }

  // TFS side of the same shared fix: before it, this shape (3 raw fragments,
  // 1 sheet row) fell to REVIEW (fragment count != row count) instead of a
  // false OK — either way the bug, just a different symptom. After the fix,
  // it's a clean OK with the merged, plausible duration.
  {
    const tfsFragHeader = [
      "Dia do Serviço", "Nº Camião", "Matrícula da Viatura", "Ordem de Entrega",
      "Código de Loja", "Designação da Loja", "Janela Início", "Janela Fim",
      "Hora de Chegada", "Hora de Saída", "ID",
    ];
    const tfsFragCols = resolveTfsColumns(tfsFragHeader);
    const tfsFragRow: SheetRecord = {
      "Dia do Serviço": day, "Nº Camião": "701", "Matrícula da Viatura": "40TT01",
      "Ordem de Entrega": "1", "Código de Loja": "7001", "Designação da Loja": "Plataforma Azambuja",
      "Janela Início": "07:00", "Janela Fim": "09:00", "Hora de Chegada": "", "Hora de Saída": "", ID: "",
    };
    const tfsFragStops: DayStop[] = [
      { id: "frag1", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("07:58"), departedAt: iso("07:58") },
      { id: "frag2", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("08:03"), departedAt: iso("08:03") },
      { id: "frag3", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("08:09"), departedAt: iso("08:31") },
    ];
    const r = runTfsMatch({
      day, records: [tfsFragRow], header: tfsFragHeader, cols: tfsFragCols, stops: tfsFragStops,
      fleetByTruck: new Map(), platesWithGps: new Set(["40TT01"]), pingWindowByPlate: new Map(),
    });
    ok("7001 fragmentation (TFS): row matches OK, not REVIEW", r.rows[0]["Confiança"] === "OK", r.rows[0]);
    ok(
      "7001 fragmentation (TFS): merged duration 07:58 -> 08:31, NOT 0.0min",
      r.rows[0]["Hora de Chegada"] === "07:58" && r.rows[0]["Hora de Saída"] === "08:31",
      [r.rows[0]["Hora de Chegada"], r.rows[0]["Hora de Saída"]],
    );
  }
}

// ---------------------------------------------------------------------------
// Regression: código 94 (Albufeira) must still show a legitimate 0min
// duration when it really is a single, isolated pass-through — no nearby
// fragment to explain away. The fix must never invent a duration.
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  const azRecords: SheetRecord[] = [
    { ROTA: "R94", N_LOJA: "94", NOME: "Armazém Albufeira", MATRICULA: "28-RN-74", "Hora Chegada": "", "Hora Saida": "", CICLO: "01:00 | 04:00", TIPO: "C" },
  ];
  const azStops: DayStop[] = [
    { id: "alb-1", vehicleId: 280, plate: "28RN74", code: "94", arrivedAt: iso("02:48"), departedAt: iso("02:48") },
  ];
  const r = runAzMatch({
    day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
    platesWithGps: new Set(["28RN74"]),
    pingWindowByPlate: new Map(),
  });
  ok("código 94 isolated 0min: still matches OK", r.rows[0]["Confiança"] === "OK", r.rows[0]);
  ok(
    "código 94 isolated 0min: duration STAYS 0min (Chegada === Saída) — no invented duration",
    r.rows[0]["Hora Chegada"] === r.rows[0]["Hora Saida"] && r.rows[0]["Hora Chegada"] === "09-09-2026 02:48:00",
    r.rows[0],
  );
}

// ---------------------------------------------------------------------------
// Boundary: two GENUINELY distinct visits to the same location by the same
// vehicle, far enough apart (> FRAGMENT_MERGE_GAP_MIN), must NOT be fused
// into one — each sheet row keeps its own real visit.
// ---------------------------------------------------------------------------
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  const mk = (rota: string): SheetRecord => ({
    ROTA: rota, N_LOJA: "7001", NOME: "Plataforma Azambuja", MATRICULA: "40-TT-01",
    "Hora Chegada": "", "Hora Saida": "", CICLO: "06:00 | 14:00", TIPO: "C",
  });
  const azRecords = [mk("R1"), mk("R2")];
  // Morning visit (08:00-08:10) and an afternoon revisit (12:00-12:15) —
  // 3h50 apart, nowhere near the 15min fragment threshold.
  const azStops: DayStop[] = [
    { id: "v1", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("08:00"), departedAt: iso("08:10") },
    { id: "v2", vehicleId: 701, plate: "40TT01", code: "7001", arrivedAt: iso("12:00"), departedAt: iso("12:15") },
  ];
  const r = runAzMatch({
    day, records: azRecords, header: azHeader, cols: azCols, stops: azStops,
    platesWithGps: new Set(["40TT01"]),
    pingWindowByPlate: new Map(),
  });
  ok("two genuine visits, same code/vehicle, 3h50 apart: both rows OK", r.rows[0]["Confiança"] === "OK" && r.rows[1]["Confiança"] === "OK", r.rows);
  ok(
    "two genuine visits: each row keeps its OWN visit, not fused",
    r.rows[0]["Hora Chegada"] === "09-09-2026 08:00:00" && r.rows[1]["Hora Chegada"] === "09-09-2026 12:00:00",
    [r.rows[0]["Hora Chegada"], r.rows[1]["Hora Chegada"]],
  );
}

// ---------------------------------------------------------------------------
// 5th visual rule: physical schedule overlap / conflict detection (dark gray)
// Case 1: User's headline case (33-IV-96, route 185840951 / 185840819, 15/09)
// 7005 mantido 02:50-03:10 vs 7001 OK 02:54-03:34
// ---------------------------------------------------------------------------
{
  const azDay = "2026-09-15";
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  const azRecords: SheetRecord[] = [
    {
      ROTA: "185840951",
      N_LOJA: "7005",
      NOME: "Auchan Congelados",
      MATRICULA: "33-IV-96",
      "Hora Chegada": "15/09/2026 02:50",
      "Hora Saida": "15/09/2026 03:10",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
    {
      ROTA: "185840951",
      N_LOJA: "7001",
      NOME: "Auchan Azambuja",
      MATRICULA: "33-IV-96",
      "Hora Chegada": "",
      "Hora Saida": "",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
  ];
  const azStops: DayStop[] = [
    {
      id: "stop-7001",
      vehicleId: 1039275,
      plate: "33IV96",
      code: "7001",
      arrivedAt: "2026-09-15T02:54:00+01:00",
      departedAt: "2026-09-15T03:34:00+01:00",
    },
  ];
  const r = runAzMatch({
    day: azDay,
    records: azRecords,
    header: azHeader,
    cols: azCols,
    stops: azStops,
    platesWithGps: new Set(["33IV96"]),
    pingWindowByPlate: new Map(),
    rawRecords: azRecords,
  });

  const row7005 = r.rows[0];
  const row7001 = r.rows[1];

  ok("33-IV-96 conflict: row 7005 conf kept unchanged", row7005["Confiança"] === KEPT, row7005);
  ok("33-IV-96 conflict: row 7005 times kept unchanged", row7005["Hora Chegada"] === "15-09-2026 02:50" && row7005["Hora Saida"] === "15-09-2026 03:10", row7005);
  ok("33-IV-96 conflict: row 7001 conf OK unchanged", row7001["Confiança"] === "OK", row7001);
  ok("33-IV-96 conflict: row 7001 times OK unchanged", row7001["Hora Chegada"] === "15-09-2026 02:54:00" && row7001["Hora Saida"] === "15-09-2026 03:34:00", row7001);

  ok("33-IV-96 conflict: row 7005 flags conflict in Real", typeof row7005["Real"] === "string" && row7005["Real"].includes("⚠️ Conflito: sobrepõe-se à linha 7001 (Auchan Azambuja, 02:54–03:34)"), row7005["Real"]);
  ok("33-IV-96 conflict: row 7001 flags conflict in Real", typeof row7001["Real"] === "string" && row7001["Real"].includes("⚠️ Conflito: sobrepõe-se à linha 7005 (Auchan Congelados, 02:50–03:10)"), row7001["Real"]);
}

// Case 2: Co-located stores (12/7030, 26/7004, 01/7001, B78/94) with overlapping times
// Must NOT flag conflict because they are the same physical site!
{
  const azDay = "2026-09-15";
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  const azRecords: SheetRecord[] = [
    {
      ROTA: "R100",
      N_LOJA: "B78",
      NOME: "Albufeira Hiper",
      MATRICULA: "28-RN-74",
      "Hora Chegada": "15/09/2026 02:50",
      "Hora Saida": "15/09/2026 03:10",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
    {
      ROTA: "R100",
      N_LOJA: "94",
      NOME: "Albufeira Armazém",
      MATRICULA: "28-RN-74",
      "Hora Chegada": "15/09/2026 02:54",
      "Hora Saida": "15/09/2026 03:34",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
  ];
  const coLocatedGroups: CoLocatedGroups = [new Set(["B78", "94", "AUCHAN-06"])];
  const r = runAzMatch({
    day: azDay,
    records: azRecords,
    header: azHeader,
    cols: azCols,
    stops: [],
    platesWithGps: new Set(["28RN74"]),
    pingWindowByPlate: new Map(),
    rawRecords: azRecords,
    coLocatedGroups,
  });
  ok("co-located B78/94: no conflict flagged on B78", !String(r.rows[0]["Real"] ?? "").includes("Conflito"), r.rows[0]["Real"]);
  ok("co-located B78/94: no conflict flagged on 94", !String(r.rows[1]["Real"] ?? "").includes("Conflito"), r.rows[1]["Real"]);
}

// Case 3: Adjacent stops (02:50-03:10 and 03:10-03:30)
// Must NOT flag conflict because startB === endA (no overlap)
{
  const azDay = "2026-09-15";
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  const azRecords: SheetRecord[] = [
    {
      ROTA: "R101",
      N_LOJA: "7005",
      NOME: "Auchan Congelados",
      MATRICULA: "33-IV-96",
      "Hora Chegada": "15/09/2026 02:50",
      "Hora Saida": "15/09/2026 03:10",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
    {
      ROTA: "R101",
      N_LOJA: "7001",
      NOME: "Auchan Azambuja",
      MATRICULA: "33-IV-96",
      "Hora Chegada": "15/09/2026 03:10",
      "Hora Saida": "15/09/2026 03:30",
      CICLO: "01:00 | 05:00",
      TIPO: "C",
    },
  ];
  const r = runAzMatch({
    day: azDay,
    records: azRecords,
    header: azHeader,
    cols: azCols,
    stops: [],
    platesWithGps: new Set(["33IV96"]),
    pingWindowByPlate: new Map(),
    rawRecords: azRecords,
  });
  ok("adjacent stops: no conflict flagged on 7005", !String(r.rows[0]["Real"] ?? "").includes("Conflito"), r.rows[0]["Real"]);
  ok("adjacent stops: no conflict flagged on 7001", !String(r.rows[1]["Real"] ?? "").includes("Conflito"), r.rows[1]["Real"]);
}

// Case 4: TFS sheet conflict detection
{
  const tfsDay = "2026-09-15";
  const tfsHeader = [
    "Dia do Serviço",
    "Nº Camião",
    "Matrícula da Viatura",
    "Ordem de Entrega",
    "Código de Loja",
    "Designação da Loja",
    "Janela Início",
    "Janela Fim",
    "Hora de Chegada",
    "Hora de Saída",
    "ID",
  ];
  const tfsCols = resolveTfsColumns(tfsHeader);
  const tfsRecords: SheetRecord[] = [
    {
      "Dia do Serviço": tfsDay,
      "Nº Camião": "500",
      "Matrícula da Viatura": "11-AA-11",
      "Ordem de Entrega": "1",
      "Código de Loja": "E89",
      "Designação da Loja": "Continente Cascais",
      "Janela Início": "08:00",
      "Janela Fim": "10:00",
      "Hora de Chegada": "08:30",
      "Hora de Saída": "09:15",
      ID: "TFS-500-11AA11-1ªRota-15/09/2026",
    },
    {
      "Dia do Serviço": tfsDay,
      "Nº Camião": "500",
      "Matrícula da Viatura": "11-AA-11",
      "Ordem de Entrega": "2",
      "Código de Loja": "B97",
      "Designação da Loja": "Continente Amadora",
      "Janela Início": "08:00",
      "Janela Fim": "10:00",
      "Hora de Chegada": "09:00",
      "Hora de Saída": "09:45",
      ID: "TFS-500-11AA11-1ªRota-15/09/2026",
    },
  ];
  const r = runTfsMatch({
    day: tfsDay,
    records: tfsRecords,
    header: tfsHeader,
    cols: tfsCols,
    stops: [],
    platesWithGps: new Set(["11AA11"]),
    fleetByTruck: new Map(),
    pingWindowByPlate: new Map(),
  });
  ok("TFS conflict: row E89 flags conflict in Real", typeof r.rows[0]["Real"] === "string" && r.rows[0]["Real"].includes("⚠️ Conflito: sobrepõe-se à linha B97 (Continente Amadora, 09:00–09:45)"), r.rows[0]["Real"]);
  ok("TFS conflict: row B97 flags conflict in Real", typeof r.rows[1]["Real"] === "string" && r.rows[1]["Real"].includes("⚠️ Conflito: sobrepõe-se à linha E89 (Continente Cascais, 08:30–09:15)"), r.rows[1]["Real"]);
  ok("TFS conflict: row E89 conf KEPT unchanged", r.rows[0]["Confiança"] === KEPT);
  ok("TFS conflict: row B97 conf KEPT unchanged", r.rows[1]["Confiança"] === KEPT);
}

// ---------------------------------------------------------------------------
// Case 5: implausible speed between a vehicle's own CONSECUTIVE stops
// (day-wide — crosses ROUTES on purpose, unlike Case 4's conflict rule,
// which is scoped to one route). Two fictional locations ~30km apart, same
// longitude, so the haversine distance has a closed form (R * Δlat_rad
// exactly — no linear-degrees approximation error): the 3 sub-cases below
// derive their exact minute gaps from the REAL distance haversineKm computes,
// not a hand-typed approximation, so a boundary case actually lands on the
// boundary regardless of floating-point noise in the trig.
// ---------------------------------------------------------------------------
{
  const EARTH_R_KM = 6371;
  const SYN_DISTANCE_KM = 30;
  const dLatDeg = (SYN_DISTANCE_KM / EARTH_R_KM) * (180 / Math.PI);
  const SYN_A = { lat: 38.7, lng: -9.0 };
  const SYN_B = { lat: 38.7 + dLatDeg, lng: -9.0 };
  const syntheticDistanceKm = haversineKm(SYN_A.lat, SYN_A.lng, SYN_B.lat, SYN_B.lng);
  ok(
    `synthetic pair really is ~${SYN_DISTANCE_KM}km apart (sanity check on the construction, not the code under test)`,
    Math.abs(syntheticDistanceKm - SYN_DISTANCE_KM) < 0.01,
    syntheticDistanceKm,
  );
  const codeCoords = new Map([
    ["SYN-A", SYN_A],
    ["SYN-B", SYN_B],
  ]);

  // baseHour:baseMin + addMin -> "HH:MM", via real arithmetic (not string
  // concat) so a case that happens to cross an hour boundary stays correct.
  const fmtHHMM = (addMin: number) => {
    const total = 8 * 60 + addMin; // base: 08:00
    const h = Math.floor(total / 60) % 24;
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const azCols = resolveAzColumns(azHeader);
  // Rows are "mantido" (both times pre-filled with a plausible 10min stop
  // duration each) — deliberately NOT "OK" rows, to also confirm the rule
  // fires on kept rows, same as scheduleConflict already does.
  const mkSpeedRow = (rota: string, code: string, addMin: number): SheetRecord => ({
    ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: "SP-EE-DD",
    "Hora Chegada": `09-09-2026 ${fmtHHMM(addMin)}`,
    "Hora Saida": `09-09-2026 ${fmtHHMM(addMin + 10)}`,
    CICLO: "08:00 | 20:00", TIPO: "C",
  });

  // gapMin = the Saída_A -> Chegada_B gap the 3 sub-cases vary. Two different
  // ROTAs on purpose — proves the rule crosses routes, which the
  // route-scoped conflict rule (Case 4) never would.
  const runSpeedCase = (gapMin: number) => {
    const records: SheetRecord[] = [
      mkSpeedRow("SPD-R1", "SYN-A", 0), // 08:00 -> 08:10
      mkSpeedRow("SPD-R2", "SYN-B", 10 + gapMin), // chegada = 08:10 + gapMin
    ];
    return runAzMatch({
      day, records, header: azHeader, cols: azCols, stops: [],
      platesWithGps: new Set(),
      pingWindowByPlate: new Map(),
      codeCoords,
    });
  };

  const hasSpeedNote = (v: unknown) => typeof v === "string" && v.includes("⚠️ Velocidade implausível");

  // Sub-case 1: clearly implausible (~20min gap -> ~90km/h, well over 50).
  {
    const gapMin = Math.round((syntheticDistanceKm / 90) * 60);
    const r = runSpeedCase(gapMin);
    ok(`speed [dispara]: gap chosen for ~90km/h is ${gapMin}min`, gapMin > 0 && gapMin < 30, gapMin);
    ok("speed [dispara]: row A (SYN-A) flags implausible speed in Real", hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
    ok("speed [dispara]: row B (SYN-B) flags implausible speed in Real", hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
    ok("speed [dispara]: note names both codes", typeof r.rows[0]["Real"] === "string" && (r.rows[0]["Real"] as string).includes("SYN-A") && (r.rows[0]["Real"] as string).includes("SYN-B"), r.rows[0]["Real"]);
    ok("speed [dispara]: note states the >50km/h limit", typeof r.rows[0]["Real"] === "string" && (r.rows[0]["Real"] as string).includes(`exceder ${MAX_PLAUSIBLE_SPEED_KMH}km/h`), r.rows[0]["Real"]);
    ok("speed [dispara]: Confiança untouched (still mantido), rule only annotates Real", r.rows[0]["Confiança"] === KEPT && r.rows[1]["Confiança"] === KEPT, [r.rows[0]["Confiança"], r.rows[1]["Confiança"]]);
  }

  // Sub-case 2: plausible, comfortably within the limit (~45min -> ~40km/h).
  {
    const gapMin = Math.round((syntheticDistanceKm / 40) * 60);
    const r = runSpeedCase(gapMin);
    ok(`speed [não dispara]: gap chosen for ~40km/h is ${gapMin}min`, gapMin > 30, gapMin);
    ok("speed [não dispara]: row A (SYN-A) Real has NO speed note", !hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
    ok("speed [não dispara]: row B (SYN-B) Real has NO speed note", !hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
  }

  // Sub-case 3: the boundary itself, EXACTLY 50km/h (36min for a 30km gap) —
  // must NOT fire (strict >, same convention as every other threshold rule
  // in this codebase: exactly-at-the-limit is plausible).
  {
    const gapMin = Math.round((syntheticDistanceKm / MAX_PLAUSIBLE_SPEED_KMH) * 60);
    const r = runSpeedCase(gapMin);
    ok(`speed [limite]: gap for exactly ${MAX_PLAUSIBLE_SPEED_KMH}km/h is ${gapMin}min`, gapMin === 36, gapMin);
    ok("speed [limite]: row A (SYN-A) Real has NO speed note (exactly at the limit is plausible)", !hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
    ok("speed [limite]: row B (SYN-B) Real has NO speed note (exactly at the limit is plausible)", !hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
  }

  // Same-location pairs never trip the rule, however far apart in time —
  // zero distance, regardless of gap.
  {
    const records: SheetRecord[] = [
      mkSpeedRow("SPD-R3", "SYN-A", 0), // 08:00 -> 08:10
      mkSpeedRow("SPD-R4", "SYN-A", 500), // same code, 08h10min later
    ];
    const r = runAzMatch({
      day, records, header: azHeader, cols: azCols, stops: [],
      platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords,
    });
    ok("speed: same code, huge time gap -> never flagged (zero distance)", !hasSpeedNote(r.rows[0]["Real"]) && !hasSpeedNote(r.rows[1]["Real"]), [r.rows[0]["Real"], r.rows[1]["Real"]]);
  }

  // Missing coordinates for one of the codes -> no unverified assumption,
  // never flagged (mirrors codeTypes' "unknown -> no assumption" stance).
  {
    const records: SheetRecord[] = [
      mkSpeedRow("SPD-R5", "SYN-A", 0),
      mkSpeedRow("SPD-R6", "SYN-NOCOORD", 30), // 20min gap, would be ~90km/h IF we knew where it was
    ];
    const r = runAzMatch({
      day, records, header: azHeader, cols: azCols, stops: [],
      platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords,
    });
    ok("speed: unknown coordinates for one code -> not flagged (no unverified assumption)", !hasSpeedNote(r.rows[0]["Real"]) && !hasSpeedNote(r.rows[1]["Real"]), [r.rows[0]["Real"], r.rows[1]["Real"]]);
  }

  // Long-distance trips (>100km): highway threshold MAX_PLAUSIBLE_SPEED_LONG_KMH (80km/h).
  {
    ok("getMaxPlausibleSpeedKmh: <=100km returns 50", getMaxPlausibleSpeedKmh(100) === 50);
    ok("getMaxPlausibleSpeedKmh: >100km returns 80", getMaxPlausibleSpeedKmh(100.1) === 80);
    ok("getMaxPlausibleSpeedKmh: custom override respected", getMaxPlausibleSpeedKmh(250, 45) === 45);

    // Real-world regression: 7003 -> 26 (246.0km in 219min = 67.4km/h)
    // Legitimate highway trip in Portugal that previously false-positive flagged under the 50km/h ceiling.
    const DIST_246_KM = 246;
    const dLat246 = (DIST_246_KM / EARTH_R_KM) * (180 / Math.PI);
    const COORD_7003 = { lat: 38.0, lng: -8.0 };
    const COORD_26 = { lat: 38.0 + dLat246, lng: -8.0 };
    const longCoords = new Map([
      ["7003", COORD_7003],
      ["26", COORD_26],
    ]);
    const dist246Computed = haversineKm(COORD_7003.lat, COORD_7003.lng, COORD_26.lat, COORD_26.lng);
    ok("long speed: synthetic 7003->26 distance is ~246km", Math.abs(dist246Computed - 246) < 0.1, dist246Computed);

    // Real case: 219 min gap -> 67.4 km/h (< 80km/h) -> must NOT fire.
    {
      const records: SheetRecord[] = [
        mkSpeedRow("SPD-L1", "7003", 0), // 08:00 -> 08:10
        mkSpeedRow("SPD-L2", "26", 10 + 219), // arrival 219 min after departure of 7003
      ];
      const r = runAzMatch({
        day, records, header: azHeader, cols: azCols, stops: [],
        platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords: longCoords,
      });
      ok("real case 7003->26 (246km, 219min, 67.4km/h): row 7003 has NO speed note", !hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
      ok("real case 7003->26 (246km, 219min, 67.4km/h): row 26 has NO speed note", !hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
    }

    // Impossible long-distance speed: 246km in 120min = 123km/h (> 80km/h) -> DOES fire.
    {
      const records: SheetRecord[] = [
        mkSpeedRow("SPD-L3", "7003", 0), // 08:00 -> 08:10
        mkSpeedRow("SPD-L4", "26", 10 + 120), // arrival 120 min after departure -> 123km/h
      ];
      const r = runAzMatch({
        day, records, header: azHeader, cols: azCols, stops: [],
        platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords: longCoords,
      });
      ok("impossible long trip (246km in 120min = 123km/h): row 7003 flags implausible speed", hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
      ok("impossible long trip (246km in 120min = 123km/h): row 26 flags implausible speed", hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
      ok("impossible long trip note states the >80km/h limit", typeof r.rows[0]["Real"] === "string" && (r.rows[0]["Real"] as string).includes(`exceder ${MAX_PLAUSIBLE_SPEED_LONG_KMH}km/h`), r.rows[0]["Real"]);
    }

    // Boundary at exactly 100km: distance <= 100km uses base limit (50km/h).
    {
      const dLat100 = (100.0 / EARTH_R_KM) * (180 / Math.PI);
      const COORD_100A = { lat: 38.0, lng: -8.0 };
      const COORD_100B = { lat: 38.0 + dLat100, lng: -8.0 };
      const boundCoords = new Map([
        ["BND-A", COORD_100A],
        ["BND-B", COORD_100B],
      ]);
      // 100km in 100min = 60km/h (> 50km/h base limit).
      // Since distance is exactly 100.0km (not > 100), it uses 50km/h limit and must fire.
      const records: SheetRecord[] = [
        mkSpeedRow("SPD-B1", "BND-A", 0),
        mkSpeedRow("SPD-B2", "BND-B", 10 + 100),
      ];
      const r = runAzMatch({
        day, records, header: azHeader, cols: azCols, stops: [],
        platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords: boundCoords,
      });
      ok("boundary at 100.0km (60km/h): uses 50km/h limit -> flags speed", hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
      ok("boundary at 100.0km: note states 50km/h limit", typeof r.rows[0]["Real"] === "string" && (r.rows[0]["Real"] as string).includes("exceder 50km/h"), r.rows[0]["Real"]);
    }

    // Just above 100km (101km): distance > 100km uses 80km/h limit.
    {
      const dLat101 = (101.0 / EARTH_R_KM) * (180 / Math.PI);
      const COORD_101A = { lat: 38.0, lng: -8.0 };
      const COORD_101B = { lat: 38.0 + dLat101, lng: -8.0 };
      const boundCoords101 = new Map([
        ["BND-101A", COORD_101A],
        ["BND-101B", COORD_101B],
      ]);
      // 101km in 101min = 60km/h (<= 80km/h highway limit).
      // Since distance is 101km (> 100), it uses 80km/h limit and must NOT fire.
      const records: SheetRecord[] = [
        mkSpeedRow("SPD-B3", "BND-101A", 0),
        mkSpeedRow("SPD-B4", "BND-101B", 10 + 101),
      ];
      const r = runAzMatch({
        day, records, header: azHeader, cols: azCols, stops: [],
        platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords: boundCoords101,
      });
      ok("trip at 101.0km (60km/h): uses 80km/h limit -> NO speed note", !hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
    }
  }

  // TFS matcher: same rule, confirms the wiring (RunMatchArgs.codeCoords,
  // the detectImplausibleSpeed call site) also works on that matcher.
  {
    const spdDay = "2026-09-09";
    const spdTfsHeader = [
      "Dia do Serviço", "Nº Camião", "Matrícula da Viatura", "Ordem de Entrega",
      "Código de Loja", "Designação da Loja", "Janela Início", "Janela Fim",
      "Hora de Chegada", "Hora de Saída", "ID",
    ];
    const spdTfsCols = resolveTfsColumns(spdTfsHeader);
    const gapMin = Math.round((syntheticDistanceKm / 90) * 60); // ~90km/h
    const mkTfsSpeedRow = (ordem: number, code: string, addMin: number): SheetRecord => ({
      "Dia do Serviço": spdDay, "Nº Camião": "700", "Matrícula da Viatura": "SP-EE-DD",
      "Ordem de Entrega": String(ordem), "Código de Loja": code, "Designação da Loja": code,
      "Janela Início": "08:00", "Janela Fim": "20:00",
      "Hora de Chegada": fmtHHMM(addMin), "Hora de Saída": fmtHHMM(addMin + 10),
      ID: "TFS-700-SPEEDD-1ªRota-09/09/2026",
    });
    const records: SheetRecord[] = [
      mkTfsSpeedRow(1, "SYN-A", 0),
      mkTfsSpeedRow(2, "SYN-B", 10 + gapMin),
    ];
    const r = runTfsMatch({
      day: spdDay, records, header: spdTfsHeader, cols: spdTfsCols, stops: [],
      fleetByTruck: new Map(), platesWithGps: new Set(), pingWindowByPlate: new Map(),
      codeCoords,
    });
    ok("TFS speed [dispara]: row A (SYN-A) flags implausible speed in Real", hasSpeedNote(r.rows[0]["Real"]), r.rows[0]["Real"]);
    ok("TFS speed [dispara]: row B (SYN-B) flags implausible speed in Real", hasSpeedNote(r.rows[1]["Real"]), r.rows[1]["Real"]);
    ok("TFS speed [dispara]: Confiança untouched (still mantido)", r.rows[0]["Confiança"] === KEPT && r.rows[1]["Confiança"] === KEPT);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

