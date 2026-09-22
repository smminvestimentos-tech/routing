// One-off, READ-ONLY 3-way comparison for a single deeply-investigated case:
// BG-96-ID, 2026-09-21, TRACKiT "default" account.
//
// Ground truth: Transpogest export pasted by the operator (already in Lisbon
// local time, HH:MM, no seconds) — 22 stops across the whole day. Hardcoded
// below verbatim, not re-derived or guessed.
//
// For each Transpogest stop, finds the nearest-by-arrival-time candidate in:
//   (a) our `stops` table (trackit_account = 'default', to avoid the near-
//       duplicate rows this vehicle produces across both TRACKiT accounts —
//       see scripts/compare-vehicletravels-vs-stops.ts's findings)
//   (b) TRACKiT /vehicleTravels, with a "stop" derived as the gap between one
//       travel's `end` and the next travel's `ini` (vehicleTravels has no
//       native stop record — see compare-vehicletravels-vs-stops.ts)
// and reports arrival/departure deltas in minutes (Lisbon local, so it lines
// up directly with the Transpogest numbers as given).
//
// Writes nothing to the DB, changes no production code.
//
// Usage: npx tsx scripts/compare-3way-bg96id-20260921.ts

import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getAccountCredentials, getVehicleTravels } from "../src/lib/trackit/http";

config({ path: resolve(process.cwd(), ".env.local") });

const DAY = "2026-09-21";
const VEHICLE_ID = 1062417; // BG-96-ID, resolved earlier via vehicle_pings
const ACCOUNT_ID = "default";
const PAD_HOURS = 6;

// --- Transpogest ground truth, as pasted (Lisbon local, HH:MM) -------------
type TgRow = { label: string; arr: string; dep: string };
const TRANSPOGEST: TgRow[] = [
  { label: "Armazém Vialonga (Hub)", arr: "00:00", dep: "02:33" },
  { label: "01 — Armazém Azambuja", arr: "02:57", dep: "03:05" },
  { label: "7005 — Aucham Congelados", arr: "03:07", dep: "04:20" },
  { label: "01 — Armazém Azambuja", arr: "04:21", dep: "04:28" },
  { label: "7003 — Salvesen", arr: "04:29", dep: "05:14" },
  { label: "B67 — SU Cascais_CasalQuei", arr: "06:13", dep: "07:16" },
  { label: "B82 — SU Rio Mouro_MáximoS", arr: "07:31", dep: "08:10" },
  { label: "Sem POI (38.7490,-9.2834)", arr: "08:20", dep: "08:21" },
  { label: "Sem POI (39.0495,-8.9129)", arr: "09:08", dep: "09:16" },
  { label: "01 — Armazém Azambuja", arr: "09:22", dep: "09:28" },
  { label: "7005 — Aucham Congelados", arr: "09:30", dep: "10:19" },
  { label: "01 — Armazém Azambuja", arr: "10:19", dep: "10:59" },
  { label: "29 — Alverca", arr: "11:24", dep: "12:17" },
  { label: "Armazém Vialonga (Hub)", arr: "12:22", dep: "12:59" },
  { label: "01 — Armazém Azambuja", arr: "13:21", dep: "13:36" },
  { label: "7001 — Armazém-Azambuja", arr: "13:37", dep: "14:44" },
  { label: "01 — Armazém Azambuja", arr: "14:45", dep: "15:45" },
  { label: "Sem POI (39.0359,-8.9348)", arr: "15:51", dep: "15:58" },
  { label: "Sem POI (38.7167,-9.4376)", arr: "16:59", dep: "17:00" },
  { label: "B67 — SU Cascais_CasalQuei", arr: "17:02", dep: "18:30" },
  { label: "Sem POI (38.7027,-9.4163)", arr: "18:46", dep: "19:45" },
  { label: "AUCHAN-03 — ARMAZÉM ALVERCA", arr: "20:30", dep: "20:33" },
];

// Lisbon is UTC+1 in September (WEST/DST) — same assumption used throughout
// this codebase (see src/lib/sheet-match/common.ts's lisbonEpoch).
const LISBON_OFFSET_MIN = 60;

function lisbonHmToUtcMs(day: string, hm: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - LISBON_OFFSET_MIN * 60_000;
}

function utcMsToLisbonHm(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms + LISBON_OFFSET_MIN * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

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

type Candidate = { arrMs: number; depMs: number | null; label: string };

function nearest(candidates: Candidate[], targetArrMs: number): Candidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    Math.abs(c.arrMs - targetArrMs) < Math.abs(best.arrMs - targetArrMs) ? c : best,
  );
}

