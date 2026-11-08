// Plano de Cargas na folha Azambuja (src/lib/azambuja-sheet/plano.ts + match.ts).
//
//   npm run test:azambuja-plano
//
// Usa os ficheiros reais de 07-11-2026 em data/fixtures/ quando existem
// (folha sem horas + plano de cargas) e casos sintéticos sempre.

import * as XLSX from "xlsx";
import { existsSync, readFileSync } from "node:fs";
import { parsePlanoCargas, parsePlanTime, type PlanLine } from "@/lib/azambuja-sheet/plano";
import { resolveColumns, runMatch, REVIEW, type DayStop, type SheetRecord } from "@/lib/azambuja-sheet/match";

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

// --- parsePlanTime -------------------------------------------------------
console.log("== parsePlanTime ==");
{
  // 07-11-2026 00:32 Lisboa (= UTC em novembro) como série Excel e como texto
  const serial = 46333 + 32 / 1440; // 2026-11-07 = 46333
  ok("série Excel 07-11 00:32 -> 00:32Z", parsePlanTime(serial) === Date.parse("2026-11-07T00:32:00Z"), new Date(parsePlanTime(serial)!).toISOString());
  ok("texto ISO", parsePlanTime("2026-11-07 00:32:00") === Date.parse("2026-11-07T00:32:00Z"));
  ok("texto DD-MM-YYYY", parsePlanTime("07-11-2026 00:32") === Date.parse("2026-11-07T00:32:00Z"));
  ok("setembro (WEST, +01:00)", parsePlanTime("2026-09-10 08:00") === Date.parse("2026-09-10T07:00:00Z"));
  ok("vazio -> null", parsePlanTime("") === null);
}

// --- ficheiros reais 07-11-2026 -----------------------------------------
console.log("\n== ficheiros reais 07-11-2026 ==");
const PLANO = "data/fixtures/plano-cargas-07-11-2026.xlsx";
const FOLHA = "data/fixtures/folha-azambuja-07-11-2026-sem-horas.xlsx";
if (existsSync(PLANO) && existsSync(FOLHA)) {
  const parsed = parsePlanoCargas(XLSX.read(readFileSync(PLANO), { type: "buffer" }));
  ok("plano lê-se sem erro", !("error" in parsed), parsed);
  if (!("error" in parsed)) {
    const lines = parsed.lines;
    ok("plano: 533 linhas", lines.length === 533, lines.length);
    const first = lines.find((l) => l.rota === "186307191" && l.seq === 1)!;
    ok("plano: 186307191 SEQ1 = 7003, 00:32, 29 paletes, tipo C",
      first.code === "7003" && first.arrMs === Date.parse("2026-11-07T00:32:00Z") && first.carga === 29 && first.tipo === "C", first);
    const ret = lines.find((l) => l.rota === "186307191" && l.seq === 4)!;
    ok("plano: regresso 7001 sem carga", ret.code === "7001" && ret.carga === 0, ret);

    const ws = XLSX.read(readFileSync(FOLHA), { type: "buffer" });
    const sh = ws.Sheets[ws.SheetNames[0]];
    const header = (XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, defval: "" })[0] as unknown[]).map((h) => String(h).trim());
    const records = XLSX.utils.sheet_to_json<SheetRecord>(sh, { raw: false, defval: "", blankrows: false })
      // a folha de teste vem de um output antigo: limpar o que a app escreveu
      .map((r) => ({ ...r, "Hora Chegada": "", "Hora Saida": "" }));
    const cols = resolveColumns(header);
    const res = runMatch({ day: "2026-11-07", records, header, cols, stops: [], platesWithGps: new Set(), pingWindowByPlate: new Map(), plan: lines });
    ok("todas as 533 linhas da folha ligadas ao plano", res.summary.planRows === 533, res.summary.planRows);
  }
} else {
  console.log("  ~~   ficheiros reais em falta — saltado");
}

