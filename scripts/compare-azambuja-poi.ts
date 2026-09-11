// Compares our `locations` table against data/azambuja_poi_reference.csv
// (the TRACKiT Azambuja account's POI list: code, name, latitude, longitude, raio, validado).
//
//   npx tsx scripts/compare-azambuja-poi.ts
//
// IMPORTANT: the POI CSV's `code` values are bare numbers (12, 14, 24, 25, ...)
// that can collide with unrelated codes in our `locations` table with zero
// relation to the Auchan network. A matching code is NOT sufficient evidence
// of a real match — the location name must also make sense against the POI
// name (tolerant comparison: strip accents, lowercase, drop generic words
// like "auchan").
//
// Read-only. Writes two CSVs, never touches the DB:
//   - data/azambuja-poi-safe-matches.csv   (name matches, coord/radius differ -> update candidates)
//   - data/azambuja-poi-name-collisions.csv (code matches, name doesn't -> different systems, do not touch)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

const CSV_PATH = resolve(process.cwd(), "data/azambuja_poi_reference.csv");
const OUT_SAFE = resolve(process.cwd(), "data/azambuja-poi-safe-matches.csv");
const OUT_COLLISIONS = resolve(process.cwd(), "data/azambuja-poi-name-collisions.csv");

type PoiRow = { code: string; name: string; latitude: string; longitude: string; raio: string; validado: string };

type LocationRow = {
  id: number;
  code: string;
  name: string | null;
  type: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number | null;
  active: boolean | null;
};

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

// "ma" = our internal abbreviation for "My Auchan"; "pb" = "Preço(s) Baixo(s)".
// Both are brand/format prefixes, same role as "auchan" itself -> drop them all.
const STOPWORDS = new Set([
  "auchan",
  "my",
  "ma",
  "pb",
  "loja",
  "hipermercado",
  "supermercado",
  "de",
  "da",
  "do",
  "das",
  "dos",
]);

const ABBREVIATIONS: Record<string, string> = {
  sto: "santo",
  sta: "santa",
};

function normalizeName(raw: string): string {
  const stripped = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((tok) => ABBREVIATIONS[tok] ?? tok)
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok));
  return stripped.join(" ").trim();
}

// Token-set similarity: overlap of normalized tokens relative to the smaller name.
// Also checks substring containment either direction, which catches things like
// "Amoreiras" vs "Auchan Amoreiras" (one token, fully contained).
function nameSimilarity(a: string, b: string): { score: number; normA: string; normB: string } {
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (!normA || !normB) return { score: 0, normA, normB };
  if (normA === normB) return { score: 1, normA, normB };

  const tokensA = new Set(normA.split(" "));
  const tokensB = new Set(normB.split(" "));
  const shared = [...tokensA].filter((t) => tokensB.has(t));
  const smaller = Math.min(tokensA.size, tokensB.size);
  const tokenScore = smaller > 0 ? shared.length / smaller : 0;

  const containScore = normA.includes(normB) || normB.includes(normA) ? 1 : 0;

  return { score: Math.max(tokenScore, containScore), normA, normB };
}

