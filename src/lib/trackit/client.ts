import "server-only";

const BASE_URL = "https://trackit.targatelematics.com/api";

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

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

// TRACKiT enforces a global ~1 request/second limit per account (observed as
// a 200-OK business error, not HTTP 429: "wait 1000ms between requests").
// Every call funnels through this pacer so callers can freely issue several
// requests without needing to know about the limit themselves.
const MIN_REQUEST_INTERVAL_MS = 1100;
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRequest(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}

const RATE_LIMIT_MESSAGE_RE = /wait \d+ms between requests/i;

function authHeader(): string {
  const user = process.env.TRACKIT_USER;
  const pass = process.env.TRACKIT_PASS;
  if (!user || !pass) {
    throw new Error("TRACKIT_USER / TRACKIT_PASS not configured");
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function callTrackitOnce<T>(path: string, init?: RequestInit): Promise<T> {
  await paceRequest();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
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

async function callTrackit<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    try {
      const result = await callTrackitOnce<T>(path, init);
      // TEMPORARY: retry diagnostics — remove once the 15s/request
      // bottleneck is understood.
      console.log(
        `[retry] ${path} attempt ${attempt}/${MAX_ATTEMPTS} SUCCEEDED after ${Date.now() - attemptStart}ms`,
      );
      return result;
    } catch (err) {
      const attemptMs = Date.now() - attemptStart;
      lastError = err;
      const transient = err instanceof TrackitError ? err.transient : true;
      const message = err instanceof Error ? err.message : String(err);

      if (!transient || attempt === MAX_ATTEMPTS) {
        // TEMPORARY: retry diagnostics — remove once the 15s/request
        // bottleneck is understood.
        console.log(
          `[retry] ${path} attempt ${attempt}/${MAX_ATTEMPTS} FINAL FAILURE after ${attemptMs}ms: transient=${transient} error="${message}"`,
        );
        throw err;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      // TEMPORARY: retry diagnostics — remove once the 15s/request
      // bottleneck is understood.
      console.log(
        `[retry] ${path} attempt ${attempt}/${MAX_ATTEMPTS} failed after ${attemptMs}ms: transient=${transient} error="${message}" — backing off ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

export function getPois(): Promise<TrackitPoi[]> {
  return callTrackit<TrackitPoi[]>("/poi/0");
}

export function getVehiclesForUser(): Promise<TrackitVehicle[]> {
  return callTrackit<TrackitVehicle[]>("/vehiclesForUser");
}

export function getVehicleTravels(
  vehicleId: number,
  dateBegin: string,
  dateEnd: string,
): Promise<TrackitTravel[]> {
  return callTrackit<TrackitTravel[]>("/vehicleTravels?v=1", {
    method: "POST",
    body: JSON.stringify({ vehicleId, dateBegin, dateEnd }),
  });
}
