// Structural checks for the shared exceljs output workbook (PROTOTYPE),
// used by both /dashboard/tfs-sheet and /dashboard/azambuja-sheet.
//
//   npm run test:sheet-workbook
//
// Can't open Excel from CI, so this builds a workbook covering every Confiança
// category, then re-opens it (with exceljs AND with SheetJS, the upload path)
// and asserts: the hidden ZZ / YY / XX columns + their values; the conditional
// formats and their formulae (amber missing-time incl. the accidental-deletion
// safety net; red pending-suggestion; red "sem cobertura GPS" on the plate
// cell); the "OK" dropdown on exactly the suggestion rows; and that kept / OK
// rows are byte-for-byte what went in. Also simulates the formulae per cell
// state so the behaviour is proven without Excel.

import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSheetWorkbook,
  ZZ_COL,
  YY_COL,
  XX_COL,
} from "@/lib/sheet-match/xlsx-out";
import {
  CONFIANCA_COL,
  REAL_COL,
  REVIEW,
  KEPT,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
  noGpsCoverageNote,
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

type Cf = { ref: string; rules: { type?: string; formulae?: string[] }[] };
const cfsOf = (ws: ExcelJS.Worksheet) =>
  (ws as unknown as { conditionalFormattings: Cf[] }).conditionalFormattings;

// Both no-coverage branches must literally carry the phrase the rule searches.
ok(
  'noGpsCoverageNote(…, false) contains "cobertura GPS"',
  /cobertura GPS/.test(noGpsCoverageNote("72XR33", false)),
  noGpsCoverageNote("72XR33", false),
);
ok(
  'noGpsCoverageNote(…, true) contains "cobertura GPS"',
  /cobertura GPS/.test(noGpsCoverageNote("72XR33", true)),
  noGpsCoverageNote("72XR33", true),
);

// ===========================================================================
// TFS-shaped workbook — one row of every category.
// ===========================================================================
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

const rows: SheetRecord[] = [
  /* 2 */ row({ "Matrícula da Viatura": "11AA11", "Hora de Chegada": "08:00", "Hora de Saída": "08:20", [CONFIANCA_COL]: "OK" }),
  /* 3 */ row({ "Matrícula da Viatura": "22BB22", "Hora de Chegada": "07:00", "Hora de Saída": "07:30", [CONFIANCA_COL]: KEPT }),
  /* 4 */ row({ "Matrícula da Viatura": "33CC33", [CONFIANCA_COL]: REVIEW, [REAL_COL]: "Sem paragens nossas para 33CC33 em 2026-09-09." }),
  /* 5 */ row({ "Matrícula da Viatura": "44DD44", "Hora de Chegada": "09:10", "Hora de Saída": "09:35", [CONFIANCA_COL]: SWAP, [REAL_COL]: "Camião 500 planeado como 44DD44, mas 44DD45 esteve em E00…" }),
  /* 6 */ row({ "Matrícula da Viatura": "55EE55", "Hora de Chegada": "21:00", "Hora de Saída": "21:25", [CONFIANCA_COL]: SWAP_OUT_OF_WINDOW }),
  /* 7 */ row({ "Matrícula da Viatura": "32OG64", "Hora de Chegada": "10:25", "Hora de Saída": "10:52", [CONFIANCA_COL]: PLATE_TYPO }),
  /* 8 */ row({ "Matrícula da Viatura": "72XR33", [CONFIANCA_COL]: REVIEW, [REAL_COL]: noGpsCoverageNote("72XR33", false) }),
  /* 9 */ row({ "Matrícula da Viatura": "88GG88", [CONFIANCA_COL]: REVIEW, [REAL_COL]: noGpsCoverageNote("88GG88", true) }),
  /* 10 */ row({ "Nº Camião": "", "Código de Loja": "", [CONFIANCA_COL]: "" }), // blank-ish passthrough
];
const LAST = rows.length + 1; // 10
const suggestionRowNums = [5, 6, 7];
const gpsRowNums = [8, 9];

async function main() {
  const b64 = await buildSheetWorkbook({
    rows,
    header,
    plateColName: "Matrícula da Viatura",
    chegadaColName: "Hora de Chegada",
    saidaColName: "Hora de Saída",
    sheetName: "TFS",
  });
  const buf = Buffer.from(b64, "base64");
  const outPath = join(process.env.TEMP || ".", "sheet-workbook-proto.xlsx");
  writeFileSync(outPath, buf);
  console.log("wrote", outPath, `(${buf.length} bytes)\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("TFS")!;
  ok("exceljs re-opens the file, sheet 'TFS'", !!ws && wb.worksheets.length === 1);

  const hdr = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v));
  ok("ZZ / YY / XX appended, in order", hdr.slice(-3).join(",") === `${ZZ_COL},${YY_COL},${XX_COL}`, hdr);
  const colIdx = (name: string) => hdr.indexOf(name) + 1;
  for (const c of [ZZ_COL, YY_COL, XX_COL]) {
    ok(`${c} column hidden`, ws.getColumn(colIdx(c)).hidden === true);
  }

  const cellAt = (r: number, name: string) => String(ws.getCell(r, colIdx(name)).value ?? "");
  ok("ZZ blank on OK/KEPT/REVIEW rows", [2, 3, 4, 8, 9].every((r) => cellAt(r, ZZ_COL) === ""));
  ok("ZZ = suggested plate on the 3 suggestion rows", cellAt(5, ZZ_COL) === "44DD44" && cellAt(6, ZZ_COL) === "55EE55" && cellAt(7, ZZ_COL) === "32OG64");
  ok("YY/XX snapshot the OK row's times", cellAt(2, YY_COL) === "08:00" && cellAt(2, XX_COL) === "08:20");
  ok("YY/XX blank on the no-data REVIEW + GPS rows", [4, 8, 9].every((r) => cellAt(r, YY_COL) === "" && cellAt(r, XX_COL) === ""));
  ok("OK / KEPT rows keep their times & Confiança verbatim", cellAt(2, "Hora de Chegada") === "08:00" && cellAt(3, CONFIANCA_COL) === KEPT);

  // ---- conditional formatting ----
  const cfs = cfsOf(ws);
  ok("4 conditional-format rules present", cfs.flatMap((c) => c.rules).length === 4, cfs.map((c) => c.ref));

  // Layout: C=Matrícula, E=Chegada, F=Saída, G=Confiança, H=Real, J=YY, K=XX.
  const cfFor = (ref: string) => cfs.find((c) => c.ref === ref);
  const amberChe = cfFor(`E2:E${LAST}`);
  const amberSai = cfFor(`F2:F${LAST}`);
  const redSugg = cfFor(`C2:C${LAST} G2:G${LAST}`);
  const redGps = cfFor(`C2:C${LAST}`);
  ok("amber Chegada sqref = E-column only", !!amberChe, cfs.map((c) => c.ref));
  ok("amber Saída sqref = F-column only", !!amberSai, cfs.map((c) => c.ref));
  ok("red suggestion sqref = Matrícula + Confiança", !!redSugg, cfs.map((c) => c.ref));
  ok("red no-GPS sqref = Matrícula column ONLY (not Confiança)", !!redGps, cfs.map((c) => c.ref));

  const fChe = amberChe?.rules[0]?.formulae?.[0] ?? "";
  const fSai = amberSai?.rules[0]?.formulae?.[0] ?? "";
  const fSugg = redSugg?.rules[0]?.formulae?.[0] ?? "";
  const fGps = redGps?.rules[0]?.formulae?.[0] ?? "";
  ok("amber Chegada formula", fChe === 'OR(AND(ISNUMBER(SEARCH("Rever",$G2)),$E2=""),AND($J2<>"",$E2=""))', fChe);
  ok("amber Saída formula", fSai === 'OR(AND(ISNUMBER(SEARCH("Rever",$G2)),$F2=""),AND($K2<>"",$F2=""))', fSai);
  ok("red suggestion formula", fSugg === 'AND($I2<>"",$C2=$I2,$G2<>"OK")', fSugg);
  ok('red no-GPS formula = ISNUMBER(SEARCH("cobertura GPS",$H2))', fGps === 'ISNUMBER(SEARCH("cobertura GPS",$H2))', fGps);
  ok("red no-GPS formula does NOT reference the plate cell ($C) — a plate delete can't hide it", !/\$C\d/.test(fGps), fGps);
  ok("no CF paints a whole-row range", cfs.every((c) => !/(^|\s)A2:/.test(c.ref)), cfs.map((c) => c.ref));

  // ---- behavioural sim ----
  const amberOn = (formula: string, st: { conf: string; chegada: string; saida: string; yy: string; xx: string }) => {
    const isChe = formula.includes("$E2");
    const cell = isChe ? st.chegada : st.saida;
    const snap = isChe ? st.yy : st.xx;
    return cell === "" && (/rever/i.test(st.conf) || snap !== "");
  };
  const redGpsOn = (realText: string) => /cobertura gps/i.test(realText); // mirrors SEARCH("cobertura GPS",$H)

  const rever = { conf: REVIEW, chegada: "", saida: "", yy: "", xx: "" };
  ok("Rever, both blank -> both amber", amberOn(fChe, rever) && amberOn(fSai, rever));
  ok("Rever, only Chegada typed -> Saída STILL amber", !amberOn(fChe, { ...rever, chegada: "08:00" }) && amberOn(fSai, { ...rever, chegada: "08:00" }));
  const okRow = { conf: "OK", chegada: "08:00", saida: "08:20", yy: "08:00", xx: "08:20" };
  ok("OK row intact -> neither amber", !amberOn(fChe, okRow) && !amberOn(fSai, okRow));
  ok("OK row, Chegada deleted -> Chegada amber (Confiança still OK)", amberOn(fChe, { ...okRow, chegada: "" }) && !amberOn(fSai, { ...okRow, chegada: "" }));

  // *** the no-GPS-coverage red (72XR33/B67-style) ***
  ok("no-GPS Real text -> plate cell red (everSeen=false branch)", redGpsOn(noGpsCoverageNote("72XR33", false)) === true);
  ok("no-GPS Real text -> plate cell red (everSeen=true branch)", redGpsOn(noGpsCoverageNote("72XR33", true)) === true);
  ok("OK row (Real empty) -> plate cell NOT red", redGpsOn("") === false);
  ok("plain Rever (no coverage phrase) -> plate cell NOT red", redGpsOn("Sem paragens nossas para 33CC33 em 2026-09-09.") === false);
  ok("swap note ('não tem dados GPS') -> plate cell NOT red", redGpsOn("Nota: o veículo XX não tem dados GPS — não é alternativa real.") === false);
  ok("no-GPS red survives an accidental plate delete (formula ignores the plate cell)", redGpsOn(noGpsCoverageNote("72XR33", false)) === true);

  // ---- data validation ----
  const dvAt = (r: number) => ws.getCell(r, colIdx(CONFIANCA_COL)).dataValidation;
  ok("dropdown ['OK'] on exactly the suggestion rows", suggestionRowNums.every((r) => dvAt(r)?.type === "list") && [2, 3, 4, 8, 9, 10].every((r) => !dvAt(r)));
  void gpsRowNums;

  // ---- SheetJS still reads it back ----
  const rr = XLSX.utils.sheet_to_json<SheetRecord>(XLSX.read(buf, { type: "buffer" }).Sheets.TFS, { raw: false, defval: "", blankrows: false });
  ok("SheetJS re-reads the file, all rows + tech cols", rr.length === rows.length && [ZZ_COL, YY_COL, XX_COL].every((c) => c in rr[0]));

  // ===========================================================================
  // Azambuja-shaped workbook — different column names; same rules must apply.
  // ===========================================================================
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "TIPO", "Dia Serviço", "Hora Chegada", "Hora Saida", CONFIANCA_COL, REAL_COL];
  const azRow = (o: Partial<SheetRecord> & { [CONFIANCA_COL]: string }): SheetRecord => ({
    ROTA: "185787179", N_LOJA: "7001", NOME: "Loja", MATRICULA: "AD-90-DE", TIPO: "C",
    "Dia Serviço": "2026-09-09", "Hora Chegada": "", "Hora Saida": "", [REAL_COL]: "", ...o,
  });
  const azRows = [
    azRow({ "Hora Chegada": "09/09/2026 06:26", "Hora Saida": "09/09/2026 07:09", [CONFIANCA_COL]: "OK" }),
    azRow({ MATRICULA: "72-XR-33", [CONFIANCA_COL]: REVIEW, [REAL_COL]: noGpsCoverageNote("72XR33", false) }),
    azRow({ MATRICULA: "AB-12-CD", [CONFIANCA_COL]: REVIEW, [REAL_COL]: "Sem paragens nossas para AB12CD em 2026-09-09." }),
  ];
  const azB64 = await buildSheetWorkbook({
    rows: azRows, header: azHeader,
    plateColName: "MATRICULA", chegadaColName: "Hora Chegada", saidaColName: "Hora Saida",
    sheetName: "route-806-20260909111720-1",
  });
  const azWb = new ExcelJS.Workbook();
  await azWb.xlsx.load(Buffer.from(azB64, "base64") as unknown as ArrayBuffer);
  const azWs = azWb.getWorksheet("route-806-20260909111720-1")!;
  ok("Azambuja: workbook builds & re-opens with the route sheet name", !!azWs);
  const azHdr = (azWs.getRow(1).values as unknown[]).slice(1).map((v) => String(v));
  // MATRICULA is column D here; Real is column J.
  const dL = azWs.getColumn(azHdr.indexOf("MATRICULA") + 1).letter;
  const jL = azWs.getColumn(azHdr.indexOf(REAL_COL) + 1).letter;
  const azCfs = cfsOf(azWs);
  const azGps = azCfs.find((c) => c.ref === `${dL}2:${dL}4`);
  ok("Azambuja: no-GPS red rule lands on the MATRICULA column", !!azGps, azCfs.map((c) => c.ref));
  ok(
    "Azambuja: no-GPS formula keys off its Real column",
    azGps?.rules[0]?.formulae?.[0] === `ISNUMBER(SEARCH("cobertura GPS",$${jL}2))`,
    azGps?.rules[0]?.formulae?.[0],
  );
  ok("Azambuja: ZZ/YY/XX appended & hidden", ["ZZ", "YY", "XX"].every((c) => azWs.getColumn(azHdr.indexOf(c) + 1).hidden === true));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
