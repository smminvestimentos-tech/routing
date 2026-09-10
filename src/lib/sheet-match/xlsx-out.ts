// Output-workbook builder shared by /dashboard/tfs-sheet and
// /dashboard/azambuja-sheet.
//
// PROTOTYPE — swaps SheetJS for exceljs on the WRITE side only so the returned
// .xlsx can carry real conditional formatting + data validation. The upload is
// still parsed with SheetJS (it copes with the transporter's quirky exports —
// date serials, blank rows, the raw pass collectServiceDay() needs); exceljs is
// used purely to emit the result.
//
// What the produced file does, live in Excel:
//
//   • 🟡 âmbar on «Hora de Chegada» / «Hora de Saída», independently, when the
//     cell is empty AND either (a) the row is "⚠️ Rever manualmente", or
//     (b) we had written a value there and it has since been deleted. Case (b)
//     is the safety net: an already-resolved row (OK / mantida / sugestão
//     confirmada) whose time gets cleared by accident goes amber again even
//     though Confiança still says "OK". Fill the cell back in and only its own
//     fill clears. Only those two cells are painted, never the whole row.
//
//     Two more hidden technical columns back this: «YY» = the Chegada we wrote,
//     «XX» = the Saída we wrote (blank only for genuine "Rever" rows with no
//     data of ours). The rule compares the live cell against its snapshot.
//
//   • 🔴 vermelho on a suggestion row (troca / troca fora da janela / erro de
//     matrícula) while the plate cell still equals the suggested value AND the
//     Confiança cell isn't "OK". A hidden technical column «ZZ» holds the
//     originally-suggested plate; the Confiança cell gets a dropdown whose only
//     option is "OK". Change the plate, or pick "OK", and the fill clears. Only
//     the Matrícula + Confiança cells are painted, not the whole row.
//
//   • 🔴 vermelho on the Matrícula cell alone when «Real» mentions "cobertura
//     GPS" — i.e. we have NO data of ours to confirm or deny that this truck
//     made these deliveries. It's a "go check by hand (Transpogest)" flag,
//     distinct from the generic amber. No snapshot column is needed: the rule
//     keys off «Real» (which the user doesn't edit), not off the plate cell's
//     own value, so an accidental plate delete doesn't change whether it fires.

import ExcelJS from "exceljs";
import {
  CONFIANCA_COL,
  PLATE_TYPO,
  REAL_COL,
  SWAP,
  SWAP_OUT_OF_WINDOW,
  type SheetRecord,
} from "@/lib/sheet-match/common";

// Hidden helper columns, appended after the real data. Frozen at build time so
// the conditional formats can tell "user hasn't touched it" from "user changed
// / deleted it".
//   ZZ — the plate we suggested (suggestion rows only)
//   YY — the "Hora de Chegada" we wrote
//   XX — the "Hora de Saída" we wrote
export const ZZ_COL = "ZZ";
export const YY_COL = "YY";
export const XX_COL = "XX";
const TECH_COLS = [ZZ_COL, YY_COL, XX_COL] as const;

// Light tints — dark enough to read at a glance, light enough to keep the cell
// text legible. ARGB (leading FF = opaque).
const FILL_AMBER = "FFFFE699";
const FILL_RED = "FFF4B6B0";

const SUGGESTION_CONFS: ReadonlySet<string> = new Set([
  SWAP,
  SWAP_OUT_OF_WINDOW,
  PLATE_TYPO,
]);

export type BuildSheetWorkbookArgs = {
  rows: SheetRecord[];
  /** header order for the output, WITHOUT the ZZ/YY/XX columns (added here) */
  header: string[];
  /** resolved plate column header ("Matrícula da Viatura" / "MATRICULA"), or "" */
  plateColName: string;
  /** resolved arrival column header ("Hora de Chegada" / "Hora Chegada") */
  chegadaColName: string;
  /** resolved departure column header ("Hora de Saída" / "Hora Saida") */
  saidaColName: string;
  sheetName?: string;
};

