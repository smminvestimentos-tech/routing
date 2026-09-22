// Prototype #2, still READ-ONLY: for each (vehicle, day) case, derive an
// "alternative candidate" stop from /vehicleTravels using ONLY its
// timestamps + lat/lng (never TRACKiT's own `fractal` text or `poi` id —
// scripts/compare-3way-bg96id-20260921.ts already showed those are
// unreliable exactly in the dense Azambuja/Vila Nova da Rainha cluster).
// The location for that candidate is picked by a straight TypeScript port
// of our own `match_stop_location()` SQL function (supabase/migrations/
// 0009_detect_stops.sql, as revised by 0036) — same radius/vote/tie-break
// rule, applied to the same `locations` table.
//
// Does NOT write to the DB, does NOT touch match_stop_location itself or
// any production code path — this is a parallel, offline re-implementation
// for comparison only. Writes one CSV per case to
// data/location-candidates/<plate>-<day>.csv.
//
// --- Porting note: match_stop_location needs a BUFFER of pings (it votes
// by how many buffered points fall inside each candidate's radius,
// tie-broken by distance to the stop's centroid). vehicleTravels gives us
// only 1-2 points per gap (the arrival point = end lat/lng of the incoming
// travel, and the departure point = ini lat/lng of the outgoing travel) —
// nowhere near detect_stops' dense per-ping buffer. This port uses exactly
// those 1-2 points as the "buffer" and their average as the centroid. With
// so few points the vote step will almost always degenerate to a plain
// nearest-matching-circle pick — that's an honest limitation of the sparse
// vehicleTravels data, not a bug in the port. merged_into_id needs no
// separate resolution: match_stop_location already restricts the join to
// `l.active`, and a merged-away location is required to be inactive (see
// 0030's `locations_merged_into_id_requires_inactive` check), so an
// inactive/merged row can never be selected in the first place — porting
// the `l.active` filter is sufficient. colocated_with_id is NOT part of
// match_stop_location itself (that DB function has no notion of it) — it's
// applied one layer up, in the sheet-matchers' own logic. This script
// surfaces it as an informational side-note on the picked candidate only
// (so you can see "this pick has a co-located sibling"), not as an
// alternate pick.
//
// Usage: npx tsx scripts/compare-location-candidates.ts

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getAccountCredentials, getVehicleTravels } from "../src/lib/trackit/http";
import { lisbonEpoch } from "@/lib/sheet-match/common";

config({ path: resolve(process.cwd(), ".env.local") });

type Case = { plate: string; vehicleId: number; day: string; account: string };
const CASES: Case[] = [
  { plate: "BG-96-ID", vehicleId: 1062417, day: "2026-09-16", account: "default" },
  { plate: "BG-96-ID", vehicleId: 1062417, day: "2026-09-18", account: "default" },
  { plate: "BG-96-ID", vehicleId: 1062417, day: "2026-09-21", account: "default" },
  { plate: "42-HX-80", vehicleId: 1795, day: "2026-09-18", account: "default" },
  { plate: "91-DD-33", vehicleId: 2940, day: "2026-09-18", account: "default" },
];

const PAD_HOURS = 6;
const OUT_DIR = resolve(process.cwd(), "data/location-candidates");

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

// --- match_stop_location, ported ------------------------------------------
type LocationRow = {
  id: string;
  code: string;
  name: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  active: boolean;
  colocated_with_id: string | null;
};

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Mirrors match_stop_location(p_buffer, p_centroid_lat, p_centroid_lng):
//   select l.id from unnest(buffer) b join locations l
//     on l.active and haversine(b, l) <= l.radius_meters
//   group by l.id order by count(*) desc, haversine(centroid, l) asc, l.id asc
//   limit 1
function matchStopLocation(
  buffer: Array<{ lat: number; lng: number }>,
  centroidLat: number,
  centroidLng: number,
  locations: LocationRow[],
): LocationRow | null {
  const active = locations.filter((l) => l.active);
  let best: LocationRow | null = null;
  let bestCount = -1;
  let bestDist = Infinity;
  for (const l of active) {
    const count = buffer.filter((b) => haversineMeters(b.lat, b.lng, l.latitude, l.longitude) <= l.radius_meters).length;
    if (count === 0) continue;
    const dist = haversineMeters(centroidLat, centroidLng, l.latitude, l.longitude);
    if (count > bestCount || (count === bestCount && dist < bestDist) || (count === bestCount && dist === bestDist && (!best || l.id < best.id))) {
      best = l;
      bestCount = count;
      bestDist = dist;
    }
  }
  return best;
}

