// Structural checks for the exceljs TFS output workbook (PROTOTYPE).
//
//   npm run test:tfs-workbook
//
// Can't open Excel from CI, so this builds a workbook covering every Confiança
// category, then re-opens it (with exceljs AND with SheetJS, the upload path)
// and asserts: the hidden ZZ column + its values, the two conditional-format
// rules and their formulae, the "OK" dropdown on exactly the suggestion rows,
// and that kept / OK rows are byte-for-byte what went in.

import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTfsWorkbook, ZZ_COL } from "@/lib/tfs-sheet/xlsx-out";
import {
  CONFIANCA_COL,
  REAL_COL,
  REVIEW,
  KEPT,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
  type SheetRecord,
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

const header = [
  "Dia do Serviço",
  "Nº Camião",
  "Matrícula da Viatura",
  "Código de Loja",
  "Hora de Chegada",
  "Hora de Saída",
  CONFIANCA_COL,
  REAL_COL,
];
const row = (o: Partial<SheetRecord> & { [CONFIANCA_COL]: string }): SheetRecord => ({
  "Dia do Serviço": "2026-09-09",
  "Nº Camião": "500",
  "Matrícula da Viatura": "",
  "Código de Loja": "E00",
  "Hora de Chegada": "",
  "Hora de Saída": "",
  [REAL_COL]: "",
  ...o,
});

// One row of each kind, in a known order.
const rows: SheetRecord[] = [
  row({ "Matrícula da Viatura": "11AA11", "Hora de Chegada": "08:00", "Hora de Saída": "08:20", [CONFIANCA_COL]: "OK" }),
  row({ "Matrícula da Viatura": "22BB22", "Hora de Chegada": "07:00", "Hora de Saída": "07:30", [CONFIANCA_COL]: KEPT }),
  row({ "Matrícula da Viatura": "33CC33", [CONFIANCA_COL]: REVIEW, [REAL_COL]: "sem paragem" }),
  row({ "Matrícula da Viatura": "44DD44", "Hora de Chegada": "09:10", "Hora de Saída": "09:35", [CONFIANCA_COL]: SWAP, [REAL_COL]: "troca…" }),
  row({ "Matrícula da Viatura": "55EE55", "Hora de Chegada": "21:00", "Hora de Saída": "21:25", [CONFIANCA_COL]: SWAP_OUT_OF_WINDOW }),
  row({ "Matrícula da Viatura": "32OG64", "Hora de Chegada": "10:25", "Hora de Saída": "10:52", [CONFIANCA_COL]: PLATE_TYPO }),
  row({ "Nº Camião": "", "Código de Loja": "", [CONFIANCA_COL]: "" }), // blank-ish passthrough
];
const suggestionRowNums = [5, 6, 7]; // 1-based sheet rows (header = 1)

async function main() {
  const b64 = await buildTfsWorkbook({
    rows,
    header,
    plateColName: "Matrícula da Viatura",
    chegadaColName: "Hora de Chegada",
    saidaColName: "Hora de Saída",
    sheetName: "TFS",
  });
  const buf = Buffer.from(b64, "base64");
  const outPath = join(process.env.TEMP || ".", "tfs-workbook-proto.xlsx");
  writeFileSync(outPath, buf);
  console.log("wrote", outPath, `(${buf.length} bytes)\n`);

  // ---- re-open with exceljs ----
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  ok("exceljs re-opens the file", wb.worksheets.length === 1);
  const ws = wb.getWorksheet("TFS")!;
  ok("sheet name is TFS", !!ws);

  const headerRow = ws.getRow(1).values as unknown[];
  const hdr = headerRow.slice(1).map((v) => String(v));
  ok("ZZ column appended to header", hdr[hdr.length - 1] === ZZ_COL, hdr);

  const zzCol = ws.getColumn(hdr.indexOf(ZZ_COL) + 1);
  ok("ZZ column is hidden", zzCol.hidden === true, zzCol.hidden);

  // ZZ values: suggested plate on suggestion rows, blank elsewhere.
  const zzAt = (rowNum: number) => String(ws.getCell(rowNum, hdr.indexOf(ZZ_COL) + 1).value ?? "");
  ok("ZZ blank on OK row", zzAt(2) === "");
  ok("ZZ blank on KEPT row", zzAt(3) === "");
  ok("ZZ blank on REVIEW row", zzAt(4) === "");
  ok("ZZ = 44DD44 on SWAP row", zzAt(5) === "44DD44", zzAt(5));
  ok("ZZ = 55EE55 on SWAP_OOW row", zzAt(6) === "55EE55", zzAt(6));
  ok("ZZ = 32OG64 on PLATE_TYPO row", zzAt(7) === "32OG64", zzAt(7));

  // kept / OK rows: untouched values.
  ok("OK row keeps its times", String(ws.getCell(2, 5).value) === "08:00" && String(ws.getCell(2, 6).value) === "08:20");
  ok("KEPT row keeps its times", String(ws.getCell(3, 5).value) === "07:00" && String(ws.getCell(3, 6).value) === "07:30");
  ok("KEPT row Confiança text preserved", String(ws.getCell(3, 7).value) === KEPT);

  // ---- conditional formatting ----
  type Cf = { ref: string; rules: { type?: string; formulae?: string[] }[] };
  const cfs = (ws as unknown as { conditionalFormattings: Cf[] })
    .conditionalFormattings;
  const allRules = cfs.flatMap((c) => c.rules);
  ok("3 conditional-format rules present", allRules.length === 3, allRules.map((r) => r.type));

  // Column layout here: C=Matrícula, E=Chegada, F=Saída, G=Confiança.
  const cfFor = (ref: string) => cfs.find((c) => c.ref === ref);
  const amberChegada = cfFor("E2:E8");
  const amberSaida = cfFor("F2:F8");
  const redCf = cfFor("C2:C8 G2:G8");
  ok("amber Chegada rule: sqref E2:E8 only", !!amberChegada, cfs.map((c) => c.ref));
  ok("amber Saída rule: sqref F2:F8 only", !!amberSaida, cfs.map((c) => c.ref));
  ok("red rule: sqref C2:C8 G2:G8 only", !!redCf, cfs.map((c) => c.ref));
  ok(
    "amber Chegada formula references its OWN column ($E2)",
    amberChegada?.rules[0]?.formulae?.[0] ===
      'AND(ISNUMBER(SEARCH("Rever",$G2)),$E2="")',
    amberChegada?.rules[0]?.formulae?.[0],
  );
  ok(
    "amber Saída formula references its OWN column ($F2)",
    amberSaida?.rules[0]?.formulae?.[0] ===
      'AND(ISNUMBER(SEARCH("Rever",$G2)),$F2="")',
    amberSaida?.rules[0]?.formulae?.[0],
  );
  ok(
    "no CF paints a whole-row range",
    cfs.every((c) => !/(^|\s)A2:/.test(c.ref)),
    cfs.map((c) => c.ref),
  );

  // ---- behavioural sim: evaluate the actual amber formulae per row state ----
  // Mirrors AND(ISNUMBER(SEARCH("Rever",conf)), cell="").
  const amberOn = (formula: string, conf: string, chegada: string, saida: string) => {
    const hasRever = /rever/i.test(conf);
    const col = formula.includes("$E2") ? chegada : formula.includes("$F2") ? saida : "";
    return hasRever && col === "";
  };
  const fChe = amberChegada!.rules[0].formulae![0];
  const fSai = amberSaida!.rules[0].formulae![0];
  const REV = REVIEW;

  ok(
    "Rever, both blank -> Chegada amber + Saída amber",
    amberOn(fChe, REV, "", "") === true && amberOn(fSai, REV, "", "") === true,
  );
  ok(
    "Rever, only Chegada filled -> Chegada white, Saída STILL amber",
    amberOn(fChe, REV, "08:00", "") === false && amberOn(fSai, REV, "08:00", "") === true,
  );
  ok(
    "Rever, only Saída filled -> Saída white, Chegada STILL amber",
    amberOn(fSai, REV, "", "08:20") === false && amberOn(fChe, REV, "", "08:20") === true,
  );
  ok(
    "Rever, both filled -> both white",
    amberOn(fChe, REV, "08:00", "08:20") === false && amberOn(fSai, REV, "08:00", "08:20") === false,
  );
  ok(
    "not a Rever row -> neither amber, whatever the times",
    amberOn(fChe, "OK", "", "") === false && amberOn(fSai, "OK", "", "") === false,
  );

  // ---- data validation ("OK" dropdown) ----
  const dvAt = (rowNum: number) => ws.getCell(rowNum, hdr.indexOf(CONFIANCA_COL) + 1).dataValidation;
  for (const rn of suggestionRowNums) {
    const dv = dvAt(rn);
    ok(
      `row ${rn}: Confiança has list ["OK"] validation`,
      !!dv && dv.type === "list" && JSON.stringify(dv.formulae) === JSON.stringify(['"OK"']),
      dv,
    );
  }
  for (const rn of [2, 3, 4, 8]) {
    ok(`row ${rn}: no validation on Confiança`, !dvAt(rn), dvAt(rn));
  }

  // ---- SheetJS can still read it back (the re-upload path) ----
  const reread = XLSX.read(buf, { type: "buffer" });
  const rr = XLSX.utils.sheet_to_json<SheetRecord>(reread.Sheets[reread.SheetNames[0]], {
    raw: false,
    defval: "",
    blankrows: false,
  });
  ok("SheetJS re-reads the produced file", rr.length === rows.length, rr.length);
  ok(
    "SheetJS sees the KEPT row intact",
    String(rr[1]["Matrícula da Viatura"]) === "22BB22" &&
      String(rr[1]["Hora de Chegada"]) === "07:00" &&
      String(rr[1][CONFIANCA_COL]) === KEPT,
    rr[1],
  );
  ok("SheetJS also sees the ZZ column", ZZ_COL in rr[0], Object.keys(rr[0]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
