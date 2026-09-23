// Synthetic + real-data checks for the TRACKiT /vehicleTravels fallback
// (src/lib/sheet-match/trackit-candidates.ts, trackit-fallback.ts, and the
// Step 4 leftover wiring in both matchers).
//
//   npm run test:trackit-fallback
//
// Pure — no network, no DB. Covers, in order: the ported match_stop_location
// algorithm, candidate derivation (gap duration + signal-loss guard),
// overlap-with-real-stops exclusion, the shared outcome/notes logic, both
// matchers' runMatch() wiring (including the "unicidade nos dois sentidos"
// and skip-reason cases), a DST regression, and one real data point from
// this investigation's BG-96-ID/2026-09-21 run
// (scripts/compare-location-candidates.ts).

import {
  resolveColumns as resolveAzColumns,
  runMatch as runAzMatch,
} from "@/lib/azambuja-sheet/match";
import {
  resolveColumns as resolveTfsColumns,
  runMatch as runTfsMatch,
} from "@/lib/tfs-sheet/match";
import {
  REVIEW,
  TRACKIT_FALLBACK,
  lisbonEpoch,
  type CoLocatedGroups,
  type DayStop,
  type SheetRecord,
  type TrackitSkipReason,
  type WStop,
} from "@/lib/sheet-match/common";
import {
  applyTrackitOutcome,
  deriveTravelDayStops,
  excludeOverlappingRealStops,
  matchStopLocationTs,
  tryTrackitFallback,
  type LocationForMatch,
  type RawTravel,
  type TrackitCandidateMap,
} from "@/lib/sheet-match/trackit-candidates";

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

const NO_GROUPS: CoLocatedGroups = [];

// ---------------------------------------------------------------------------
console.log("== matchStopLocationTs ==");
{
  const locA: LocationForMatch = {
    id: "loc-A",
    code: "A",
    latitude: 38.9,
    longitude: -8.97,
    radius_meters: 30,
    active: true,
  };
  // ~60m north of A (0.00054deg lat) — same shape as the real 7001/7005 pair
  // post-migration-0040 (both 30m, touching but not overlapping).
  const locB: LocationForMatch = { ...locA, id: "loc-B", code: "B", latitude: 38.90054 };
  const locs = [locA, locB];

  const atA = matchStopLocationTs([{ lat: 38.9, lng: -8.97 }], 38.9, -8.97, locs);
  ok("point at A's centre matches A only (B is ~60m away, radius 30m)", atA?.code === "A", atA);

  // Midpoint sits ~30m from each (real haversine distance, not the naive
  // lat-delta estimate) — with a 31m radius both circles contain it, so count
  // ties 1-1 and the tie is broken by distance to the supplied centroid
  // (here: A's own coords).
  const locA31: LocationForMatch = { ...locA, radius_meters: 31 };
  const locB31: LocationForMatch = { ...locB, radius_meters: 31 };
  const midLat = (locA.latitude + locB.latitude) / 2;
  const tie = matchStopLocationTs([{ lat: midLat, lng: -8.97 }], locA.latitude, locA.longitude, [locA31, locB31]);
  ok("boundary point (tied count) broken by centroid distance -> nearer wins", tie?.code === "A", tie);

  const far = matchStopLocationTs([{ lat: 39.5, lng: -8.97 }], 39.5, -8.97, locs);
  ok("point far from any circle -> null", far === null, far);

  const inactive: LocationForMatch = { ...locA, id: "loc-A-inactive", active: false };
  const inactiveOnly = matchStopLocationTs([{ lat: 38.9, lng: -8.97 }], 38.9, -8.97, [inactive]);
  ok("inactive location never matches even when geometrically inside", inactiveOnly === null, inactiveOnly);
}

