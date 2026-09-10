import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildTfsWorkbook } from "@/lib/tfs-sheet/xlsx-out";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { lisbonDayStartISO, addDaysYmd } from "@/app/dashboard/_server";
import { normalizePlate } from "@/lib/fleet/validate";
import {
  collectServiceDay,
  dedupeStops,
  normalizeTruck,
  resolveColumns,
  runMatch,
  type DayStop,
  type SheetRecord,
} from "@/lib/tfs-sheet/match";

// Internal tool, no auth yet — same stance as the rest of /dashboard. Parses
// one day's TFS sheet, matches it against our stops, and returns a filled-in
// workbook. Nothing is persisted between uploads.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const [stopsRes, pingsRes, fleetRes, allPlatesRes] = await Promise.all([
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
    fetchAllRows<{ vehicle_id: number; plate: string | null; recorded_at: string }>(
      (from, to) =>
        supabase
          .from("vehicle_pings")
          .select("vehicle_id, plate, recorded_at", { count: "exact" })
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
  // swap-coverage gate).
  const plateTally = new Map<number, Map<string, number>>();
  const pingWindowByPlate = new Map<string, { min: number; max: number }>();
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

  const { rows, header: outHeader, summary } = runMatch({
    day,
    records,
    header,
    cols,
    stops,
    fleetByTruck,
    platesWithGps,
    pingWindowByPlate,
  });

  // PROTOTYPE: output written with exceljs (conditional formatting + the "OK"
  // dropdown on suggestion rows). Input parsing above stays on SheetJS.
  const fileBase64 = await buildTfsWorkbook({
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
  });
}
