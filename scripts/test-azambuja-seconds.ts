// Azambuja Chegada/Saída with the GPS's REAL seconds ("DD-MM-YYYY HH:MM:SS",
// 2026-09-23) — every place that re-reads those cells must understand the
// extra ":SS", and a re-uploaded "conferido" file must round-trip without
// losing them.
//
//   npm run test:azambuja-seconds
//
// Covers: fmtDateTimeLisbon (real seconds, truncated not rounded, midnight,
// DST); the three re-read parsers (parseTimeCellToEpochMs, normalizeDateTimeCell,
// minutesBetweenKeptCells) on HH:MM:SS, HH:MM and a mix; that 🔘 conflict and
// 🔵 implausible-speed detection still fire on cells with seconds (they
// silently skipped every such row before the parsers accepted ":SS"); a full
// round-trip matcher -> exceljs workbook -> SheetJS (exactly the upload path)
// -> matcher again; and the WW formula's ROUND(…,2). Also writes a colour-matrix
// workbook to %TEMP%\azambuja-seconds-colors.xlsx for the manual Excel check.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import {
  resolveColumns,
  runMatch,
} from "@/lib/azambuja-sheet/match";
import {
  classifyKeptDuration,
  CONFIANCA_COL,
  type DayStop,
  fmtDateTimeLisbon,
  KEPT,
  minutesBetweenKeptCells,
  normalizeDateTimeCell,
  parseTimeCellToEpochMs,
  REAL_COL,
  REVIEW,
  type SheetRecord,
  TRACKIT_FALLBACK,
  VV_COL,
} from "@/lib/sheet-match/common";
import { buildSheetWorkbook, WW_COL } from "@/lib/sheet-match/xlsx-out";

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

const SVC = "2026-09-09";
const serialOf = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  (Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(1899, 11, 30)) / 86_400_000;