// --- casos sintéticos ----------------------------------------------------
console.log("\n== sintéticos ==");
const header = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
const cols = resolveColumns(header);
const P = "AD-49-DH";
const row = (rota: string, code: string, tipo = "C"): SheetRecord => ({
  ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: P, "Hora Chegada": "", "Hora Saida": "", CICLO: "08:00 | 20:00", TIPO: tipo,
});
let sid = 0;
const Z = (hhmm: string) => `2026-11-07T${hhmm}:00Z`;
const st = (code: string, a: string, d: string): DayStop => ({ id: `s${sid++}`, vehicleId: 1, plate: "AD49DH", code, arrivedAt: Z(a), departedAt: Z(d) });
const pl = (rota: string, seq: number, code: string, a: string, carga: number, tipo = "C"): PlanLine => ({
  rota, seq, code, arrMs: Date.parse(Z(a)), depMs: null, carga, tipo, frota: "",
});
const run = (records: SheetRecord[], stops: DayStop[], plan?: PlanLine[]) =>
  runMatch({ day: "2026-11-07", records, header, cols, stops, platesWithGps: new Set(["AD49DH"]), pingWindowByPlate: new Map(), plan });
const t = (r: SheetRecord) => `${String(r["Hora Chegada"]).slice(11, 16)}-${String(r["Hora Saida"]).slice(11, 16)}`;

// 1. Duas paragens 7001 antes da entrega: sem plano ganha a mais cedo... (head
//    = última antes da entrega); com plano ganha a mais próxima da hora prevista.
{
  const recs = [row("R", "7001"), row("R", "18", "D"), row("R", "7001")];
  const stops = [st("7001", "06:00", "06:50"), st("7001", "07:20", "08:20"), st("18", "09:30", "10:00"), st("7001", "11:00", "11:05")];
  const plan = [pl("R", 1, "7001", "06:10", 33), pl("R", 2, "18", "09:35", 33, "D"), pl("R", 3, "7001", "11:08", 0)];
  const r = run(recs, stops, plan);
  ok("com plano: carga = 06:00 (prevista 06:10), não a última antes da entrega", t(r.rows[0]) === "06:00-06:50", t(r.rows[0]));
  ok("com plano: regresso sem carga com toque de 5 min aceite", t(r.rows[2]) === "11:00-11:05" && r.rows[2]["Confiança"] === "OK", r.rows[2]);
}

// 2. Carga prevista mas só um toque de 1 min -> Rever com motivo, sem horas.
{
  const recs = [row("R", "7001"), row("R", "18", "D")];
  const stops = [st("7001", "07:30", "07:31"), st("18", "09:30", "10:00")];
  const plan = [pl("R", 1, "7001", "07:30", 33), pl("R", 2, "18", "09:35", 33, "D")];
  const r = run(recs, stops, plan);
  ok("carga só com toque -> Rever", r.rows[0]["Confiança"] === REVIEW && r.rows[0]["Hora Chegada"] === "", r.rows[0]);
  ok("carga só com toque -> motivo no Real", /Carga prevista \(33 paletes\)/.test(String(r.rows[0]["Real"])), r.rows[0]["Real"]);
  ok("entrega continua OK", r.rows[1]["Confiança"] === "OK", r.rows[1]);
}

// 3. Carga: há um toque perto da hora e uma permanência um pouco mais longe -> a permanência.
{
  const recs = [row("R", "7001"), row("R", "18", "D")];
  // (≥ 15 min de intervalo, senão mergeFragmentedStops junta-as numa só visita)
  const stops = [st("7001", "07:30", "07:31"), st("7001", "07:55", "08:55"), st("18", "09:30", "10:00")];
  const plan = [pl("R", 1, "7001", "07:30", 33), pl("R", 2, "18", "09:35", 33, "D")];
  const r = run(recs, stops, plan);
  ok("carga prefere a permanência de 60 min ao toque", t(r.rows[0]) === "07:55-08:55", t(r.rows[0]));
}

