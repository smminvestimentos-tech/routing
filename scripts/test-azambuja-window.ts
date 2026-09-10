// Checks for the two Azambuja-sheet safeguards:
//
//   1. stopQueryWindowMs() — the real-stop search window must reach the actual
//      calendar day an overnight CICLO ("20:00-1 | 08:00", "…| …+1") runs on,
//      not just skirt the service day by a fixed margin.
//
//   2. findRotaDayConflicts() — the same ROTA on two different service days in
//      one uploaded file is an anomaly that would corrupt (ROTA, N_LOJA)
//      grouping; it must be reported, not processed silently.
//
//   npm run test:azambuja-window
//
// Runs on synthetic data always; if the real files are present it also checks
// Ficheiro 09-09-2026.xlsx (set AZAMBUJA_RAW_XLSX / AZAMBUJA_CONFERIDO_XLSX to
// override the default Downloads paths).

import * as XLSX from "xlsx";
import { existsSync } from "node:fs";
import {
  cicloSpan,
  parseCiclo,
  groupWindowMs,
  stopQueryWindowMs,
  stopInWindow,
  normalizeDateTimeCell,
  findRotaDayConflicts,
  resolveColumns,
  runMatch,
  REVIEW,
  type DayStop,
  type SheetRecord,
} from "@/lib/azambuja-sheet/match";
import { lisbonEpoch } from "@/lib/sheet-match/common";

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`FAIL   ${name}`, extra ?? "");
  }
}
function skipped(name: string, why: string) {
  skip++;
  console.log(`  ~~   ${name}  (skipped: ${why})`);
}

const lisbon = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

// ---------------------------------------------------------------------------
// cicloSpan
// ---------------------------------------------------------------------------
console.log("== cicloSpan ==");
ok(
  '"20:00-1 | 08:00" -> starts -1 @1200, ends 0 @480',
  JSON.stringify(cicloSpan("20:00-1 | 08:00")) ===
    JSON.stringify({ startOffsetDays: -1, startMin: 1200, endOffsetDays: 0, endMin: 480 }),
  cicloSpan("20:00-1 | 08:00"),
);
ok(
  '"08:00 | 20:00" -> same day both ends',
  JSON.stringify(cicloSpan("08:00 | 20:00")) ===
    JSON.stringify({ startOffsetDays: 0, startMin: 480, endOffsetDays: 0, endMin: 1200 }),
);
ok(
  '"12:30 | 00:30+1" -> ends +1 @30',
  JSON.stringify(cicloSpan("12:30 | 00:30+1")) ===
    JSON.stringify({ startOffsetDays: 0, startMin: 750, endOffsetDays: 1, endMin: 30 }),
);
ok(
  '"20:00 | 08:00" (wrap, no marker) -> treated as starts -1',
  cicloSpan("20:00 | 08:00")?.startOffsetDays === -1,
  cicloSpan("20:00 | 08:00"),
);
ok('"Noturno" -> null', cicloSpan("Noturno") === null);
ok('"Crossdocking peixe" -> null', cicloSpan("Crossdocking peixe") === null);
ok('"" -> null', cicloSpan("") === null);

// parseCiclo behaviour unchanged by the refactor.
console.log("== parseCiclo (regression) ==");
ok('parseCiclo "20:00-1 | 08:00" -> 00:00..08:00', JSON.stringify(parseCiclo("20:00-1 | 08:00")) === JSON.stringify({ ini: "00:00", fim: "08:00" }));
ok('parseCiclo "08:00 | 20:00" -> 08:00..20:00', JSON.stringify(parseCiclo("08:00 | 20:00")) === JSON.stringify({ ini: "08:00", fim: "20:00" }));
ok('parseCiclo "12:30 | 00:30+1" -> 12:30..23:59', JSON.stringify(parseCiclo("12:30 | 00:30+1")) === JSON.stringify({ ini: "12:30", fim: "23:59" }));
ok('parseCiclo "20:00 | 08:00" -> 00:00..08:00', JSON.stringify(parseCiclo("20:00 | 08:00")) === JSON.stringify({ ini: "00:00", fim: "08:00" }));
ok('parseCiclo "Noturno" -> "" ""', JSON.stringify(parseCiclo("Noturno")) === JSON.stringify({ ini: "", fim: "" }));

