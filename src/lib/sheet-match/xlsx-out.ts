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
//
//   • 🟣 roxo/lilás on «Hora de Chegada» AND «Hora de Saída» (both cells, same
//     row) whenever the stop's duration (Saída - Chegada) reads under 5
//     minutes. Deliberately NOT limited to any location type — armazéns/CDs
//     included on purpose: even though 0035 treats a 0-min warehouse stop as
//     legitimate for matching purposes, a human reviewer should still SEE it,
//     because a real short stop sometimes hides fragmentation (confirmed
//     2026-09). Only fires once both cells hold something Excel can parse as a
//     time (bare "HH:MM…" or the Azambuja "DD-MM-YYYY HH:MM" shape) — a row
//     still stuck on "⚠️ Rever manualmente" has blank times and never lights
//     up. A hidden technical column «WW» carries the live duration in minutes
//     (an Excel formula, not a snapshot, so it re-evaluates as the user edits
//     either cell). 🔴 takes priority: while a suggestion is still pending
//     (plate cell == ZZ and Confiança <> "OK", same test as the red rule
//     above) the times shown belong to an UNCONFIRMED candidate stop, so 🟣
//     stays off even if that candidate's duration is short — accepting the
//     suggestion (Confiança -> "OK") lets 🟣 evaluate normally from then on.
//
//   • 🔘 cinzento escuro on «Hora de Chegada» AND «Hora de Saída» (both cells,
//     same row) whenever «Real» flags a physical schedule conflict ("Conflito").
//     Fires when two rows of the same route and vehicle plate have overlapping
//     time windows at different store codes (not co-located/merged). Takes
//     precedence over 🟣 (short stop) AND over 🔵 (implausible speed, below —
//     if a row somehow carries both notes, this is the one that wins the
//     cell). Both times and Confiança values are kept verbatim as
//     calculated/maintained.
//
//   • 🔵 azul (FF9DC3E6) on «Hora de Chegada» AND «Hora de Saída» (both cells,
//     same row) whenever «Real» flags implausible travel speed ("Velocidade
//     implausível"). A DIFFERENT problem from 🔘: not two overlapping windows
//     on one route, but two CONSECUTIVE stops anywhere in the vehicle's whole
//     day (any route/leg) whose Saída->Chegada gap implies a speed no truck
//     can sustain (2026-09-22). Deliberately its own color rather than folding
//     into 🔘 — the two call for different fixes (which store is right, vs.
//     which time is mistyped) and reusing 🔘's already-tested exact formula
//     string would mean rewriting those tests for no functional gain. Yields
//     to 🔘 when a row somehow carries both notes (NOT("Conflito") in its own
//     formula, not just priority number — same defensive style as 🟣 below).
//     Takes precedence over 🟣 (short stop).

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
// WW — live "Saída minus Chegada" in minutes, an Excel FORMULA (not a
// snapshot like ZZ/YY/XX) referencing the row's own Chegada/Saída cells, so it
// re-evaluates whenever the user edits either one. "" when either cell is
// blank or unparseable. Backs the 🟣 short-stop rule below.
export const WW_COL = "WW";
const TECH_COLS = [ZZ_COL, YY_COL, XX_COL, WW_COL] as const;
const TECH_COL_SET: ReadonlySet<string> = new Set(TECH_COLS);

