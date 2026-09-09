/*
 * One-off backfill of `vehicle_pings` for the `azambuja` TRACKiT account.
 *
 * The live poll for this account only started mid-afternoon on 2026-09-09, so
 * the whole morning (and the overnight delivery cycle it belongs to) is
 * missing. This pulls that gap from TRACKiT's `/vehicleHistoric` endpoint —
 * raw position points, one vehicle at a time — and upserts them into
 * `vehicle_pings` (NOT route_legs). Then optionally re-runs `detect_stops` for
 * the account so the corresponding `stops` get generated.
 *
 * Resumable: a progress file (data/.backfill-azambuja-pings.json) records which
 * vehicles are done, so an interrupted run continues where it stopped. The
 * upsert is idempotent (ON CONFLICT DO NOTHING on
 * trackit_account+vehicle_id+recorded_at), so overlapping the live data is
 * harmless.
 *
 * Rate limit: every TRACKiT call funnels through the ~1.1s/req pacer in
 * src/lib/trackit/http.ts, keyed on the account id — so this stays within the
 * ~1 req/s the account allows without contending with the live poll's own
 * account budget.
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/backfill-azambuja-pings.ts [opts]
 *     --vehicles 693700,123      only these vehicle ids (smoke test)
 *     --limit 5                  only the first N vehicles
 *     --from "2026-09-08 23:00:00"   UTC start (default: 00:00 Lisbon of 09-09)
 *     --to   "2026-09-09 17:00:00"   UTC end   (default: 17:00 UTC 09-09, just
 *                                    past the live-poll handoff; dedup covers
 *                                    the overlap)
 *     --detect-stops             after backfill, wipe azambuja stops for the
 *                                backfilled vehicles and re-run detect_stops in
 *                                time-slices (one call over the whole day
 *                                exceeds the DB statement timeout)
 *     --skip-backfill            go straight to detect_stops (pings already in)
 *     --no-clear                 don't wipe stops first — resume the slice walk
 *     --thin-existing            thin already-inserted azambuja pings in the
 *                                window to MIN_PING_GAP_SEC (one-time cleanup
 *                                for a run made before on-write thinning)
 *     --reset                    ignore the progress file
 *     --dry-run                  fetch + parse + report, no DB writes
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  getAccountCredentials,
  getVehicleHistoric,
  getVehiclesForUser,
  parseHistoricPoint,
  type TrackitAccount,
} from "../src/lib/trackit/http";

config({ path: resolve(process.cwd(), ".env.local") });

function makeClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type DB = ReturnType<typeof makeClient>;

const ACCOUNT_ID = "azambuja";
const PROGRESS_PATH = resolve(process.cwd(), "data/.backfill-azambuja-pings.json");
const VEHICLE_BATCH = 10; // flush to DB every N vehicles
const UPSERT_CHUNK = 1000;
// `/vehicleHistoric` returns ~1 point every 28s. That's ~20x denser than the
// live poll (15 min) and detect_stops — which re-walks a vehicle's pings from
// its last stop on every call — chokes on it (statement timeout) when
// reprocessing a whole day. Thin to one point per this many seconds on the way
// in; a stop is minutes long, so detection is unaffected.
const MIN_PING_GAP_SEC = 180;

type Args = {
  vehicles: number[] | null;
  limit: number | null;
  from: string | null;
  to: string | null;
  detectStops: boolean;
  skipBackfill: boolean;
  noClear: boolean;
  thinExisting: boolean;
  reset: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    vehicles: null,
    limit: null,
    from: null,
    to: null,
    detectStops: false,
    skipBackfill: false,
    noClear: false,
    thinExisting: false,
    reset: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--vehicles")
      a.vehicles = argv[++i].split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--from") a.from = argv[++i];
    else if (k === "--to") a.to = argv[++i];
    else if (k === "--detect-stops") a.detectStops = true;
    else if (k === "--skip-backfill") a.skipBackfill = true;
    else if (k === "--no-clear") a.noClear = true;
    else if (k === "--thin-existing") a.thinExisting = true;
    else if (k === "--reset") a.reset = true;
    else if (k === "--dry-run") a.dryRun = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

// "YYYY-MM-DD HH:MM:SS" in UTC — the format /vehicleHistoric expects (same as
// getVehicleTravels).
function fmtTrackitDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

// 00:00 Lisbon of 2026-09-09. Portugal is UTC+1 in September (WEST).
function defaultFrom(): string {
  return fmtTrackitDate(new Date("2026-09-08T23:00:00.000Z"));
}

// A little past when the live poll took over (~16:11 UTC). Fixed (not `now()`)
// so re-runs without --to still match the progress file and resume.
function defaultTo(): string {
  return fmtTrackitDate(new Date("2026-09-09T17:00:00.000Z"));
}

type Progress = { from: string; to: string; done: number[]; pingsUpserted: number };

function loadProgress(from: string, to: string, reset: boolean): Progress {
  if (!reset && existsSync(PROGRESS_PATH)) {
    try {
      const p = JSON.parse(readFileSync(PROGRESS_PATH, "utf-8")) as Progress;
      if (p.from === from && p.to === to) return p;
      console.log(
        `progress file is for a different range (${p.from} .. ${p.to}); starting fresh`,
      );
    } catch {
      /* fall through */
    }
  }
  return { from, to, done: [], pingsUpserted: 0 };
}