const NAME_MATCH_THRESHOLD = 0.5;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const raw = readFileSync(CSV_PATH, "utf-8");
  const poiRows: PoiRow[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const poiByCode = new Map<string, PoiRow>();
  for (const r of poiRows) {
    if (!r.code) continue;
    poiByCode.set(r.code.trim(), r);
  }

  const { data, error } = await sb
    .from("locations")
    .select("id, code, name, type, latitude, longitude, radius_meters, active");
  if (error) throw error;
  const locations = (data ?? []) as LocationRow[];

  type Row = {
    code: string;
    ourName: string | null;
    poiName: string;
    normOur: string;
    normPoi: string;
    similarity: number;
    ourLat: number | null;
    ourLng: number | null;
    poiLat: number;
    poiLng: number;
    distanceM: number | null;
    ourRadius: number | null;
    poiRadius: number;
    active: boolean | null;
  };

  const matches: Row[] = [];
  let matchedCount = 0;

  for (const loc of locations) {
    const poi = poiByCode.get(loc.code);
    if (!poi) continue;
    matchedCount++;

    const poiLat = Number(poi.latitude);
    const poiLng = Number(poi.longitude);
    if (!Number.isFinite(poiLat) || !Number.isFinite(poiLng)) continue;

    const { score, normA, normB } = nameSimilarity(loc.name ?? "", poi.name);

    let distanceM: number | null = null;
    if (loc.latitude != null && loc.longitude != null) {
      distanceM = haversineM(loc.latitude, loc.longitude, poiLat, poiLng);
    }

    matches.push({
      code: loc.code,
      ourName: loc.name,
      poiName: poi.name,
      normOur: normA,
      normPoi: normB,
      similarity: score,
      ourLat: loc.latitude,
      ourLng: loc.longitude,
      poiLat,
      poiLng,
      distanceM,
      ourRadius: loc.radius_meters,
      poiRadius: Number(poi.raio) || 0,
      active: loc.active,
    });
  }

  const safe = matches
    .filter((m) => m.similarity >= NAME_MATCH_THRESHOLD)
    .sort((a, b) => (b.distanceM ?? -1) - (a.distanceM ?? -1));
  const collisions = matches
    .filter((m) => m.similarity < NAME_MATCH_THRESHOLD)
    .sort((a, b) => a.code.localeCompare(b.code));

  console.log(`Locations in DB: ${locations.length}`);
  console.log(`POI rows in CSV: ${poiRows.length}`);
  console.log(`Codes present in both (by bare code): ${matchedCount}`);
  console.log("");
  console.log(`=== GRUPO 1 - nome bate, candidatos seguros a atualizar coordenada/raio: ${safe.length} ===`);
  console.log("");
  for (const m of safe) {
    const distTxt = m.distanceM != null ? `${Math.round(m.distanceM)}m` : "sem coord nossa";
    console.log(
      `code=${m.code.padEnd(6)} sim=${m.similarity.toFixed(2)}  "${m.ourName}"  <->  "${m.poiName}"`
    );
    console.log(
      `  dist=${distTxt}  nosso_raio=${m.ourRadius ?? "?"}m  poi_raio=${m.poiRadius}m  active=${m.active}`
    );
    if (m.ourLat != null && m.ourLng != null) {
      console.log(`  ours: ${m.ourLat}, ${m.ourLng}   poi: ${m.poiLat}, ${m.poiLng}`);
    }
    console.log("");
  }

  console.log(`=== GRUPO 2 - codigo bate mas nome nao bate (colisao entre sistemas, NAO tocar): ${collisions.length} ===`);
  console.log("");
  for (const m of collisions) {
    console.log(`code=${m.code.padEnd(6)} sim=${m.similarity.toFixed(2)}  "${m.ourName}"  <->  "${m.poiName}"`);
  }

  const header =
    "code,our_name,poi_name,norm_our_name,norm_poi_name,similarity,our_lat,our_lng,poi_lat,poi_lng,distance_m,our_radius_m,poi_radius_m,active\n";
  const toRow = (m: Row) =>
    [
      m.code,
      JSON.stringify(m.ourName ?? ""),
      JSON.stringify(m.poiName),
      JSON.stringify(m.normOur),
      JSON.stringify(m.normPoi),
      m.similarity.toFixed(2),
      m.ourLat ?? "",
      m.ourLng ?? "",
      m.poiLat,
      m.poiLng,
      m.distanceM != null ? Math.round(m.distanceM) : "",
      m.ourRadius ?? "",
      m.poiRadius,
      m.active,
    ].join(",");

  writeFileSync(OUT_SAFE, header + safe.map(toRow).join("\n") + "\n", "utf-8");
  writeFileSync(OUT_COLLISIONS, header + collisions.map(toRow).join("\n") + "\n", "utf-8");

  console.log("");
  console.log(`Grupo 1 (candidatos seguros) escrito em: ${OUT_SAFE}`);
  console.log(`Grupo 2 (colisoes, nao tocar) escrito em: ${OUT_COLLISIONS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
