import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { lisbonDayStartISO, addDaysYmd } from "@/app/dashboard/_server";
import { normalizePlate } from "@/lib/fleet/validate";
import {
  collectServiceDay,
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

// A day's fleet at ~one ping / 5 min is a few thousand rows; cap generously.
const PING_LIMIT = 200_000;
const STOP_LIMIT = 20_000;

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

  const [stopsRes, pingsRes, fleetRes] = await Promise.all([
    supabase
      .from("stops")
      .select("id, vehicle_id, arrived_at, departed_at, location:locations(code)")
      .gte("arrived_at", dayStart)
      .lt("arrived_at", dayEnd)
      .order("arrived_at", { ascending: true })
      .limit(STOP_LIMIT),
    supabase
      .from("vehicle_pings")
      .select("vehicle_id, plate")
      .gte("recorded_at", dayStart)
      .lt("recorded_at", dayEnd)
      .not("plate", "is", null)
      .limit(PING_LIMIT),
    supabase.from("fleet_trucks").select("truck_number, plate"),
  ]);

  if (stopsRes.error) {
    return NextResponse.json(
      { error: `Falha a ler paragens: ${stopsRes.error.message}` },
      { status: 500 },
    );
  }
  if (pingsRes.error) {
    return NextResponse.json(
      { error: `Falha a ler posições: ${pingsRes.error.message}` },
      { status: 500 },
    );
  }

  // Most-seen plate per vehicle that day (vehicle_pings.plate, normalised).
  const plateTally = new Map<number, Map<string, number>>();
  for (const p of pingsRes.data ?? []) {
    if (!p.plate) continue;
    const np = normalizePlate(String(p.plate));
    if (!np) continue;
    let m = plateTally.get(p.vehicle_id);
    if (!m) {
      m = new Map();
      plateTally.set(p.vehicle_id, m);
    }
    m.set(np, (m.get(np) ?? 0) + 1);
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

  const stops: DayStop[] = ((stopsRes.data ?? []) as StopEmbedRow[]).map((s) => ({
    id: s.id,
    vehicleId: s.vehicle_id,
    plate: plateByVehicle.get(s.vehicle_id) ?? null,
    code: embeddedCode(s.location),
    arrivedAt: s.arrived_at,
    departedAt: s.departed_at,
  }));

  const fleetByTruck = new Map<string, string>();
  for (const f of fleetRes.data ?? []) {
    if (!f.plate || !f.truck_number) continue;
    const np = normalizePlate(String(f.plate));
    if (!np) continue;
    fleetByTruck.set(normalizeTruck(String(f.truck_number)), np);
  }

  const { rows, header: outHeader, summary } = runMatch({
    day,
    records,
    header,
    cols,
    stops,
    fleetByTruck,
  });

  const outWs = XLSX.utils.json_to_sheet(rows, { header: outHeader });
  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, outWs, "TFS");
  const fileBase64 = XLSX.write(outWb, { type: "base64", bookType: "xlsx" });

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
