import "server-only";

const BASE_URL = "https://trackit.targatelematics.com/api";

// A resolved TRACKiT account: a stable id (also used as the `trackit_account`
// column value everywhere the sync writes) plus its Basic-auth credentials.
export type TrackitAccount = {
  id: string;
  user: string;
  pass: string;
};

// Every account this codebase knows how to talk to, in priority order. An
// entry with either credential half missing in the current environment is
// dropped by getConfiguredAccounts() below — so a preview/staging env that
// only has the default pair set still works, it just syncs one account.
const ACCOUNT_ENV: Array<{ id: string; user?: string; pass?: string }> = [
  { id: "default", user: process.env.TRACKIT_USER, pass: process.env.TRACKIT_PASS },
  { id: "azambuja", user: process.env.TRACKIT_USER_2, pass: process.env.TRACKIT_PASS_2 },
];

/**
 * The accounts that are actually usable in this environment (both
 * TRACKIT_USER* and TRACKIT_PASS* present). Callers iterate this so adding a
 * third account is just another ACCOUNT_ENV row.
 */
export function getConfiguredAccounts(): TrackitAccount[] {
  return ACCOUNT_ENV.filter(
    (a): a is TrackitAccount => Boolean(a.user) && Boolean(a.pass),
  );
}

/**
 * Resolve one account by id, throwing if it isn't configured here. Use when a
 * caller needs a specific account (e.g. the "default" one) rather than
 * iterating them all.
 */
export function getAccountCredentials(accountId: string): TrackitAccount {
  const account = getConfiguredAccounts().find((a) => a.id === accountId);
  if (!account) {
    throw new Error(
      `TRACKiT account "${accountId}" is not configured (missing TRACKIT_USER*/TRACKIT_PASS*)`,
    );
  }
  return account;
}

export type TrackitPoi = {
  id: number;
  id_external?: string | null;
  type?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
};

export type TrackitVehicle = {
  mid: number;
  [key: string]: unknown;
};

// Parsed from a `vehiclesForUser` element. TRACKiT's raw JSON is deeply
// nested and inconsistent across vehicles (confirmed via real payload
// inspection: e.g. `data.pos.loc.lat/lon`, `data.pos.gsp`, `data.pos.gkm`).
export type TrackitVehiclePosition = {
  vehicleId: number;
  plate: string | null;
  latitude: number | null;
  longitude: number | null;
  speedKmh: number | null;
  odometerKm: number | null;
  recordedAt: string | null; // ISO 8601, confirmed via real payload (data.pos.tmx)
  // TRACKiT already matches the position against its own POI dataset
  // (trackit_pois) when close enough — free signal, captured for later
  // cross-validation against our own locations-based stop matching.
  trackitPoiId: number | null;
  trackitPoiDistanceM: number | null;
};

function normalizeTrackitTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseVehiclePosition(v: TrackitVehicle): TrackitVehiclePosition {
  const info = (v.info ?? {}) as Record<string, unknown>;
  const data = (v.data ?? {}) as Record<string, unknown>;
  const pos = (data.pos ?? {}) as Record<string, unknown>;
  const drs = (data.drs ?? {}) as Record<string, unknown>;
  const loc = (pos.loc ?? {}) as Record<string, unknown>;
  const poi = (pos.poi ?? null) as { info?: { id?: number }; dist?: number } | null;

  return {
    vehicleId: v.mid,
    plate: typeof info.plate === "string" ? info.plate : null,
    latitude: typeof loc.lat === "number" ? loc.lat : null,
    longitude: typeof loc.lon === "number" ? loc.lon : null,
    speedKmh: typeof pos.gsp === "number" ? pos.gsp : null,
    odometerKm:
      typeof pos.gkm === "number" ? pos.gkm : typeof drs.ckm === "number" ? drs.ckm : null,
    recordedAt: normalizeTrackitTimestamp(pos.tmx),
    trackitPoiId: typeof poi?.info?.id === "number" ? poi.info.id : null,
    trackitPoiDistanceM: typeof poi?.dist === "number" ? poi.dist : null,
  };
}

export type TrackitTravelPoint = {
  timestamp?: string | null;
  km?: number | null;
  poi?: number | null;
  lat?: number | null;
  lng?: number | null;
};

export type TrackitTravel = {
  mid: string;
  ymd?: string | null;
  total_drive?: number | null;
  total_km?: number | null;
  avg_speed?: number | null;
  ini?: TrackitTravelPoint | null;
  end?: TrackitTravelPoint | null;
};