type Candidate = {
  arrMs: number;
  depMs: number;
  arrLat: number;
  arrLng: number;
  depLat: number;
  depLng: number;
  matched: LocationRow | null;
};

// Proper CSV quoting (double internal quotes) — NOT JSON.stringify, whose
// backslash-escaping of `"` isn't valid CSV and breaks any real CSV parser.
function csvCell(v: unknown): string {
  if (v == null) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: locRows, error: locErr } = await sb
    .from("locations")
    .select("id, code, name, latitude, longitude, radius_meters, active, colocated_with_id")
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .not("radius_meters", "is", null);
  if (locErr) throw locErr;
  const locations = locRows as LocationRow[];
  const locationsById = new Map(locations.map((l) => [l.id, l]));
  console.log(`locations loaded: ${locations.length} (active: ${locations.filter((l) => l.active).length})\n`);

  mkdirSync(OUT_DIR, { recursive: true });

  for (const c of CASES) {
    console.log("=".repeat(100));
    console.log(`CASE: ${c.plate} (vehicle_id=${c.vehicleId})  day=${c.day}  account=${c.account}`);
    console.log("=".repeat(100));

    let account;
    try {
      account = getAccountCredentials(c.account);
    } catch (err) {
      console.log(`  SKIPPED — ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    const dayLoMs = lisbonEpoch(c.day, 0) - PAD_HOURS * 3_600_000;
    const dayHiMs = lisbonEpoch(addDays(c.day, 1), 0) + PAD_HOURS * 3_600_000;
    const dateBegin = fmtTrackitDate(dayLoMs);
    const dateEnd = fmtTrackitDate(dayHiMs);

    let travels: Array<{
      ini?: { timestampUTC?: string | null; lat?: number | null; lng?: number | null } | null;
      end?: { timestampUTC?: string | null; lat?: number | null; lng?: number | null } | null;
    }>;
    try {
      travels = (await getVehicleTravels(account, c.vehicleId, dateBegin, dateEnd)) as unknown as typeof travels;
    } catch (err) {
      console.log(`  /vehicleTravels FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    const toMs = (v: string) => new Date(`${v.replace(" ", "T")}Z`).getTime();
    const sorted = travels
      .filter((t) => t.ini?.timestampUTC && t.end?.timestampUTC && t.ini?.lat != null && t.end?.lat != null)
      .sort((a, b) => a.ini!.timestampUTC!.localeCompare(b.ini!.timestampUTC!));

    const candidates: Candidate[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const arrLat = cur.end!.lat!;
      const arrLng = cur.end!.lng!;
      const depLat = next.ini!.lat!;
      const depLng = next.ini!.lng!;
      const buffer = [{ lat: arrLat, lng: arrLng }, { lat: depLat, lng: depLng }];
      const centroidLat = (arrLat + depLat) / 2;
      const centroidLng = (arrLng + depLng) / 2;
      candidates.push({
        arrMs: toMs(cur.end!.timestampUTC!),
        depMs: toMs(next.ini!.timestampUTC!),
        arrLat,
        arrLng,
        depLat,
        depLng,
        matched: matchStopLocation(buffer, centroidLat, centroidLng, locations),
      });
    }
    console.log(`  vehicleTravels-derived candidates: ${candidates.length}`);

    const { data: stopRows, error: stopErr } = await sb
      .from("stops")
      .select("location_id, arrived_at, departed_at, status")
      .eq("vehicle_id", c.vehicleId)
      .eq("trackit_account", c.account)
      .gte("arrived_at", new Date(dayLoMs).toISOString())
      .lt("arrived_at", new Date(dayHiMs).toISOString())
      .order("arrived_at", { ascending: true });
    if (stopErr) throw stopErr;
    const stops = (stopRows ?? []) as Array<{
      location_id: string | null;
      arrived_at: string;
      departed_at: string | null;
      status: string;
    }>;
    console.log(`  our \`stops\` rows (account=${c.account}): ${stops.length}\n`);

    // side-by-side, matched by nearest arrival time, union of both timelines
    type Row = {
      arrived_stops: string;
      departed_stops: string;
      location_stops: string;
      arrived_candidate: string;
      departed_candidate: string;
      location_candidate: string;
      darr_min: string;
      ddep_min: string;
      location_agrees: string;
    };
    const rows: Row[] = [];
    const usedCandidates = new Set<number>();
    for (const s of stops) {
      const sArrMs = new Date(s.arrived_at).getTime();
      const sDepMs = s.departed_at ? new Date(s.departed_at).getTime() : null;
      const loc = s.location_id ? locationsById.get(s.location_id) : null;
      let best: Candidate | null = null;
      let bestIdx = -1;
      candidates.forEach((cand, idx) => {
        if (best === null || Math.abs(cand.arrMs - sArrMs) < Math.abs(best.arrMs - sArrMs)) {
          best = cand;
          bestIdx = idx;
        }
      });
      if (best) usedCandidates.add(bestIdx);
      const b = best as Candidate | null;
      const candLoc = b?.matched;
      rows.push({
        arrived_stops: s.arrived_at,
        departed_stops: s.departed_at ?? `(${s.status})`,
        location_stops: loc ? `${loc.code} "${loc.name}"` : "(unmatched)",
        arrived_candidate: b ? new Date(b.arrMs).toISOString() : "",
        departed_candidate: b ? new Date(b.depMs).toISOString() : "",
        location_candidate: candLoc
          ? `${candLoc.code} "${candLoc.name}"${candLoc.colocated_with_id ? ` (colocated w/ ${locationsById.get(candLoc.colocated_with_id)?.code ?? "?"})` : ""}`
          : b
            ? "(no radius match)"
            : "(no candidate)",
        darr_min: b ? String(Math.round((b.arrMs - sArrMs) / 60_000)) : "",
        ddep_min: b && sDepMs != null ? String(Math.round((b.depMs - sDepMs) / 60_000)) : "",
        location_agrees: loc && candLoc ? String(loc.id === candLoc.id) : "n/a",
      });
    }
    // candidates with no nearby stop row at all (pure vehicleTravels-only finds)
    candidates.forEach((cand, idx) => {
      if (usedCandidates.has(idx)) return;
      const candLoc = cand.matched;
      rows.push({
        arrived_stops: "",
        departed_stops: "(no stops row nearby)",
        location_stops: "",
        arrived_candidate: new Date(cand.arrMs).toISOString(),
        departed_candidate: new Date(cand.depMs).toISOString(),
        location_candidate: candLoc ? `${candLoc.code} "${candLoc.name}"` : "(no radius match)",
        darr_min: "",
        ddep_min: "",
        location_agrees: "n/a",
      });
    });
    rows.sort((a, b) => (a.arrived_stops || a.arrived_candidate).localeCompare(b.arrived_stops || b.arrived_candidate));

    for (const r of rows) {
      console.log(
        `  stops: ${(r.arrived_stops || "—").slice(11, 16)}->${(typeof r.departed_stops === "string" && r.departed_stops.startsWith("2026") ? r.departed_stops.slice(11, 16) : r.departed_stops).padEnd(14)} ${r.location_stops.padEnd(28)} | ` +
          `candidate: ${(r.arrived_candidate || "—").slice(11, 16)}->${(r.departed_candidate || "—").slice(11, 16)} ${r.location_candidate.padEnd(30)} ` +
          `Δarr=${r.darr_min || "—"}min Δdep=${r.ddep_min || "—"}min  agree=${r.location_agrees}`,
      );
    }

    const agreeCount = rows.filter((r) => r.location_agrees === "true").length;
    const disagreeCount = rows.filter((r) => r.location_agrees === "false").length;
    console.log(`\n  location agreement (both sides had a match): ${agreeCount} agree, ${disagreeCount} disagree\n`);

    const header = Object.keys(rows[0] ?? {});
    const csvLines = [header.join(","), ...rows.map((r) => header.map((h) => csvCell((r as any)[h])).join(","))];
    const outPath = resolve(OUT_DIR, `${c.plate.replace(/[^A-Za-z0-9]/g, "")}-${c.day}.csv`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, csvLines.join("\n") + "\n", "utf-8");
    console.log(`  CSV written to ${outPath}\n`);
  }

  console.log("Done. No DB writes were made, match_stop_location itself was not touched.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
