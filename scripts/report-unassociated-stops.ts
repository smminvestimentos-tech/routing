// One-off analysis: every closed stop with no location_id, across all history.
//
//   npx tsx scripts/report-unassociated-stops.ts
//
// For each such stop, finds the nearest ACTIVE location (by great-circle
// distance, ignoring that location's radius), then:
//   • groups the stops by that nearest location — count, min/median/max
//     distance, and the location's current radius_meters — sorted by count;
//   • separates the stops whose nearest active location is > 1 km away
//     (clustered) — these are candidate MISSING locations / bad coordinates,
//     not mis-calibrated radii.
//
// Read-only. Writes a per-stop CSV next to the script's output for follow-up.

import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const ORPHAN_THRESHOLD_M = 1000; // "no nearby location" cutoff
const CLUSTER_RADIUS_M = 250; // greedy cluster size for orphan stops

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

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r0 = (n: number) => Math.round(n);

async function pageAll<T>(
  make: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
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

type Stop = {
  id: string;
  centroid_lat: number | null;
  centroid_lng: number | null;
  arrived_at: string;
  trackit_account: string | null;
};

async function main() {
  // Which "active" column does this DB use?
  const probe = await sb.from("locations").select("*").limit(1);
  if (probe.error) throw new Error(`locations probe: ${probe.error.message}`);
  const keys = Object.keys(probe.data?.[0] ?? {});
  console.log(`locations columns: ${keys.join(", ")}`);
  const activeCol = keys.includes("is_active")
    ? "is_active"
    : keys.includes("active")
      ? "active"
      : null;
  const typeCol = keys.includes("location_type")
    ? "location_type"
    : keys.includes("type")
      ? "type"
      : keys.includes("category")
        ? "category"
        : null;
  console.log(`active column: ${activeCol ?? "(none)"} | type column: ${typeCol ?? "(none)"}`);

  const locs = await pageAll<Record<string, unknown>>((f, t) => {
    let q = sb
      .from("locations")
      .select(
        ["id", "code", "name", "latitude", "longitude", "radius_meters", typeCol]
          .filter(Boolean)
          .join(", "),
      )
      .not("latitude", "is", null)
      .not("longitude", "is", null);
    if (activeCol) q = q.eq(activeCol, true);
    return q.order("id", { ascending: true }).range(f, t);
  });
  const L = locs.map((l) => ({
    id: String(l.id),
    code: (l.code as string | null) ?? null,
    name: (l.name as string | null) ?? null,
    type: typeCol ? ((l[typeCol] as string | null) ?? "") : "",
    lat: Number(l.latitude),
    lng: Number(l.longitude),
    radius: (l.radius_meters as number | null) ?? 0,
  }));
  console.log(`active locations with coords: ${L.length}`);

  const stops = await pageAll<Stop>((f, t) =>
    sb
      .from("stops")
      .select("id, centroid_lat, centroid_lng, arrived_at, trackit_account")
      .eq("status", "closed")
      .is("location_id", null)
      .not("centroid_lat", "is", null)
      .not("centroid_lng", "is", null)
      .order("arrived_at", { ascending: true })
      .range(f, t),
  );
  console.log(`closed stops with location_id IS NULL (and coords): ${stops.length}\n`);

  type Row = {
    stop: Stop;
    nearest: (typeof L)[number] | null;
    dist: number;
  };
  const rows: Row[] = stops.map((s) => {
    let best: (typeof L)[number] | null = null;
    let bd = Infinity;
    for (const l of L) {
      const d = haversineM(s.centroid_lat!, s.centroid_lng!, l.lat, l.lng);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return { stop: s, nearest: best, dist: bd };
  });

  const near = rows.filter((r) => r.nearest && r.dist <= ORPHAN_THRESHOLD_M);
  const orphan = rows.filter((r) => !r.nearest || r.dist > ORPHAN_THRESHOLD_M);

  // ---- grouped by nearest location ----
  const byLoc = new Map<string, Row[]>();
  for (const r of near) {
    const k = r.nearest!.id;
    let arr = byLoc.get(k);
    if (!arr) byLoc.set(k, (arr = []));
    arr.push(r);
  }
  const groups = [...byLoc.values()]
    .map((rs) => {
      const l = rs[0].nearest!;
      const ds = rs.map((r) => r.dist);
      const within = rs.filter((r) => r.dist <= l.radius).length;
      const justOut = rs.filter((r) => r.dist > l.radius && r.dist <= l.radius + 150).length;
      const dates = rs.map((r) => r.stop.arrived_at).sort();
      return {
        code: l.code ?? "(sem código)",
        name: l.name ?? "",
        type: l.type,
        radius: l.radius,
        n: rs.length,
        within,
        justOut,
        far: rs.length - within - justOut,
        min: r0(Math.min(...ds)),
        med: r0(median(ds)),
        max: r0(Math.max(...ds)),
        first: dates[0]?.slice(0, 10),
        last: dates[dates.length - 1]?.slice(0, 10),
        verdict:
          within === rs.length
            ? "backfill (já dentro do raio)"
            : median(ds) <= l.radius + 150
              ? "raio pequeno demais"
              : "investigar (coords/loja?)",
      };
    })
    .sort((a, b) => b.n - a.n);

  console.log("=".repeat(110));
  console.log(
    `PARAGENS SEM LOCATION, PERTO DE UMA LOCATION ATIVA (≤ ${ORPHAN_THRESHOLD_M} m)  —  ${near.length} paragens, ${groups.length} locations`,
  );
  console.log("=".repeat(110));
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);
  console.log(
    pad("CÓDIGO", 12) + pad("NOME", 30) + padL("N", 5) + padL("RAIO", 7) +
      padL("d.min", 8) + padL("d.med", 8) + padL("d.max", 8) +
      padL("≤raio", 7) + padL("+150m", 7) + padL("longe", 7) + "  " + pad("PERÍODO", 24) + "VEREDICTO",
  );
  console.log("-".repeat(140));
  for (const g of groups) {
    console.log(
      pad(g.code, 12) +
        pad(g.name.slice(0, 28), 30) +
        padL(g.n, 5) +
        padL(g.radius, 7) +
        padL(g.min, 8) +
        padL(g.med, 8) +
        padL(g.max, 8) +
        padL(g.within, 7) +
        padL(g.justOut, 7) +
        padL(g.far, 7) +
        "  " +
        pad(`${g.first}…${g.last}`, 24) +
        g.verdict,
    );
  }

  // ---- orphan clusters ----
  const oc: { lat: number; lng: number; rows: Row[] }[] = [];
  for (const r of orphan) {
    const s = r.stop;
    let c = oc.find(
      (cl) => haversineM(cl.lat, cl.lng, s.centroid_lat!, s.centroid_lng!) <= CLUSTER_RADIUS_M,
    );
    if (!c) {
      c = { lat: s.centroid_lat!, lng: s.centroid_lng!, rows: [] };
      oc.push(c);
    }
    c.rows.push(r);
  }
  const clusters = oc
    .map((c) => {
      const dates = c.rows.map((r) => r.stop.arrived_at).sort();
      const nd = c.rows.map((r) => r.dist).filter((d) => Number.isFinite(d));
      const anyNear = c.rows.find((r) => r.nearest);
      return {
        lat: c.lat,
        lng: c.lng,
        n: c.rows.length,
        first: dates[0]?.slice(0, 10),
        last: dates[dates.length - 1]?.slice(0, 10),
        nearestCode: anyNear?.nearest?.code ?? "—",
        nearestName: anyNear?.nearest?.name ?? "",
        nearestDist: nd.length ? r0(median(nd)) : NaN,
        accounts: [...new Set(c.rows.map((r) => r.stop.trackit_account ?? "?"))].join(","),
      };
    })
    .sort((a, b) => b.n - a.n);

  console.log("\n" + "=".repeat(110));
  console.log(
    `PARAGENS SEM LOCATION PRÓXIMA (> ${ORPHAN_THRESHOLD_M} m da location ativa mais próxima)  —  ${orphan.length} paragens, ${clusters.length} pontos`,
  );
  console.log("candidatas a LOJAS EM FALTA / coordenadas erradas (não a raios mal calibrados)");
  console.log("=".repeat(110));
  console.log(
    pad("LAT, LNG", 26) + padL("N", 5) + "  " + pad("PERÍODO", 24) +
      pad("MAPA", 46) + "LOCATION ATIVA MAIS PRÓXIMA",
  );
  console.log("-".repeat(150));
  for (const c of clusters) {
    console.log(
      pad(`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, 26) +
        padL(c.n, 5) +
        "  " +
        pad(`${c.first}…${c.last}`, 24) +
        pad(`https://maps.google.com/?q=${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, 46) +
        `${c.nearestCode} ${String(c.nearestName).slice(0, 22)} (~${Number.isFinite(c.nearestDist) ? c.nearestDist + " m" : "?"})`,
    );
  }

  // ---- summary ----
  const nWithin = near.filter((r) => r.dist <= r.nearest!.radius).length;
  const nJustOut = near.filter(
    (r) => r.dist > r.nearest!.radius && r.dist <= r.nearest!.radius + 150,
  ).length;
  const nMid = near.length - nWithin - nJustOut;
  console.log("\n" + "=".repeat(110));
  console.log("RESUMO");
  console.log("=".repeat(110));
  console.log(`  total paragens closed sem location .......... ${rows.length}`);
  console.log(`  já dentro do raio de uma location ativa ..... ${nWithin}   -> re-match / backfill (raio está bem)`);
  console.log(`  até 150 m fora do raio ...................... ${nJustOut}   -> raio pequeno demais (ajuste rápido em /dashboard/locations)`);
  console.log(`  150 m .. 1 km de uma location ............... ${nMid}   -> investigar caso a caso`);
  console.log(`  > 1 km de qualquer location ativa .......... ${orphan.length}   -> loja em falta / coordenadas erradas`);

  // ---- CSV ----
  const csvPath = resolve(process.cwd(), "data/unassociated-stops-report.csv");
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    "stop_id,arrived_at,trackit_account,centroid_lat,centroid_lng,nearest_code,nearest_name,nearest_type,dist_m,radius_m,bucket,maps_url",
    ...rows
      .sort((a, b) => a.dist - b.dist)
      .map((r) =>
        [
          r.stop.id,
          r.stop.arrived_at,
          r.stop.trackit_account ?? "",
          r.stop.centroid_lat,
          r.stop.centroid_lng,
          r.nearest?.code ?? "",
          r.nearest?.name ?? "",
          r.nearest?.type ?? "",
          Number.isFinite(r.dist) ? r0(r.dist) : "",
          r.nearest?.radius ?? "",
          !r.nearest || r.dist > ORPHAN_THRESHOLD_M
            ? "orphan"
            : r.dist <= r.nearest.radius
              ? "within_radius"
              : r.dist <= r.nearest.radius + 150
                ? "radius_too_small"
                : "mid",
          `https://maps.google.com/?q=${r.stop.centroid_lat},${r.stop.centroid_lng}`,
        ]
          .map(esc)
          .join(","),
      ),
  ];
  writeFileSync(csvPath, lines.join("\n"));
  console.log(`\nCSV por paragem: ${csvPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
