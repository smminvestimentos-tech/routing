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

// --- duas rotas, mesma viatura, mesma visita ao 7003 (19-11 41-XR-50) -------
console.log("\n== visita partilhada confirmada pelo armazém ==");
{
  const wl = (rota: string, seq: number, code: string, tipo: string, a: string, b: string) => ({
    rota, seq, code, tipo, plate: "41XR50", iniMs: null, fimMs: null, cais: "6",
    portaInMs: Date.parse(`2026-11-19T${a}:00Z`), portaOutMs: Date.parse(`2026-11-19T${b}:00Z`),
  });
  const rec = (rota: string, code: string, tipo: string): SheetRecord => ({
    ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: "41-XR-50", "Hora Chegada": "", "Hora Saida": "", CICLO: "08:00 | 20:00", TIPO: tipo,
  });
  // a 1.ª rota ainda tem o 7007 depois do 7003 (não é o regresso → a regra
  // regresso → carga seguinte não se aplica)
  const recs = [rec("186398779", "7003", "D"), rec("186398779", "7007", "C"), rec("186398770", "7003", "C"), rec("186398770", "12", "D")];
  const sts: DayStop[] = [
    { id: "x1", vehicleId: 9, plate: "41XR50", code: "7003", arrivedAt: "2026-11-19T10:44:00Z", departedAt: "2026-11-19T12:24:00Z" },
    { id: "x2", vehicleId: 9, plate: "41XR50", code: "12", arrivedAt: "2026-11-19T13:19:00Z", departedAt: "2026-11-19T14:00:00Z" },
  ];
  const r = runMatch({
    day: "2026-11-19", records: recs, header, cols, stops: sts, platesWithGps: new Set(["41XR50"]), pingWindowByPlate: new Map(),
    warehouse: [wl("186398779", 2, "7003", "D", "10:43", "12:25"), wl("186398770", 1, "7003", "C", "10:43", "12:25")],
  });
  ok("as duas linhas 7003 ficam com a visita 10:44–12:24", [r.rows[0], r.rows[2]].every((x) => t(x) === "10:44-12:24"), r.rows.map(t));
  ok("a segunda diz que é partilhada e confirmada pelo armazém",
    [r.rows[0], r.rows[2]].some((x) => String(x.Real).includes("partilhada com outra linha")), r.rows.map((x) => x.Real));
}

// --- regresso não pode ficar antes da carga real (19-11 AB-22-BP) -------------
console.log("\n== rota ancorada na carga real ==");
{
  const rec = (code: string, tipo: string): SheetRecord => ({
    ROTA: "186407883", N_LOJA: code, NOME: code, MATRICULA: "AB-22-BP", "Hora Chegada": "", "Hora Saida": "", CICLO: "12:30 | 00:30+1", TIPO: tipo,
  });
  const recs = [rec("7001", "C"), rec("12", "D"), rec("7001", "D")];
  const sts: DayStop[] = [
    { id: "y1", vehicleId: 8, plate: "AB22BP", code: "7001", arrivedAt: "2026-11-19T01:42:00Z", departedAt: "2026-11-19T03:35:00Z" },
    { id: "y2", vehicleId: 8, plate: "AB22BP", code: "7001", arrivedAt: "2026-11-19T15:55:00Z", departedAt: "2026-11-19T16:31:00Z" },
    { id: "y3", vehicleId: 8, plate: "AB22BP", code: "12", arrivedAt: "2026-11-19T18:00:00Z", departedAt: "2026-11-19T18:40:00Z" },
  ];
  const r = runMatch({
    day: "2026-11-19", records: recs, header, cols, stops: sts, platesWithGps: new Set(["AB22BP"]), pingWindowByPlate: new Map(),
    warehouse: [{ rota: "186407883", seq: 1, code: "7001", tipo: "C", plate: "AB22BP", iniMs: Date.parse("2026-11-19T15:55:00Z"),
      fimMs: Date.parse("2026-11-19T16:40:00Z"), portaInMs: null, portaOutMs: null, cais: "62" }],
  });
  ok("carga 7001 = 15:55–16:31", t(r.rows[0]) === "15:55-16:31", r.rows.map(t));
  ok("regresso não fica com a visita das 01:42", !t(r.rows[2]).startsWith("01:42"), r.rows.map(t));
}

