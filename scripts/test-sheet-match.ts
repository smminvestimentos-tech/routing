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
  codeEq,
  codeKey,
  type CoLocatedGroups,
  findPlateTypo,
  isEditDistance1,
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
    r.rows[1]["Hora Chegada"] === "05/09/2026 07:00" && r.rows[1]["Hora Saida"] === "05/09/2026 07:20",
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
