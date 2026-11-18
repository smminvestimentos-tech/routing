// 0046 — códigos da folha que apontam para locais existentes + pino da Lactogal
// Oliveira de Azeméis (auditoria de locais 18-11-2026, confirmada pelo utilizador).
//
//  1. Aliases INATIVOS com merged_into_id (padrão da 0030 — o matcher resolve
//     o código da folha para o canónico; a deteção de paragens só usa ativos):
//       C750O -> C75O   Lactogal Oliveira Azeméis
//       A136T -> A136   S&A Taveiro / S.I.A.
//       N126C -> N126   Nestlé Carreras / Nestlé
//  2. C75O: pino movido para onde os camiões param (mediana das paragens sem
//     local a ≤200 m de 40.836,-8.487 nos últimos 30 dias), tipo fornecedor.
//  3. Paragens fechadas SEM local desde 2026-09-01 dentro do novo raio → C75O.
//
//   npx tsx scripts/apply-0046.ts            # dry-run
//   npx tsx scripts/apply-0046.ts --apply    # aplica; cópia em data/backfill-0046-backup.json
//   npx tsx scripts/apply-0046.ts --revert
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BACKUP = "data/backfill-0046-backup.json";
const ALIASES = [
  { code: "C750O", target: "C75O", name: "Lactogal Oliveira Azemeis" },
  { code: "A136T", target: "A136", name: "S&A Taveiro" },
  { code: "N126C", target: "N126", name: "Nestlé Carreras" },
];
const CLUSTER = { lat: 40.836, lng: -8.487 };
const RADIUS = 200;

function hav(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

(async () => {
  if (REVERT) {
    if (!existsSync(BACKUP)) throw new Error(`sem ${BACKUP}`);
    const b = JSON.parse(readFileSync(BACKUP, "utf8"));
    for (let i = 0; i < b.stopIds.length; i += 300)
      await must(sb.from("stops").update({ location_id: null, updated_at: new Date().toISOString() }).in("id", b.stopIds.slice(i, i + 300)));
    await must(sb.from("locations").update({ ...b.c75oBefore, updated_at: new Date().toISOString() }).eq("code", "C75O"));
    await must(sb.from("locations").delete().in("id", b.aliasIds));
    return console.log(`revertido: ${b.stopIds.length} paragens sem local, C75O reposto, ${b.aliasIds.length} aliases apagados`);
  }

  const codes = [...ALIASES.map((a) => a.code), ...ALIASES.map((a) => a.target), "A73"];
  const locs = await must(sb.from("locations").select("id,code,name,type,active,latitude,longitude,radius_meters,merged_into_id").in("code", codes));
  const by = new Map(locs.map((l: any) => [l.code, l]));
  for (const a of ALIASES) {
    const t = by.get(a.target), ex = by.get(a.code);
    console.log(`alias ${a.code} -> ${a.target} (${t ? `"${t.name}" ${t.active ? "ativo" : "INATIVO"}` : "ALVO NÃO EXISTE"})${ex ? `  [já existe: ${ex.active ? "ativo" : "inativo"}, merged ${ex.merged_into_id ?? "-"}]` : ""}`);
    if (!t || !t.active) throw new Error(`alvo ${a.target} inválido`);
  }

  // pino novo da C75O
  const c75o = by.get("C75O")!;
  const near = await must(sb.from("stops").select("id,centroid_lat,centroid_lng,vehicle_id,duration_minutes").is("location_id", null).eq("status", "closed")
    .gte("arrived_at", new Date(Date.now() - 30 * 864e5).toISOString()).gte("duration_minutes", 10)
    .gte("centroid_lat", CLUSTER.lat - 0.004).lte("centroid_lat", CLUSTER.lat + 0.004).gte("centroid_lng", CLUSTER.lng - 0.005).lte("centroid_lng", CLUSTER.lng + 0.005));
  const pts = near.filter((s: any) => hav(s.centroid_lat, s.centroid_lng, CLUSTER.lat, CLUSTER.lng) <= 200);
  const newPin = { latitude: +med(pts.map((s: any) => s.centroid_lat)).toFixed(6), longitude: +med(pts.map((s: any) => s.centroid_lng)).toFixed(6) };
  const a73 = by.get("A73");
  console.log(`C75O pino ${c75o.latitude.toFixed(5)},${c75o.longitude.toFixed(5)} r${c75o.radius_meters} -> ${newPin.latitude},${newPin.longitude} r${RADIUS} ` +
    `(base: ${pts.length} paragens, ${new Set(pts.map((s: any) => s.vehicle_id)).size} viaturas; desloca ${Math.round(hav(c75o.latitude, c75o.longitude, newPin.latitude, newPin.longitude))} m)`);
  if (a73) console.log(`  folga para A73 "${a73.name}" r${a73.radius_meters}: ${Math.round(hav(newPin.latitude, newPin.longitude, a73.latitude, a73.longitude) - a73.radius_meters - RADIUS)} m (<0 = sobrepõe)`);

  // backfill
  const scope = await must(sb.from("stops").select("id,centroid_lat,centroid_lng").is("location_id", null).eq("status", "closed").gte("arrived_at", "2026-09-01T00:00:00Z")
    .gte("centroid_lat", newPin.latitude - 0.003).lte("centroid_lat", newPin.latitude + 0.003).gte("centroid_lng", newPin.longitude - 0.004).lte("centroid_lng", newPin.longitude + 0.004));
  const ids = scope.filter((s: any) => hav(s.centroid_lat, s.centroid_lng, newPin.latitude, newPin.longitude) <= RADIUS).map((s: any) => s.id);
  console.log(`${APPLY ? "APLICAR" : "DRY-RUN"}: ${ids.length} paragens sem local passam a C75O`);
  if (!APPLY) return;

  const aliasIds: string[] = [];
  for (const a of ALIASES) {
    const t = by.get(a.target)!;
    const row = { code: a.code, name: a.name, type: t.type ?? "fornecedor", active: false, merged_into_id: t.id, updated_at: new Date().toISOString() };
    const ex = by.get(a.code);
    if (ex) { await must(sb.from("locations").update(row).eq("id", ex.id)); }
    else { const ins = await must(sb.from("locations").insert(row).select("id").single()); aliasIds.push((ins as any).id); }
  }
  const c75oBefore = { latitude: c75o.latitude, longitude: c75o.longitude, radius_meters: c75o.radius_meters, type: c75o.type };
  await must(sb.from("locations").update({ ...newPin, radius_meters: RADIUS, type: "fornecedor", updated_at: new Date().toISOString() }).eq("id", c75o.id));
  for (let i = 0; i < ids.length; i += 300)
    await must(sb.from("stops").update({ location_id: c75o.id, updated_at: new Date().toISOString() }).in("id", ids.slice(i, i + 300)));
  writeFileSync(BACKUP, JSON.stringify({ aliasIds, c75oBefore, stopIds: ids }));
  console.log(`feito. cópia em ${BACKUP}`);
})();
