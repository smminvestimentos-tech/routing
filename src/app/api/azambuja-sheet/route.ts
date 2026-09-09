import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { lisbonDayStartISO, addDaysYmd } from "@/app/dashboard/_server";
import { normalizePlate } from "@/lib/fleet/validate";
import {
  parseServiceDay,
  resolveColumns,
  resolveDay,
  runMatch,
  type DayStop,
  type SheetRecord,
} from "@/lib/azambuja-sheet/match";

// Internal tool, no auth yet — same stance as the rest of /dashboard. Parses
// one day's Azambuja route sheet, matches it against our stops, and returns a
// filled-in workbook. Nothing is persisted between uploads.
//
// NOTE: stops/pings are NOT filtered by trackit_account. vehicle_id is unique
// company-wide and it's one shared fleet — a truck can run both Vialonga and
// Azambuja service on the same day — so the match wants every stop that truck
// made, regardless of which TRACKiT account recorded it.
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

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
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

  const cols = resolveColumns(header);
  if (cols.errors.length > 0) {
    return NextResponse.json(
      { error: cols.errors.join(" "), errors: cols.errors },
      { status: 422 },
    );
  }

  // The sheet carries no service-day column. Prefer an explicit form field,
  // then the sheet name ("route-…-YYYYMMDDHHMMSS-…"), then the file name.
  const dayField = String(form.get("day") ?? "").trim();
  const day =
    (dayField && parseServiceDay(dayField)) ||
    resolveDay(sheetName, file.name);
  if (!day) {
    return NextResponse.json(
      {
        error:
          "Não consegui determinar o dia de serviço (nem no nome da folha, " +
          "nem no nome do ficheiro). Indica a data no campo «Dia».",
      },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  // Azambuja delivery cycles run heavily overnight (CICLO "20:00-1 | 08:00"),
  // so a route's stops straddle the calendar boundary of its service day.
  // Skirt the strict day by 4h on each side to catch an evening start / a
  // past-midnight finish without pulling in a whole neighbouring day.
  const SKIRT_MS = 4 * 60 * 60 * 1000;
  const dayStart = new Date(
    new Date(lisbonDayStartISO(day)).getTime() - SKIRT_MS,
  ).toISOString();
  const dayEnd = new Date(
    new Date(lisbonDayStartISO(addDaysYmd(day, 1))).getTime() + SKIRT_MS,
  ).toISOString();

  const [stopsRes, pingsRes, allPlatesRes] = await Promise.all([
    supabase
      .from("stops")
      .select("id, vehicle_id, arrived_at, departed_at, location:locations(code)")
      .gte("arrived_at", dayStart)
      .lt("arrived_at", dayEnd)
      .order("arrived_at", { ascending: true })
      .limit(STOP_LIMIT),
    supabase
      .from("vehicle_pings")
      .select("vehicle_id, plate, recorded_at")
      .gte("recorded_at", dayStart)
      .lt("recorded_at", dayEnd)
      .not("plate", "is", null)
      .limit(PING_LIMIT),
    // Every plate our GPS feed has ever seen (one row per vehicle/account).
    // Used by the swap-suggestion logic to tell a real rival from a ghost.
    supabase.from("latest_vehicle_plate").select("plate"),
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

  // Most-seen plate per vehicle that day (vehicle_pings.plate, normalised), and
  // per plate the [min, max] time span of its pings in this window (for the
  // swap-coverage gate).
  const plateTally = new Map<number, Map<string, number>>();
  const pingWindowByPlate = new Map<string, { min: number; max: number }>();
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

  const stops: DayStop[] = ((stopsRes.data ?? []) as StopEmbedRow[]).map((s) => ({
    id: s.id,
    vehicleId: s.vehicle_id,
    plate: plateByVehicle.get(s.vehicle_id) ?? null,
    code: embeddedCode(s.location),
    arrivedAt: s.arrived_at,
    departedAt: s.departed_at,
  }));

  // Plates known to our GPS feed (any day). Falls back to the day's ping
  // plates if the view query failed, so the feature degrades gracefully.
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
    platesWithGps,
    pingWindowByPlate,
  });

  const outWs = XLSX.utils.json_to_sheet(rows, { header: outHeader });
  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, outWs, "Azambuja");
  const fileBase64 = XLSX.write(outWb, { type: "base64", bookType: "xlsx" });

  return NextResponse.json({
    filename: `azambuja-${day}-conferido.xlsx`,
    fileBase64,
    day,
    summary: {
      ...summary,
      dayStops: stops.length,
    },
  });
}