// ---------------------------------------------------------------------------
// groupWindowMs — the per-CICLO day-aware window.
// ---------------------------------------------------------------------------
console.log("== groupWindowMs (day = 2026-09-09) ==");
const DAY = "2026-09-09";
const H = 3_600_000;

const dayLo = lisbonEpoch(DAY, 0); // 09/09 00:00
const dayHi = lisbonEpoch(DAY, 24 * 60); // 10/09 00:00
const prev2000 = lisbonEpoch("2026-09-08", 20 * 60);
const next0130 = lisbonEpoch("2026-09-10", 90);

// The three real regression cases — free text and same-day windows must stay
// strictly inside the service day (00:00–24:00), never touching 10/09.
for (const c of ["Crossdocking peixe", "02:00 | 14:00", "11:30 | 23:30", "Noturno", ""]) {
  const w = groupWindowMs(DAY, c);
  ok(
    `groupWindowMs(${JSON.stringify(c)}) == strict service day [00:00, 24:00)`,
    w.loMs === dayLo && w.hiMs === dayHi,
    { lo: lisbon(w.loMs), hi: lisbon(w.hiMs) },
  );
}
// …and a stop at 10/09 00:10 / 00:12 / 00:44 is OUTSIDE those windows.
const toIso = (d: string, hhmm: string) =>
  new Date(lisbonEpoch(d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)))).toISOString();
for (const [c, hhmm] of [
  ["Crossdocking peixe", "00:10"],
  ["02:00 | 14:00", "00:12"],
  ["11:30 | 23:30", "00:44"],
] as const) {
  const w = groupWindowMs(DAY, c);
  ok(
    `10/09 ${hhmm} ARRIVAL is OUT of the ${JSON.stringify(c)} window`,
    stopInWindow(toIso("2026-09-10", hhmm), null, w.loMs, w.hiMs) === false,
  );
}

// stopInWindow — a stop that ARRIVES in-day but DEPARTS past midnight (the
// real "…OK with Hora Saída em 10/09" bug) must be rejected for a same-day /
// free-text route.
{
  const w = groupWindowMs(DAY, "Crossdocking peixe"); // strict service day
  ok(
    "stop 09/09 23:04 -> 10/09 00:10 : rejected (departure crosses midnight)",
    stopInWindow(toIso("2026-09-09", "23:04"), toIso("2026-09-10", "00:10"), w.loMs, w.hiMs) === false,
  );
  ok(
    "stop 09/09 23:04 -> 09/09 23:40 : accepted (both ends in-day)",
    stopInWindow(toIso("2026-09-09", "23:04"), toIso("2026-09-09", "23:40"), w.loMs, w.hiMs) === true,
  );
  ok(
    "stop 09/09 23:04 -> (no departure) : accepted on arrival alone",
    stopInWindow(toIso("2026-09-09", "23:04"), null, w.loMs, w.hiMs) === true,
  );
  const wp1 = groupWindowMs(DAY, "13:30 | 01:30+1");
  ok(
    "+1 route: stop 09/09 23:04 -> 10/09 01:00 : accepted (window reaches next day)",
    stopInWindow(toIso("2026-09-09", "23:04"), toIso("2026-09-10", "01:00"), wp1.loMs, wp1.hiMs) === true,
  );
}

