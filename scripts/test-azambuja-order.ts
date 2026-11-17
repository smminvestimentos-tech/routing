// Ordem das linhas do pátio (7001/7005/7003) na folha Azambuja — casos do
// ficheiro de 16-11-2026 (src/lib/azambuja-sheet/match.ts).
//
//   npx tsx scripts/test-azambuja-order.ts

import { resolveColumns, runMatch, KEPT, REVIEW, type DayStop, type SheetRecord } from "@/lib/azambuja-sheet/match";

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

const DAY = "2026-11-16";
const header = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
const cols = resolveColumns(header);
const codeTypes = new Map([
  ["7001", "centro_distribuicao"],
  ["7003", "centro_distribuicao"],
  ["7005", "armazem"],
  ["437", "loja"],
  ["22", "loja"],
  ["B53", "loja"],
]);
const row = (rota: string, code: string, plate: string, ch = "", sa = "", tipo = "C"): SheetRecord => ({
  ROTA: rota, N_LOJA: code, NOME: code, MATRICULA: plate,
  "Hora Chegada": ch ? `16-11-2026 ${ch}` : "", "Hora Saida": sa ? `16-11-2026 ${sa}` : "", CICLO: "Noturno", TIPO: tipo,
});
let sid = 0;
const st = (plate: string, code: string | null, a: string, d: string): DayStop => ({
  id: `s${++sid}`, vehicleId: 1, plate: plate.replace(/-/g, ""), code,
  arrivedAt: `${DAY}T${a}:00Z`, departedAt: `${DAY}T${d}:00Z`,
});
const run = (records: SheetRecord[], stops: DayStop[], plates: string[]) =>
  runMatch({ day: DAY, records, rawRecords: records, header, cols, stops, platesWithGps: new Set(plates), pingWindowByPlate: new Map(), codeTypes });
const hm = (r: SheetRecord) => `${String(r["Hora Chegada"]).slice(11, 16)}-${String(r["Hora Saida"]).slice(11, 16)}`;

console.log("== regresso não pode ser antes das entregas mantidas ==");
{
  // 186376999 / 47-LF-63: entrega 437 mantida 11:37; antes ficava regresso 05:10
  const P = "47-LF-63";
  const recs = [row("R1", "7005", P), row("R1", "437", P, "11:37", "12:32", "D"), row("R1", "7001", P)];
  const stops = [st(P, "7005", "04:24", "05:04"), st(P, "7001", "05:10", "05:10"), st(P, "437", "11:40", "12:28"), st(P, "7001", "13:40", "13:55")];
  const r = run(recs, stops, ["47LF63"]);
  ok("carga 7005 = 04:24-05:04", hm(r.rows[0]) === "04:24-05:04", hm(r.rows[0]));
  ok("regresso 7001 = 13:40 (depois da entrega)", hm(r.rows[2]) === "13:40-13:55", hm(r.rows[2]));
  const r2 = run(recs, stops.slice(0, 3), ["47LF63"]);
  ok("sem 7001 depois da entrega -> Rever (não 05:10)", r2.rows[2]["Confiança"] === REVIEW, hm(r2.rows[2]));
}

console.log("\n== linha mantida reclama a sua paragem ==");
{
  // 186377185 / BB-77-EX: carga 7001 mantida 00:17-00:42; regresso pegava 00:15-00:40
  const P = "BB-77-EX";
  const recs = [row("R1", "7001", P, "00:17", "00:42"), row("R1", "437", P, "05:39", "06:16", "D"), row("R1", "7001", P)];
  const stops = [st(P, "7001", "00:15", "00:40"), st(P, "437", "05:40", "06:10")];
  const r = run(recs, stops, ["BB77EX"]);
  ok("carga continua mantida", r.rows[0]["Confiança"] === KEPT);
  ok("regresso não reutiliza a paragem da carga -> Rever", r.rows[2]["Confiança"] === REVIEW, hm(r.rows[2]));

  // ...mas o regresso de uma rota pode ser a carga (mantida) da seguinte
  const recs2 = [
    row("R1", "7001", P, "00:17", "00:42"), row("R1", "437", P, "05:39", "06:16", "D"), row("R1", "7001", P),
    row("R2", "7001", P, "07:45", "08:18"), row("R2", "22", P, "09:42", "10:29", "D"),
  ];
  const stops2 = [...stops, st(P, "7001", "07:35", "08:15"), st(P, "22", "09:40", "10:25")];
  const r2 = run(recs2, stops2, ["BB77EX"]);
  ok("regresso R1 = carga mantida de R2 (07:35-08:15)", hm(r2.rows[2]) === "07:35-08:15" && r2.rows[2]["Confiança"] === "OK", [hm(r2.rows[2]), r2.rows[2]["Real"]]);
}

console.log("\n== rotas da mesma matrícula pela hora, não pela ordem da folha ==");
{
  // 50-JG-95: 186377850 (cargas 08:14) vem antes de 186377945 (cargas 02:39) na folha
  const P = "50-JG-95";
  const recs = [
    row("R850", "7005", P), row("R850", "7001", P, "08:14", "09:26"), row("R850", "22", P, "10:58", "11:32", "D"),
    row("R945", "7001", P, "02:39", "03:09"), row("R945", "7005", P), row("R945", "B53", P, "06:11", "06:52", "D"),
  ];
  const stops = [st(P, "7005", "02:50", "03:04"), st(P, "B53", "06:14", "06:49"), st(P, "22", "10:59", "11:28")];
  const r = run(recs, stops, ["50JG95"]);
  ok("7005 02:50 vai para a rota das 02:39", hm(r.rows[4]) === "02:50-03:04", hm(r.rows[4]));
  ok("7005 da rota das 08:14 -> Rever", r.rows[0]["Confiança"] === REVIEW, hm(r.rows[0]));
}

