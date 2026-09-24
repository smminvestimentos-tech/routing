// I/O orchestrator for the TRACKiT /vehicleTravels fallback — the one piece
// of this feature that actually talks to TRACKiT (via src/lib/trackit/http.ts
// directly, the same import style scripts/backfill-azambuja-pings.ts already
// uses, bypassing client.ts's server-only guard) and merges the result with
// each vehicle's real stops. Shared by both sheet routes (azambuja-sheet,
// tfs-sheet) so the deadline/timeout/concurrency/cache logic lives in
// exactly one place — candidate derivation/matching itself stays pure, in
// trackit-candidates.ts.

import {
  getConfiguredAccounts,
  getVehicleTravels,
  type TrackitAccount,
} from "../trackit/http";
import {
  deriveTravelDayStops,
  excludeOverlappingRealStops,
  getCachedTravels,
  setCachedTravels,
  travelsCacheKey,
  type LocationForMatch,
  type RawTravel,
} from "./trackit-candidates";
import type { DayStop, TrackitSkipReason, WStop } from "./common";

// Sem cap à partida: todas as matrículas pendentes entram na fila e é o prazo
// global que decide até onde se chega. Um cap calculado com o pior caso por
// chamada (55s) e como se tudo fosse sequencial dava só 1-2 matrículas por
// pedido, quando as chamadas reais demoram 23-26s e as contas correm em
// paralelo. As que o prazo não alcança ficam com { skipped: "deadline" }.
export const DEFAULT_MAX_DURATION_MS = 150_000;
// Reservado, depois do prazo do fallback, para o pass 2 do matching e o
// ExcelJS. O timeout de cada chamada é cortado ao tempo que falta até ao
// prazo, por isso nenhuma chamada TRACKiT invade esta margem — é isto que
// garante que a rota nunca rebenta o maxDuration.
export const ROUTE_SAFETY_MARGIN_MS = 35_000;

// Timeout máximo por chamada getVehicleTravels(): as chamadas reais demoram
// 23-26s com picos observados até 55s.
export const TRACKIT_FALLBACK_CALL_TIMEOUT_MS = 55_000;

// Não vale a pena começar uma chamada com menos tempo do que isto até ao
// prazo — abaixo das chamadas mais rápidas observadas (~23s), expiraria
// quase sempre e só gastaria um pedido à conta.
export const MIN_CALL_BUDGET_MS = 20_000;

export type TrackitFallbackInput = {
  /** matrículas elegíveis, na ordem em que apareceram na folha (pass 1) */
  pendingPlates: readonly string[];
  vehicleIdByPlate: ReadonlyMap<string, number>;
  /** vehicleId -> contas TRACKiT em que essa matrícula teve pings NESSE dia */
  accountsByVehicle: ReadonlyMap<number, ReadonlySet<string>>;
  /** paragens REAIS (não derivadas do TRACKiT) desse veículo nesse dia */
  realStopsByVehicle: ReadonlyMap<number, DayStop[]>;
  locations: readonly LocationForMatch[];
  /** "YYYY-MM-DD HH:MM:SS" UTC — mesma janela já usada para a query de `stops` */
  dateBegin: string;
  dateEnd: string;
  /** Date.now() no início do pedido HTTP — para o prazo global */
  fnStart: number;
  /** maxDuration da rota em milissegundos (default 150_000ms) */
  maxDurationMs?: number;
  /** margem de segurança reservada para matching pass 2 e ExcelJS (default 35_000ms) */
  safetyMarginMs?: number;
  /** timeout máximo por chamada individual (default TRACKIT_FALLBACK_CALL_TIMEOUT_MS) */
  callTimeoutMs?: number;
  /** tempo mínimo até ao prazo para começar uma chamada (default MIN_CALL_BUDGET_MS) */
  minCallBudgetMs?: number;
  /** só para testes — substitui a chamada real a /vehicleTravels */
  fetchTravels?: typeof getVehicleTravels;
};

export type TrackitFallbackDiagnostics = {
  /** matrículas elegíveis */
  targeted: number;
  /** matrículas com pelo menos uma chamada feita (ou servida da cache) */
  attempted: number;
  /** matrículas que o prazo global não alcançou (nenhuma chamada começou) */
  deadlinePlates: string[];
  /** matrículas com pelo menos uma chamada falhada/expirada */
  failedPlates: string[];
  /**
   * matrícula -> motivo exato da falha (mensagem da exceção ou o timeout da
   * chamada) — só para as matrículas em failedPlates. Diagnóstico, nunca
   * escrito na folha.
   */
  failedPlateReasons: Record<string, string>;
  /** duração de cada chamada real (não cache) a /vehicleTravels, em ms */
  callDurationsMs: number[];
};

