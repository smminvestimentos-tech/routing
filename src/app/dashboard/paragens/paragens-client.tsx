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

export const STOP_HEADERS = [
  "Local",
  "Tipo",
  "Chegada",
  "Partida",
  "Tempo parado",
  "Pings",
] as const;

export function stopsToExportRows(stops: StopRow[]): ExportRow[] {
  return stops.map((s) => ({
    Local: codeName(s.location_code, s.location_name),
    Tipo: fmtLocationType(s.location_type),
    Chegada: fmtDateTime(s.arrived_at),
    Partida: fmtDateTime(s.departed_at),
    "Tempo parado": fmtMinutes(s.duration_minutes),
    Pings: s.ping_count,
  }));
}

const stopColumns: Col<StopRow>[] = [
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

// Free-text: location name / code / type.
function stopMatchesSearch(s: StopRow, needle: string): boolean {
  if (!needle) return true;
  return [s.location_name, s.location_code, s.location_type].some(
    (v) => v != null && String(v).toLowerCase().includes(needle),
  );
}

export function ParagensClient({
  stops,
  stopsError,
  filterFrom,
  filterTo,
  today,
}: {
  stops: StopRow[];
  stopsError: string | null;
  filterFrom: string;
  filterTo: string;
  today: string;
}) {
  const search = useDebouncedSearch();

  const filtered = useMemo(
    () =>
      search.value
        ? stops.filter((s) => stopMatchesSearch(s, search.value))
        : stops,
    [stops, search.value],
  );

  const exportXlsx = () =>
    exportToXlsx(
      stopsToExportRows(filtered),
      `paragens-${todayStamp()}.xlsx`,
      "Paragens",
      STOP_HEADERS,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Paragens</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            {filtered.length}, {intervalLabel(filterFrom, filterTo, today)}
            {search.value ? ` · “${search.value}”` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard" className={chipClass}>
            ← Dashboard
          </Link>
          <ExportButton onClick={() => void exportXlsx()}>
            Exportar .xlsx
          </ExportButton>
        </div>
      </header>

      {stopsError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados:{" "}
            <code className="font-mono">{stopsError}</code>
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
            placeholder="local, código, tipo…"
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
    </main>
  );
}
