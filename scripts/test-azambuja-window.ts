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
  stopQueryWindowMs,
  findRotaDayConflicts,
  resolveColumns,
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
// stopQueryWindowMs
// ---------------------------------------------------------------------------
console.log("== stopQueryWindowMs (day = 2026-09-09) ==");
const DAY = "2026-09-09";
const H = 3_600_000;

// Reference instants.
const prev2000 = lisbonEpoch("2026-09-08", 20 * 60); // 08/09 20:00
const prev1800 = lisbonEpoch("2026-09-08", 18 * 60);
const next0130 = lisbonEpoch("2026-09-10", 90); // 10/09 01:30
const skirtOnly = stopQueryWindowMs(DAY, []);

ok(
  "no CICLOs: lo = 08/09 20:00 exactly (the 4h skirt = 4h before midnight)",
  skirtOnly.loMs === prev2000,
  lisbon(skirtOnly.loMs),
);
ok(
  "no CICLOs: hi = 10/09 04:00 exactly",
  skirtOnly.hiMs === lisbonEpoch("2026-09-10", 4 * 60),
  lisbon(skirtOnly.hiMs),
);

const w2000 = stopQueryWindowMs(DAY, ["20:00-1 | 08:00"]);
ok(
  '"20:00-1 | 08:00": search starts at/ before 08/09 20:00 (includes the evening start)',
  w2000.loMs <= prev2000,
  lisbon(w2000.loMs),
);
ok(
  '"20:00-1 | 08:00": lo = 08/09 17:00 (shift start − 3h pad), 3h earlier than the bare skirt',
  w2000.loMs === prev2000 - 3 * H,
  lisbon(w2000.loMs),
);

const w1800 = stopQueryWindowMs(DAY, ["18:00-1 | 06:00"]);
ok(
  '"18:00-1 | 06:00": lo = 08/09 15:00 — reaches the real shift day, NOT clipped by the 4h skirt',
  w1800.loMs === prev1800 - 3 * H && w1800.loMs < skirtOnly.loMs,
  { lo: lisbon(w1800.loMs), skirt: lisbon(skirtOnly.loMs) },
);

const wPlus1 = stopQueryWindowMs(DAY, ["13:30 | 01:30+1"]);
ok(
  '"13:30 | 01:30+1": hi reaches 10/09 01:30 + 3h pad',
  wPlus1.hiMs === next0130 + 3 * H && wPlus1.hiMs > skirtOnly.hiMs,
  lisbon(wPlus1.hiMs),
);

const wPlain = stopQueryWindowMs(DAY, ["08:00 | 20:00", "Noturno", "Crossdocking peixe", ""]);
ok(
  "plain / free-text CICLOs only: window == the bare ±4h skirt (no regression)",
  wPlain.loMs === skirtOnly.loMs && wPlain.hiMs === skirtOnly.hiMs,
);

const wMixed = stopQueryWindowMs(DAY, ["08:00 | 20:00", "22:00-1 | 10:00", "13:30 | 01:30+1"]);
ok(
  "mixed file: lo from the earliest -1 start, hi from the latest +1 end",
  wMixed.loMs === lisbonEpoch("2026-09-08", 22 * 60) - 3 * H &&
    wMixed.hiMs === next0130 + 3 * H,
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
  console.log(`     window: ${lisbon(win.loMs)}  ..  ${lisbon(win.hiMs)}`);
  console.log(
    `     distinct overnight starts: ${[
      ...new Set(
        ciclos
          .map((c) => cicloSpan(c))
          .filter((s): s is NonNullable<typeof s> => !!s && s.startOffsetDays < 0)
          .map((s) => `${Math.floor(s.startMin / 60)}:${String(s.startMin % 60).padStart(2, "0")}-1`),
      ),
    ].join(", ")}`,
  );
  ok(
    "real: search window reaches back to at least 08/09 20:00 (covers the 20:00-1 shifts)",
    win.loMs <= prev2000,
    lisbon(win.loMs),
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

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
