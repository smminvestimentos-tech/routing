// One-off, READ-ONLY evaluation: is TRACKiT's /vehicleTravels more reliable
// than our own detect_stops() for location matching? This does NOT write to
// the DB and does NOT touch any production code path — it only calls
// /vehicleTravels directly (via src/lib/trackit/http.ts, bypassing the
// server-only client.ts guard, same trick scripts/backfill-azambuja-pings.ts
// uses) and reads `stops`/`locations`/`trackit_pois` for comparison.
//
// For each (plate, day) case below it:
//   1. Resolves the plate to its TRACKiT vehicle_id + trackit_account via
//      vehicle_pings (vehicle_id is fleet-wide unique — see
//      CONTEXTO_PROJETO_ROUTING.md §2).
//   2. Calls /vehicleTravels for that vehicle over the day (±6h pad, since we
//      don't know the exact shift window for these routes up front).
//   3. Extracts ini.poi, ini.fractal, end.poi, end.fractal, ini/end
//      timestamps from EVERY travel returned (raw fields — `fractal`'s exact
//      meaning is unconfirmed, so it's reported as-is, not interpreted).
//   4. Prints our own `stops` rows for the same vehicle + window, fleet-wide
//      (no trackit_account filter — same "matching is fleet-wide" convention
//      documented in CONTEXTO_PROJETO_ROUTING.md), for side-by-side eyeball
//      comparison against whatever ground truth (Transpogest) the operator
//      already has for these specific routes.
//   5. Writes a combined CSV per case to data/ for offline comparison.
//
// Usage:
//   npx tsx scripts/compare-vehicletravels-vs-stops.ts
//
// NOTE: BG-96-ID is on the "default" TRACKiT account (its vehicle_id also
// shows pings under "azambuja", but our own /api/sync/travels route only
// ever syncs travels via the "default" account regardless — see
// src/app/api/sync/travels/route.ts — so "default" is the consistent choice
// here too). 71-IL-59 and BG-75-IP are azambuja-only and are SKIPPED unless
// TRACKIT_USER_2/TRACKIT_PASS_2 are present in .env.local (not the case as
// of this writing — those creds only exist in the Vercel production env).

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  getConfiguredAccounts,
  getVehicleTravels,
  type TrackitAccount,
} from "../src/lib/trackit/http";
import { lisbonEpoch } from "@/lib/sheet-match/common";

config({ path: resolve(process.cwd(), ".env.local") });

// ---------------------------------------------------------------------------
// Cases under investigation — plates already deeply investigated manually
// (see supabase/migrations/0040_fix_7001_7005_radius_overlap.sql for
// BG-96-ID/15-09, and scripts/test-sheet-match.ts's "BG-75-IP regression"
// block for 21-09).
// ---------------------------------------------------------------------------
type Case = { plate: string; day: string; account: string };
const CASES: Case[] = [
  { plate: "BG-96-ID", day: "2026-09-15", account: "default" },
  { plate: "71-IL-59", day: "2026-09-15", account: "azambuja" },
  { plate: "BG-75-IP", day: "2026-09-21", account: "azambuja" },
];

const PAD_HOURS = 6; // window padding either side of the Lisbon calendar day
const OUT_DIR = resolve(process.cwd(), "data/vehicletravels-vs-stops");

// "YYYY-MM-DD HH:MM:SS" UTC — what /vehicleTravels expects (same format used
// by src/app/api/sync/travels/route.ts's formatTrackitDate).
function fmtTrackitDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Raw travel-point shape actually returned by TRACKiT, widened beyond
// TrackitTravelPoint (src/lib/trackit/http.ts) to also capture `fractal` —
// present in the real payload but not (yet) part of that narrower type.
// `timestamp` is Lisbon local time; `timestampUTC` (confirmed present in the
// real payload, 1h behind `timestamp` in September/WEST) is what lines up
// directly with `stops.arrived_at` (timestamptz, stored/printed as UTC) —
// use the UTC one for anything compared against our own tables.
type RawTravelPoint = {
  timestamp?: string | null;
  timestampUTC?: string | null;
  km?: number | null;
  poi?: number | null;
  fractal?: unknown;
  lat?: number | null;
  lng?: number | null;
};
type RawTravel = {
  mid?: string;
  ymd?: string | null;
  total_drive?: number | null;
  total_km?: number | null;
  avg_speed?: number | null;
  ini?: RawTravelPoint | null;
  end?: RawTravelPoint | null;
};

type LocationRow = { id: string; code: string; name: string | null };
type PoiRow = { id_poi_trackit: number; name: string | null };
type StopRow = {
  id: string;
  trackit_account: string;
  vehicle_id: number;
  location_id: string | null;
  arrived_at: string;
  departed_at: string | null;
  duration_minutes: number | null;
  status: string;
};

