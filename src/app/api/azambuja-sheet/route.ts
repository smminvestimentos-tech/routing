import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { normalizePlate } from "@/lib/fleet/validate";
import {
  dedupeStops,
  findRotaDayConflicts,
  parseServiceDay,
  resolveColumns,
  resolveDay,
  runMatch,
  stopQueryWindowMs,
  type DayStop,
  type SheetRecord,
} from "@/lib/azambuja-sheet/match";
import { buildSheetWorkbook } from "@/lib/sheet-match/xlsx-out";

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

  // The transporter's raw sheet carries no service-day column, so the day is
  // resolved, in order of trust:
  //   1. the explicit "Dia" field on the page
  //   2. our own "Dia Serviço" column (present on a re-uploaded conferido file)
  //   3. the sheet name ("route-…-YYYYMMDDHHMMSS-…")
  //   4. the file name (…YYYY-MM-DD… / …DD-MM-YYYY…)
  // If none give a date, refuse — better a clear error than 500 false negatives
  // from querying the wrong (or no) day.
  const dayField = String(form.get("day") ?? "").trim();
  const dayFromCell = cols.diaCol
    ? parseServiceDay(
        records.map((r) => r[cols.diaCol!]).find((v) => v != null && v !== "") ??
          "",
      )
    : null;
  const day =
    (dayField && parseServiceDay(dayField)) ||
    dayFromCell ||
    resolveDay(sheetName, file.name);
  if (!day) {
    return NextResponse.json(
      {
        error:
          "Não consigo determinar a data deste ficheiro (não há coluna «Dia " +
          "Serviço», e nem o nome da folha nem o do ficheiro têm uma data " +
          "reconhecível). Indica a data no campo «Dia» e volta a carregar.",
      },
      { status: 422 },
    );
  }

  // Safety check: the same ROTA on two different service days inside one file
  // would corrupt the (ROTA, N_LOJA) grouping (see findRotaDayConflicts). Only
  // fires on a re-uploaded file carrying our per-row «Dia Serviço» column.
  const rotaConflicts = findRotaDayConflicts(records, cols.rotaCol, cols.diaCol);
  if (rotaConflicts.length > 0) {
    const detail = rotaConflicts
      .slice(0, 5)
      .map((c) => `ROTA ${c.rota} → ${c.days.join(" e ")}`)
      .join("; ");
    return NextResponse.json(
      {
        error:
          `Este ficheiro tem a mesma ROTA em dias de serviço diferentes ` +
          `(${detail}${rotaConflicts.length > 5 ? "; …" : ""}). O emparelhamento ` +
          `agrupa por (ROTA, N_LOJA) e assume uma rota por dia — carrega um dia ` +
          `de cada vez.`,
        rotaConflicts,
      },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  // Azambuja delivery cycles run heavily overnight (CICLO "20:00-1 | 08:00"),
  // so a route's stops straddle the calendar boundary of its service day. The
  // query window is the strict day skirted by 4h each side AND stretched to
  // reach the real shift day of any "…-1 | …" / "… | …+1" CICLO in the file
  // (a fixed skirt clips an early start like "18:00-1 …").
  const { loMs, hiMs } = stopQueryWindowMs(
    day,
    cols.cicloCol ? records.map((r) => r[cols.cicloCol!]) : [],
  );
  const dayStart = new Date(loMs).toISOString();
  const dayEnd = new Date(hiMs).toISOString();

  // PostgREST caps every response at 1000 rows regardless of .limit(), so both
  // of these must be paged — a full backfilled day is well over 1000 stops and
  // tens of thousands of pings, and truncation shows up as silent "Rever
  // manualmente" for whichever vehicles fall past the cut.
  const [stopsRes, pingsRes, allPlatesRes] = await Promise.all([
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
    // Every plate our GPS feed has ever seen (one row per vehicle/account).
    // Used by the swap-suggestion logic to tell a real rival from a ghost.
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

  // Keep the transporter's original sheet name when it's a valid one (it
  // usually encodes the day, "route-806-YYYYMMDD…") — Excel rejects names over
  // 31 chars or with []:*?/\, and needs something non-empty.
  const outSheetName =
    sheetName && sheetName.length <= 31 && !/[[\]:*?/\\]/.test(sheetName)
      ? sheetName
      : "Azambuja";
  // PROTOTYPE: output written with exceljs — conditional formatting (amber on
  // missing times, red on suggestions / "sem cobertura GPS") + the "OK"
  // dropdown. Input parsing above stays on SheetJS.
  const fileBase64 = await buildSheetWorkbook({
    rows,
    header: outHeader,
    plateColName: cols.plateCol,
    chegadaColName: cols.chegadaCol,
    saidaColName: cols.saidaCol,
    sheetName: outSheetName,
  });

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
