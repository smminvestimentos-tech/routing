"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  SortableTable,
  useDebouncedSearch,
  Notice,
  DateRangeForm,
  ExportButton,
  chipClass,
  codeName,
  fmtDateTime,
  fmtMinutes,
  intervalLabel,
  todayStamp,
  exportToXlsx,
  type Col,
  type ExportRow,
} from "../_shared";
import type { StopRow } from "../_server";

const LOCATION_TYPE_LABELS: Record<string, string> = {
  loja: "Loja",
  armazem: "Armazém",
  centro_distribuicao: "Centro distribuição",
  fornecedor: "Fornecedor",
  oficina: "Oficina",
};

function fmtLocationType(t: string | null): string {
  if (!t) return "—";
  return LOCATION_TYPE_LABELS[t] ?? t;
}

// carga = load/unload, estacionamento = parking. See stop_kind_of() (0017).
const STOP_KIND_LABELS: Record<string, string> = {
  carga: "Carga",
  estacionamento: "Estacionamento",
};

function fmtStopKind(k: string | null): string {
  if (!k) return "—";
  return STOP_KIND_LABELS[k] ?? k;
}

export const STOP_HEADERS = [
  "Veículo",
  "Local",
  "Tipo",
  "Classificação",
  "Chegada",
  "Partida",
  "Tempo parado",
  "Pings",
] as const;

// Plate, falling back to the numeric id — same pattern as "Trajetos recentes".
const vehicleLabel = (s: { vehicle_plate: string | null; vehicle_id: number }) =>
  s.vehicle_plate ?? String(s.vehicle_id);

export function stopsToExportRows(stops: StopRow[]): ExportRow[] {
  return stops.map((s) => ({
    Veículo: vehicleLabel(s),
    Local: codeName(s.location_code, s.location_name),
    Tipo: fmtLocationType(s.location_type),
    Classificação: fmtStopKind(s.stop_kind),
    Chegada: fmtDateTime(s.arrived_at),
    Partida: fmtDateTime(s.departed_at),
    "Tempo parado": fmtMinutes(s.duration_minutes),
    Pings: s.ping_count,
  }));
}

const stopColumns: Col<StopRow>[] = [
  {
    key: "vehicle",
    label: "Veículo",
    value: (r) => vehicleLabel(r),
    render: (r) => vehicleLabel(r),
  },
  {
    key: "local",
    label: "Local",
    value: (r) => r.location_name ?? "",
    render: (r) => codeName(r.location_code, r.location_name),
  },
  {
    key: "type",
    label: "Tipo",
    value: (r) => r.location_type ?? "",
    render: (r) => fmtLocationType(r.location_type),
  },
  {
    key: "kind",
    label: "Classificação",
    value: (r) => fmtStopKind(r.stop_kind),
    render: (r) => fmtStopKind(r.stop_kind),
  },
  {
    key: "arrived",
    label: "Chegada",
    value: (r) => new Date(r.arrived_at).getTime(),
    render: (r) => fmtDateTime(r.arrived_at),
  },
  {
    key: "departed",
    label: "Partida",
    value: (r) => (r.departed_at ? new Date(r.departed_at).getTime() : null),
    render: (r) => fmtDateTime(r.departed_at),
  },
  {
    key: "dwell",
    label: "Tempo parado",
    align: "right",
    value: (r) => r.duration_minutes,
    render: (r) => fmtMinutes(r.duration_minutes),
  },
  {
    key: "pings",
    label: "Pings",
    align: "right",
    value: (r) => r.ping_count,
  },
];