async function main() {
  // ---------------------------------------------------------------------------
  console.log("== fmtDateTimeLisbon ==");
  ok("summer (WEST, UTC+1): real seconds", fmtDateTimeLisbon("2026-09-09T05:26:14Z") === "09-09-2026 06:26:14", fmtDateTimeLisbon("2026-09-09T05:26:14Z"));
  ok("sub-second part TRUNCATED, not rounded (.887 stays :14)", fmtDateTimeLisbon("2026-09-09T05:26:14.887+00:00") === "09-09-2026 06:26:14", fmtDateTimeLisbon("2026-09-09T05:26:14.887+00:00"));
  ok(":59.999 does not roll into the next minute", fmtDateTimeLisbon("2026-09-09T05:26:59.999Z") === "09-09-2026 06:26:59", fmtDateTimeLisbon("2026-09-09T05:26:59.999Z"));
  ok("whole-minute GPS value still shows :00 (it IS the GPS's value)", fmtDateTimeLisbon("2026-09-09T05:26:00Z") === "09-09-2026 06:26:00");
  ok("midnight crossing: date follows Lisbon, not UTC", fmtDateTimeLisbon("2026-09-09T23:01:07Z") === "10-09-2026 00:01:07", fmtDateTimeLisbon("2026-09-09T23:01:07Z"));
  ok("winter (WET, UTC+0) after the Oct DST change", fmtDateTimeLisbon("2026-10-25T01:30:45Z") === "25-10-2026 01:30:45", fmtDateTimeLisbon("2026-10-25T01:30:45Z"));
  ok("null / invalid -> ''", fmtDateTimeLisbon(null) === "" && fmtDateTimeLisbon("nope") === "");

  // ---------------------------------------------------------------------------
  console.log("== parseTimeCellToEpochMs ==");
  const withSec = parseTimeCellToEpochMs("09-09-2026 06:26:14", SVC);
  const noSec = parseTimeCellToEpochMs("09-09-2026 06:26", SVC);
  ok("HH:MM:SS parses (was null -> 🔘/🔵 silently skipped the row)", withSec != null, withSec);
  ok("HH:MM:SS is exactly 14s after HH:MM", withSec != null && noSec != null && withSec - noSec === 14_000, withSec != null && noSec != null ? withSec - noSec : null);
  ok("HH:MM:SS is the right instant (Lisbon wall-clock)", withSec === Date.parse("2026-09-09T06:26:14+01:00"), withSec);
  // Day <> month on purpose: before ":SS" was accepted, "DD-MM-YYYY HH:MM:SS"
  // fell through to `new Date(s)`, which V8 reads as MM-DD in the SERVER's
  // local zone — null for day > 12, the wrong date for day <= 12 (and off by
  // the UTC offset on Vercel). "09-09" alone can't tell those apart.
  ok("day > 12 with seconds (old fallback: null)", parseTimeCellToEpochMs("15-09-2026 02:54:17", SVC) === Date.parse("2026-09-15T02:54:17+01:00"), parseTimeCellToEpochMs("15-09-2026 02:54:17", SVC));
  ok("day <= 12, day <> month, with seconds (old fallback: read as 9 May)", parseTimeCellToEpochMs("05-09-2026 06:26:14", SVC) === Date.parse("2026-09-05T06:26:14+01:00"), parseTimeCellToEpochMs("05-09-2026 06:26:14", SVC));
  ok("'/' separator + seconds", parseTimeCellToEpochMs("09/09/2026 06:26:14", SVC) === withSec);
  ok("bare HH:MM:SS attaches to the default day", parseTimeCellToEpochMs("06:26:14", SVC) === withSec);
  ok("HH:MM unchanged (still accepted)", noSec === Date.parse("2026-09-09T06:26:00+01:00"), noSec);

  // ---------------------------------------------------------------------------
  console.log("== normalizeDateTimeCell ==");
  ok("our own HH:MM:SS is kept verbatim", normalizeDateTimeCell("09-09-2026 06:26:14", "09-09-2026 06:26:14", SVC) === "09-09-2026 06:26:14", normalizeDateTimeCell("09-09-2026 06:26:14", "09-09-2026 06:26:14", SVC));
  ok("transporter HH:MM gets NO invented ':00'", normalizeDateTimeCell("08/09/2026 20:58", "08/09/2026 20:58", SVC) === "08-09-2026 20:58");
  ok("'/' + seconds -> '-' + seconds", normalizeDateTimeCell("09/09/2026 06:26:14", "09/09/2026 06:26:14", SVC) === "09-09-2026 06:26:14");
  ok("bare HH:MM:SS -> service day + seconds", normalizeDateTimeCell("06:26:14", "06:26:14", SVC) === "09-09-2026 06:26:14");
  const ser = serialOf(2026, 9, 9, 6, 26, 14);
  ok("Excel serial with seconds (cell Excel re-parsed after an edit) keeps them", normalizeDateTimeCell("09/09/2026 06:26", ser, SVC) === "09-09-2026 06:26:14", normalizeDateTimeCell("09/09/2026 06:26", ser, SVC));
  // A serial for :14 computed the way Excel stores it can land a hair under
  // (…:13.9999) — rounding to the second, not truncating, keeps it :14.
  const serNoisy = ser - 1e-9;
  ok("Excel serial float noise (…:13.9999) still reads :14", normalizeDateTimeCell("", serNoisy, SVC) === "09-09-2026 06:26:14", normalizeDateTimeCell("", serNoisy, SVC));
  ok("whole-minute Excel serial gets no ':00'", normalizeDateTimeCell("", serialOf(2026, 9, 8, 0, 12), SVC) === "08-09-2026 00:12");
  ok("12h clock with seconds + PM", normalizeDateTimeCell("09/09/2026 1:05:09 PM", "09/09/2026 1:05:09 PM", SVC) === "09-09-2026 13:05:09");

  // ---------------------------------------------------------------------------
  console.log("== minutesBetweenKeptCells / classifyKeptDuration ==");
  const k = (a: string, b: string) => minutesBetweenKeptCells(a, b, a, b, SVC);
  const near = (x: number | null, y: number) => x != null && Math.abs(x - y) < 1e-9;
  ok("HH:MM:SS -> fractional minutes (4m20s = 4.333)", near(k("09-09-2026 06:26:50", "09-09-2026 06:31:10"), 260 / 60), k("09-09-2026 06:26:50", "09-09-2026 06:31:10"));
  ok("…which a loja now rejects as too short (<5 real min; HH:MM truncation used to read 5)", classifyKeptDuration(k("09-09-2026 06:26:50", "09-09-2026 06:31:10"), "loja") === "too_short_for_store");
  ok("exactly 5:00 with seconds is plausible at a loja", classifyKeptDuration(k("09-09-2026 06:26:07", "09-09-2026 06:31:07"), "loja") === null);
  ok("mixed: seconds on one side only", near(k("09-09-2026 06:26:30", "09-09-2026 06:29"), 2.5), k("09-09-2026 06:26:30", "09-09-2026 06:29"));
  ok("midnight crossing with seconds", near(k("09-09-2026 23:58:30", "10-09-2026 00:01:10"), 160 / 60), k("09-09-2026 23:58:30", "10-09-2026 00:01:10"));
  ok("HH:MM-only still integer", k("09-09-2026 06:26", "09-09-2026 07:09") === 43);

  // ---------------------------------------------------------------------------
  console.log("== matcher: 🔘 conflict + 🔵 speed still fire on HH:MM:SS cells ==");
  const header = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const cols = resolveColumns(header);
  {
    // 33-IV-96 shape from test-sheet-match, but the GPS stop carries seconds:
    // kept 7005 02:50–03:10 overlaps our OK 7001 02:54:17–03:34:41.
    const records: SheetRecord[] = [
      { ROTA: "R1", N_LOJA: "7005", NOME: "A", MATRICULA: "33-IV-96", "Hora Chegada": "15/09/2026 02:50", "Hora Saida": "15/09/2026 03:10", CICLO: "01:00 | 05:00", TIPO: "C" },
      { ROTA: "R1", N_LOJA: "7001", NOME: "B", MATRICULA: "33-IV-96", "Hora Chegada": "", "Hora Saida": "", CICLO: "01:00 | 05:00", TIPO: "C" },
    ];
    const stops: DayStop[] = [
      { id: "s1", vehicleId: 1, plate: "33IV96", code: "7001", arrivedAt: "2026-09-15T02:54:17.412+01:00", departedAt: "2026-09-15T03:34:41.09+01:00" },
    ];
    const r = runMatch({ day: "2026-09-15", records, header, cols, stops, platesWithGps: new Set(["33IV96"]), pingWindowByPlate: new Map(), rawRecords: records });
    ok("OK row written with the GPS's real seconds", r.rows[1]["Hora Chegada"] === "15-09-2026 02:54:17" && r.rows[1]["Hora Saida"] === "15-09-2026 03:34:41", [r.rows[1]["Hora Chegada"], r.rows[1]["Hora Saida"]]);
    ok("kept transporter row stays HH:MM (no invented seconds)", r.rows[0]["Hora Chegada"] === "15-09-2026 02:50" && r.rows[0]["Hora Saida"] === "15-09-2026 03:10", [r.rows[0]["Hora Chegada"], r.rows[0]["Hora Saida"]]);
    ok("🔘 conflict still detected with a seconds cell on one side", String(r.rows[1][REAL_COL]).includes("Conflito") && String(r.rows[0][REAL_COL]).includes("Conflito"), [r.rows[0][REAL_COL], r.rows[1][REAL_COL]]);
  }
  {
    // Two kept rows, both with seconds, 30km apart 20min apart (~90km/h).
    // Day 15 (> 12) so the old V8 MM-DD fallback can't pass it by accident.
    const EARTH_R_KM = 6371;
    const dLat = (30 / EARTH_R_KM) * (180 / Math.PI);
    const codeCoords = new Map([["SYN-A", { lat: 38.7, lng: -9.0 }], ["SYN-B", { lat: 38.7 + dLat, lng: -9.0 }]]);
    const records: SheetRecord[] = [
      { ROTA: "R1", N_LOJA: "SYN-A", NOME: "A", MATRICULA: "SP-EE-DD", "Hora Chegada": "15-09-2026 08:00:12", "Hora Saida": "15-09-2026 08:10:40", CICLO: "08:00 | 20:00", TIPO: "C" },
      { ROTA: "R2", N_LOJA: "SYN-B", NOME: "B", MATRICULA: "SP-EE-DD", "Hora Chegada": "15-09-2026 08:30:05", "Hora Saida": "15-09-2026 08:41:33", CICLO: "08:00 | 20:00", TIPO: "C" },
    ];
    const r = runMatch({ day: "2026-09-15", records, header, cols, stops: [], platesWithGps: new Set(), pingWindowByPlate: new Map(), codeCoords, rawRecords: records });
    ok("kept rows with seconds stay KEPT, seconds intact", r.rows.every((x) => x[CONFIANCA_COL] === KEPT) && r.rows[0]["Hora Chegada"] === "15-09-2026 08:00:12", r.rows.map((x) => [x[CONFIANCA_COL], x["Hora Chegada"]]));
    ok("🔵 implausible speed still detected on HH:MM:SS cells", r.rows.every((x) => String(x[REAL_COL]).includes("Velocidade implausível")), r.rows.map((x) => x[REAL_COL]));
  }

  // ---------------------------------------------------------------------------
  console.log("== round-trip: matcher -> xlsx -> SheetJS (upload path) -> matcher ==");
  {
    const records: SheetRecord[] = [
      { ROTA: "R1", N_LOJA: "7001", NOME: "A", MATRICULA: "AD-90-DE", "Hora Chegada": "", "Hora Saida": "", CICLO: "05:00 | 12:00", TIPO: "C" },
      { ROTA: "R1", N_LOJA: "7002", NOME: "B", MATRICULA: "AD-90-DE", "Hora Chegada": "", "Hora Saida": "", CICLO: "05:00 | 12:00", TIPO: "C" },
      { ROTA: "R1", N_LOJA: "7003", NOME: "C", MATRICULA: "AD-90-DE", "Hora Chegada": "09/09/2026 10:00", "Hora Saida": "09/09/2026 10:40", CICLO: "05:00 | 12:00", TIPO: "C" },
    ];
    const stops: DayStop[] = [
      { id: "a", vehicleId: 1, plate: "AD90DE", code: "7001", arrivedAt: "2026-09-09T06:26:14.887+01:00", departedAt: "2026-09-09T07:09:03.1+01:00" },
      { id: "b", vehicleId: 1, plate: "AD90DE", code: "7002", arrivedAt: "2026-09-09T07:40:59.5+01:00", departedAt: "2026-09-09T08:12:00+01:00" },
    ];
    const p1 = runMatch({ day: SVC, records, header, cols, stops, platesWithGps: new Set(["AD90DE"]), pingWindowByPlate: new Map(), rawRecords: records });
    ok("pass 1: GPS rows OK with seconds", p1.rows[0][CONFIANCA_COL] === "OK" && p1.rows[0]["Hora Chegada"] === "09-09-2026 06:26:14" && p1.rows[1]["Hora Chegada"] === "09-09-2026 07:40:59" && p1.rows[1]["Hora Saida"] === "09-09-2026 08:12:00", p1.rows.slice(0, 2).map((x) => [x[CONFIANCA_COL], x["Hora Chegada"], x["Hora Saida"]]));

    const b64 = await buildSheetWorkbook({ rows: p1.rows, header: p1.header, plateColName: cols.plateCol, chegadaColName: cols.chegadaCol, saidaColName: cols.saidaCol, sheetName: "Azambuja" });
    const buf = Buffer.from(b64, "base64");

    // WW formula: ROUND(…,2), not 0.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Azambuja")!;
    const hdr = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const ww = (ws.getCell(2, hdr.indexOf(WW_COL) + 1).value as { formula?: string } | null)?.formula ?? "";
    ok("WW formula rounds to 2 decimals (<5 = under 5 REAL minutes)", ww.endsWith('*1440,2)),"")') && !ww.includes("*1440,0)"), ww);
    const cheL = ws.getColumn(hdr.indexOf("Hora Chegada") + 1).letter;
    const saiL = ws.getColumn(hdr.indexOf("Hora Saida") + 1).letter;
    ok(
      "WW formula takes a hand-edited cell (Excel date serial) as-is, both sides",
      ww.includes(`IF(ISNUMBER($${cheL}2),$${cheL}2,`) && ww.includes(`IF(ISNUMBER($${saiL}2),$${saiL}2,`),
      ww,
    );

    // Re-read exactly like src/app/api/azambuja-sheet/route.ts does.
    const sh = XLSX.read(buf, { type: "buffer" }).Sheets.Azambuja;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, defval: "", blankrows: false });
    const h2 = (aoa[0] as unknown[]).map((x) => String(x).trim());
    const rec2 = XLSX.utils.sheet_to_json<SheetRecord>(sh, { raw: false, defval: "", blankrows: false });
    const raw2 = XLSX.utils.sheet_to_json<SheetRecord>(sh, { raw: true, defval: "", blankrows: false });
    ok("SheetJS reads our cells back as the exact strings", rec2[0]["Hora Chegada"] === "09-09-2026 06:26:14" && raw2[0]["Hora Chegada"] === "09-09-2026 06:26:14", [rec2[0]["Hora Chegada"], raw2[0]["Hora Chegada"]]);

    const cols2 = resolveColumns(h2);
    const p2 = runMatch({ day: SVC, records: rec2, header: h2, cols: cols2, stops: [], platesWithGps: new Set(), pingWindowByPlate: new Map(), rawRecords: raw2 });
    for (let i = 0; i < 3; i++) {
      ok(
        `pass 2 row ${i + 1}: KEPT with Chegada/Saída byte-identical to pass 1`,
        p2.rows[i][CONFIANCA_COL] === KEPT && p2.rows[i]["Hora Chegada"] === p1.rows[i]["Hora Chegada"] && p2.rows[i]["Hora Saida"] === p1.rows[i]["Hora Saida"],
        [p2.rows[i][CONFIANCA_COL], p2.rows[i]["Hora Chegada"], p1.rows[i]["Hora Chegada"], p2.rows[i]["Hora Saida"], p1.rows[i]["Hora Saida"]],
      );
    }
    ok("pass 2: transporter row still HH:MM (no seconds invented on the way round)", p2.rows[2]["Hora Chegada"] === "09-09-2026 10:00");

    // The user edited a Chegada in Excel -> Excel stored a date serial.
    const raw3 = raw2.map((r) => ({ ...r }));
    const rec3 = rec2.map((r) => ({ ...r }));
    raw3[0]["Hora Chegada"] = serialOf(2026, 9, 9, 6, 27, 45);
    rec3[0]["Hora Chegada"] = "09/09/2026 06:27"; // what a raw:false display would show
    const p3 = runMatch({ day: SVC, records: rec3, header: h2, cols: cols2, stops: [], platesWithGps: new Set(), pingWindowByPlate: new Map(), rawRecords: raw3 });
    ok("pass 3: a cell Excel turned into a serial keeps its seconds", p3.rows[0]["Hora Chegada"] === "09-09-2026 06:27:45" && p3.rows[0][CONFIANCA_COL] === KEPT, [p3.rows[0]["Hora Chegada"], p3.rows[0][CONFIANCA_COL]]);
  }

  // ---------------------------------------------------------------------------
  // Colour-matrix workbook for the MANUAL check in real Excel (see the COM
  // script used on 2026-09-23). One row per rule / edge case; column L holds
  // the expected colour name so the check reads it straight off the sheet.
  {
    const hdr = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "TIPO", "Dia Serviço", "Hora Chegada", "Hora Saida", CONFIANCA_COL, REAL_COL, "ESPERADO"];
    const row = (o: Partial<SheetRecord>): SheetRecord => ({
      ROTA: "R", N_LOJA: "7001", NOME: "Loja", MATRICULA: "AD-90-DE", TIPO: "C", "Dia Serviço": SVC,
      "Hora Chegada": "", "Hora Saida": "", [CONFIANCA_COL]: "OK", [REAL_COL]: "", [VV_COL]: "AD90DE", ESPERADO: "", ...o,
    });
    const rows = [
      row({ "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 07:09:03", ESPERADO: "nenhuma|42.82" }),
      row({ "Hora Chegada": "09-09-2026 06:26:50", "Hora Saida": "09-09-2026 06:31:10", ESPERADO: "roxo|4.33" }),
      row({ "Hora Chegada": "09-09-2026 06:00:00", "Hora Saida": "09-09-2026 06:04:59", ESPERADO: "roxo|4.98" }),
      row({ "Hora Chegada": "09-09-2026 06:00:07", "Hora Saida": "09-09-2026 06:05:07", ESPERADO: "nenhuma|5" }),
      row({ "Hora Chegada": "09-09-2026 06:00:20", "Hora Saida": "09-09-2026 06:05:00", ESPERADO: "roxo|4.67" }),
      row({ "Hora Chegada": "09-09-2026 23:58:30", "Hora Saida": "10-09-2026 00:01:10", ESPERADO: "roxo|2.67" }),
      row({ "Hora Chegada": "09-09-2026 06:26", "Hora Saida": "09-09-2026 06:29", [CONFIANCA_COL]: KEPT, ESPERADO: "roxo|3" }),
      row({ "Hora Chegada": "09-09-2026 06:26:30", "Hora Saida": "09-09-2026 06:29", [CONFIANCA_COL]: KEPT, ESPERADO: "roxo|2.5" }),
      row({ "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 06:28:03", [REAL_COL]: "⚠️ Conflito: sobrepõe-se …", ESPERADO: "cinzento|1.82" }),
      row({ "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 06:28:03", [REAL_COL]: "⚠️ Velocidade implausível …", ESPERADO: "azul|1.82" }),
      row({ "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 06:28:03", [CONFIANCA_COL]: TRACKIT_FALLBACK, ESPERADO: "verde|1.82" }),
      row({ MATRICULA: "AD-90-DF", "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 07:09:03", ESPERADO: "laranja(matricula)|42.82" }),
      row({ [CONFIANCA_COL]: REVIEW, ESPERADO: "ambar|" }),
      row({ "Hora Chegada": "09-09-2026 06:26:14", "Hora Saida": "09-09-2026 07:09:03", ESPERADO: "apagar->ambar|42.82" }),
    ];
    const b64 = await buildSheetWorkbook({ rows, header: hdr, plateColName: "MATRICULA", chegadaColName: "Hora Chegada", saidaColName: "Hora Saida", sheetName: "Azambuja" });
    const out = join(process.env.TEMP || ".", "azambuja-seconds-colors.xlsx");
    writeFileSync(out, Buffer.from(b64, "base64"));
    console.log("wrote", out);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