export async function buildSheetWorkbook(
  args: BuildSheetWorkbookArgs,
): Promise<string> {
  const { rows, header, plateColName, chegadaColName, saidaColName } = args;

  const outHeader = [
    ...header,
    ...TECH_COLS.filter((c) => !header.includes(c)),
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = "routing/sheet-match";
  wb.created = new Date();
  const ws = wb.addWorksheet(args.sheetName || "Folha");

  ws.addRow(outHeader);
  ws.getRow(1).font = { bold: true };

  const isSuggestion = (r: SheetRecord) =>
    SUGGESTION_CONFS.has(String(r[CONFIANCA_COL] ?? ""));

  for (const r of rows) {
    const sugg = isSuggestion(r);
    const values = outHeader.map((h) => {
      // Snapshots of what WE wrote, so a later edit/delete is detectable.
      if (h === ZZ_COL) {
        return sugg && plateColName ? String(r[plateColName] ?? "") : "";
      }
      if (h === YY_COL) {
        return chegadaColName ? String(r[chegadaColName] ?? "") : "";
      }
      if (h === XX_COL) {
        return saidaColName ? String(r[saidaColName] ?? "") : "";
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
  const saidaL = saidaColName ? letter(saidaColName) : null;
  const plateL = plateColName ? letter(plateColName) : null;
  const realL = letter(REAL_COL);
  const zzL = letter(ZZ_COL)!;
  const yyL = letter(YY_COL)!;
  const xxL = letter(XX_COL)!;

  // Hide the technical columns.
  for (const c of TECH_COLS) {
    const i = outHeader.indexOf(c);
    if (i >= 0) {
      ws.getColumn(i + 1).hidden = true;
      ws.getColumn(i + 1).width = 14;
    }
  }
  // Roomier Confiança / Real columns.
  for (const n of [CONFIANCA_COL, REAL_COL]) {
    const i = outHeader.indexOf(n);
    if (i >= 0) ws.getColumn(i + 1).width = n === REAL_COL ? 60 : 26;
  }

  const solid = (argb: string) => ({
    fill: {
      type: "pattern" as const,
      pattern: "solid" as const,
      bgColor: { argb },
      fgColor: { argb },
    },
  });

  // A `sqref` that lists just the given columns' data rows, e.g. "C2:C8 G2:G8".
  // OOXML allows a space-separated multi-range sqref; exceljs writes it through
  // verbatim. The rule's formula stays anchored to row 2 (the top-left row).
  const colsRef = (...letters: (string | null)[]) =>
    letters
      .filter((l): l is string => !!l)
      .map((l) => `${l}2:${l}${lastRow}`)
      .join(" ");

  // 🟡 One INDEPENDENT rule per time column — each reacts to ITS OWN cell only
  // (a shared rule would clear both once Chegada is typed, hiding that Saída is
  // still missing). The cell goes amber when it is empty AND either:
  //   • the row is "⚠️ Rever manualmente" (keyed off the substring "Rever",
  //     unique to that label, so a mangled ⚠️ doesn't break it), or
  //   • its snapshot column (YY / XX) is non-empty — i.e. we had put a value
  //     there and it has since been deleted. This is the safety net for an
  //     already-resolved row whose time gets wiped by accident.
  if (confL) {
    ([
      [chegadaL, yyL],
      [saidaL, xxL],
    ] as const).forEach(([cellL, snapL], i) => {
      if (!cellL) return;
      ws.addConditionalFormatting({
        ref: `${cellL}2:${cellL}${lastRow}`,
        rules: [
          {
            type: "expression",
            priority: i + 1,
            formulae: [
              `OR(AND(ISNUMBER(SEARCH("Rever",$${confL}2)),$${cellL}2=""),` +
                `AND($${snapL}2<>"",$${cellL}2=""))`,
            ],
            style: solid(FILL_AMBER),
          },
        ],
      });
    });
  }

  // 🔴 suggestion still pending: plate untouched (== ZZ) and Confiança <> "OK"
  // — painted ONLY on the Matrícula + Confiança cells.
  if (confL && plateL) {
    ws.addConditionalFormatting({
      ref: colsRef(plateL, confL),
      rules: [
        {
          type: "expression",
          priority: 3,
          formulae: [
            `AND($${zzL}2<>"",$${plateL}2=$${zzL}2,$${confL}2<>"OK")`,
          ],
          style: solid(FILL_RED),
        },
      ],
    });
  }

  // 🔴 no GPS of ours to confirm the planned truck — «Real» carries the phrase
  // "cobertura GPS" (both "sem cobertura … no período desta entrega" and
  // "nenhum dado GPS registado"). Painted ONLY on the Matrícula cell: a
  // "confirm by hand (Transpogest)" flag. Keyed off «Real» (not user-edited),
  // so it needs no snapshot column and an accidental plate delete can't hide it.
  if (plateL && realL) {
    ws.addConditionalFormatting({
      ref: `${plateL}2:${plateL}${lastRow}`,
      rules: [
        {
          type: "expression",
          priority: 4,
          formulae: [`ISNUMBER(SEARCH("cobertura GPS",$${realL}2))`],
          style: solid(FILL_RED),
        },
      ],
    });
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