// Free-text: plate / id, location name / code / type, classification label.
function stopMatchesSearch(s: StopRow, needle: string): boolean {
  if (!needle) return true;
  return [
    s.vehicle_plate,
    String(s.vehicle_id),
    s.location_name,
    s.location_code,
    s.location_type,
    fmtStopKind(s.stop_kind),
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// "Tempo médio parado por local" — one row per (location, classification):
// v_location_dwell_stats (migrations 0016 + 0017) splits carga vs.
// estacionamento so the two don't get blended into one average. Aggregates
// every closed stop; no date filter, like the trip matrix.
// ---------------------------------------------------------------------------

export type DwellStatRow = {
  location_id: string;
  location_code: string | null;
  location_name: string | null;
  location_type: string | null;
  stop_kind: string | null;
  stop_count: number;
  avg_duration_minutes: number | null;
  median_duration_minutes: number | null;
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
};

export const DWELL_STAT_HEADERS = [
  "Local",
  "Tipo",
  "Classificação",
  "Paragens",
  "Tempo médio",
  "Tempo mediano",
  "Mín",
  "Máx",
] as const;

export function dwellStatsToExportRows(rows: DwellStatRow[]): ExportRow[] {
  return rows.map((r) => ({
    Local: codeName(r.location_code, r.location_name),
    Tipo: fmtLocationType(r.location_type),
    Classificação: fmtStopKind(r.stop_kind),
    Paragens: r.stop_count,
    "Tempo médio": fmtMinutes(r.avg_duration_minutes),
    "Tempo mediano": fmtMinutes(r.median_duration_minutes),
    Mín: fmtMinutes(r.min_duration_minutes),
    Máx: fmtMinutes(r.max_duration_minutes),
  }));
}

const dwellStatColumns: Col<DwellStatRow>[] = [
  {
    key: "local",
    label: "Local",
    value: (r) => r.location_name ?? "",
    render: (r) => codeName(r.location_code, r.location_name),
  },
  {
    key: "type",
    label: "Tipo",
    value: (r) => r.location_type ?? "",
    render: (r) => fmtLocationType(r.location_type),
  },
  {
    key: "kind",
    label: "Classificação",
    value: (r) => fmtStopKind(r.stop_kind),
    render: (r) => fmtStopKind(r.stop_kind),
  },
  {
    key: "stops",
    label: "Paragens",
    align: "right",
    value: (r) => r.stop_count,
  },
  {
    key: "avg",
    label: "Tempo médio",
    align: "right",
    value: (r) => r.avg_duration_minutes,
    render: (r) => fmtMinutes(r.avg_duration_minutes),
  },
  {
    key: "median",
    label: "Tempo mediano",
    align: "right",
    value: (r) => r.median_duration_minutes,
    render: (r) => fmtMinutes(r.median_duration_minutes),
  },
  {
    key: "min",
    label: "Mín",
    align: "right",
    value: (r) => r.min_duration_minutes,
    render: (r) => fmtMinutes(r.min_duration_minutes),
  },
  {
    key: "max",
    label: "Máx",
    align: "right",
    value: (r) => r.max_duration_minutes,
    render: (r) => fmtMinutes(r.max_duration_minutes),
  },
];

function dwellStatMatchesSearch(r: DwellStatRow, needle: string): boolean {
  if (!needle) return true;
  return [
    r.location_name,
    r.location_code,
    r.location_type,
    fmtStopKind(r.stop_kind),
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

export function ParagensClient({
  stops,
  stopsError,
  dwellStats,
  dwellStatsError,
  filterFrom,
  filterTo,
  today,
}: {
  stops: StopRow[];
  stopsError: string | null;
  dwellStats: DwellStatRow[];
  dwellStatsError: string | null;
  filterFrom: string;
  filterTo: string;
  today: string;
}) {
  const search = useDebouncedSearch();
  const dwellSearch = useDebouncedSearch();

  const filtered = useMemo(
    () =>
      search.value
        ? stops.filter((s) => stopMatchesSearch(s, search.value))
        : stops,
    [stops, search.value],
  );
  const filteredDwell = useMemo(
    () =>
      dwellSearch.value
        ? dwellStats.filter((r) => dwellStatMatchesSearch(r, dwellSearch.value))
        : dwellStats,
    [dwellStats, dwellSearch.value],
  );

  const exportStops = () =>
    exportToXlsx(
      stopsToExportRows(filtered),
      `paragens-${todayStamp()}.xlsx`,
      "Paragens",
      STOP_HEADERS,
    );
  const exportDwell = () =>
    exportToXlsx(
      dwellStatsToExportRows(filteredDwell),
      `tempo-por-local-${todayStamp()}.xlsx`,
      "Tempo por local",
      DWELL_STAT_HEADERS,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Paragens</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Tempo de carga/descarga — paragens individuais e média por local.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard" className={chipClass}>
            ← Dashboard
          </Link>
        </div>
      </header>

      <section className="mb-12">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Paragens individuais{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filtered.length}, {intervalLabel(filterFrom, filterTo, today)}
              {search.value ? ` · “${search.value}”` : ""})
            </span>
          </h2>
          <ExportButton onClick={() => void exportStops()}>
            Exportar .xlsx
          </ExportButton>
        </div>

        {stopsError && (
          <div className="mb-3">
            <Notice>
              Erro a carregar dados:{" "}
              <code className="font-mono">{stopsError}</code>
              <br />
              Se falta a coluna <code className="font-mono">stop_kind</code>,
              aplica a migração <code className="font-mono">0017</code>.
            </Notice>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
          <DateRangeForm
            action="/dashboard/paragens"
            filterFrom={filterFrom}
            filterTo={filterTo}
            today={today}
          />

          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Pesquisar</span>
            <input
              type="search"
              value={search.input}
              onChange={(e) => search.setInput(e.target.value)}
              placeholder="matrícula, local, código, tipo…"
              className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
        </div>

        {!stopsError && (
          <SortableTable
            rows={filtered}
            columns={stopColumns}
            initialSort={{ key: "arrived", dir: "desc" }}
          />
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Tempo médio parado por local{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filteredDwell.length} locais · todo o histórico
              {dwellSearch.value ? ` · “${dwellSearch.value}”` : ""})
            </span>
          </h2>
          <ExportButton onClick={() => void exportDwell()}>
            Exportar .xlsx
          </ExportButton>
        </div>

        {dwellStatsError && (
          <div className="mb-3">
            <Notice>
              Erro a carregar dados:{" "}
              <code className="font-mono">{dwellStatsError}</code>
              <br />
              Se a view não existe ou está desatualizada, aplica as migrações{" "}
              <code className="font-mono">0016</code>–
              <code className="font-mono">0017</code>.
            </Notice>
          </div>
        )}

        <div className="mb-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Pesquisar</span>
            <input
              type="search"
              value={dwellSearch.input}
              onChange={(e) => dwellSearch.setInput(e.target.value)}
              placeholder="local, código, tipo…"
              className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
        </div>

        {!dwellStatsError && (
          <SortableTable
            rows={filteredDwell}
            columns={dwellStatColumns}
            initialSort={{ key: "stops", dir: "desc" }}
          />
        )}
      </section>
    </main>
  );
}
