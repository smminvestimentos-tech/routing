// Structural checks for the exceljs TFS output workbook (PROTOTYPE).
//
//   npm run test:tfs-workbook
//
// Can't open Excel from CI, so this builds a workbook covering every Confiança
// category, then re-opens it (with exceljs AND with SheetJS, the upload path)
// and asserts: the hidden ZZ / YY / XX columns + their values, the three
// conditional-format rules and their formulae (incl. the accidental-deletion
// safety net), the "OK" dropdown on exactly the suggestion rows, and that
// kept / OK rows are byte-for-byte what went in. Also simulates the amber
// formulae per cell state so the "delete a resolved time -> goes amber" path
// is proven without Excel.

import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTfsWorkbook,
  ZZ_COL,
  YY_COL,
  XX_COL,
} from "@/lib/tfs-sheet/xlsx-out";
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
  ok(
    "ZZ / YY / XX columns appended to header, in order",
    hdr.slice(-3).join(",") === `${ZZ_COL},${YY_COL},${XX_COL}`,
    hdr,
  );

  const colIdx = (name: string) => hdr.indexOf(name) + 1;
  for (const c of [ZZ_COL, YY_COL, XX_COL]) {
    ok(`${c} column is hidden`, ws.getColumn(colIdx(c)).hidden === true);
  }

  // ZZ values: suggested plate on suggestion rows, blank elsewhere.
  const cellAt = (rowNum: number, name: string) =>
    String(ws.getCell(rowNum, colIdx(name)).value ?? "");
  ok("ZZ blank on OK/KEPT/REVIEW rows", [2, 3, 4].every((r) => cellAt(r, ZZ_COL) === ""));
  ok("ZZ = 44DD44 on SWAP row", cellAt(5, ZZ_COL) === "44DD44", cellAt(5, ZZ_COL));
  ok("ZZ = 55EE55 on SWAP_OOW row", cellAt(6, ZZ_COL) === "55EE55", cellAt(6, ZZ_COL));
  ok("ZZ = 32OG64 on PLATE_TYPO row", cellAt(7, ZZ_COL) === "32OG64", cellAt(7, ZZ_COL));

  // YY / XX = snapshot of the times WE wrote (blank only for the genuine
  // no-data REVIEW row and the blank passthrough row).
  ok("YY/XX snapshot the OK row's times", cellAt(2, YY_COL) === "08:00" && cellAt(2, XX_COL) === "08:20", [cellAt(2, YY_COL), cellAt(2, XX_COL)]);
  ok("YY/XX snapshot the KEPT row's times", cellAt(3, YY_COL) === "07:00" && cellAt(3, XX_COL) === "07:30");
  ok("YY/XX blank on the no-data REVIEW row", cellAt(4, YY_COL) === "" && cellAt(4, XX_COL) === "");
  ok("YY/XX snapshot the SWAP row's times", cellAt(5, YY_COL) === "09:10" && cellAt(5, XX_COL) === "09:35");
  ok("YY/XX snapshot the PLATE_TYPO row's times", cellAt(7, YY_COL) === "10:25" && cellAt(7, XX_COL) === "10:52");
  ok("YY/XX blank on the passthrough row", cellAt(8, YY_COL) === "" && cellAt(8, XX_COL) === "");

  // kept / OK rows: untouched visible values.
  ok("OK row keeps its times", cellAt(2, "Hora de Chegada") === "08:00" && cellAt(2, "Hora de Saída") === "08:20");
  ok("KEPT row keeps its times", cellAt(3, "Hora de Chegada") === "07:00" && cellAt(3, "Hora de Saída") === "07:30");
  ok("KEPT row Confiança text preserved", cellAt(3, CONFIANCA_COL) === KEPT);

  // ---- conditional formatting ----
  type Cf = { ref: string; rules: { type?: string; formulae?: string[] }[] };
  const cfs = (ws as unknown as { conditionalFormattings: Cf[] })
    .conditionalFormattings;
  const allRules = cfs.flatMap((c) => c.rules);
  ok("3 conditional-format rules present", allRules.length === 3, allRules.map((r) => r.type));

  // Column layout here: C=Matrícula, E=Chegada, F=Saída, G=Confiança,
  //                     I=ZZ, J=YY, K=XX.
  const cfFor = (ref: string) => cfs.find((c) => c.ref === ref);
  const amberChegada = cfFor("E2:E8");
  const amberSaida = cfFor("F2:F8");
  const redCf = cfFor("C2:C8 G2:G8");
  ok("amber Chegada rule: sqref E2:E8 only", !!amberChegada, cfs.map((c) => c.ref));
  ok("amber Saída rule: sqref F2:F8 only", !!amberSaida, cfs.map((c) => c.ref));
  ok("red rule: sqref C2:C8 G2:G8 only", !!redCf, cfs.map((c) => c.ref));

  const fChe = amberChegada?.rules[0]?.formulae?.[0] ?? "";
  const fSai = amberSaida?.rules[0]?.formulae?.[0] ?? "";
  ok(
    "amber Chegada formula = OR(Rever+empty, snapshot YY set + empty)",
    fChe ===
      'OR(AND(ISNUMBER(SEARCH("Rever",$G2)),$E2=""),AND($J2<>"",$E2=""))',
    fChe,
  );
  ok(
    "amber Saída formula = OR(Rever+empty, snapshot XX set + empty)",
    fSai ===
      'OR(AND(ISNUMBER(SEARCH("Rever",$G2)),$F2=""),AND($K2<>"",$F2=""))',
    fSai,
  );
  ok(
    "no CF paints a whole-row range",
    cfs.every((c) => !/(^|\s)A2:/.test(c.ref)),
    cfs.map((c) => c.ref),
  );

  // ---- behavioural sim: evaluate the actual amber formulae per cell state ----
  // Mirrors OR(AND(ISNUMBER(SEARCH("Rever",conf)),cell=""), AND(snap<>"",cell=""))
  //   == cell=="" AND (confHasRever OR snap!="")
  const amberOn = (
    formula: string,
    st: { conf: string; chegada: string; saida: string; yy: string; xx: string },
  ) => {
    const isChegada = formula.includes("$E2");
    const cell = isChegada ? st.chegada : st.saida;
    const snap = isChegada ? st.yy : st.xx;
    return cell === "" && (/rever/i.test(st.conf) || snap !== "");
  };

  // Genuine "Rever" row, no data of ours (YY/XX blank).
  const rever = { conf: REVIEW, chegada: "", saida: "", yy: "", xx: "" };
  ok(
    "Rever, both blank -> Chegada + Saída amber",
    amberOn(fChe, rever) && amberOn(fSai, rever),
  );
  ok(
    "Rever, only Chegada typed -> Chegada white, Saída STILL amber",
    !amberOn(fChe, { ...rever, chegada: "08:00" }) &&
      amberOn(fSai, { ...rever, chegada: "08:00" }),
  );
  ok(
    "Rever, both typed -> both white",
    !amberOn(fChe, { ...rever, chegada: "08:00", saida: "08:20" }) &&
      !amberOn(fSai, { ...rever, chegada: "08:00", saida: "08:20" }),
  );

  // *** the headline case: a resolved "OK" row whose time is deleted ***
  const okRow = { conf: "OK", chegada: "08:00", saida: "08:20", yy: "08:00", xx: "08:20" };
  ok("OK row intact -> neither cell amber", !amberOn(fChe, okRow) && !amberOn(fSai, okRow));
  ok(
    "OK row, Chegada deleted by accident -> Chegada amber (Confiança still OK)",
    amberOn(fChe, { ...okRow, chegada: "" }) === true &&
      amberOn(fSai, { ...okRow, chegada: "" }) === false,
  );
  ok(
    "OK row, Saída deleted -> Saída amber",
    amberOn(fSai, { ...okRow, saida: "" }) === true,
  );
  ok(
    "OK row, both times deleted -> both amber",
    amberOn(fChe, { ...okRow, chegada: "", saida: "" }) &&
      amberOn(fSai, { ...okRow, chegada: "", saida: "" }),
  );

  // KEPT and suggestion rows get the same protection.
  const keptRow = { conf: KEPT, chegada: "07:00", saida: "07:30", yy: "07:00", xx: "07:30" };
  ok("KEPT row, Saída deleted -> Saída amber", amberOn(fSai, { ...keptRow, saida: "" }));
  const swapRow = { conf: SWAP, chegada: "09:10", saida: "09:35", yy: "09:10", xx: "09:35" };
  ok("SWAP row, Chegada deleted -> Chegada amber", amberOn(fChe, { ...swapRow, chegada: "" }));

  // ---- data validation ("OK" dropdown) ----
  const dvAt = (rowNum: number) => ws.getCell(rowNum, colIdx(CONFIANCA_COL)).dataValidation;
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
  ok(
    "SheetJS also sees the ZZ / YY / XX columns",
    [ZZ_COL, YY_COL, XX_COL].every((c) => c in rr[0]),
    Object.keys(rr[0]),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