// Proper CSV quoting (double internal quotes) — NOT JSON.stringify, whose
// backslash-escaping of `"` isn't valid CSV and breaks any real CSV parser.
function csvCell(v: unknown): string {
  if (v == null) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const configured = new Map(getConfiguredAccounts().map((a) => [a.id, a]));
  console.log(`Configured TRACKiT accounts (locally): ${[...configured.keys()].join(", ") || "(none)"}\n`);

  const { data: locRows, error: locErr } = await sb.from("locations").select("id, code, name");
  if (locErr) throw locErr;
  const locationsById = new Map((locRows as LocationRow[]).map((l) => [l.id, l]));

  mkdirSync(OUT_DIR, { recursive: true });

  for (const c of CASES) {
    console.log("=".repeat(100));
    console.log(`CASE: ${c.plate}  day=${c.day}  account=${c.account}`);
    console.log("=".repeat(100));

    const account: TrackitAccount | undefined = configured.get(c.account);
    if (!account) {
      console.log(
        `  SKIPPED — TRACKiT account "${c.account}" is not configured locally ` +
          `(missing TRACKIT_USER*/TRACKIT_PASS* for it in .env.local). ` +
          `This case's vehicle only has pings under "${c.account}"; it cannot be pulled ` +
          `from /vehicleTravels without those credentials.\n`,
      );
      continue;
    }

    // Resolve plate -> vehicle_id via vehicle_pings (fleet-wide unique id).
    const { data: pingRows, error: pingErr } = await sb
      .from("vehicle_pings")
      .select("vehicle_id")
      .eq("plate", c.plate)
      .limit(500);
    if (pingErr) throw pingErr;
    const vehicleIdCounts = new Map<number, number>();
    for (const r of (pingRows ?? []) as Array<{ vehicle_id: number }>) {
      vehicleIdCounts.set(r.vehicle_id, (vehicleIdCounts.get(r.vehicle_id) ?? 0) + 1);
    }
    if (vehicleIdCounts.size === 0) {
      console.log(`  SKIPPED — no vehicle_pings found for plate "${c.plate}"\n`);
      continue;
    }
    if (vehicleIdCounts.size > 1) {
      console.log(
        `  WARNING — plate "${c.plate}" maps to ${vehicleIdCounts.size} distinct vehicle_ids in vehicle_pings: ` +
          `${[...vehicleIdCounts.entries()].map(([id, n]) => `${id} (${n}x)`).join(", ")}. Using the most frequent.`,
      );
    }
    const vehicleId = [...vehicleIdCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    console.log(`  resolved vehicle_id = ${vehicleId}\n`);

    const dayLoMs = lisbonEpoch(c.day, 0) - PAD_HOURS * 3_600_000;
    const dayHiMs = lisbonEpoch(addDays(c.day, 1), 0) + PAD_HOURS * 3_600_000;
    const dateBegin = fmtTrackitDate(dayLoMs);
    const dateEnd = fmtTrackitDate(dayHiMs);
    console.log(`  window (UTC, ±${PAD_HOURS}h pad): ${dateBegin} .. ${dateEnd}`);

    // trackit_pois for this account, to resolve ini/end poi ids to a name.
    const { data: poiRows, error: poiErr } = await sb
      .from("trackit_pois")
      .select("id_poi_trackit, name")
      .eq("trackit_account", c.account);
    if (poiErr) throw poiErr;
    const poiById = new Map((poiRows as PoiRow[]).map((p) => [p.id_poi_trackit, p.name]));

    // --- 1. /vehicleTravels ---------------------------------------------
    let travels: RawTravel[];
    try {
      travels = (await getVehicleTravels(account, vehicleId, dateBegin, dateEnd)) as unknown as RawTravel[];
    } catch (err) {
      console.log(`  /vehicleTravels FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    console.log(`\n  --- /vehicleTravels: ${travels.length} travel(s) ---`);
    if (travels.length > 0) {
      console.log(`  raw sample (travel[0], full JSON, to confirm field shapes incl. "fractal"):`);
      console.log("  " + JSON.stringify(travels[0], null, 2).split("\n").join("\n  "));
    }
    // "YYYY-MM-DD HH:MM:SS" (UTC, no offset marker) -> ISO 8601 UTC, so it
    // sorts/compares directly against stops.arrived_at (timestamptz).
    const toUtcIso = (v: string | null | undefined) => (v ? `${v.replace(" ", "T")}Z` : "");

    const travelRows: Array<Record<string, unknown>> = [];
    travels
      .slice()
      .sort((a, b) => toUtcIso(a.ini?.timestampUTC).localeCompare(toUtcIso(b.ini?.timestampUTC)))
      .forEach((t, i) => {
        const iniPoiName = t.ini?.poi != null ? poiById.get(t.ini.poi) ?? "(unknown poi id)" : null;
        const endPoiName = t.end?.poi != null ? poiById.get(t.end.poi) ?? "(unknown poi id)" : null;
        console.log(
          `  [${i}] ${toUtcIso(t.ini?.timestampUTC) || "?"} -> ${toUtcIso(t.end?.timestampUTC) || "?"}  (UTC)  ` +
            `ini.poi=${t.ini?.poi ?? "null"}(${iniPoiName ?? "-"}) ini.fractal=${JSON.stringify(t.ini?.fractal)}  ` +
            `end.poi=${t.end?.poi ?? "null"}(${endPoiName ?? "-"}) end.fractal=${JSON.stringify(t.end?.fractal)}  ` +
            `total_km=${t.total_km ?? "?"} total_drive=${t.total_drive ?? "?"}`,
        );
        travelRows.push({
          source: "trackit_vehicleTravels",
          index: i,
          ts_start: toUtcIso(t.ini?.timestampUTC),
          ts_end: toUtcIso(t.end?.timestampUTC),
          ini_poi: t.ini?.poi ?? "",
          ini_poi_name: iniPoiName ?? "",
          ini_fractal: t.ini?.fractal ?? "",
          ini_lat: t.ini?.lat ?? "",
          ini_lng: t.ini?.lng ?? "",
          end_poi: t.end?.poi ?? "",
          end_poi_name: endPoiName ?? "",
          end_fractal: t.end?.fractal ?? "",
          end_lat: t.end?.lat ?? "",
          end_lng: t.end?.lng ?? "",
          total_km: t.total_km ?? "",
          total_drive_s: t.total_drive ?? "",
        });
      });

    // --- 2. our `stops` table, fleet-wide (no trackit_account filter) ---
    const fromISO = new Date(dayLoMs).toISOString();
    const toISO = new Date(dayHiMs).toISOString();
    const { data: stopRows, error: stopErr } = await sb
      .from("stops")
      .select("id, trackit_account, vehicle_id, location_id, arrived_at, departed_at, duration_minutes, status")
      .eq("vehicle_id", vehicleId)
      .gte("arrived_at", fromISO)
      .lt("arrived_at", toISO)
      .order("arrived_at", { ascending: true });
    if (stopErr) throw stopErr;
    const stops = (stopRows ?? []) as StopRow[];
    console.log(`\n  --- our \`stops\` table: ${stops.length} row(s) ---`);
    const stopCsvRows: Array<Record<string, unknown>> = [];
    for (const s of stops) {
      const loc = s.location_id ? locationsById.get(s.location_id) : null;
      console.log(
        `  ${s.arrived_at} -> ${s.departed_at ?? "(open)"}  ` +
          `location=${loc ? `${loc.code} "${loc.name}"` : "(null — unmatched)"}  ` +
          `duration_min=${s.duration_minutes ?? "?"}  status=${s.status}  account=${s.trackit_account}`,
      );
      stopCsvRows.push({
        source: "our_stops",
        index: "",
        ts_start: s.arrived_at,
        ts_end: s.departed_at ?? "",
        ini_poi: "",
        ini_poi_name: loc ? `${loc.code} ${loc.name ?? ""}`.trim() : "(unmatched)",
        ini_fractal: "",
        ini_lat: "",
        ini_lng: "",
        end_poi: "",
        end_poi_name: "",
        end_fractal: "",
        end_lat: "",
        end_lng: "",
        total_km: "",
        total_drive_s: s.duration_minutes != null ? Math.round(s.duration_minutes * 60) : "",
      });
    }

    // --- 3. combined CSV, sorted chronologically -------------------------
    const combined = [...travelRows, ...stopCsvRows].sort((a, b) =>
      String(a.ts_start).localeCompare(String(b.ts_start)),
    );
    const header = Object.keys(combined[0] ?? { source: "", ts_start: "" });
    const csvLines = [
      header.join(","),
      ...combined.map((row) => header.map((h) => csvCell(row[h])).join(",")),
    ];
    const outPath = resolve(OUT_DIR, `${c.plate.replace(/[^A-Za-z0-9]/g, "")}-${c.day}.csv`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, csvLines.join("\n") + "\n", "utf-8");
    console.log(`\n  combined CSV written to ${outPath}\n`);
  }

  console.log("Done. No DB writes were made.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
