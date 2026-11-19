// Relatório diário do armazém na folha Azambuja (src/lib/azambuja-sheet/relatorio.ts + match.ts).
//
//   npm run test:azambuja-relatorio

import * as XLSX from "xlsx";
import { parseRelatorioDiario, relatorioOverlap } from "@/lib/azambuja-sheet/relatorio";
import { ARMAZEM_COL, resolveColumns, runMatch, REVIEW, type DayStop, type SheetRecord } from "@/lib/azambuja-sheet/match";

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

// --- relatório sintético (mesma forma do real: título, cabeçalho na 5.ª linha)
const HEAD = [
  "ROTA", "SEQ", "Nº_LOJA", "NOME", "TRANSP.", "VIATURA", "TIPO VIATURA", "HORA CHEGADA", "HORA SAIDA", "Hora Inicio",
  "TIPO", "JE", "Key", "Real Suportes SLV", "STATUS", "Matricula", "Paletes Reais", "Hora Real Inicio", "Hora Real Fim",
];
const SLV_HEAD = [...HEAD, "Tempo", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "Cais", "Selo", "Obs", "x",
  "Hora Chegada Real\n (portaria)", "Hora Saída Real\n (portaria)"];
const line = (rota: string, seq: number, code: string, tipo: string, plan: string, start: string, mat: string, ini: string, fim: string) => {
  const r: string[] = new Array(HEAD.length).fill("");
  r[0] = rota; r[1] = String(seq); r[2] = code; r[7] = plan; r[9] = start; r[10] = tipo; r[15] = mat; r[17] = ini; r[18] = fim;
  return r;
};
const dhl = [
  ["ANÁLISE EXECUÇÃO"], [], [], [],
  HEAD,
  // rota que começa às 22:40 de 17-11: carga 7005 23:10–23:25, 7001 23:35–23:50 (dia 17), matrícula real ≠ folha
  line("186388422", 1, "7005", "C", "22:40", "17/11/26 22:40", "AN-38-VF", "23:10", "23:25"),
  line("186388422", 2, "7001", "C", "23:00", "17/11/26 22:40", "AN-38-VF", "23:35", "23:50"),
  line("186388422", 3, "7003", "C", "23:30", "17/11/26 22:40", "", "", ""), // vazia na DHL, preenchida na SLV
  line("186388422", 4, "53", "D", "04:30", "17/11/26 22:40", "", "", ""),
  // carga que passa a meia-noite: 23:50 → 00:20 (fim no dia seguinte)
  line("186390000", 1, "7001", "C", "23:40", "17/11/26 23:40", "BB-14-EU", "23:50", "0:20"),
];
const slvRow = (() => {
  const r: string[] = new Array(SLV_HEAD.length).fill("");
  r[0] = "186388422"; r[1] = "3"; r[2] = "7003"; r[7] = "23:30"; r[9] = "17/11/26 22:40"; r[10] = "C"; r[15] = "AN-38-VF";
  r[17] = "00:28"; r[18] = "00:58"; r[32] = "9"; r[36] = "00:10"; r[37] = "01:05";
  return r;
})();
const slv = [["ANÁLISE EXECUÇÃO"], [], [], [], SLV_HEAD, slvRow];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["MENU"]]), "Menu");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dhl), "Real Time - DHL");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(slv), "Real Time - SLV");

console.log("== parseRelatorioDiario ==");
const parsed = parseRelatorioDiario(wb);
ok("lê-se sem erro", !("error" in parsed), parsed);
const lines = "error" in parsed ? [] : parsed.lines;
const L = (rota: string, seq: number) => lines.find((l) => l.rota === rota && l.seq === seq)!;
ok("7005 23:10–23:25 do dia 17", L("186388422", 1)?.iniMs === Date.parse("2026-11-17T23:10:00Z") && L("186388422", 1)?.fimMs === Date.parse("2026-11-17T23:25:00Z"), L("186388422", 1));
ok("matrícula normalizada", L("186388422", 1)?.plate === "AN38VF");
ok("7003: DHL vazia + SLV preenchida = uma linha com portaria 00:10–01:05 do dia 18",
  lines.filter((l) => l.rota === "186388422" && l.seq === 3).length === 1 &&
  L("186388422", 3).portaInMs === Date.parse("2026-11-18T00:10:00Z") && L("186388422", 3).portaOutMs === Date.parse("2026-11-18T01:05:00Z") &&
  L("186388422", 3).cais === "9", L("186388422", 3));
ok("carga que passa a meia-noite: fim 00:20 do dia 18", L("186390000", 1)?.fimMs === Date.parse("2026-11-18T00:20:00Z"), L("186390000", 1));
ok("sem as folhas Real Time -> erro", "error" in parseRelatorioDiario(XLSX.utils.book_new()));
ok("relatorioOverlap", JSON.stringify(relatorioOverlap(lines, ["186388422", "186388422", "999"])) === JSON.stringify({ sheetRoutes: 2, reportRoutes: 2, common: 1 }));

