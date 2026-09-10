// Output-workbook builder for /dashboard/tfs-sheet.
//
// PROTOTYPE — swaps SheetJS for exceljs on the WRITE side only so the returned
// .xlsx can carry real conditional formatting + data validation. The upload is
// still parsed with SheetJS (it copes with the transporter's quirky exports —
// date serials, blank rows, the raw pass collectServiceDay() needs); exceljs is
// used purely to emit the result.
//
// What the produced file does, live in Excel:
//
//   • 🟡 âmbar on a "⚠️ Rever manualmente" row — but only while «Hora de
//     Chegada» is still empty. Type an arrival and the fill clears.
//
//   • 🔴 vermelho on a suggestion row (troca / troca fora da janela / erro de
//     matrícula) while the plate cell still equals the suggested value AND the
//     Confiança cell isn't "OK". A hidden technical column «ZZ» holds the
//     originally-suggested plate; the Confiança cell gets a dropdown whose only
//     option is "OK". Change the plate, or pick "OK", and the fill clears.

import ExcelJS from "exceljs";
import {
  CONFIANCA_COL,
  PLATE_TYPO,
  REAL_COL,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  type SheetRecord,
} from "@/lib/sheet-match/common";

// Hidden helper column: the plate we suggested, frozen at build time, so the
// conditional format can tell "user hasn't touched it" from "user corrected it".
export const ZZ_COL = "ZZ";

// Light tints — dark enough to read at a glance, light enough to keep the cell
// text legible. ARGB (leading FF = opaque).
const FILL_AMBER = "FFFFE699";
const FILL_RED = "FFF4B6B0";

const SUGGESTION_CONFS: ReadonlySet<string> = new Set([
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
]);

export type BuildTfsWorkbookArgs = {
  rows: SheetRecord[];
  /** header order for the output, WITHOUT the ZZ column (added here) */
  header: string[];
  /** resolved "Matrícula da Viatura" header, or "" if the sheet has none */
  plateColName: string;
  /** resolved "Hora de Chegada" header */
  chegadaColName: string;
  sheetName?: string;
};

export async function buildTfsWorkbook(
  args: BuildTfsWorkbookArgs,
): Promise<string> {
  const { rows, header, plateColName, chegadaColName } = args;

  const outHeader = header.includes(ZZ_COL) ? [...header] : [...header, ZZ_COL];
  const zzIdx = outHeader.indexOf(ZZ_COL) + 1; // 1-based

  const wb = new ExcelJS.Workbook();
  wb.creator = "routing/tfs-sheet";
  wb.created = new Date();
  const ws = wb.addWorksheet(args.sheetName || "TFS");

  ws.addRow(outHeader);
  ws.getRow(1).font = { bold: true };

  const isSuggestion = (r: SheetRecord) =>
    SUGGESTION_CONFS.has(String(r[CONFIANCA_COL] ?? ""));

  for (const r of rows) {
    const sugg = isSuggestion(r);
    const values = outHeader.map((h) => {
      if (h === ZZ_COL) {
        return sugg && plateColName ? String(r[plateColName] ?? "") : "";
      }
      const v = r[h];
      return v == null ? "" : v;
    });
    ws.addRow(values);
  }

  const lastRow = rows.length + 1; // + header
  if (lastRow < 2) {
    // no data rows — still emit a valid file
    return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
  }

  const letter = (name: string): string | null => {
    const i = outHeader.indexOf(name);
    return i < 0 ? null : ws.getColumn(i + 1).letter;
  };
  const confL = letter(CONFIANCA_COL);
  const chegadaL = letter(chegadaColName);
  const plateL = plateColName ? letter(plateColName) : null;
  const zzL = ws.getColumn(zzIdx).letter;
  const lastColL = ws.getColumn(outHeader.length).letter;

  // Hide the technical column.
  ws.getColumn(zzIdx).hidden = true;
  ws.getColumn(zzIdx).width = 14;
  // Roomier Confiança / Real columns.
  for (const n of [CONFIANCA_COL, REAL_COL]) {
    const i = outHeader.indexOf(n);
    if (i >= 0) ws.getColumn(i + 1).width = n === REAL_COL ? 60 : 26;
  }

  const dataRef = `A2:${lastColL}${lastRow}`;
  const solid = (argb: string) => ({
    fill: {
      type: "pattern" as const,
      pattern: "solid" as const,
      bgColor: { argb },
      fgColor: { argb },
    },
  });

  const rules: ExcelJS.ConditionalFormattingRule[] = [];

  // 🟡 "Rever manualmente" AND arrival still blank. Keyed off the substring
  // "Rever" (unique to the REVIEW label among all Confiança values) rather than
  // the emoji-bearing literal, so it survives a copy/paste that mangles the ⚠️.
  if (confL && chegadaL) {
    rules.push({
      type: "expression",
      priority: 1,
      formulae: [
        `AND(ISNUMBER(SEARCH("Rever",$${confL}2)),$${chegadaL}2="")`,
      ],
      style: solid(FILL_AMBER),
    });
  }

  // 🔴 suggestion still pending: plate untouched (== ZZ) and Confiança <> "OK".
  if (confL && plateL) {
    rules.push({
      type: "expression",
      priority: 2,
      formulae: [
        `AND($${zzL}2<>"",$${plateL}2=$${zzL}2,$${confL}2<>"OK")`,
      ],
      style: solid(FILL_RED),
    });
  }

  if (rules.length > 0) {
    ws.addConditionalFormatting({ ref: dataRef, rules });
  }

  // Dropdown ("OK") on the Confiança cell of every suggestion row.
  if (confL) {
    rows.forEach((r, i) => {
      if (!isSuggestion(r)) return;
      const cell = ws.getCell(`${confL}${i + 2}`);
      cell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"OK"'],
        showErrorMessage: false,
        showInputMessage: false,
      };
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}
