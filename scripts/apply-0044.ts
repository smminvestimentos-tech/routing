// Aplica supabase/migrations/0044_yard_7005_cais_7001_docas_so.sql pela API
// (service role), com cópia de segurança das paragens alteradas.
//
//   npx tsx scripts/apply-0044.ts            # dry-run: só conta
//   npx tsx scripts/apply-0044.ts --apply    # aplica e grava data/backfill-0044-backup.json
//   npx tsx scripts/apply-0044.ts --revert   # repõe 7005, desativa 7001-SON/SOS e as paragens do backup

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BACKUP = "data/backfill-0044-backup.json";

const NEW_7005 = { latitude: 39.04244, longitude: -8.920872, radius_meters: 25 };
const OLD_7005 = { latitude: 39.042528952161, longitude: -8.92070763033689, radius_meters: 75 };
const NEW_LOCS = [
  { code: "7001-SON", name: "Armazém-Azambuja — docas SO (noroeste)", latitude: 39.043163, longitude: -8.921499, radius_meters: 75 },
  { code: "7001-SOS", name: "Armazém-Azambuja — docas SO (sudeste)", latitude: 39.042083, longitude: -8.920562, radius_meters: 30 },
];

function hav(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

async function revert() {
  if (!existsSync(BACKUP)) throw new Error(`sem ${BACKUP}`);
  const rows: { id: string; from: string | null }[] = JSON.parse(readFileSync(BACKUP, "utf8"));
  await must(sb.from("locations").update({ ...OLD_7005, updated_at: new Date().toISOString() }).eq("code", "7005"));
  const byFrom = new Map<string | null, string[]>();
  for (const r of rows) (byFrom.get(r.from) ?? byFrom.set(r.from, []).get(r.from)!).push(r.id);
  for (const [from, ids] of byFrom)
    for (let i = 0; i < ids.length; i += 300)
      await must(sb.from("stops").update({ location_id: from, updated_at: new Date().toISOString() }).in("id", ids.slice(i, i + 300)));
  await must(sb.from("locations").update({ active: false, updated_at: new Date().toISOString() }).in("code", NEW_LOCS.map((l) => l.code)));
  console.log(`revertido: 7005 reposto, ${rows.length} paragens repostas, 7001-SON/SOS desativados`);
}

(async () => {
  if (REVERT) return revert();

  const yardBase = await must(sb.from("locations").select("id,code,address,locality,latitude,longitude,radius_meters,active").in("code", ["7001", "7005", ...NEW_LOCS.map((l) => l.code)]));
  const l7001 = yardBase.find((l: any) => l.code === "7001" && l.active)!;
  const l7005 = yardBase.find((l: any) => l.code === "7005" && l.active)!;

  // 1 + 2 (only when applying)
  if (APPLY) {
    await must(sb.from("locations").update({ ...NEW_7005, updated_at: new Date().toISOString() }).eq("id", l7005.id));
    for (const nl of NEW_LOCS) {
      const ex = yardBase.find((l: any) => l.code === nl.code);
      const row = { ...nl, type: "centro_distribuicao", address: l7001.address, locality: l7001.locality, active: true, colocated_with_id: l7001.id, updated_at: new Date().toISOString() };
      if (ex) await must(sb.from("locations").update(row).eq("id", ex.id));
      else await must(sb.from("locations").insert(row));
    }
  }
  const after = await must(sb.from("locations").select("id,code,latitude,longitude,radius_meters").in("code", ["7001", "7005", ...NEW_LOCS.map((l) => l.code)]).eq("active", true));
  // in dry-run, model the new geometry in memory
  const geo: { id: string; code: string; lat: number; lng: number; r: number }[] = APPLY
    ? after.map((l: any) => ({ id: l.id, code: l.code, lat: l.latitude, lng: l.longitude, r: l.radius_meters }))
    : [
        { id: l7001.id, code: "7001", lat: l7001.latitude, lng: l7001.longitude, r: l7001.radius_meters },
        { id: l7005.id, code: "7005", lat: NEW_7005.latitude, lng: NEW_7005.longitude, r: NEW_7005.radius_meters },
        ...NEW_LOCS.map((l) => ({
          id: after.find((a: any) => a.code === l.code)?.id ?? `new:${l.code}`,
          code: l.code, lat: l.latitude, lng: l.longitude, r: l.radius_meters,
        })),
      ];
  const yardIds = new Set([l7001.id, l7005.id, ...after.filter((l: any) => l.code.startsWith("7001-SO")).map((l: any) => l.id)]);
  const codeOf = new Map<string | null, string>([[null, "sem local"], ...geo.map((g) => [g.id, g.code] as [string, string]), [l7005.id, "7005"], [l7001.id, "7001"]]);

  // 3. backfill scope: closed stops since 2026-09-01, ≤ 400 m of the 7005 cais, no location or a yard one
  const scope: any[] = [];
  for (let f = 0; ; f += 1000) {
    const page = await must(sb.from("stops").select("id,location_id,centroid_lat,centroid_lng")
      .eq("status", "closed").gte("arrived_at", "2026-09-01T00:00:00Z")
      .gte("centroid_lat", 39.0385).lte("centroid_lat", 39.0465).gte("centroid_lng", -8.9255).lte("centroid_lng", -8.9159)
      .order("id").range(f, f + 999));
    scope.push(...page);
    if (page.length < 1000) break;
  }
  const changes: { id: string; from: string | null; to: string | null }[] = [];
  for (const s of scope) {
    if (s.centroid_lat == null) continue;
    if (s.location_id != null && !yardIds.has(s.location_id)) continue;
    if (hav(s.centroid_lat, s.centroid_lng, 39.042529, -8.920708) > 400) continue;
    let best: { id: string; d: number } | null = null;
    for (const g of geo) {
      const d = hav(s.centroid_lat, s.centroid_lng, g.lat, g.lng);
      if (d <= g.r && (!best || d < best.d || (d === best.d && g.id < best.id))) best = { id: g.id, d };
    }
    const to = best?.id ?? null;
    // the 7001 pin didn't move: leave its stops alone unless they now belong
    // to one of the new SW docks or the 7005 cais
    if (s.location_id === l7001.id && to === null) continue;
    if (to !== s.location_id) changes.push({ id: s.id, from: s.location_id, to });
  }
  const tally: Record<string, number> = {};
  for (const c of changes) { const k = `${codeOf.get(c.from) ?? c.from} -> ${codeOf.get(c.to) ?? c.to}`; tally[k] = (tally[k] ?? 0) + 1; }
  console.log(`${APPLY ? "APLICAR" : "DRY-RUN"}: ${scope.length} paragens na área, ${changes.length} mudam`);
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(26)} ${n}`);
  if (!APPLY) return;

  writeFileSync(BACKUP, JSON.stringify(changes));
  const byTo = new Map<string | null, string[]>();
  for (const c of changes) (byTo.get(c.to) ?? byTo.set(c.to, []).get(c.to)!).push(c.id);
  for (const [to, ids] of byTo)
    for (let i = 0; i < ids.length; i += 300)
      await must(sb.from("stops").update({ location_id: to, updated_at: new Date().toISOString() }).in("id", ids.slice(i, i + 300)));
  console.log(`feito. cópia das ${changes.length} paragens alteradas em ${BACKUP}`);
})();