type TrackitDocument<T> = {
  error?: string | null;
  code?: string | null;
  message?: string | null;
  data?: T | null;
};

export class TrackitError extends Error {
  transient: boolean;
  status?: number;

  constructor(message: string, opts: { transient: boolean; status?: number }) {
    super(message);
    this.name = "TrackitError";
    this.transient = opts.transient;
    this.status = opts.status;
  }
}

// 30s, not 20s: a TRACKiT tenant with a large fleet (observed: ~180 vehicles)
// can take 20-30s just to build the /vehiclesForUser payload, and a 20s cap was
// tripping the timeout and burning all 3 retries (~60s) before eventually
// succeeding. vehicleTravels is ~15s server-side, comfortably inside 30s too.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

// TRACKiT enforces a global ~1 request/second limit *per account* (observed as
// a 200-OK business error, not HTTP 429: "wait 1000ms between requests").
// Every call funnels through this pacer so callers can freely issue several
// requests without needing to know about the limit themselves. State is keyed
// by account id: distinct accounts have distinct limits, so their calls never
// wait on each other and can run fully in parallel; only calls sharing an
// account id are serialised.
const MIN_REQUEST_INTERVAL_MS = 1100;
const nextRequestAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRequest(accountId: string): Promise<void> {
  const now = Date.now();
  const scheduled = nextRequestAt.get(accountId) ?? 0;
  const waitMs = Math.max(0, scheduled - now);
  // Reserve this account's slot synchronously (before any await) so concurrent
  // callers on the same account queue up deterministically.
  nextRequestAt.set(accountId, Math.max(now, scheduled) + MIN_REQUEST_INTERVAL_MS);
  if (waitMs > 0) await sleep(waitMs);
}

const RATE_LIMIT_MESSAGE_RE = /wait \d+ms between requests/i;

function authHeader(account: TrackitAccount): string {
  return `Basic ${Buffer.from(`${account.user}:${account.pass}`).toString("base64")}`;
}

async function callTrackitOnce<T>(
  account: TrackitAccount,
  path: string,
  init?: RequestInit,
): Promise<T> {
  await paceRequest(account.id);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(account),
        "Content-Type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or our own timeout abort — worth retrying.
    throw new TrackitError(
      `TRACKiT ${path} request failed: ${err instanceof Error ? err.message : String(err)}`,
      { transient: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Rate limiting and server errors are worth retrying; anything else
    // (auth, bad request, not found) will just fail the same way again.
    const transient = res.status === 429 || res.status >= 500;
    throw new TrackitError(`TRACKiT ${path} responded ${res.status} ${res.statusText}`, {
      transient,
      status: res.status,
    });
  }

  const doc = (await res.json()) as TrackitDocument<T>;
  if (doc.error) {
    // Belt-and-braces: the pacer above should prevent this, but treat it as
    // transient if it still slips through (e.g. another process sharing the
    // same account) so a retry — not an immediate failure — follows.
    const isRateLimit = RATE_LIMIT_MESSAGE_RE.test(doc.message ?? doc.error ?? "");
    throw new TrackitError(`TRACKiT ${path} error: ${doc.message ?? doc.error}`, {
      transient: isRateLimit,
    });
  }

  return (doc.data ?? ([] as unknown as T));
}

async function callTrackit<T>(
  account: TrackitAccount,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callTrackitOnce<T>(account, path, init);
    } catch (err) {
      lastError = err;
      const transient = err instanceof TrackitError ? err.transient : true;
      if (!transient || attempt === MAX_ATTEMPTS) throw err;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await sleep(delay);
    }
  }

  throw lastError;
}

export function getPois(account: TrackitAccount): Promise<TrackitPoi[]> {
  return callTrackit<TrackitPoi[]>(account, "/poi/0");
}

export function getVehiclesForUser(account: TrackitAccount): Promise<TrackitVehicle[]> {
  return callTrackit<TrackitVehicle[]>(account, "/vehiclesForUser");
}

export function getVehicleTravels(
  account: TrackitAccount,
  vehicleId: number,
  dateBegin: string,
  dateEnd: string,
): Promise<TrackitTravel[]> {
  return callTrackit<TrackitTravel[]>(account, "/vehicleTravels?v=1", {
    method: "POST",
    body: JSON.stringify({ vehicleId, dateBegin, dateEnd }),
  });
}
