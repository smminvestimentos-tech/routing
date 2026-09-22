import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSheetWorkbook } from "@/lib/sheet-match/xlsx-out";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { lisbonDayStartISO, addDaysYmd } from "@/app/dashboard/_server";
import { normalizePlate } from "@/lib/fleet/validate";
import { coLocatedGroupsFromLocations, type DayStop } from "@/lib/sheet-match/common";
import {
  collectServiceDay,
  dedupeStops,
  normalizeTruck,
  resolveColumns,
  runMatch,
  type MergedCodeEntry,
  type SheetRecord,
} from "@/lib/tfs-sheet/match";
import { formatTrackitDate, resolveTrackitFallback } from "@/lib/sheet-match/trackit-fallback";
import type { LocationForMatch } from "@/lib/sheet-match/trackit-candidates";

// Internal tool, no auth yet — same stance as the rest of /dashboard. Parses
// one day's TFS sheet, matches it against our stops, and returns a filled-in
// workbook. Nothing is persisted between uploads.
export const dynamic = "force-dynamic";
// 150s (was 60s) — see src/app/api/azambuja-sheet/route.ts's comment: this
// project's Vercel plan/Fluid Compute already runs other routes well above
// 60s (up to 300s), and the (capped, budgeted) TRACKiT /vehicleTravels
// fallback below needs the headroom.
export const maxDuration = 150;

// Hard ceiling on how many ping rows we'll page in for one day's window.
const PING_LIMIT = 200_000;

type StopEmbedRow = {
  id: string;
  vehicle_id: number;
  arrived_at: string;
  departed_at: string | null;
  location: { code: string | null } | { code: string | null }[] | null;
};

function embeddedCode(loc: StopEmbedRow["location"]): string | null {
  if (!loc) return null;
  return Array.isArray(loc) ? (loc[0]?.code ?? null) : loc.code;
}