// --- no matcher ------------------------------------------------------------
console.log("\n== runMatch com relatório ==");
const header = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
const cols = resolveColumns(header);
const row = (code: string, tipo: string, mat = "41-XR-50"): SheetRecord => ({
  ROTA: "186388422", N_LOJA: code, NOME: code, MATRICULA: mat, "Hora Chegada": "", "Hora Saida": "", CICLO: "02:00 | 14:00", TIPO: tipo,
});
const records = [row("7005", "C"), row("7001", "C"), row("7003", "C"), row("53", "D")];
let sid = 0;
const st = (plate: string, code: string, a: string, d: string): DayStop => ({
  id: `s${sid++}`, vehicleId: plate === "AN38VF" ? 1 : 2, plate, code, arrivedAt: a, departedAt: d,
});
// AN-38-VF: visita ao pátio 22:50–00:04 (7005 23:05–23:33, 7001 23:40–00:04), 7003, loja 53;
// e mais tarde outra visita ao 7001 (03:00–03:40) que NÃO é a carga
const stops: DayStop[] = [
  st("AN38VF", "7001", "2026-11-17T22:50:00Z", "2026-11-17T23:00:00Z"),
  st("AN38VF", "7005", "2026-11-17T23:05:00Z", "2026-11-17T23:33:00Z"),
  st("AN38VF", "7001", "2026-11-17T23:40:00Z", "2026-11-18T00:04:00Z"),
  st("AN38VF", "7003", "2026-11-18T00:10:00Z", "2026-11-18T01:05:00Z"),
  st("AN38VF", "7001", "2026-11-18T03:00:00Z", "2026-11-18T03:40:00Z"),
  st("AN38VF", "53", "2026-11-18T04:44:00Z", "2026-11-18T06:05:00Z"),
  st("41XR50", "7001", "2026-11-18T05:00:00Z", "2026-11-18T06:00:00Z"),
];
const base = { day: "2026-11-18", records, header, cols, stops, platesWithGps: new Set(["AN38VF", "41XR50"]), pingWindowByPlate: new Map() };
const res = runMatch({ ...base, warehouse: lines });
const out = res.rows;
const t = (r: SheetRecord) => `${String(r["Hora Chegada"]).slice(11, 16)}-${String(r["Hora Saida"]).slice(11, 16)}`;
ok("matrícula corrigida para a do armazém", out.every((r) => r.MATRICULA === "AN38VF"), out.map((r) => r.MATRICULA));
ok("nota da correção", String(out[0].Real).includes("Matrícula corrigida pelo relatório do armazém: AN38VF"), out[0].Real);
ok("7005 = entrada no pátio 22:50 (a carga real 23:10 está dentro)", t(out[0]).startsWith("22:50"), t(out[0]));
ok("7001 na mesma visita, termina na saída do pátio 00:04", t(out[1]).endsWith("00:04"), t(out[1]));
ok("7003 00:10–01:05", t(out[2]) === "00:10-01:05", t(out[2]));
ok("coluna «Armazém» com cais e matrícula", String(out[0][ARMAZEM_COL]).includes("23:10–23:25") && String(out[0][ARMAZEM_COL]).includes("AN38VF"), out[0][ARMAZEM_COL]);
ok("7003 «Armazém» com portaria", String(out[2][ARMAZEM_COL]).startsWith("Portaria 00:10–01:05"), out[2][ARMAZEM_COL]);
ok("resumo", res.summary.warehouse?.plateFixes === 1 && res.summary.warehouse.agree === 3 && res.summary.warehouse.disagree === 0, res.summary.warehouse);
ok("cabeçalho tem «Armazém»", res.header.includes(ARMAZEM_COL));

// sem relatório: a carga fica fora da janela 02:00|14:00? (visita das 22:50 começa antes)
const res0 = runMatch(base);
ok("sem relatório não há coluna «Armazém»", !res0.header.includes(ARMAZEM_COL));
ok("sem relatório a matrícula da folha fica", res0.rows[0].MATRICULA === "41-XR-50", res0.rows[0].MATRICULA);

// relatório com hora que nenhuma visita contém -> vazio + nota (não inventa)
const far = lines.map((l) => (l.rota === "186388422" && l.seq === 1 ? { ...l, iniMs: Date.parse("2026-11-18T09:00:00Z"), fimMs: Date.parse("2026-11-18T09:20:00Z") } : l));
const res2 = runMatch({ ...base, warehouse: far });
ok("hora do armazém sem visita GPS -> sem hora + Rever + nota",
  res2.rows[0]["Hora Chegada"] === "" && res2.rows[0]["Confiança"] === REVIEW && String(res2.rows[0].Real).includes("sem visita GPS ao pátio"),
  [res2.rows[0]["Hora Chegada"], res2.rows[0]["Confiança"], res2.rows[0].Real]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