function saveProgress(p: Progress) {
  mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
  writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  const supabase = makeClient(supabaseUrl, serviceKey);

  const account = getAccountCredentials(ACCOUNT_ID); // throws if creds missing

  const fromStr = args.from ?? defaultFrom();
  const toStr = args.to ?? defaultTo();
  console.log(`account=${ACCOUNT_ID}  window(UTC): ${fromStr}  ..  ${toStr}`);
  if (args.dryRun) console.log("DRY RUN — no DB writes");

  const progress = loadProgress(fromStr, toStr, args.reset);
  const processedThisRun: number[] = [];

  if (!args.skipBackfill) {
    // Vehicle list + plate map (historic points carry no plate).
    const vehicles = await getVehiclesForUser(account);
    const plateByVehicle = new Map<number, string | null>();
    for (const v of vehicles) {
      const info = (v.info ?? {}) as { plate?: unknown };
      plateByVehicle.set(v.mid, typeof info.plate === "string" ? info.plate : null);
    }
    let vids = [...plateByVehicle.keys()];
    console.log(`fleet: ${vids.length} vehicles`);
    if (args.vehicles) vids = vids.filter((id) => args.vehicles!.includes(id));
    if (args.limit != null) vids = vids.slice(0, args.limit);

    await runBackfill(supabase, account, args, fromStr, toStr, vids, plateByVehicle, progress, processedThisRun);
  } else {
    console.log("--skip-backfill: pings assumed already in vehicle_pings");
  }

  if (args.thinExisting) {
    await thinExistingPings(supabase, fromStr, toStr);
  }

  if (!args.detectStops) {
    console.log(
      "\nSkipping detect_stops (pass --detect-stops to regenerate azambuja stops).",
    );
    return;
  }
  await runDetectStops(supabase, args, fromStr, toStr, progress, processedThisRun);
}