// ---------------------------------------------------------------------------
console.log("\n== deriveTravelDayStops ==");
{
  const locA: LocationForMatch = {
    id: "loc-A",
    code: "7005",
    latitude: 38.9,
    longitude: -8.97,
    radius_meters: 30,
    active: true,
  };
  const locB: LocationForMatch = { ...locA, id: "loc-B", code: "7001", latitude: 38.93 }; // far away, distinct
  const locs = [locA, locB];
  const pt = (tsUTC: string, lat: number, lng: number) => ({ timestampUTC: tsUTC, lat, lng });

  // same-location gap, 35min -> emitted
  const sameLoc: RawTravel[] = [
    { ini: pt("2026-09-21 03:00:00", 38.95, -8.97), end: pt("2026-09-21 03:35:00", locA.latitude, locA.longitude) },
    { ini: pt("2026-09-21 04:10:00", locA.latitude, locA.longitude), end: pt("2026-09-21 04:40:00", 38.95, -8.97) },
  ];
  const out1 = deriveTravelDayStops(sameLoc, 999, "AA11BB", locs);
  ok("same-location gap (35min) -> exactly 1 candidate", out1.length === 1, out1);
  ok(
    "candidate carries the right code/vehicle/plate/times, starts unassigned",
    out1[0]?.code === "7005" &&
      out1[0]?.vehicleId === 999 &&
      out1[0]?.plate === "AA11BB" &&
      out1[0]?.arrivedAt === "2026-09-21T03:35:00.000Z" &&
      out1[0]?.departedAt === "2026-09-21T04:10:00.000Z" &&
      out1[0]?.assigned === false,
    out1[0],
  );

  // different-location gap (signal-loss shape) -> dropped
  const diffLoc: RawTravel[] = [
    { ini: pt("2026-09-21 03:00:00", 38.95, -8.97), end: pt("2026-09-21 03:35:00", locA.latitude, locA.longitude) },
    { ini: pt("2026-09-21 04:10:00", locB.latitude, locB.longitude), end: pt("2026-09-21 04:40:00", 38.95, -8.97) },
  ];
  ok(
    "gap whose two ends resolve to DIFFERENT locations -> no candidate",
    deriveTravelDayStops(diffLoc, 999, "AA11BB", locs).length === 0,
  );

  // too-short gap (30s, under MIN_GAP_MINUTES) -> dropped
  const tooShort: RawTravel[] = [
    { ini: pt("2026-09-21 03:00:00", 38.95, -8.97), end: pt("2026-09-21 03:35:00", locA.latitude, locA.longitude) },
    { ini: pt("2026-09-21 03:35:30", locA.latitude, locA.longitude), end: pt("2026-09-21 04:40:00", 38.95, -8.97) },
  ];
  ok(
    "gap under MIN_GAP_MINUTES (30s) -> no candidate",
    deriveTravelDayStops(tooShort, 999, "AA11BB", locs).length === 0,
  );

  // one end unresolved (far from every circle) -> dropped
  const unresolved: RawTravel[] = [
    { ini: pt("2026-09-21 03:00:00", 38.95, -8.97), end: pt("2026-09-21 03:35:00", locA.latitude, locA.longitude) },
    { ini: pt("2026-09-21 04:10:00", 39.5, -8.97), end: pt("2026-09-21 04:40:00", 38.95, -8.97) },
  ];
  ok(
    "gap whose departure point matches NO location -> no candidate",
    deriveTravelDayStops(unresolved, 999, "AA11BB", locs).length === 0,
  );
}

// ---------------------------------------------------------------------------
console.log("\n== excludeOverlappingRealStops ==");
{
  const mkW = (id: string, arr: string, dep: string | null): WStop => ({
    id,
    vehicleId: 1,
    plate: "AA11BB",
    code: "X",
    arrivedAt: arr,
    departedAt: dep,
    assigned: false,
  });

  const real: DayStop[] = [
    { id: "real1", vehicleId: 1, plate: "AA11BB", code: "7001", arrivedAt: "2026-09-21T03:00:00.000Z", departedAt: "2026-09-21T03:30:00.000Z" },
  ];
  const overlapping = mkW("cand1", "2026-09-21T03:10:00.000Z", "2026-09-21T03:20:00.000Z"); // inside real
  const touching = mkW("cand2", "2026-09-21T03:30:00.000Z", "2026-09-21T03:40:00.000Z"); // starts exactly when real ends
  const distinct = mkW("cand3", "2026-09-21T05:00:00.000Z", "2026-09-21T05:10:00.000Z");

  const kept = excludeOverlappingRealStops([overlapping, touching, distinct], real);
  ok("candidate fully inside a real stop's interval -> excluded", !kept.some((c) => c.id === "cand1"), kept);
  ok("candidate touching (not overlapping) a real stop's boundary -> kept", kept.some((c) => c.id === "cand2"), kept);
  ok("candidate well outside any real stop -> kept", kept.some((c) => c.id === "cand3"), kept);

  // OPEN real stop (departedAt null) assumed OPEN_STOP_ASSUMED_MS (2h) long.
  const openReal: DayStop[] = [
    { id: "real2", vehicleId: 1, plate: "AA11BB", code: "7091", arrivedAt: "2026-09-21T10:00:00.000Z", departedAt: null },
  ];
  const within2h = mkW("cand4", "2026-09-21T11:00:00.000Z", "2026-09-21T11:10:00.000Z");
  const past2h = mkW("cand5", "2026-09-21T12:30:00.000Z", "2026-09-21T12:40:00.000Z");
  const kept2 = excludeOverlappingRealStops([within2h, past2h], openReal);
  ok("candidate inside an OPEN real stop's assumed 2h window -> excluded", !kept2.some((c) => c.id === "cand4"), kept2);
  ok("candidate past an OPEN real stop's assumed 2h window -> kept", kept2.some((c) => c.id === "cand5"), kept2);
}