// Only an explicit -1 / +1 widens past the service day.
const wm1 = groupWindowMs(DAY, "20:00-1 | 08:00");
ok(
  '"20:00-1 | 08:00": lo = 08/09 17:00 (start − 3h); hi stays at end of service day',
  wm1.loMs === prev2000 - 3 * H && wm1.hiMs === dayHi,
  { lo: lisbon(wm1.loMs), hi: lisbon(wm1.hiMs) },
);
const wm1b = groupWindowMs(DAY, "18:00-1 | 06:00");
ok('"18:00-1 | 06:00": lo = 08/09 15:00', wm1b.loMs === lisbonEpoch("2026-09-08", 18 * 60) - 3 * H && wm1b.hiMs === dayHi);
const wp1 = groupWindowMs(DAY, "13:30 | 01:30+1");
ok(
  '"13:30 | 01:30+1": hi = 10/09 04:30 (end + 3h); lo stays at start of service day',
  wp1.loMs === dayLo && wp1.hiMs === next0130 + 3 * H,
  { lo: lisbon(wp1.loMs), hi: lisbon(wp1.hiMs) },
);

// ---------------------------------------------------------------------------
// stopQueryWindowMs — union of every row's groupWindowMs, NO blanket skirt.
// ---------------------------------------------------------------------------
console.log("== stopQueryWindowMs ==");
const wEmpty = stopQueryWindowMs(DAY, []);
ok("no CICLOs: window == strict service day (no ±skirt any more)", wEmpty.loMs === dayLo && wEmpty.hiMs === dayHi, { lo: lisbon(wEmpty.loMs), hi: lisbon(wEmpty.hiMs) });

const wFree = stopQueryWindowMs(DAY, ["08:00 | 20:00", "Noturno", "Crossdocking peixe", "02:00 | 14:00", "11:30 | 23:30", ""]);
ok(
  "REGRESSION: only same-day / free-text CICLOs -> window is EXACTLY the service day, never 10/09",
  wFree.loMs === dayLo && wFree.hiMs === dayHi,
  { lo: lisbon(wFree.loMs), hi: lisbon(wFree.hiMs) },
);

const wMixed = stopQueryWindowMs(DAY, ["08:00 | 20:00", "22:00-1 | 10:00", "13:30 | 01:30+1"]);
ok(
  "mixed file: lo from the earliest -1, hi from the latest +1",
  wMixed.loMs === lisbonEpoch("2026-09-08", 22 * 60) - 3 * H && wMixed.hiMs === next0130 + 3 * H,
  { lo: lisbon(wMixed.loMs), hi: lisbon(wMixed.hiMs) },
);

// ---------------------------------------------------------------------------
// findRotaDayConflicts
// ---------------------------------------------------------------------------
console.log("== findRotaDayConflicts ==");
const mkRow = (rota: string, dia: string): SheetRecord => ({
  ROTA: rota,
  N_LOJA: "7001",
  "Dia Serviço": dia,
});
ok(
  "same ROTA on two days -> reported",
  JSON.stringify(
    findRotaDayConflicts(
      [mkRow("185787179", "2026-09-09"), mkRow("185787179", "2026-09-08"), mkRow("185787181", "2026-09-09")],
      "ROTA",
      "Dia Serviço",
    ),
  ) === JSON.stringify([{ rota: "185787179", days: ["2026-09-08", "2026-09-09"] }]),
);
ok(
  "each ROTA one day -> nothing",
  findRotaDayConflicts(
    [mkRow("R1", "2026-09-09"), mkRow("R2", "2026-09-09"), mkRow("R1", "2026-09-09")],
    "ROTA",
    "Dia Serviço",
  ).length === 0,
);
ok(
  "no Dia Serviço column -> nothing (raw file is one day by construction)",
  findRotaDayConflicts([mkRow("R1", "2026-09-09"), mkRow("R1", "2026-09-08")], "ROTA", null).length === 0,
);