async function runBackfill(
  supabase: DB,
  account: TrackitAccount,
  args: Args,
  fromStr: string,
  toStr: string,
  vids: number[],
  plateByVehicle: Map<number, string | null>,
  progress: Progress,
  processedThisRun: number[],
) {
  const doneSet = new Set(progress.done);
  const todo = vids.filter((id) => !doneSet.has(id));
  console.log(
    `to process: ${todo.length}` +
      (doneSet.size ? ` (${progress.done.length} already done, skipping)` : ""),
  );
  if (todo.length === 0) {
    console.log("nothing to backfill");
    return;
  }

  let batchRows: Array<Record<string, unknown>> = [];
  let totalPoints = 0;
  let totalRows = 0;

  const flush = async () => {
    if (batchRows.length === 0) return;
    // de-dupe within the batch on the table's unique key
    const byKey = new Map<string, Record<string, unknown>>();
    for (const r of batchRows) byKey.set(`${r.vehicle_id}|${r.recorded_at}`, r);
    const rows = [...byKey.values()];
    batchRows = [];
    if (args.dryRun) {
      totalRows += rows.length;
      return;
    }
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { error } = await supabase
        .from("vehicle_pings")
        .upsert(chunk, {
          onConflict: "trackit_account,vehicle_id,recorded_at",
          ignoreDuplicates: true,
        });
      if (error) throw new Error(`vehicle_pings upsert failed: ${error.message}`);
      totalRows += chunk.length;
    }
  };

  for (let i = 0; i < todo.length; i++) {
    const vid = todo[i];
    const plate = plateByVehicle.get(vid) ?? null;
    let points;
    try {
      points = await getVehicleHistoric(account, vid, fromStr, toStr);
    } catch (err) {
      console.error(
        `  vehicle ${vid}: FAILED — ${err instanceof Error ? err.message : String(err)} (will retry on next run)`,
      );
      continue;
    }

    // thin to MIN_PING_GAP_SEC resolution, in chronological order
    const sorted = points
      .map(parseHistoricPoint)
      .filter((p) => p.recordedAt && p.latitude != null && p.longitude != null)
      .sort((a, b) => (a.recordedAt! < b.recordedAt! ? -1 : 1));
    let lastKeptMs = -Infinity;
    let kept = 0;
    for (const p of sorted) {
      const tMs = new Date(p.recordedAt!).getTime();
      if (tMs - lastKeptMs < MIN_PING_GAP_SEC * 1000) continue;
      lastKeptMs = tMs;
      batchRows.push({
        trackit_account: ACCOUNT_ID,
        vehicle_id: p.vehicleId || vid,
        plate,
        latitude: p.latitude,
        longitude: p.longitude,
        speed_kmh: p.speedKmh == null ? null : Math.round(p.speedKmh),
        odometer_km: p.odometerKm,
        recorded_at: p.recordedAt,
        trackit_poi_id: null,
        trackit_poi_distance_m: null,
      });
      kept++;
    }
    totalPoints += points.length;
    processedThisRun.push(vid);
    progress.done.push(vid);
    console.log(
      `  [${i + 1}/${todo.length}] vehicle ${vid} (${plate ?? "—"}): ${points.length} points, ${kept} kept`,
    );

    if ((i + 1) % VEHICLE_BATCH === 0) {
      await flush();
      progress.pingsUpserted = totalRows;
      if (!args.dryRun) saveProgress(progress);
      console.log(`  … flushed (${totalRows} rows upserted so far)`);
    }
  }
  await flush();
  progress.pingsUpserted = totalRows;
  if (!args.dryRun) saveProgress(progress);

  console.log(
    `\nbackfill done: ${processedThisRun.length} vehicles this run, ` +
      `${totalPoints} points fetched, ${totalRows} ping rows ${args.dryRun ? "(dry-run)" : "upserted"}.`,
  );
}

// One-time: thin azambuja pings already in the DB for [from,to) down to
// MIN_PING_GAP_SEC resolution (per vehicle). Pages through id+vehicle_id+
// recorded_at, keeps the first ping of each time bucket, deletes the rest.
async function thinExistingPings(supabase: DB, fromStr: string, toStr: string) {
  const fromISO = new Date(`${fromStr.replace(" ", "T")}Z`).toISOString();
  const toISO = new Date(`${toStr.replace(" ", "T")}Z`).toISOString();
  console.log(`\nthin-existing: scanning azambuja pings ${fromISO} .. ${toISO}…`);

  const PAGE = 1000;
  const lastKeptMs = new Map<number, number>();
  const deleteIds: string[] = [];
  let scanned = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("vehicle_pings")
      .select("id, vehicle_id, recorded_at")
      .eq("trackit_account", ACCOUNT_ID)
      .gte("recorded_at", fromISO)
      .lt("recorded_at", toISO)
      .order("vehicle_id", { ascending: true })
      .order("recorded_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`thin scan failed: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      const vid = r.vehicle_id as number;
      const tMs = new Date(r.recorded_at as string).getTime();
      const prev = lastKeptMs.get(vid);
      if (prev != null && tMs - prev < MIN_PING_GAP_SEC * 1000) {
        deleteIds.push(r.id as string);
      } else {
        lastKeptMs.set(vid, tMs);
      }
    }
    scanned += rows.length;
    if (rows.length < PAGE) break;
  }
  console.log(
    `thin-existing: scanned ${scanned}, keeping ${scanned - deleteIds.length}, deleting ${deleteIds.length}…`,
  );

  const DEL = 300;
  const CONC = 4;
  let done = 0;
  for (let i = 0; i < deleteIds.length; i += DEL * CONC) {
    const jobs = [];
    for (let j = 0; j < CONC; j++) {
      const slice = deleteIds.slice(i + j * DEL, i + (j + 1) * DEL);
      if (slice.length === 0) break;
      jobs.push(
        supabase
          .from("vehicle_pings")
          .delete()
          .in("id", slice)
          .then(({ error }) => {
            if (error) throw new Error(`thin delete failed: ${error.message}`);
            done += slice.length;
          }),
      );
    }
    await Promise.all(jobs);
    if (done % (DEL * CONC * 5) < DEL * CONC)
      console.log(`  … deleted ${done}/${deleteIds.length}`);
  }
  console.log(`thin-existing: done (deleted ${done})`);
}