// ---------------------------------------------------------------------------
console.log("\n== tryTrackitFallback / applyTrackitOutcome ==");
{
  const mk = (id: string, code: string, arr: string, dep: string): WStop => ({
    id,
    vehicleId: 1,
    plate: "AA11BB",
    code,
    arrivedAt: arr,
    departedAt: dep,
    assigned: false,
  });
  const alwaysFits = () => true;

  ok(
    "no map at all -> not-attempted",
    tryTrackitFallback("AA11BB", "7005", alwaysFits, undefined, NO_GROUPS).kind === "not-attempted",
  );
  ok(
    "plate absent from map -> not-attempted",
    tryTrackitFallback("AA11BB", "7005", alwaysFits, new Map(), NO_GROUPS).kind === "not-attempted",
  );

  const skipReason: TrackitSkipReason = { skipped: "cap" };
  const mapSkip: TrackitCandidateMap = new Map([["AA11BB", skipReason]]);
  const oSkip = tryTrackitFallback("AA11BB", "7005", alwaysFits, mapSkip, NO_GROUPS);
  ok("skip-reason entry -> skipped(cap)", oSkip.kind === "skipped" && oSkip.reason === "cap", oSkip);

  const mapNoMatch: TrackitCandidateMap = new Map([
    ["AA11BB", [mk("c1", "9999", "2026-09-21T03:00:00.000Z", "2026-09-21T03:10:00.000Z")]],
  ]);
  ok(
    "candidates present but none match the code -> no-match",
    tryTrackitFallback("AA11BB", "7005", alwaysFits, mapNoMatch, NO_GROUPS).kind === "no-match",
  );

  const cand = mk("c2", "7005", "2026-09-21T03:00:00.000Z", "2026-09-21T03:10:00.000Z");
  const mapOne: TrackitCandidateMap = new Map([["AA11BB", [cand]]]);
  const resolved = tryTrackitFallback("AA11BB", "7005", alwaysFits, mapOne, NO_GROUPS);
  ok("exactly one match -> resolved", resolved.kind === "resolved" && resolved.stop.id === "c2", resolved);
  ok("resolved candidate is mutated to assigned=true", cand.assigned === true, cand);

  const claimed = tryTrackitFallback("AA11BB", "7005", alwaysFits, mapOne, NO_GROUPS);
  ok("re-querying the same (now-assigned) candidate -> claimed", claimed.kind === "claimed", claimed);

  const candA = mk("c3", "7005", "2026-09-21T05:00:00.000Z", "2026-09-21T05:10:00.000Z");
  const candB = mk("c4", "7005", "2026-09-21T05:20:00.000Z", "2026-09-21T05:30:00.000Z");
  const mapTwo: TrackitCandidateMap = new Map([["AA11BB", [candA, candB]]]);
  const ambiguous = tryTrackitFallback("AA11BB", "7005", alwaysFits, mapTwo, NO_GROUPS);
  ok("two unassigned candidates match -> ambiguous", ambiguous.kind === "ambiguous", ambiguous);
  ok(
    "ambiguous outcome mutates neither candidate",
    candA.assigned === false && candB.assigned === false,
    [candA, candB],
  );

  const appliedSkip = applyTrackitOutcome({ kind: "skipped", reason: "deadline" }, "base note.");
  ok(
    "skipped note is APPENDED to the base note, not replacing it",
    appliedSkip.note ===
      "base note. TRACKiT não consultado — tempo esgotado antes de chegar a esta matrícula." &&
      appliedSkip.conf === REVIEW,
    appliedSkip,
  );

  const appliedResolved = applyTrackitOutcome({ kind: "resolved", stop: cand }, "");
  ok(
    "resolved outcome -> TRACKIT_FALLBACK conf, stop carried through",
    appliedResolved.conf === TRACKIT_FALLBACK && appliedResolved.stop === cand,
    appliedResolved,
  );
}

