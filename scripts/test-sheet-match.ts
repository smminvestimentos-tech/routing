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
  type DayStop,
  type SheetRecord,
} from "@/lib/tfs-sheet/match";
import {
  resolveColumns as resolveAzColumns,
  runMatch as runAzMatch,
} from "@/lib/azambuja-sheet/match";
import { findPlateTypo, isEditDistance1 } from "@/lib/sheet-match/common";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
