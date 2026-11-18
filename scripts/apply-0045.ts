// 0045 — Pátio Azambuja: docas do 7001 a norte sem local (13-15 e 24-25).
// Mapa de docas do relatório do armazém (05-11 e 29-09): cargas 7001 nas docas
// 13-15 (≈39.04432,-8.92049) e 24-25 (≈39.04365,-8.91975) caíam em "sem local".
// Cria 7001-D13 e 7001-D24 (centro_distribuicao, colocated_with 7001) e atribui
// só paragens fechadas SEM local desde 2026-09-01 dentro do raio.
//
//   npx tsx scripts/apply-0045.ts            # dry-run
//   npx tsx scripts/apply-0045.ts --apply    # aplica; cópia em data/backfill-0045-backup.json
//   npx tsx scripts/apply-0045.ts --revert   # desativa os 2 locais e repõe location_id = null
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BACKUP = "data/backfill-0045-backup.json";
const R = Number(process.argv.find((a) => a.startsWith("--r="))?.slice(4) ?? 50);
const NEW_LOCS = [
  { code: "7001-D13", name: "Armazém-Azambuja — docas 13-15", latitude: 39.04432, longitude: -8.92049, radius_meters: R },
  { code: "7001-D24", name: "Armazém-Azambuja — docas 24-25", latitude: 39.04365, longitude: -8.91975, radius_meters: R },
];
function hav(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<NonNullable<T>> {
  const { data, error } = await p; if (error) throw new Error(error.message); return data as NonNullable<T>;
}
(async () => {
  if (REVERT) {
    if (!existsSync(BACKUP)) throw new Error(`sem ${BACKUP}`);
    const ids: string[] = JSON.parse(readFileSync(BACKUP, "utf8")).map((c: any) => c.id);
    for (let i = 0; i < ids.length; i += 300) await must(sb.from("stops").update({ location_id: null, updated_at: new Date().toISOString() }).in("id", ids.slice(i, i + 300)));
    await must(sb.from("locations").update({ active: false, updated_at: new Date().toISOString() }).in("code", NEW_LOCS.map((l) => l.code)));
    return console.log(`revertido: ${ids.length} paragens sem local; 7001-D13/D24 desativados`);
  }
  const locs = await must(sb.from("locations").select("id,code,address,locality,latitude,longitude,radius_meters,active").eq("active", true));
  const l7001 = locs.find((l: any) => l.code === "7001")!;
  for (const nl of NEW_LOCS) {
    const near = locs.filter((l: any) => l.latitude != null && !l.code.startsWith(nl.code))
      .map((l: any) => ({ code: l.code, gap: Math.round(hav(nl.latitude, nl.longitude, l.latitude, l.longitude) - l.radius_meters - nl.radius_meters) }))
      .filter((x) => x.gap < 50).sort((a, b) => a.gap - b.gap);
    console.log(nl.code, "r", nl.radius_meters, "folga para vizinhos (m, <0 = sobrepõe):", JSON.stringify(near));
  }
  if (APPLY) for (const nl of NEW_LOCS) {
    const ex = locs.find((l: any) => l.code === nl.code);
    const row = { ...nl, type: "centro_distribuicao", address: l7001.address, locality: l7001.locality, active: true, colocated_with_id: l7001.id, updated_at: new Date().toISOString() };
    if (ex) await must(sb.from("locations").update(row).eq("id", ex.id)); else await must(sb.from("locations").insert(row));
  }
  const after = APPLY ? await must(sb.from("locations").select("id,code").in("code", NEW_LOCS.map((l) => l.code)).eq("active", true)) : [];
  const scope: any[] = [];
  for (let f = 0; ; f += 1000) {
    const page = await must(sb.from("stops").select("id,centroid_lat,centroid_lng,arrived_at").eq("status", "closed").is("location_id", null)
      .gte("arrived_at", "2026-09-01T00:00:00Z").gte("centroid_lat", 39.042).lte("centroid_lat", 39.046).gte("centroid_lng", -8.923).lte("centroid_lng", -8.917)
      .order("id").range(f, f + 999));
    scope.push(...page); if (page.length < 1000) break;
  }
  const changes: { id: string; to: string }[] = []; const tally: Record<string, number> = {};
  for (const s of scope) {
    let best: { code: string; d: number } | null = null;
    for (const nl of NEW_LOCS) { const d = hav(s.centroid_lat, s.centroid_lng, nl.latitude, nl.longitude); if (d <= nl.radius_meters && (!best || d < best.d)) best = { code: nl.code, d }; }
    if (!best) continue;
    tally[best.code] = (tally[best.code] ?? 0) + 1;
    changes.push({ id: s.id, to: best.code });
  }
  console.log(`${APPLY ? "APLICAR" : "DRY-RUN"}: ${scope.length} paragens sem local na caixa; atribuídas:`, tally);
  if (!APPLY) return;
  writeFileSync(BACKUP, JSON.stringify(changes));
  for (const nl of after) {
    const ids = changes.filter((c) => c.to === nl.code).map((c) => c.id);
    for (let i = 0; i < ids.length; i += 300) await must(sb.from("stops").update({ location_id: nl.id, updated_at: new Date().toISOString() }).in("id", ids.slice(i, i + 300)));
  }
  console.log(`feito. cópia em ${BACKUP}`);
})();
