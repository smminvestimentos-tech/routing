// Preview for migration 0033 — re-run of the 0029 fleet-wide backfill now that
// 0028 (radii), 0030 (AUCHAN-4/7092 -> 206 merge), and 0032 (Azambuja POI
// coord/radius sync) have landed since 0029 ran.
//
// Same rule as 0029: a closed stop with no location is attached to the
// ACTIVE location whose circle (radius_meters) contains the stop's stored
// centroid, nearest centre winning, location id a final tie-break.
//
//   npx tsx scripts/preview-backfill-0033.ts
//
// Read-only.

import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function pageAll<T>(
  make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await make(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

type Loc = {
  id: number;
  code: string;
  name: string | null;
  type: string | null;
  radius_meters: number | null;
  latitude: number;
  longitude: number;
};

type Stop = {
  id: string;
  centroid_lat: number | null;
  centroid_lng: number | null;
  trackit_account: string | null;
};

async function main() {
  // 1. Current count: status='closed' AND location_id IS NULL
  const { count: totalClosedNull, error: cErr } = await sb
    .from("stops")
    .select("id", { count: "exact", head: true })
    .eq("status", "closed")
    .is("location_id", null);
  if (cErr) throw cErr;
  console.log(`stops WHERE status='closed' AND location_id IS NULL: ${totalClosedNull}`);
  console.log("");

  const locs = await pageAll<Loc>((f, t) =>
    sb
      .from("locations")
      .select("id, code, name, type, radius_meters, latitude, longitude")
      .eq("active", true)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("id", { ascending: true })
      .range(f, t),
  );
  console.log(`active locations with coords: ${locs.length}`);

  const stops = await pageAll<Stop>((f, t) =>
    sb
      .from("stops")
      .select("id, centroid_lat, centroid_lng, trackit_account")
      .eq("status", "closed")
      .is("location_id", null)
      .not("centroid_lat", "is", null)
      .not("centroid_lng", "is", null)
      .order("id", { ascending: true })
      .range(f, t),
  );
  console.log(`  of which have centroid coords: ${stops.length}`);
  console.log("");

  type Pick = { stopId: string; loc: Loc; dist: number; account: string | null };
  const picks: Pick[] = [];

  for (const s of stops) {
    let best: Loc | null = null;
    let bestDist = Infinity;
    for (const l of locs) {
      const r = l.radius_meters ?? 0;
      if (r <= 0) continue;
      const d = haversineM(s.centroid_lat!, s.centroid_lng!, l.latitude, l.longitude);
      if (d <= r) {
        if (d < bestDist || (d === bestDist && best && l.id < best.id)) {
          best = l;
          bestDist = d;
        }
      }
    }
    if (best) picks.push({ stopId: s.id, loc: best, dist: bestDist, account: s.trackit_account });
  }

  console.log(`=== would resolve: ${picks.length} of ${stops.length} (${totalClosedNull! - stops.length} have no centroid at all and are unreachable by this backfill) ===`);
  console.log(`=== would stay NULL: ${stops.length - picks.length} ===`);
  console.log("");

  type Group = { code: string; name: string; type: string; radius: number; n: number; dmin: number; dmax: number };
  const byLoc = new Map<number, Group>();
  for (const p of picks) {
    let g = byLoc.get(p.loc.id);
    if (!g) {
      g = { code: p.loc.code, name: p.loc.name ?? "", type: p.loc.type ?? "", radius: p.loc.radius_meters ?? 0, n: 0, dmin: Infinity, dmax: -Infinity };
      byLoc.set(p.loc.id, g);
    }
    g.n++;
    g.dmin = Math.min(g.dmin, p.dist);
    g.dmax = Math.max(g.dmax, p.dist);
  }
  const groups = [...byLoc.values()].sort((a, b) => b.n - a.n);

  console.log("CÓDIGO".padEnd(10) + "NOME".padEnd(35) + "TIPO".padEnd(20) + "RAIO".padStart(6) + "  N".padStart(5) + "  d_min".padStart(8) + "  d_max".padStart(8));
  for (const g of groups) {
    console.log(
      g.code.padEnd(10) + g.name.slice(0, 33).padEnd(35) + g.type.padEnd(20) +
      String(g.radius).padStart(6) + String(g.n).padStart(5) +
      `  ${Math.round(g.dmin)}`.padStart(8) + `  ${Math.round(g.dmax)}`.padStart(8)
    );
  }

  console.log("");
  const byAccount = new Map<string, number>();
  for (const p of picks) {
    const k = p.account ?? "(null)";
    byAccount.set(k, (byAccount.get(k) ?? 0) + 1);
  }
  console.log("By trackit_account:");
  for (const [k, v] of byAccount) console.log(`  ${k}: ${v}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