// ---------------------------------------------------------------------------
console.log("\n== runMatch (Azambuja) — TRACKiT fallback integration ==");
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const cols = resolveAzColumns(azHeader);
  const mkRow = (rota: string, code: string): SheetRecord => ({
    ROTA: rota,
    N_LOJA: code,
    NOME: code,
    MATRICULA: "AA-11-BB",
    "Hora Chegada": "",
    "Hora Saida": "",
    CICLO: "08:00 | 20:00",
    TIPO: "C",
  });
  const DAY = "2026-09-21";
  const plate = "AA11BB";
  const pingSpan = { min: Date.parse("2026-09-21T00:00:00Z"), max: Date.parse("2026-09-21T23:59:00Z") };

  // --- match único -----------------------------------------------------
  {
    const baseArgs = {
      day: DAY,
      records: [mkRow("R1", "9001")],
      header: azHeader,
      cols,
      stops: [],
      platesWithGps: new Set([plate]),
      pingWindowByPlate: new Map([[plate, pingSpan]]),
    };
    const pass1 = runAzMatch(baseArgs);
    ok("pass1 (no trackitStopsByPlate): row is REVIEW", pass1.rows[0]["Confiança"] === REVIEW, pass1.rows[0]);
    ok(
      "pass1: pendingTrackitPlates includes the plate",
      pass1.pendingTrackitPlates.includes(plate),
      pass1.pendingTrackitPlates,
    );

    const cand: WStop = {
      id: "trackit:1:0",
      vehicleId: 1,
      plate,
      code: "9001",
      arrivedAt: "2026-09-21T10:00:00.000Z",
      departedAt: "2026-09-21T10:20:00.000Z",
      assigned: false,
    };
    const trackitStopsByPlate: TrackitCandidateMap = new Map([[plate, [cand]]]);
    const pass2 = runAzMatch({ ...baseArgs, trackitStopsByPlate });
    ok("pass2: row resolves to TRACKIT_FALLBACK", pass2.rows[0]["Confiança"] === TRACKIT_FALLBACK, pass2.rows[0]);
    ok("pass2: Real note mentions TRACKiT", String(pass2.rows[0]["Real"]).includes("TRACKiT"), pass2.rows[0]["Real"]);
    ok("pass2: summary.trackitFallback === 1", pass2.summary.trackitFallback === 1, pass2.summary);
    ok(
      "pass2: pendingTrackitPlates now empty (resolved, no longer pending)",
      pass2.pendingTrackitPlates.length === 0,
      pass2.pendingTrackitPlates,
    );
  }

  // --- unicidade nos dois sentidos: 2 groups (diff ROTA, same code), 1 candidate
  {
    const baseArgs = {
      day: DAY,
      records: [mkRow("R1", "9001"), mkRow("R2", "9001")],
      header: azHeader,
      cols,
      stops: [],
      platesWithGps: new Set([plate]),
      pingWindowByPlate: new Map([[plate, pingSpan]]),
    };
    const cand: WStop = {
      id: "trackit:1:1",
      vehicleId: 1,
      plate,
      code: "9001",
      arrivedAt: "2026-09-21T10:00:00.000Z",
      departedAt: "2026-09-21T10:20:00.000Z",
      assigned: false,
    };
    const trackitStopsByPlate: TrackitCandidateMap = new Map([[plate, [cand]]]);
    const pass2 = runAzMatch({ ...baseArgs, trackitStopsByPlate });
    const byRota = new Map(pass2.rows.map((r) => [String(r["ROTA"]), r]));
    ok(
      "first group (R1, sheet order) claims the single candidate",
      byRota.get("R1")?.["Confiança"] === TRACKIT_FALLBACK,
      byRota.get("R1"),
    );
    ok("second group (R2) finds it already claimed -> stays REVIEW", byRota.get("R2")?.["Confiança"] === REVIEW, byRota.get("R2"));
    ok(
      "second group's note explains it was already claimed by another line",
      String(byRota.get("R2")?.["Real"]).includes("já foi atribuída a outra linha"),
      byRota.get("R2")?.["Real"],
    );
    ok("summary.trackitFallback counts exactly 1 resolved row, not 2", pass2.summary.trackitFallback === 1, pass2.summary);
  }

  // --- skip reasons: note APPENDED, never replacing the original --------
  {
    const baseArgs = {
      day: DAY,
      records: [mkRow("R3", "9001")],
      header: azHeader,
      cols,
      stops: [],
      platesWithGps: new Set([plate]),
      pingWindowByPlate: new Map([[plate, pingSpan]]),
    };
    const pass1 = runAzMatch(baseArgs);
    const baseNote = String(pass1.rows[0]["Real"]);
    ok("pass1 base note is non-empty", baseNote.length > 0, baseNote);

    for (const reason of ["cap", "deadline", "call-failed", "no-vehicle-id"] as const) {
      const trackitStopsByPlate: TrackitCandidateMap = new Map([[plate, { skipped: reason }]]);
      const pass2 = runAzMatch({ ...baseArgs, trackitStopsByPlate });
      const note = String(pass2.rows[0]["Real"]);
      ok(`skip reason "${reason}": row stays REVIEW`, pass2.rows[0]["Confiança"] === REVIEW, pass2.rows[0]);
      ok(`skip reason "${reason}": note starts with the ORIGINAL base note`, note.startsWith(baseNote), note);
      ok(`skip reason "${reason}": note is APPENDED (strictly longer)`, note.length > baseNote.length, note);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n== runMatch (TFS) — TRACKiT fallback integration ==");
{
  const tfsHeader = [
    "Dia do Serviço",
    "Matrícula da Viatura",
    "Código de Loja",
    "Janela Início",
    "Janela Fim",
    "Hora de Chegada",
    "Hora de Saída",
  ];
  const cols = resolveTfsColumns(tfsHeader);
  const plate = "BB22CC";
  const DAY = "2026-09-21";
  const baseArgs = {
    day: DAY,
    records: [
      {
        "Dia do Serviço": DAY,
        "Matrícula da Viatura": "BB-22-CC",
        "Código de Loja": "7005",
        "Janela Início": "08:00",
        "Janela Fim": "09:00",
        "Hora de Chegada": "",
        "Hora de Saída": "",
      },
    ],
    header: tfsHeader,
    cols,
    stops: [],
    fleetByTruck: new Map<string, string>(),
    platesWithGps: new Set([plate]),
    pingWindowByPlate: new Map([[plate, { min: Date.parse("2026-09-21T00:00:00Z"), max: Date.parse("2026-09-21T23:59:00Z") }]]),
  };

  const pass1 = runTfsMatch(baseArgs);
  ok("TFS pass1: row is REVIEW", pass1.rows[0]["Confiança"] === REVIEW, pass1.rows[0]);
  ok("TFS pass1: pendingTrackitPlates includes the plate", pass1.pendingTrackitPlates.includes(plate), pass1.pendingTrackitPlates);

  // 09:00Z / 09:20Z = 10:00 / 10:20 Lisbon (Sept, WEST) — inside the ±180min
  // pad around the 08:00-09:00 planned window (same mechanism findVehicleSwap
  // already uses via widenWindow/inWindow, not azambuja-sheet's winLoMs/winHiMs).
  const cand: WStop = {
    id: "trackit:2:0",
    vehicleId: 2,
    plate,
    code: "7005",
    arrivedAt: "2026-09-21T09:00:00.000Z",
    departedAt: "2026-09-21T09:20:00.000Z",
    assigned: false,
  };
  const trackitStopsByPlate: TrackitCandidateMap = new Map([[plate, [cand]]]);
  const pass2 = runTfsMatch({ ...baseArgs, trackitStopsByPlate });
  ok("TFS pass2: row resolves to TRACKIT_FALLBACK", pass2.rows[0]["Confiança"] === TRACKIT_FALLBACK, pass2.rows[0]);
  ok(
    "TFS pass2: Hora de Chegada filled from the candidate (10:00 Lisbon)",
    pass2.rows[0]["Hora de Chegada"] === "10:00",
    pass2.rows[0],
  );
}

// ---------------------------------------------------------------------------
console.log("\n== DST regression: lisbonEpoch across the 2026-10-25 PT clock change ==");
{
  // Verified via Intl.DateTimeFormat directly: the night of 25->26 Oct 2026 is
  // when Portugal's clocks go back — 2026-10-25 00:00 Lisbon is still WEST
  // (+1h), 2026-10-26 00:00 Lisbon is already WET (+0h). lisbonEpoch must
  // reflect that dynamically (it's Intl-based, not a hardcoded +1h — unlike
  // this session's own throwaway investigation scripts, which assumed a fixed
  // +1h for September only).
  ok(
    "2026-10-25 00:00 Lisbon == 2026-10-24T23:00:00Z (still WEST, +1h)",
    new Date(lisbonEpoch("2026-10-25", 0)).toISOString() === "2026-10-24T23:00:00.000Z",
    new Date(lisbonEpoch("2026-10-25", 0)).toISOString(),
  );
  ok(
    "2026-10-26 00:00 Lisbon == 2026-10-26T00:00:00Z (back to WET, +0h)",
    new Date(lisbonEpoch("2026-10-26", 0)).toISOString() === "2026-10-26T00:00:00.000Z",
    new Date(lisbonEpoch("2026-10-26", 0)).toISOString(),
  );
}

// ---------------------------------------------------------------------------
console.log("\n== real-data regression: BG-96-ID / 2026-09-21 (vehicle_id=1062417) ==");
// A single real, previously-validated data point from this investigation
// (scripts/compare-location-candidates.ts, BG-96-ID/2026-09-21 run, "default"
// account): our own `stops` had NOTHING near 03:35-04:10 UTC that day, while
// the vehicleTravels-derived candidate (via this same matchStopLocationTs
// algorithm) resolved cleanly to 7003 "Salvesen". Real numbers, not invented.
{
  const azHeader = ["ROTA", "N_LOJA", "NOME", "MATRICULA", "Hora Chegada", "Hora Saida", "CICLO", "TIPO"];
  const cols = resolveAzColumns(azHeader);
  const plate = "BG96ID";
  const DAY = "2026-09-21";
  const baseArgs = {
    day: DAY,
    records: [
      {
        ROTA: "REAL",
        N_LOJA: "7003",
        NOME: "Salvesen",
        MATRICULA: "BG-96-ID",
        "Hora Chegada": "",
        "Hora Saida": "",
        CICLO: "20:00-1 | 08:00",
        TIPO: "C",
      },
    ],
    header: azHeader,
    cols,
    stops: [], // our stops genuinely had nothing here that day (real finding)
    platesWithGps: new Set([plate]),
    pingWindowByPlate: new Map([[plate, { min: Date.parse("2026-09-20T17:00:00Z"), max: Date.parse("2026-09-22T05:00:00Z") }]]),
  };
  const pass1 = runAzMatch(baseArgs);
  ok("real case pass1: REVIEW (our stops had nothing here)", pass1.rows[0]["Confiança"] === REVIEW, pass1.rows[0]);

  const realCandidate: WStop = {
    id: "trackit:1062417:real",
    vehicleId: 1062417,
    plate,
    code: "7003",
    arrivedAt: "2026-09-21T03:35:00.000Z",
    departedAt: "2026-09-21T04:10:00.000Z",
    assigned: false,
  };
  const trackitStopsByPlate: TrackitCandidateMap = new Map([[plate, [realCandidate]]]);
  const pass2 = runAzMatch({ ...baseArgs, trackitStopsByPlate });
  ok("real case pass2: resolves to TRACKIT_FALLBACK using the real candidate", pass2.rows[0]["Confiança"] === TRACKIT_FALLBACK, pass2.rows[0]);
  ok(
    "real case pass2: Chegada/Saída match the real vehicleTravels-derived window (Lisbon)",
    pass2.rows[0]["Hora Chegada"] === "21-09-2026 04:35:00" && pass2.rows[0]["Hora Saida"] === "21-09-2026 05:10:00",
    pass2.rows[0],
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