// 4. Paragem a mais de 4 h da hora prevista não serve.
{
  const recs = [row("R", "18", "D")];
  const stops = [st("18", "14:30", "15:00")];
  const plan = [pl("R", 1, "18", "09:35", 33, "D")];
  const r = run(recs, stops, plan);
  ok("a 5 h da hora prevista -> não é aceite", r.rows[0]["Confiança"] !== "OK", r.rows[0]);
  const r2 = run(recs, stops);
  ok("sem plano: a mesma paragem é aceite (comportamento antigo)", r2.rows[0]["Confiança"] === "OK", r2.rows[0]);
}

// 5. CICLO de mesmo dia, mas o plano prevê a carga na véspera (07-11:
//    186307152 "01:00 | 13:00", 7005 prevista 06-11 22:47) -> manda o plano.
{
  const recs: SheetRecord[] = [
    { ...row("R5", "7005"), CICLO: "01:00 | 13:00" },
    { ...row("R5", "63", "D"), CICLO: "01:00 | 13:00" },
  ];
  const stops: DayStop[] = [
    { id: "c1", vehicleId: 1, plate: "AD49DH", code: "7005", arrivedAt: "2026-11-06T22:40:00Z", departedAt: "2026-11-06T23:15:00Z" },
    st("63", "04:40", "06:05"),
  ];
  const plan = [
    { ...pl("R5", 1, "7005", "00:00", 7), arrMs: Date.parse("2026-11-06T22:47:00Z") },
    pl("R5", 2, "63", "05:30", 33, "D"),
  ];
  const r = run(recs, stops, plan);
  ok("plano manda na janela: 7005 de 06-11 22:40 aceite", r.rows[0]["Confiança"] === "OK" && String(r.rows[0]["Hora Chegada"]).startsWith("06-11-2026 22:40"), r.rows[0]);
  const r2 = run(recs, stops);
  ok("sem plano: a mesma paragem fica fora da janela do CICLO", r2.rows[0]["Confiança"] !== "OK", r2.rows[0]);
}

// 6. Carga com toque na portaria + paragem SEM código logo antes, junto ao 7001.
{
  const coords = new Map([
    ["7001", { lat: 39.043191, lng: -8.920665 }],
    ["7005", { lat: 39.042557, lng: -8.920994 }],
  ]);
  const runC = (records: SheetRecord[], stops: DayStop[], plan: PlanLine[]) =>
    runMatch({ day: "2026-11-07", records, header, cols, stops, platesWithGps: new Set(["AD49DH"]), pingWindowByPlate: new Map(), plan, codeCoords: coords });
  const recs = [row("R6", "7001"), row("R6", "18", "D")];
  const plan = [pl("R6", 1, "7001", "00:40", 33), pl("R6", 2, "18", "02:00", 33, "D")];
  const near7001 = { lat: 39.0436, lng: -8.9203 }; // ~55 m do 7001, mais longe do 7005
  const near7005 = { lat: 39.0424, lng: -8.9212 }; // junto ao 7005
  const mk = (xy: { lat: number; lng: number }): DayStop[] => [
    { id: "u1", vehicleId: 1, plate: "AD49DH", code: null, arrivedAt: Z("00:37"), departedAt: Z("00:51"), ...xy },
    st("7001", "00:55", "00:55"),
    st("18", "02:00", "02:30"),
  ];
  const r = runC(recs, mk(near7001), plan);
  ok("toque + paragem sem código junto ao 7001 -> OK 00:37-00:55", r.rows[0]["Confiança"] === "OK" && t(r.rows[0]) === "00:37-00:55", [t(r.rows[0]), r.rows[0]["Real"]]);
  const r2 = runC(recs, mk(near7005), plan);
  ok("paragem sem código mais perto do 7005 NÃO conta para o 7001 -> Rever", r2.rows[0]["Confiança"] === REVIEW, r2.rows[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