export async function POST(request: NextRequest) {
  const fnStart = Date.now(); // TRACKiT fallback's global deadline is relative to this
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Envio inválido (esperado multipart/form-data)." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "Nenhum ficheiro .xlsx enviado." },
      { status: 400 },
    );
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
  } catch {
    return NextResponse.json(
      { error: "Não consegui abrir o ficheiro como .xlsx." },
      { status: 400 },
    );
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    return NextResponse.json(
      { error: "O ficheiro não tem nenhuma folha." },
      { status: 400 },
    );
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  if (aoa.length < 2) {
    return NextResponse.json(
      { error: "A folha não tem linhas de dados." },
      { status: 400 },
    );
  }
  const header = (aoa[0] as unknown[]).map((h) => String(h).trim());
  const records = XLSX.utils.sheet_to_json<SheetRecord>(ws, {
    raw: false,
    defval: "",
    blankrows: false,
  });
  // A raw pass too: "Dia do Serviço" is an Excel date serial, and formatting it
  // ("9/8/26") throws away whether it's D/M or M/D. collectServiceDay() reads
  // the serial straight from here; everything else stays on the display strings.
  const recordsRaw = XLSX.utils.sheet_to_json<SheetRecord>(ws, {
    raw: true,
    defval: "",
    blankrows: false,
  });

  const cols = resolveColumns(header);
  if (cols.errors.length > 0) {
    return NextResponse.json(
      { error: cols.errors.join(" "), errors: cols.errors },
      { status: 422 },
    );
  }

  const dayRes = collectServiceDay(recordsRaw, cols.dayCol);
  if ("error" in dayRes) {
    return NextResponse.json({ error: dayRes.error }, { status: 422 });
  }
  const day = dayRes.day;

  const supabase = createAdminClient();
  const dayStart = lisbonDayStartISO(day);
  const dayEnd = lisbonDayStartISO(addDaysYmd(day, 1));

  // PostgREST caps every response at 1000 rows regardless of .limit(), so
  // stops and pings are paged — a busy day is well over 1000 of each, and a
  // truncated read shows up as silent "Rever manualmente" for the vehicles
  // past the cut.
  const [stopsRes, pingsRes, fleetRes, allPlatesRes, locationsRes] = await Promise.all([
    fetchAllRows<StopEmbedRow>((from, to) =>
      supabase
        .from("stops")
        .select("id, vehicle_id, arrived_at, departed_at, location:locations(code)", {
          count: "exact",
        })
        .gte("arrived_at", dayStart)
        .lt("arrived_at", dayEnd)
        .order("arrived_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{
      vehicle_id: number;
      plate: string | null;
      recorded_at: string;
      trackit_account: string;
    }>(
      (from, to) =>
        supabase
          .from("vehicle_pings")
          .select("vehicle_id, plate, recorded_at, trackit_account", { count: "exact" })
          .gte("recorded_at", dayStart)
          .lt("recorded_at", dayEnd)
          .not("plate", "is", null)
          .order("recorded_at", { ascending: true })
          .order("vehicle_id", { ascending: true })
          .range(from, to),
      { hardCap: PING_LIMIT },
    ),
    supabase.from("fleet_trucks").select("truck_number, plate"),
    // Every plate our GPS feed has ever seen (one row per vehicle). Used by the
    // swap-suggestion logic to tell a real rival vehicle from a GPS-less ghost.
    supabase.from("latest_vehicle_plate").select("plate"),
    // Every location's code/active/merged_into_id/colocated_with_id — resolves
    // a sheet code that still names a merged-away location (0019, 0030) to its
    // canonical code, and feeds the same-site co-location groups (0034).
    // "type" feeds codeTypes below — gates the KEPT-row plausibility check's
    // stricter <5min threshold to actual stores (loja), never armazém/CD.
    // "latitude, longitude" feed codeCoords — the consecutive-stop
    // implausible-speed check (detectImplausibleSpeed, common.ts).
    // "radius_meters" feeds the TRACKiT-fallback location matcher
    // (matchStopLocationTs, trackit-candidates.ts) — same radii detect_stops
    // itself uses.
    supabase
      .from("locations")
      .select(
        "id, code, type, latitude, longitude, radius_meters, active, merged_into_id, colocated_with_id",
      ),
  ]);

  if (stopsRes.error) {
    return NextResponse.json(
      { error: `Falha a ler paragens: ${stopsRes.error}` },
      { status: 500 },
    );
  }
  if (pingsRes.error) {
    return NextResponse.json(
      { error: `Falha a ler posições: ${pingsRes.error}` },
      { status: 500 },
    );
  }

  // Most-seen plate per vehicle that day (vehicle_pings.plate, normalised), and
  // per plate the [min, max] time span of its pings in this window (for the
  // swap-coverage gate). Also, directly (not by inverting plateByVehicle —
  // would be lossy if a vehicle_id ever shows >1 plate in a day) the
  // most-seen vehicle_id per PLATE and the set of trackit_accounts each
  // vehicle pinged under today — both only needed by the TRACKiT fallback
  // below, kept here so this stays a single pass over pingsRes.data.
  const plateTally = new Map<number, Map<string, number>>();
  const vehicleTallyByPlate = new Map<string, Map<number, number>>();
  const pingWindowByPlate = new Map<string, { min: number; max: number }>();
  const accountsByVehicle = new Map<number, Set<string>>();
  for (const p of pingsRes.data) {
    if (!p.plate) continue;
    const np = normalizePlate(String(p.plate));
    if (!np) continue;
    let m = plateTally.get(p.vehicle_id);
    if (!m) {
      m = new Map();
      plateTally.set(p.vehicle_id, m);
    }
    m.set(np, (m.get(np) ?? 0) + 1);

    let vm = vehicleTallyByPlate.get(np);
    if (!vm) {
      vm = new Map();
      vehicleTallyByPlate.set(np, vm);
    }
    vm.set(p.vehicle_id, (vm.get(p.vehicle_id) ?? 0) + 1);

    if (p.trackit_account) {
      let accs = accountsByVehicle.get(p.vehicle_id);
      if (!accs) {
        accs = new Set();
        accountsByVehicle.set(p.vehicle_id, accs);
      }
      accs.add(p.trackit_account);
    }

    const t = new Date(p.recorded_at as string).getTime();
    if (Number.isFinite(t)) {
      const span = pingWindowByPlate.get(np);
      if (!span) pingWindowByPlate.set(np, { min: t, max: t });
      else {
        if (t < span.min) span.min = t;
        if (t > span.max) span.max = t;
      }
    }
  }
  const plateByVehicle = new Map<number, string>();
  for (const [vid, m] of plateTally) {
    let best: string | null = null;
    let bestN = -1;
    for (const [pl, n] of m) {
      if (n > bestN) {
        best = pl;
        bestN = n;
      }
    }
    if (best) plateByVehicle.set(vid, best);
  }
  const vehicleIdByPlate = new Map<string, number>();
  for (const [pl, m] of vehicleTallyByPlate) {
    let best: number | null = null;
    let bestN = -1;
    for (const [vid, n] of m) {
      if (n > bestN) {
        best = vid;
        bestN = n;
      }
    }
    if (best != null) vehicleIdByPlate.set(pl, best);
  }

  // dedupeStops merges the same physical visit when a vehicle is tracked by
  // more than one TRACKiT account (the query spans all accounts).
  const stops: DayStop[] = dedupeStops(
    stopsRes.data.map((s) => ({
      id: s.id,
      vehicleId: s.vehicle_id,
      plate: plateByVehicle.get(s.vehicle_id) ?? null,
      code: embeddedCode(s.location),
      arrivedAt: s.arrived_at,
      departedAt: s.departed_at,
    })),
  );

  const fleetByTruck = new Map<string, string>();
  for (const f of fleetRes.data ?? []) {
    if (!f.plate || !f.truck_number) continue;
    const np = normalizePlate(String(f.plate));
    if (!np) continue;
    fleetByTruck.set(normalizeTruck(String(f.truck_number)), np);
  }

  // Plates known to our GPS feed (any day). Falls back to the day's ping plates
  // if the view query failed, so the feature degrades instead of breaking.
  const platesWithGps = new Set<string>();
  for (const r of allPlatesRes.data ?? []) {
    const np = normalizePlate(String(r.plate ?? ""));
    if (np) platesWithGps.add(np);
  }
  for (const pl of plateByVehicle.values()) platesWithGps.add(pl);

  // A sheet code that still names a merged-away location (0019, 0030) resolves
  // to its canonical code before matching. Degrades to no resolution (today's
  // behaviour) if the query failed, same stance as platesWithGps above.
  const activeCodes: string[] = [];
  const mergedCodes: MergedCodeEntry[] = [];
  // Same-site co-location groups (0034) — degrades to [] (today's behaviour)
  // if the query failed, same stance as activeCodes/mergedCodes above.
  const coLocatedGroups = locationsRes.error
    ? []
    : coLocatedGroupsFromLocations(locationsRes.data ?? []);
  // locations.code -> locations.type — see classifyKeptDuration (common.ts).
  // locations.code -> {lat,lng} — see detectImplausibleSpeed (common.ts).
  // Both degrade to an empty map (no stricter threshold / no speed check
  // applied, today's behaviour) if the query failed, same stance as the
  // others above.
  const codeTypes = new Map<string, string>();
  const codeCoords = new Map<string, { lat: number; lng: number }>();
  const locationsForMatch: LocationForMatch[] = [];
  if (!locationsRes.error) {
    const codeById = new Map<string, string>();
    for (const l of locationsRes.data ?? []) codeById.set(l.id, l.code);
    for (const l of locationsRes.data ?? []) {
      if (l.active) {
        activeCodes.push(l.code);
      } else if (l.merged_into_id) {
        const canonicalCode = codeById.get(l.merged_into_id);
        if (canonicalCode) mergedCodes.push({ code: l.code, canonicalCode });
      }
      if (l.type) codeTypes.set(l.code, l.type);
      if (l.latitude != null && l.longitude != null) {
        codeCoords.set(l.code, { lat: l.latitude, lng: l.longitude });
      }
      if (l.latitude != null && l.longitude != null && l.radius_meters != null) {
        locationsForMatch.push({
          id: l.id,
          code: l.code,
          latitude: l.latitude,
          longitude: l.longitude,
          radius_meters: l.radius_meters,
          active: l.active,
        });
      }
    }
  }

  // Pass 1: exactly today's matching, no I/O. If nothing is eligible for the
  // TRACKiT fallback (the common case), this is the final result — zero extra
  // cost. `stops` here is passed fresh each call and never mutated by
  // runMatch (it copies + resets `.assigned` internally), so pass 1 and pass
  // 2 are independently deterministic given the same inputs.
  const matchArgs = {
    day,
    records,
    rawRecords: recordsRaw,
    header,
    cols,
    stops,
    fleetByTruck,
    platesWithGps,
    pingWindowByPlate,
    activeCodes,
    mergedCodes,
    coLocatedGroups,
    codeTypes,
    codeCoords,
  };
  let matched = runMatch(matchArgs);
  let trackitDiagnostics: {
    targeted: number;
    attempted: number;
    resolved: number;
    cappedPlates: string[];
    failedPlates: string[];
  } | null = null;

  if (matched.pendingTrackitPlates.length > 0) {
    const realStopsByVehicle = new Map<number, DayStop[]>();
    for (const s of stops) {
      const arr = realStopsByVehicle.get(s.vehicleId) ?? [];
      arr.push(s);
      realStopsByVehicle.set(s.vehicleId, arr);
    }

    const { trackitStopsByPlate, diagnostics } = await resolveTrackitFallback({
      pendingPlates: matched.pendingTrackitPlates,
      vehicleIdByPlate,
      accountsByVehicle,
      realStopsByVehicle,
      locations: locationsForMatch,
      dateBegin: formatTrackitDate(new Date(dayStart).getTime()),
      dateEnd: formatTrackitDate(new Date(dayEnd).getTime()),
      fnStart,
    });

    matched = runMatch({ ...matchArgs, trackitStopsByPlate });
    trackitDiagnostics = { ...diagnostics, resolved: matched.summary.trackitFallback };
  }

  const { rows, header: outHeader, summary } = matched;

  // PROTOTYPE: output written with exceljs (conditional formatting + the "OK"
  // dropdown on suggestion rows). Input parsing above stays on SheetJS.
  const fileBase64 = await buildSheetWorkbook({
    rows,
    header: outHeader,
    plateColName: cols.plateCol ?? "",
    chegadaColName: cols.chegadaCol,
    saidaColName: cols.saidaCol,
    sheetName: "TFS",
  });

  return NextResponse.json({
    filename: `tfs-${day}-conferido.xlsx`,
    fileBase64,
    day,
    summary: {
      ...summary,
      dayStops: stops.length,
      fleetTrucks: fleetRes.error ? null : (fleetRes.data?.length ?? 0),
      fleetError: fleetRes.error?.message ?? null,
    },
    ...(trackitDiagnostics ? { trackitFallback: trackitDiagnostics } : {}),
  });
}