// ---------------------------------------------------------------------------
// Real files (optional)
// ---------------------------------------------------------------------------
console.log("== real Ficheiro 09-09-2026.xlsx ==");
const RAW = process.env.AZAMBUJA_RAW_XLSX || "C:/Users/TFS/Downloads/Ficheiro 09-09-2026.xlsx";
const CONF = process.env.AZAMBUJA_CONFERIDO_XLSX || "C:/Users/TFS/Downloads/azambuja-2026-09-09-conferido (4).xlsx";

function readRows(path: string): { header: string[]; rows: SheetRecord[] } | null {
  if (!existsSync(path)) return null;
  const wb = XLSX.readFile(path, { raw: false, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h).trim());
  const rows = XLSX.utils.sheet_to_json<SheetRecord>(ws, { defval: "", blankrows: false });
  return { header, rows };
}

const raw = readRows(RAW);
if (!raw) {
  skipped("real raw file checks", `${RAW} not found`);
} else {
  const cols = resolveColumns(raw.header);
  const ciclos = raw.rows.map((r) => r[cols.cicloCol!]);
  const win = stopQueryWindowMs("2026-09-09", ciclos);
  console.log(`     file window: ${lisbon(win.loMs)}  ..  ${lisbon(win.hiMs)}`);
  ok(
    "real: file window reaches back to ≤ 08/09 20:00 (has 20:00-1 shifts)",
    win.loMs <= prev2000,
    lisbon(win.loMs),
  );
  // Per-CICLO: the free-text / same-day rows stay strictly inside the service
  // day even though the file as a whole has -1 / +1 rows widening the fetch.
  const strictCiclos = ["Crossdocking peixe", "02:00 | 14:00", "11:30 | 23:30"];
  const present = strictCiclos.filter((c) => ciclos.some((x) => String(x).trim() === c));
  console.log(`     free-text / same-day CICLOs present in the file: ${present.join(" · ") || "(none)"}`);
  ok(
    "real: every free-text / same-day CICLO in the file -> group window is exactly the service day",
    [...new Set(ciclos.map((c) => String(c).trim()))]
      .filter((c) => !cicloSpan(c) || (cicloSpan(c)!.startOffsetDays === 0 && cicloSpan(c)!.endOffsetDays === 0))
      .every((c) => {
        const w = groupWindowMs("2026-09-09", c);
        return w.loMs === dayLo && w.hiMs === dayHi;
      }),
  );
  ok(
    "real: the reported cases — a stop arriving 09/09 23:0x and departing 10/09 00:1x is rejected",
    (["Crossdocking peixe", "02:00 | 14:00", "11:30 | 23:30"] as const).every((c, i) => {
      const w = groupWindowMs("2026-09-09", c);
      const arr = new Date(lisbonEpoch("2026-09-09", 23 * 60 + 4)).toISOString();
      const dep = new Date(lisbonEpoch("2026-09-10", [10, 12, 44][i])).toISOString();
      return stopInWindow(arr, dep, w.loMs, w.hiMs) === false;
    }),
  );
  ok(
    "real: raw file has no «Dia Serviço» column -> no ROTA/day conflict possible",
    cols.diaCol === null &&
      findRotaDayConflicts(raw.rows, cols.rotaCol, cols.diaCol).length === 0,
  );
  ok(
    "real: every ROTA is a single service day within the file (trivially — one day)",
    findRotaDayConflicts(
      raw.rows.map((r) => ({ ...r, "Dia Serviço": "2026-09-09" })),
      cols.rotaCol,
      "Dia Serviço",
    ).length === 0,
  );
}