function deltaMin(a: number | null, b: number | null): string {
  if (a == null || b == null) return "—";
  return `${a - b >= 0 ? "+" : ""}${Math.round((a - b) / 60_000)}`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const account = getAccountCredentials(ACCOUNT_ID);

  const dayLoMs = lisbonHmToUtcMs(DAY, "00:00") - PAD_HOURS * 3_600_000;
  const dayHiMs = lisbonHmToUtcMs(addDays(DAY, 1), "00:00") + PAD_HOURS * 3_600_000;

  // --- our `stops`, default account only --------------------------------
  const { data: locRows } = await sb.from("locations").select("id, code, name");
  const locationsById = new Map((locRows ?? []).map((l: any) => [l.id, l]));
  const { data: stopRows, error: stopErr } = await sb
    .from("stops")
    .select("location_id, arrived_at, departed_at")
    .eq("vehicle_id", VEHICLE_ID)
    .eq("trackit_account", ACCOUNT_ID)
    .gte("arrived_at", new Date(dayLoMs).toISOString())
    .lt("arrived_at", new Date(dayHiMs).toISOString())
    .order("arrived_at", { ascending: true });
  if (stopErr) throw stopErr;
  const stopCandidates: Candidate[] = (stopRows ?? []).map((s: any) => {
    const loc = s.location_id ? locationsById.get(s.location_id) : null;
    return {
      arrMs: new Date(s.arrived_at).getTime(),
      depMs: s.departed_at ? new Date(s.departed_at).getTime() : null,
      label: loc ? `${loc.code} "${loc.name}"` : "(unmatched)",
    };
  });

  // --- /vehicleTravels, derive gaps as "stops" ---------------------------
  const dateBegin = fmtTrackitDate(dayLoMs);
  const dateEnd = fmtTrackitDate(dayHiMs);
  const travels = (await getVehicleTravels(account, VEHICLE_ID, dateBegin, dateEnd)) as unknown as Array<{
    ini?: { timestampUTC?: string | null; fractal?: unknown; poi?: number | null } | null;
    end?: { timestampUTC?: string | null; fractal?: unknown; poi?: number | null } | null;
  }>;
  const sorted = travels
    .filter((t) => t.ini?.timestampUTC && t.end?.timestampUTC)
    .sort((a, b) => a.ini!.timestampUTC!.localeCompare(b.ini!.timestampUTC!));
  const toMs = (v: string) => new Date(`${v.replace(" ", "T")}Z`).getTime();
  const travelCandidates: Candidate[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    travelCandidates.push({
      arrMs: toMs(cur.end!.timestampUTC!),
      depMs: toMs(next.ini!.timestampUTC!),
      label: String(cur.end?.fractal ?? next.ini?.fractal ?? "?"),
    });
  }

  console.log(`BG-96-ID / ${DAY} — 3-way comparison (all times Lisbon local, HH:MM)\n`);
  console.log(`our \`stops\` candidates (account=default): ${stopCandidates.length}`);
  console.log(`vehicleTravels-derived gap candidates: ${travelCandidates.length}\n`);

  const rows: Array<Record<string, string>> = [];
  for (const tg of TRANSPOGEST) {
    const tgArrMs = lisbonHmToUtcMs(DAY, tg.arr);
    const tgDepMs = lisbonHmToUtcMs(DAY, tg.dep);

    const sCand = nearest(stopCandidates, tgArrMs);
    const tCand = nearest(travelCandidates, tgArrMs);

    const row = {
      transpogest: `${tg.label}`,
      tg_window: `${tg.arr}→${tg.dep}`,
      stops_label: sCand?.label ?? "(no candidate)",
      stops_window: sCand ? `${utcMsToLisbonHm(sCand.arrMs)}→${utcMsToLisbonHm(sCand.depMs)}` : "—",
      stops_darr: sCand ? deltaMin(sCand.arrMs, tgArrMs) : "—",
      stops_ddep: sCand && sCand.depMs != null ? deltaMin(sCand.depMs, tgDepMs) : "—",
      travels_label: tCand?.label ?? "(no candidate)",
      travels_window: tCand ? `${utcMsToLisbonHm(tCand.arrMs)}→${utcMsToLisbonHm(tCand.depMs)}` : "—",
      travels_darr: tCand ? deltaMin(tCand.arrMs, tgArrMs) : "—",
      travels_ddep: tCand && tCand.depMs != null ? deltaMin(tCand.depMs, tgDepMs) : "—",
    };
    rows.push(row);
    console.log(
      `TG: ${tg.label.padEnd(30)} ${row.tg_window}\n` +
        `  stops:    ${row.stops_label.padEnd(30)} ${row.stops_window.padEnd(13)} Δarr=${row.stops_darr}min Δdep=${row.stops_ddep}min\n` +
        `  travels:  ${row.travels_label.padEnd(30)} ${row.travels_window.padEnd(13)} Δarr=${row.travels_darr}min Δdep=${row.travels_ddep}min\n`,
    );
  }

  // --- summary stats -------------------------------------------------------
  const abs = (s: string) => (s === "—" ? null : Math.abs(Number(s)));
  const stopsArrDeltas = rows.map((r) => abs(r.stops_darr)).filter((x): x is number => x != null);
  const stopsDepDeltas = rows.map((r) => abs(r.stops_ddep)).filter((x): x is number => x != null);
  const travelsArrDeltas = rows.map((r) => abs(r.travels_darr)).filter((x): x is number => x != null);
  const travelsDepDeltas = rows.map((r) => abs(r.travels_ddep)).filter((x): x is number => x != null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  console.log("=".repeat(80));
  console.log("SUMMARY (|delta| in minutes, across all 22 Transpogest stops)");
  console.log("=".repeat(80));
  console.log(
    `stops:    arrival  mean=${mean(stopsArrDeltas).toFixed(1)} median=${median(stopsArrDeltas)}  ` +
      `(n=${stopsArrDeltas.length}/22)`,
  );
  console.log(
    `stops:    departure mean=${mean(stopsDepDeltas).toFixed(1)} median=${median(stopsDepDeltas)}  ` +
      `(n=${stopsDepDeltas.length}/22)`,
  );
  console.log(
    `travels:  arrival  mean=${mean(travelsArrDeltas).toFixed(1)} median=${median(travelsArrDeltas)}  ` +
      `(n=${travelsArrDeltas.length}/22)`,
  );
  console.log(
    `travels:  departure mean=${mean(travelsDepDeltas).toFixed(1)} median=${median(travelsDepDeltas)}  ` +
      `(n=${travelsDepDeltas.length}/22)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