// Light tints — dark enough to read at a glance, light enough to keep the cell
// text legible. ARGB (leading FF = opaque).
const FILL_AMBER = "FFFFE699";
const FILL_RED = "FFF4B6B0";
const FILL_PURPLE = "FFDCC6F2";
export const FILL_DARK_GRAY = "FFA6A6A6";
// Implausible-speed rule (🔵, 2026-09-22) — distinct blue, confirmed with the
// user, kept apart from the reds/oranges/yellows already in the palette above.
export const FILL_SPEED = "FF9DC3E6";
// Header row fill — matches the transporter's own export exactly
// (Ficheiro_Horários_TFS_12-09-2026.xlsx, confirmed FFC000 / ARGB FFFFC000).
const FILL_HEADER = "FFFFC000";
// Standardized font, per the administrator's request — applied to every
// visible cell (header + data), never to the hidden ZZ/YY/XX technical
// columns, same exception already used for color/border/alignment below.
const FONT_NAME = "Aptos Narrow";

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
  // Last 1-indexed column that isn't one of our own hidden technical columns
  // — the real file's autofilter/header-fill stop there too, not at ZZ/YY/XX.
  let lastVisibleCol = 0;
  outHeader.forEach((h, i) => {
    if (!TECH_COL_SET.has(h)) lastVisibleCol = i + 1;
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "routing/sheet-match";
  wb.created = new Date();
  const ws = wb.addWorksheet(args.sheetName || "Folha");

  ws.addRow(outHeader);
  const headerRow = ws.getRow(1);
  outHeader.forEach((h, i) => {
    if (TECH_COL_SET.has(h)) return;
    headerRow.getCell(i + 1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: FILL_HEADER },
    };
  });

  // Freeze the header row so it stays visible while scrolling.
  ws.views = [{ state: "frozen", ySplit: 1 }];

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
      // WW is a formula, filled in below once every row + column letter exists.
      if (h === WW_COL) return "";
      const v = r[h];
      return v == null ? "" : v;
    });
    ws.addRow(values);
  }

  const lastRow = rows.length + 1; // + header

  // Autofilter over the whole data range (header + every row), stopping at
  // the last real column — same footprint as the transporter's own export.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: lastRow, column: lastVisibleCol },
  };

  // Thin grid border ("Contornos" + "Interior") + centered horizontal
  // alignment + standardized font on every cell that carries data — header
  // and rows, every visible column — never the hidden ZZ/YY/XX.
  const THIN_BORDER = { style: "thin" as const, color: { argb: "FF000000" } };
  const visibleCols = outHeader
    .map((h, i) => (TECH_COL_SET.has(h) ? -1 : i + 1))
    .filter((c) => c > 0);
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    for (const c of visibleCols) {
      const cell = row.getCell(c);
      cell.border = {
        top: THIN_BORDER,
        left: THIN_BORDER,
        bottom: THIN_BORDER,
        right: THIN_BORDER,
      };
      cell.alignment = { horizontal: "center" };
      cell.font =
        r === 1 ? { name: FONT_NAME, bold: true } : { name: FONT_NAME };
    }
  }

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
  const wwL = letter(WW_COL)!;

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

  // Populate WW with a live formula per row: minutes between Chegada and
  // Saída, tolerant of both time shapes this app ever writes into those
  // cells — bare "HH:MM[:SS]" (TFS) or "DD-MM-YYYY HH:MM" (Azambuja, whose
  // cycles can cross midnight; "/" also accepted — older exports and
  // transporter pre-fills used that separator before this app switched to
  // "-") — mirroring parseClockMin/minutesBetweenKeptCells (common.ts) in
  // Excel-formula form. "" (via IFERROR) whenever either cell is blank or
  // doesn't parse, so a malformed cell never miscolors the row.
  if (chegadaL && saidaL) {
    const serial = (colL: string, row: number) => {
      const cell = `$${colL}${row}`;
      const timePart = `TRIM(MID(${cell},FIND(" ",${cell})+1,20))`;
      return (
        `IF(OR(ISNUMBER(SEARCH("/",${cell})),ISNUMBER(SEARCH("-",${cell}))),` +
        `DATEVALUE(LEFT(${cell},FIND(" ",${cell})-1))+TIMEVALUE(${timePart}),` +
        `TIMEVALUE(${cell}))`
      );
    };
    for (let i = 0; i < rows.length; i++) {
      const row = i + 2;
      const cheCell = `$${chegadaL}${row}`;
      const saiCell = `$${saidaL}${row}`;
      const formula =
        `IFERROR(IF(OR(${cheCell}="",${saiCell}=""),"",` +
        `ROUND((${serial(saidaL, row)}-${serial(chegadaL, row)})*1440,0)),"")`;
      ws.getCell(`${wwL}${row}`).value = { formula };
    }
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

  // 🔘 conflito de horários sobrepostos: Chegada + Saída pintadas a cinzento
  // escuro quando «Real» menciona "Conflito" (mesma rota + viatura com paragens
  // fisicamente incompatíveis em lojas diferentes). Tem prioridade sobre o
  // azul de velocidade implausível e sobre o roxo de paragem curta.
  if (chegadaL && saidaL && realL) {
    ws.addConditionalFormatting({
      ref: colsRef(chegadaL, saidaL),
      rules: [
        {
          type: "expression",
          priority: 5,
          formulae: [`ISNUMBER(SEARCH("Conflito",$${realL}2))`],
          style: solid(FILL_DARK_GRAY),
        },
      ],
    });
  }

  // 🔵 velocidade implausível entre paragens consecutivas do mesmo veículo
  // (dia inteiro, não só a mesma rota — distinto do 🔘 acima): Chegada +
  // Saída pintadas de azul quando «Real» menciona "Velocidade implausível".
  // NOT("Conflito") explícito para o 🔘 manter prioridade caso uma linha
  // acumule as duas notas (mesmo estilo defensivo do 🟣 abaixo, não confia só
  // no número de priority).
  if (chegadaL && saidaL && realL) {
    ws.addConditionalFormatting({
      ref: colsRef(chegadaL, saidaL),
      rules: [
        {
          type: "expression",
          priority: 6,
          formulae: [
            `AND(ISNUMBER(SEARCH("Velocidade implausível",$${realL}2)),NOT(ISNUMBER(SEARCH("Conflito",$${realL}2))))`,
          ],
          style: solid(FILL_SPEED),
        },
      ],
    });
  }

  // 🟣 short stop (< 5 min): painted on Chegada + Saída together, keyed off
  // the live WW duration. Suppressed while the row is still an unconfirmed
  // suggestion (same "plate cell == ZZ and Confiança <> OK" test as the red
  // rule above) OR when the row is in conflict (🔘) or implausibly fast (🔵)
  // — both keep priority over 🟣.
  if (chegadaL && saidaL) {
    const pending =
      confL && plateL
        ? `AND($${zzL}2<>"",$${plateL}2=$${zzL}2,$${confL}2<>"OK")`
        : "FALSE";
    const conflict = realL
      ? `ISNUMBER(SEARCH("Conflito",$${realL}2))`
      : "FALSE";
    const speed = realL
      ? `ISNUMBER(SEARCH("Velocidade implausível",$${realL}2))`
      : "FALSE";
    ws.addConditionalFormatting({
      ref: colsRef(chegadaL, saidaL),
      rules: [
        {
          type: "expression",
          priority: 7,
          formulae: [
            `AND(ISNUMBER($${wwL}2),$${wwL}2>=0,$${wwL}2<5,NOT(${pending}),NOT(${conflict}),NOT(${speed}))`,
          ],
          style: solid(FILL_PURPLE),
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