const conf = readRows(CONF);
if (!conf) {
  skipped("real conferido concat check", `${CONF} not found`);
} else {
  const cols = resolveColumns(conf.header);
  ok("real conferido: has a «Dia Serviço» column", cols.diaCol !== null, conf.header.join(" | "));
  const clean = findRotaDayConflicts(conf.rows, cols.rotaCol, cols.diaCol);
  ok("real conferido as-is: no ROTA/day conflict", clean.length === 0, clean.slice(0, 3));

  // Simulate someone pasting a second day's rows in: re-date the first 30 rows
  // (spanning several ROTAs) onto 09/08.
  const poisoned = [
    ...conf.rows,
    ...conf.rows.slice(0, 30).map((r) => ({ ...r, [cols.diaCol!]: "2026-09-08" })),
  ];
  const conflicts = findRotaDayConflicts(poisoned, cols.rotaCol, cols.diaCol);
  const affectedRotas = new Set(
    conf.rows.slice(0, 30).map((r) => String(r[cols.rotaCol]).trim()),
  );
  ok(
    "real conferido + first 30 rows re-dated to 09/08: every affected ROTA reported",
    conflicts.length === affectedRotas.size &&
      conflicts.every((c) => c.days.join(",") === "2026-09-08,2026-09-09"),
    { got: conflicts.length, expected: affectedRotas.size, sample: conflicts.slice(0, 3) },
  );
}

// ---------------------------------------------------------------------------
// End-to-end: the matcher must not assign a next-day stop to a same-day /
// free-text route, even when the stop is in the fetched pool.
// ---------------------------------------------------------------------------
console.log("== runMatch: next-day stop rejected for same-day / free-text route ==");
{
  const iso = (d: string, hhmm: string) => `2026-09-${d}T${hhmm}:00+01:00`;
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const mk = (rota: string, loja: string, ciclo: string): SheetRecord => ({
    ROTA: rota, N_LOJA: loja, NOME: loja, MATRICULA: "AA-11-BB",
    "Hora Chegada": "", "Hora Saida": "", CICLO: ciclo, TIPO: "C",
  });
  const records = [
    mk("R-CROSS", "7003", "Crossdocking peixe"),   // free text
    mk("R-SAMEDAY", "7005", "02:00 | 14:00"),      // same day
    mk("R-PLUS1", "7009", "13:30 | 01:30+1"),      // +1 -> reaches next day
  ];
  const cols = resolveColumns(azHeader);
  const stops: DayStop[] = [
    // The real bug shape: arrives IN-DAY, departs after midnight.
    { id: "s1", vehicleId: 1, plate: "AA11BB", code: "7003", arrivedAt: iso("09", "23:04"), departedAt: iso("10", "00:10") },
    { id: "s2", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso("09", "23:24"), departedAt: iso("10", "00:12") },
    // a legit fully-in-day stop for the same-day route, later in the sort order
    { id: "s2b", vehicleId: 1, plate: "AA11BB", code: "7005", arrivedAt: iso("09", "23:59"), departedAt: iso("09", "23:59") },
    // legit next-day stop for the +1 route
    { id: "s3", vehicleId: 1, plate: "AA11BB", code: "7009", arrivedAt: iso("09", "23:50"), departedAt: iso("10", "01:00") },
  ];
  const res = runMatch({
    day: "2026-09-09", records, header: azHeader, cols, stops,
    platesWithGps: new Set(["AA11BB"]),
    pingWindowByPlate: new Map([["AA11BB", { min: Date.parse(iso("09", "00:00")), max: Date.parse(iso("10", "02:00")) }]]),
  });
  const byLoja = Object.fromEntries(res.rows.map((r) => [String(r["N_LOJA"]), r]));
  ok(
    "Crossdocking peixe row: 23:04->00:10 stop NOT matched (departs 10/09) -> Rever",
    byLoja["7003"]["Hora Saida"] === "" && byLoja["7003"]["Confiança"] === REVIEW,
    { ch: byLoja["7003"]["Hora Chegada"], sa: byLoja["7003"]["Hora Saida"], conf: byLoja["7003"]["Confiança"] },
  );
  ok(
    '"02:00 | 14:00" row: skips the midnight-crossing stop, takes the 23:59 in-day one',
    byLoja["7005"]["Confiança"] === "OK" && String(byLoja["7005"]["Hora Chegada"]).includes("09/09/2026 23:59"),
    byLoja["7005"]["Hora Chegada"],
  );
  ok(
    '"13:30 | 01:30+1" row: DOES match its 23:50 -> 10/09 01:00 stop (explicit +1)',
    byLoja["7009"]["Confiança"] === "OK" && String(byLoja["7009"]["Hora Saida"]).includes("10/09/2026 01:00"),
    byLoja["7009"]["Hora Saida"],
  );
}