export type TrackitFallbackResult = {
  trackitStopsByPlate: Map<string, WStop[] | TrackitSkipReason>;
  diagnostics: TrackitFallbackDiagnostics;
};

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TRACKiT call timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// "YYYY-MM-DD HH:MM:SS" UTC — what /vehicleTravels expects (same format used
// by src/app/api/sync/travels/route.ts's formatTrackitDate).
export function formatTrackitDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export async function resolveTrackitFallback(
  input: TrackitFallbackInput,
): Promise<TrackitFallbackResult> {
  const {
    pendingPlates,
    vehicleIdByPlate,
    accountsByVehicle,
    realStopsByVehicle,
    locations,
    dateBegin,
    dateEnd,
    fnStart,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    safetyMarginMs = ROUTE_SAFETY_MARGIN_MS,
    callTimeoutMs = TRACKIT_FALLBACK_CALL_TIMEOUT_MS,
    minCallBudgetMs = MIN_CALL_BUDGET_MS,
    fetchTravels = getVehicleTravels,
  } = input;

  const trackitStopsByPlate = new Map<string, WStop[] | TrackitSkipReason>();
  const configured = new Map(getConfiguredAccounts().map((a) => [a.id, a]));

  // Resolve vehicleId + contas utilizáveis primeiro, para uma matrícula sem
  // nenhuma das duas nunca ocupar um slot de prazo/timeout à toa.
  type PlanEntry = { plate: string; vehicleId: number; accounts: TrackitAccount[] };
  const plan: PlanEntry[] = [];
  for (const plate of pendingPlates) {
    const vehicleId = vehicleIdByPlate.get(plate);
    if (vehicleId == null) {
      trackitStopsByPlate.set(plate, { skipped: "no-vehicle-id" });
      continue;
    }
    const seenAccounts = accountsByVehicle.get(vehicleId) ?? new Set<string>();
    const accounts = [...seenAccounts]
      .map((id) => configured.get(id))
      .filter((a): a is TrackitAccount => a != null);
    if (accounts.length === 0) {
      // Elegível, mas nenhuma das contas em que a matrícula pingou hoje está
      // configurada neste ambiente — mesmo tratamento que uma chamada falhada.
      trackitStopsByPlate.set(plate, { skipped: "call-failed" });
      continue;
    }
    plan.push({ plate, vehicleId, accounts });
  }

  const failedPlates = new Set<string>();
  const failedPlateReasons = new Map<string, string>();
  const attemptedPlates = new Set<string>();
  const travelsByPlate = new Map<string, RawTravel[]>();
  const successByPlate = new Set<string>();
  const callDurationsMs: number[] = [];

  // Sequencial DENTRO de cada conta (o pacer em http.ts já serializa pedidos
  // à mesma conta — paralelizar aí não ganha nada), paralelo ENTRE contas
  // (ganho real: um veículo como o BG-96-ID existe em "default" E "azambuja").
  const byAccount = new Map<string, PlanEntry[]>();
  for (const entry of plan) {
    for (const account of entry.accounts) {
      const arr = byAccount.get(account.id) ?? [];
      arr.push(entry);
      byAccount.set(account.id, arr);
    }
  }

  const cacheKeyOf = (accountId: string, entry: PlanEntry) =>
    travelsCacheKey(accountId, entry.vehicleId, dateBegin, dateEnd);

  const deadlineMs = fnStart + (maxDurationMs - safetyMarginMs);

  await Promise.all(
    [...byAccount.entries()].map(async ([accountId, entries]) => {
      const account = configured.get(accountId)!;
      // Matrículas já em cache primeiro (custam 0s) — assim um re-upload
      // avança para matrículas novas em vez de repetir sempre as do topo.
      // Estável: dentro de cada grupo mantém a ordem da folha.
      const cachedFirst = [...entries].sort(
        (a, b) =>
          Number(getCachedTravels(cacheKeyOf(accountId, b)) != null) -
          Number(getCachedTravels(cacheKeyOf(accountId, a)) != null),
      );
      for (const entry of cachedFirst) {
        const key = cacheKeyOf(accountId, entry);
        let travels = getCachedTravels(key);
        if (!travels) {
          const remainingMs = deadlineMs - Date.now();
          // Não começa a chamada; sem attemptedPlates, a matrícula fica
          // "deadline" (a menos que outra conta a resolva).
          if (remainingMs < minCallBudgetMs) continue;
          attemptedPlates.add(entry.plate);
          const callStart = Date.now();
          try {
            // Nunca passa do prazo: a margem para pass 2 + ExcelJS fica intacta.
            travels = (await withTimeout(
              fetchTravels(account, entry.vehicleId, dateBegin, dateEnd),
              Math.min(callTimeoutMs, remainingMs),
            )) as unknown as RawTravel[];
            setCachedTravels(key, travels);
          } catch (err) {
            failedPlates.add(entry.plate);
            failedPlateReasons.set(
              entry.plate,
              `conta=${accountId} vehicleId=${entry.vehicleId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          } finally {
            callDurationsMs.push(Date.now() - callStart);
          }
        }
        attemptedPlates.add(entry.plate);
        successByPlate.add(entry.plate);
        const arr = travelsByPlate.get(entry.plate) ?? [];
        arr.push(...travels);
        travelsByPlate.set(entry.plate, arr);
      }
    }),
  );

  const deadlinePlates: string[] = [];
  for (const entry of plan) {
    if (!successByPlate.has(entry.plate)) {
      if (attemptedPlates.has(entry.plate)) {
        trackitStopsByPlate.set(entry.plate, { skipped: "call-failed" });
      } else {
        trackitStopsByPlate.set(entry.plate, { skipped: "deadline" });
        deadlinePlates.push(entry.plate);
      }
      continue;
    }
    const travels = travelsByPlate.get(entry.plate) ?? [];
    const derived = deriveTravelDayStops(travels, entry.vehicleId, entry.plate, locations);
    const real = realStopsByVehicle.get(entry.vehicleId) ?? [];
    trackitStopsByPlate.set(entry.plate, excludeOverlappingRealStops(derived, real));
  }

  // A plate with 2 accounts where one failed but the OTHER succeeded isn't a
  // real failure — successByPlate is the source of truth for that, same as
  // the trackitStopsByPlate assembly above.
  const trulyFailedPlates = [...failedPlates].filter((p) => !successByPlate.has(p));

  return {
    trackitStopsByPlate,
    diagnostics: {
      targeted: pendingPlates.length,
      attempted: attemptedPlates.size,
      deadlinePlates,
      failedPlates: trulyFailedPlates,
      failedPlateReasons: Object.fromEntries(
        trulyFailedPlates.map((p) => [p, failedPlateReasons.get(p) ?? "motivo desconhecido"]),
      ),
      callDurationsMs,
    },
  };
}
