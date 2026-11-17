// Simula o /api/azambuja-sheet para um ficheiro: linhas do pátio com hora
// "da app" (com segundos) são limpas, o resto fica como o operador escreveu.
import { config } from "dotenv";
config({ path: ".env.local" });
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { normalizePlate } from "@/lib/fleet/validate";
import { coLocatedGroupsFromLocations, type DayStop } from "@/lib/sheet-match/common";
import { parsePlanoCargas } from "@/lib/azambuja-sheet/plano";
import { dedupeStops, resolveColumns, runMatch, stopQueryWindowMs, type SheetRecord } from "@/lib/azambuja-sheet/match";
const [file, day] = [process.argv[2], process.argv[3]];
const planoArg = process.argv.find((a) => a.startsWith("--plano="))?.slice(8);
const plan = planoArg ? (parsePlanoCargas(XLSX.readFile(planoArg)) as any).lines : undefined;
const YARD = new Set(["7001", "7005", "7003"]);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function all<T>(q: (a: number, b: number) => any): Promise<T[]> {
  const out: T[] = []; for (let f = 0; ; f += 1000) { const { data, error } = await q(f, f + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; } return out;
}
(async () => {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h).trim());
  const records = XLSX.utils.sheet_to_json<SheetRecord>(ws, { raw: false, defval: "", blankrows: false });
  const cols = resolveColumns(header);
  for (const r of records) {
    const c = String(r[cols.chegadaCol] ?? ""), s = String(r[cols.saidaCol] ?? "");
    if (YARD.has(String(r[cols.codeCol]).trim()) && (c.length === 19 || s.length === 19)) { r[cols.chegadaCol] = ""; r[cols.saidaCol] = ""; }
  }
  const { loMs, hiMs } = stopQueryWindowMs(day, cols.cicloCol ? records.map((r) => r[cols.cicloCol!]) : []);
  const lo = new Date(loMs).toISOString(), hi = new Date(hiMs).toISOString();
  const [stopsRaw, pings, locs] = await Promise.all([
    all<any>((a, b) => sb.from("stops").select("id,vehicle_id,arrived_at,departed_at,centroid_lat,centroid_lng,location:locations(code)").gte("arrived_at", lo).lt("arrived_at", hi).order("arrived_at").order("id").range(a, b)),
    all<any>((a, b) => sb.from("vehicle_pings").select("vehicle_id,plate,recorded_at").gte("recorded_at", lo).lt("recorded_at", hi).not("plate", "is", null).order("recorded_at").order("vehicle_id").range(a, b)),
    all<any>((a, b) => sb.from("locations").select("id,code,type,latitude,longitude,radius_meters,active,merged_into_id,colocated_with_id").range(a, b)),
  ]);
  const tally = new Map<number, Map<string, number>>(); const win = new Map<string, { min: number; max: number }>();
  for (const p of pings) { const np = normalizePlate(String(p.plate)); if (!np) continue; const m = tally.get(p.vehicle_id) ?? new Map(); m.set(np, (m.get(np) ?? 0) + 1); tally.set(p.vehicle_id, m);
    const t = Date.parse(p.recorded_at); const w = win.get(np); if (!w) win.set(np, { min: t, max: t }); else { w.min = Math.min(w.min, t); w.max = Math.max(w.max, t); } }
  const plateBy = new Map<number, string>(); for (const [v, m] of tally) plateBy.set(v, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  const stops: DayStop[] = dedupeStops(stopsRaw.map((s) => ({ id: s.id, vehicleId: s.vehicle_id, plate: plateBy.get(s.vehicle_id) ?? null, code: Array.isArray(s.location) ? s.location[0]?.code ?? null : s.location?.code ?? null, arrivedAt: s.arrived_at, departedAt: s.departed_at, lat: s.centroid_lat, lng: s.centroid_lng })));
  const codeById = new Map(locs.map((l) => [l.id, l.code]));
  const activeCodes = locs.filter((l) => l.active).map((l) => l.code);
  const mergedCodes = locs.filter((l) => !l.active && l.merged_into_id && codeById.get(l.merged_into_id)).map((l) => ({ code: l.code, canonicalCode: codeById.get(l.merged_into_id)! }));
  const codeTypes = new Map<string, string>(locs.filter((l) => l.type).map((l) => [l.code, l.type]));
  const codeCoords = new Map(locs.filter((l) => l.latitude != null).map((l) => [l.code, { lat: l.latitude, lng: l.longitude }]));
  const res = runMatch({ day, records, rawRecords: records, header, cols, stops, platesWithGps: new Set(plateBy.values()), pingWindowByPlate: win, activeCodes, mergedCodes, coLocatedGroups: coLocatedGroupsFromLocations(locs), codeTypes, codeCoords, plan });
  // ---- métricas ----
  const t = (v: unknown) => { const m = String(v ?? "").match(/(\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d)/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null; };
  const byRota = new Map<string, SheetRecord[]>();
  for (const r of res.rows) { const k = String(r[cols.rotaCol]); if (!byRota.has(k)) byRota.set(k, []); byRota.get(k)!.push(r); }
  let yardRows = 0, filled = 0, review = 0, zeroMin = 0, outOfOrder = 0; const bad: string[] = [];
  for (const [rota, rs] of byRota) {
    const del = rs.filter((r) => !YARD.has(String(r[cols.codeCol]).trim()) && t(r[cols.chegadaCol]) != null);
    const firstDel = Math.min(...del.map((r) => t(r[cols.chegadaCol])!)), lastDel = Math.max(...del.map((r) => t(r[cols.saidaCol]) ?? t(r[cols.chegadaCol])!));
    const firstDelIdx = rs.findIndex((r) => !YARD.has(String(r[cols.codeCol]).trim()));
    rs.forEach((r, i) => {
      if (!YARD.has(String(r[cols.codeCol]).trim()) || r["Confiança"] === "Mantido" || String(r["Confiança"]).startsWith("✅ Mantido")) return;
      const a = t(r[cols.chegadaCol]), d = t(r[cols.saidaCol]);
      yardRows++;
      if (a == null) { review++; return; }
      filled++;
      if (d != null && d - a < 60000) zeroMin++;
      const isHead = firstDelIdx < 0 || i < firstDelIdx;
      const wrong = del.length > 0 && (isHead ? a > firstDel : a < lastDel);
      if (wrong) { outOfOrder++; bad.push(`${rota} ${r[cols.codeCol]} ${isHead ? "carga" : "regresso"} ${String(r[cols.chegadaCol]).slice(11)}→${String(r[cols.saidaCol]).slice(11)} (entregas ${new Date(firstDel).toISOString().slice(11, 16)}–${new Date(lastDel).toISOString().slice(11, 16)})`); }
    });
  }
  console.log(JSON.stringify(res.summary));
  if (process.argv.includes("--espera")) for (const r of res.rows) { const t = String(r["Real"] ?? ""); if (/Entrada no pátio|já no pátio/.test(t)) console.log("  ⏱", r[cols.rotaCol], r[cols.codeCol], String(r[cols.chegadaCol]).slice(11, 16), "→", String(r[cols.saidaCol]).slice(11, 16), "|", r["Confiança"], "|", t.slice(0, 220)); }
  console.log(`linhas pátio (não mantidas): ${yardRows} | preenchidas ${filled} | sem hora ${review} | 0 min ${zeroMin} | fora de ordem ${outOfOrder}`);
  if (process.argv.includes("-v")) for (const b of bad) console.log("  ✗", b);
  if (process.argv[4] && !process.argv[4].startsWith("-")) {
    const out = XLSX.utils.json_to_sheet(res.rows, { header: res.header }); const owb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(owb, out, "16"); XLSX.writeFile(owb, process.argv[4]);
  }
})();