// ---------------------------------------------------------------------------
// normalizeDateTimeCell — kept rows re-rendered as DD/MM/YYYY HH:MM.
// ---------------------------------------------------------------------------
console.log("== normalizeDateTimeCell ==");
const SVC = "2026-09-09";
// Excel serial for 2026-09-08 00:12 (days since 1899-12-30).
const serial0812 = (Date.UTC(2026, 8, 8, 0, 12) - Date.UTC(1899, 11, 30)) / 86_400_000;
ok("Excel serial -> DD/MM/YYYY HH:MM", normalizeDateTimeCell("9/8/26 0:12", serial0812, SVC) === "08/09/2026 00:12", normalizeDateTimeCell("9/8/26 0:12", serial0812, SVC));
ok("our own format is left as-is", normalizeDateTimeCell("09/09/2026 06:26", "09/09/2026 06:26", SVC) === "09/09/2026 06:26");
ok("DD/MM/YY string (no serial) -> full year", normalizeDateTimeCell("08/09/26 07:09", "08/09/26 07:09", SVC) === "08/09/2026 07:09");
ok("D/M/YYYY without time -> 00:00", normalizeDateTimeCell("8/9/2026", "8/9/2026", SVC) === "08/09/2026 00:00");
ok("HH:MM alone -> attach service day", normalizeDateTimeCell("06:26", "06:26", SVC) === "09/09/2026 06:26");
ok("12h clock with PM", normalizeDateTimeCell("09/09/2026 1:05 PM", "09/09/2026 1:05 PM", SVC) === "09/09/2026 13:05");
ok("empty -> empty", normalizeDateTimeCell("", "", SVC) === "");
ok("unparseable -> unchanged", normalizeDateTimeCell("mais ou menos agora", "mais ou menos agora", SVC) === "mais ou menos agora");

// End-to-end: a kept row's messy date is uniformised.
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO", "Dia Serviço"];
  const records: SheetRecord[] = [
    { ROTA: "R1", N_LOJA: "7001", NOME: "x", MATRICULA: "AA-11-BB", "Hora Chegada": "9/8/26 0:12", "Hora Saida": "9/8/26 1:30", CICLO: "Noturno", TIPO: "C", "Dia Serviço": "" },
  ];
  const rawRecords: SheetRecord[] = [
    { ROTA: "R1", N_LOJA: "7001", NOME: "x", MATRICULA: "AA-11-BB",
      "Hora Chegada": (Date.UTC(2026, 8, 8, 0, 12) - Date.UTC(1899, 11, 30)) / 86_400_000,
      "Hora Saida": (Date.UTC(2026, 8, 8, 1, 30) - Date.UTC(1899, 11, 30)) / 86_400_000,
      CICLO: "Noturno", TIPO: "C", "Dia Serviço": "" },
  ];
  const cols = resolveColumns(azHeader);
  const res = runMatch({
    day: "2026-09-09", records, rawRecords, header: azHeader, cols, stops: [],
    platesWithGps: new Set(), pingWindowByPlate: new Map(),
  });
  const r = res.rows[0];
  ok("kept row: Confiança = mantido", String(r["Confiança"]).includes("mantido"));
  ok("kept row: Chegada re-rendered DD/MM/YYYY", r["Hora Chegada"] === "08/09/2026 00:12", r["Hora Chegada"]);
  ok("kept row: Saida re-rendered DD/MM/YYYY", r["Hora Saida"] === "08/09/2026 01:30", r["Hora Saida"]);
  ok("kept row: MATRICULA untouched", r["MATRICULA"] === "AA-11-BB");
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