// --- RAQ: loja trocada / anulada pelo Auchan (19-11 186408319 8 → 38) -------
console.log("\n== RAQ ==");
{
  const raqWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(raqWb, XLSX.utils.aoa_to_sheet(dhl), "Real Time - DHL");
  XLSX.utils.book_append_sheet(raqWb, XLSX.utils.aoa_to_sheet([
    ["RAQ"], [],
    ["Data", "Rota", "Cod_Loja Inicial", "Loja Inicial", "Departamento", "Ação", "Motivo", "Pedido por:", "Cod_Loja alterada", "Loja Alterada"],
    ["11/19/26", "186408319", "8", "Auchan Gaia", "AL-PBS", "ALTERADA", "OUTROS", "AUCHAN", "38", "Auchan Sintra"],
    ["11/19/26", "186399599", "32", "Auchan Aveiro", "AL-PBS", "ANULADA", "SEM VOLUME", "AUCHAN", "", ""],
    ["11/19/26", "EXTRA 1", "461", "My Auchan Baixa da Banheira", "AL-PBS", "EXTRA", "OUTROS", "AUCHAN", "", ""],
  ]), "RAQ");
  const pr = parseRelatorioDiario(raqWb);
  const changes = "error" in pr ? [] : pr.changes;
  ok("lê 2 trocas (EXTRA fica de fora)", changes.length === 2, changes);
  ok("8 → 38 Auchan Sintra", changes[0]?.action === "ALTERADA" && changes[0]?.from === "8" && changes[0]?.to === "38" && changes[0]?.toName === "Auchan Sintra", changes[0]);
  ok("32 anulada", changes[1]?.action === "ANULADA" && changes[1]?.to === null, changes[1]);

  const rec = (rota: string, code: string, tipo: string, mat = "CG-53-PT"): SheetRecord => ({
    ROTA: rota, N_LOJA: code, NOME: code === "8" ? "Auchan Gaia" : code, MATRICULA: mat, "Hora Chegada": "", "Hora Saida": "", CICLO: "11:30 | 23:30", TIPO: tipo,
  });
  const recs = [rec("186408319", "7001", "C"), rec("186408319", "8", "D"), rec("186408319", "7001", "C"), rec("186399599", "32", "D", "AA-11-BB")];
  const sts: DayStop[] = [
    { id: "c1", vehicleId: 1, plate: "CG53PT", code: "7001", arrivedAt: "2026-11-19T13:35:00Z", departedAt: "2026-11-19T14:34:00Z" },
    { id: "c2", vehicleId: 1, plate: "CG53PT", code: "38", arrivedAt: "2026-11-19T15:34:00Z", departedAt: "2026-11-19T16:31:00Z" },
    { id: "c3", vehicleId: 1, plate: "CG53PT", code: "7001", arrivedAt: "2026-11-19T17:35:00Z", departedAt: "2026-11-19T18:15:00Z" },
    // outro camião em Gaia pela rota dele, à hora do regresso desta
    { id: "o1", vehicleId: 2, plate: "AS16CH", code: "8", arrivedAt: "2026-11-19T17:34:00Z", departedAt: "2026-11-19T18:40:00Z" },
    { id: "o2", vehicleId: 3, plate: "ZZ99ZZ", code: "32", arrivedAt: "2026-11-19T10:00:00Z", departedAt: "2026-11-19T10:40:00Z" },
  ];
  const span = { min: Date.parse("2026-11-19T00:00:00Z"), max: Date.parse("2026-11-20T06:00:00Z") };
  const base = {
    day: "2026-11-19", records: recs, header, cols, stops: sts, platesWithGps: new Set(["CG53PT", "AS16CH", "AA11BB", "ZZ99ZZ"]),
    pingWindowByPlate: new Map([["CG53PT", span], ["AA11BB", span]]),
  };
  const r = runMatch({ ...base, storeChanges: changes });
  ok("linha passa a 38 Auchan Sintra", r.rows[1].N_LOJA === "38" && r.rows[1].NOME === "Auchan Sintra", r.rows[1]);
  ok("com as horas de Sintra 15:34–16:31, OK", t(r.rows[1]) === "15:34-16:31" && r.rows[1]["Confiança"] === "OK", r.rows[1]);
  ok("nota da troca", String(r.rows[1].Real).startsWith("Loja alterada pelo Auchan (RAQ): 8 Auchan Gaia → 38 Auchan Sintra."), r.rows[1].Real);
  ok("regresso 17:35–18:15", t(r.rows[2]) === "17:35-18:15", r.rows.map(t));
  ok("anulada: sem troca de viatura, nota RAQ", t(r.rows[3]) === "-" && String(r.rows[3].Real).startsWith("Loja anulada pelo Auchan (RAQ: SEM VOLUME)"), r.rows[3]);

  const r0 = runMatch(base);
  ok("sem RAQ: Gaia não vai para o AS-16-CH (rota já no pátio às 17:35)", t(r0.rows[1]) === "-" && r0.rows[1].MATRICULA === "CG-53-PT", r0.rows[1]);
  ok("sem RAQ: a anulada 32 vira troca para ZZ99ZZ (sem RAQ não se sabe)", r0.rows[3].MATRICULA === "ZZ99ZZ", r0.rows[3]);

  // RAQ sem visita da viatura à loja nova: fica a original, com nota
  const r2 = runMatch({ ...base, stops: sts.filter((s) => s.id !== "c2"), storeChanges: changes });
  ok("sem visita a 38: código fica 8 e nota RAQ", r2.rows[1].N_LOJA === "8" && String(r2.rows[1].Real).includes("alterou esta loja para 38 Auchan Sintra"), r2.rows[1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
