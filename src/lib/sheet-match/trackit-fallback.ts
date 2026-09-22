// I/O orchestrator for the TRACKiT /vehicleTravels fallback — the one piece
// of this feature that actually talks to TRACKiT (via src/lib/trackit/http.ts
// directly, the same import style scripts/backfill-azambuja-pings.ts already
// uses, bypassing client.ts's server-only guard) and merges the result with
// each vehicle's real stops. Shared by both sheet routes (azambuja-sheet,
// tfs-sheet) so the cap/deadline/timeout/concurrency/cache logic lives in
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

// Matrículas distintas, não pares (vehicleId, account) — uma matrícula com
// veículo em 2 contas (ex. BG-96-ID) é tratada por inteiro ou fica de fora
// por inteiro, nunca parcialmente (quebraria a nota "não consultado", que é
// por matrícula/linha).
export const MAX_TRACKIT_FALLBACK_PLATES = 6;
// Deixa ~50s dos 150s de maxDuration para o resto do pedido (construir o
// workbook, etc.) — ver route.ts.
export const TRACKIT_FALLBACK_BUDGET_MS = 100_000;
// Envolve CADA chamada getVehicleTravels() (que já tem retry com backoff, até
// 3 tentativas de 30s cada, dentro de src/lib/trackit/http.ts — pior caso bem
// mais que 60s para UMA chamada) para que um único veículo lento nunca coma o
// orçamento inteiro pensado para até MAX_TRACKIT_FALLBACK_PLATES veículos.
export const TRACKIT_FALLBACK_CALL_TIMEOUT_MS = 25_000;

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
};

export type TrackitFallbackDiagnostics = {
  /** matrículas elegíveis antes do cap */
  targeted: number;
  /** matrículas para as quais pelo menos uma chamada foi mesmo feita */
  attempted: number;
  /** matrículas cortadas só pelo cap (não por prazo/erro) */
  cappedPlates: string[];
  /** matrículas com pelo menos uma chamada falhada/expirada */
  failedPlates: string[];
  /**
   * matrícula -> motivo exato da falha (mensagem da exceção, "budget
   * exceeded", ou o timeout de TRACKIT_FALLBACK_CALL_TIMEOUT_MS) — só para
   * as matrículas em failedPlates. Diagnóstico, nunca escrito na folha.
   */
  failedPlateReasons: Record<string, string>;
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
  } = input;

  const trackitStopsByPlate = new Map<string, WStop[] | TrackitSkipReason>();
  const configured = new Map(getConfiguredAccounts().map((a) => [a.id, a]));

  const targeted = pendingPlates.length;
  const eligible = pendingPlates.slice(0, MAX_TRACKIT_FALLBACK_PLATES);
  const cappedPlates = pendingPlates.slice(MAX_TRACKIT_FALLBACK_PLATES);
  for (const plate of cappedPlates) trackitStopsByPlate.set(plate, { skipped: "cap" });

  // Resolve vehicleId + contas utilizáveis primeiro, para uma matrícula sem
  // nenhuma das duas nunca ocupar um slot de prazo/timeout à toa.
  type PlanEntry = { plate: string; vehicleId: number; accounts: TrackitAccount[] };
  const plan: PlanEntry[] = [];
  for (const plate of eligible) {
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
  const travelsByPlate = new Map<string, RawTravel[]>();
  const successByPlate = new Set<string>();

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

  await Promise.all(
    [...byAccount.entries()].map(async ([accountId, entries]) => {
      const account = configured.get(accountId)!;
      for (const entry of entries) {
        if (Date.now() - fnStart > TRACKIT_FALLBACK_BUDGET_MS) {
          failedPlates.add(entry.plate);
          failedPlateReasons.set(entry.plate, `prazo global excedido (>${TRACKIT_FALLBACK_BUDGET_MS}ms desde o início do pedido)`);
          continue;
        }
        const key = travelsCacheKey(accountId, entry.vehicleId, dateBegin, dateEnd);
        let travels = getCachedTravels(key);
        if (!travels) {
          try {
            travels = (await withTimeout(
              getVehicleTravels(account, entry.vehicleId, dateBegin, dateEnd),
              TRACKIT_FALLBACK_CALL_TIMEOUT_MS,
            )) as unknown as RawTravel[];
            setCachedTravels(key, travels);
          } catch (err) {
            failedPlates.add(entry.plate);
            failedPlateReasons.set(
              entry.plate,
              `conta=${accountId} vehicleId=${entry.vehicleId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
        successByPlate.add(entry.plate);
        const arr = travelsByPlate.get(entry.plate) ?? [];
        arr.push(...travels);
        travelsByPlate.set(entry.plate, arr);
      }
    }),
  );

  for (const entry of plan) {
    if (trackitStopsByPlate.has(entry.plate)) continue; // já tem skip-reason acima
    if (!successByPlate.has(entry.plate)) {
      trackitStopsByPlate.set(entry.plate, { skipped: "call-failed" });
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
      targeted,
      attempted: plan.length,
      cappedPlates,
      failedPlates: trulyFailedPlates,
      failedPlateReasons: Object.fromEntries(
        trulyFailedPlates.map((p) => [p, failedPlateReasons.get(p) ?? "motivo desconhecido"]),
      ),
    },
  };
}