console.log("\n== bloco de carga sem ordem fixa entre 7005/7001/7003 ==");
{
  // 186378400 / BV-97-IV: folha 7005, 7003; GPS 7003 00:45 -> 7005 02:20
  const P = "BV-97-IV";
  const recs = [row("R1", "7005", P), row("R1", "7003", P), row("R1", "437", P, "06:38", "07:05", "D")];
  const stops = [st(P, "7003", "00:45", "01:59"), st(P, "7005", "02:20", "03:00"), st(P, "437", "06:40", "07:00")];
  const r = run(recs, stops, ["BV97IV"]);
  ok("7005 = 02:20-03:00", hm(r.rows[0]) === "02:20-03:00", hm(r.rows[0]));
  ok("7003 = 00:45-01:59", hm(r.rows[1]) === "00:45-01:59", hm(r.rows[1]));

  // 186376792 / BG-96-ID: folha 7005, 7001; GPS toque 7001 04:50 -> 7005 04:55-05:10
  const Q = "BG-96-ID";
  const recs2 = [row("R2", "7005", Q), row("R2", "7001", Q), row("R2", "437", Q, "07:15", "08:40", "D")];
  const stops2 = [st(Q, "7001", "04:50", "04:50"), st(Q, "7005", "04:55", "05:10"), st(Q, "437", "07:15", "08:40")];
  const r2 = run(recs2, stops2, ["BG96ID"]);
  ok("7005 = 04:55-05:10 (antes ficava vazio)", hm(r2.rows[0]) === "04:55-05:10", hm(r2.rows[0]));
  ok("7001 = toque 04:50", hm(r2.rows[1]) === "04:50-04:50", hm(r2.rows[1]));
}

console.log("\n== espera pelo cais conta na Chegada da carga ==");
{
  // pinos reais do pátio; paragem de espera sem local a norte do 7001 (zona B)
  const coords = new Map([
    ["7001", { lat: 39.042563, lng: -8.919161 }],
    ["7005", { lat: 39.042529, lng: -8.920708 }],
    ["7003", { lat: 39.045012, lng: -8.922637 }],
  ]);
  const B = { lat: 39.043906, lng: -8.919972 };
  const C = { lat: 39.041782, lng: -8.920121 }; // parque/pernoita
  const P = "BC-88-TC";
  const wst = (code: string | null, a: string, d: string, xy?: { lat: number; lng: number }): DayStop => ({ ...st(P, code, a, d), ...(xy ?? {}) });
  const recs = [row("R1", "7003", P), row("R1", "437", P, "05:00", "05:30", "D")];
  const runW = (stops: DayStop[], plan?: { arr: string }) =>
    runMatch({
      day: DAY, records: recs, rawRecords: recs, header, cols, stops, platesWithGps: new Set(["BC88TC"]), pingWindowByPlate: new Map(), codeTypes, codeCoords: coords,
      plan: plan ? [{ rota: "R1", seq: 1, code: "7003", tipo: "C", carga: 0, arrMs: Date.parse(`${DAY}T${plan.arr}:00Z`), depMs: null } as any] : undefined,
    });
  // 07-11 186315010: entrou 00:19 (portão), esperou 61 min, cais 01:25 (planeado 01:02)
  const base = [wst("7001", "00:19", "00:19"), wst(null, "00:24", "01:20", B), wst("7003", "01:25", "02:39"), wst("437", "05:00", "05:30")];
  const r = runW(base, { arr: "01:02" });
  ok("Chegada = entrada no pátio 00:19, Saída = saída do cais 02:39", hm(r.rows[0]) === "00:19-02:39" && r.rows[0]["Confiança"] === "OK", [hm(r.rows[0]), r.rows[0]["Real"]]);
  ok("Real explica a espera", /Entrada no pátio 00:19 · espera 66 min · cais 01:25 \(\+23 min vs planeado 01:02\)/.test(String(r.rows[0]["Real"])), r.rows[0]["Real"]);

  // chegada 4h antes do planeado com espera longa -> horas reais, mas Rever
  const early = runW(base, { arr: "04:30" });
  ok("chegada muito antecipada -> Rever com as horas reais", early.rows[0]["Confiança"] === REVIEW && hm(early.rows[0]) === "00:19-02:39", [early.rows[0]["Confiança"], early.rows[0]["Real"]]);

  // pernoita no parque (zona C) não conta como espera
  const park = runW([wst(null, "18:00", "01:20", C), wst("7003", "01:25", "02:39"), wst("437", "05:00", "05:30")], { arr: "01:02" });
  ok("parque não conta: Chegada = cais 01:25", hm(park.rows[0]) === "01:25-02:39", [hm(park.rows[0]), park.rows[0]["Real"]]);

  // espera interrompida (> 20 min sem paragens) não conta
  const gap = runW([wst(null, "23:00", "00:30", B), wst("7003", "01:25", "02:39"), wst("437", "05:00", "05:30")], { arr: "01:02" });
  ok("intervalo > 20 min corta a cadeia", hm(gap.rows[0]) === "01:25-02:39", hm(gap.rows[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