// detect_stops takes only (account, p_now) and walks every ping since each
// vehicle's last stop. Reprocessing the whole backfilled day for 182 vehicles
// in one call exceeds the DB statement timeout, so we advance `p_now` in
// slices — each call is its own transaction that commits, leaving a trailing
// open stop the next slice resumes from (exactly how the 15-min cron uses it).
// The step is adaptive: it halves on a timeout and retries from the last
// committed `p_now`. It does NOT grow back — the busy midday period needs a
// small step and re-growing just wastes calls re-hitting the timeout; the
// walk still finishes, and the whole thing is a one-off.
const DETECT_STEP_START_MIN = 60;
const DETECT_STEP_MIN_MIN = 5;
const TIMEOUT_RE = /statement timeout|canceling statement/i;

async function runDetectStops(
  supabase: DB,
  args: Args,
  fromStr: string,
  toStr: string,
  progress: Progress,
  processedThisRun: number[],
) {
  if (args.dryRun) {
    console.log("\ndetect_stops: (dry-run — skipped)");
    return;
  }

  if (args.noClear) {
    console.log("\ndetect_stops: --no-clear, resuming from existing stops");
  } else {
    // The backfilled pings sit BEFORE the account's existing (live-poll) stops,
    // and detect_stops resumes forward from each vehicle's last stop — so the
    // account's stops must be cleared for it to reprocess the whole day. This
    // is a one-off full regen; the live cron rebuilds forward from here.
    const vids = new Set<number>([...progress.done, ...processedThisRun]);
    console.log(
      vids.size
        ? `\ndetect_stops: clearing azambuja stops for ${vids.size} backfilled vehicle(s)…`
        : "\ndetect_stops: clearing ALL azambuja stops (full regen)…",
    );
    if (vids.size) {
      const list = [...vids];
      for (let i = 0; i < list.length; i += 500) {
        const { error } = await supabase
          .from("stops")
          .delete()
          .eq("trackit_account", ACCOUNT_ID)
          .in("vehicle_id", list.slice(i, i + 500));
        if (error) throw new Error(`stops delete failed: ${error.message}`);
      }
    } else {
      const { error } = await supabase
        .from("stops")
        .delete()
        .eq("trackit_account", ACCOUNT_ID);
      if (error) throw new Error(`stops delete failed: ${error.message}`);
    }
  }

  const start = new Date(`${fromStr.replace(" ", "T")}Z`).getTime();
  const end = Math.max(
    new Date(`${toStr.replace(" ", "T")}Z`).getTime(),
    Date.now(),
  );
  console.log(
    `detect_stops: walking ${new Date(start).toISOString()} .. ${new Date(end).toISOString()} in adaptive slices…`,
  );

  let stepMs = DETECT_STEP_START_MIN * 60_000;
  const minStepMs = DETECT_STEP_MIN_MIN * 60_000;
  let cursor = start;
  let totalUpserted = 0;
  let slices = 0;

  while (cursor < end) {
    const pNowMs = Math.min(cursor + stepMs, end);
    const pNow = new Date(pNowMs).toISOString();
    const { data, error } = await supabase.rpc("detect_stops", {
      p_trackit_account: ACCOUNT_ID,
      p_now: pNow,
    });
    if (error) {
      if (TIMEOUT_RE.test(error.message) && stepMs > minStepMs) {
        stepMs = Math.max(minStepMs, Math.floor(stepMs / 2));
        console.log(`  p_now=${pNow}: TIMEOUT — shrinking step to ${stepMs / 60000}min and retrying`);
        continue;
      }
      throw new Error(`detect_stops failed at p_now=${pNow}: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{ stops_upserted: number }>;
    const up = rows.reduce((s, r) => s + r.stops_upserted, 0);
    totalUpserted += up;
    slices++;
    console.log(
      `  p_now=${pNow} (step ${stepMs / 60000}min): ${rows.length} vehicles, ${up} stops upserted`,
    );
    cursor = pNowMs;
  }
  console.log(
    `detect_stops: done — ${slices} slices, ${totalUpserted} stops upserted total.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
