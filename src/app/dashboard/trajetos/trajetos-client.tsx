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
  fmtDuration,
  fmtKm,
  fmtKm2,
  fmtMinutes,
  intervalLabel,
  todayStamp,
  exportToXlsx,
  type Col,
  type ExportRow,
} from "../_shared";

export type Trip = {
  vehicle_id: number;
  vehicle_plate: string | null;
  origin_name: string | null;
  destination_name: string | null;
  origin_code: string | null;
  destination_code: string | null;
  departed_at: string | null;
  arrived_at: string;
  travel_seconds: number | null;
  leg_km: number | null;
  // Minutes the vehicle stayed at the destination stop (load/unload time).
  destination_duration_minutes: number | null;
};

export const TRIP_HEADERS = [
  "Veículo",
  "Origem",
  "Destino",
  "Partida",
  "Chegada",
  "Duração",
  "Km",
  "Tempo parado",
] as const;

// Human-readable rows — same formatting as the on-screen table (durations as
// "1h 23m", dates in pt-PT), km at 2 decimals — never the raw seconds/ISO.
export function tripsToExportRows(trips: Trip[]): ExportRow[] {
  return trips.map((t) => ({
    Veículo: t.vehicle_plate ?? String(t.vehicle_id),
    Origem: codeName(t.origin_code, t.origin_name),
    Destino: codeName(t.destination_code, t.destination_name),
    Partida: fmtDateTime(t.departed_at),
    Chegada: fmtDateTime(t.arrived_at),
    Duração: fmtDuration(t.travel_seconds),
    Km: fmtKm2(t.leg_km),
    "Tempo parado": fmtMinutes(t.destination_duration_minutes),
  }));
}

const tripColumns: Col<Trip>[] = [
  {
    key: "vehicle",
    label: "Veículo",
    value: (r) => r.vehicle_plate ?? String(r.vehicle_id),
    render: (r) => r.vehicle_plate ?? String(r.vehicle_id),
  },
  {
    key: "origin",
    label: "Origem",
    // sort by name (the meaningful key); display "CODE — Name"
    value: (r) => r.origin_name ?? "",
    render: (r) => codeName(r.origin_code, r.origin_name),
  },
  {
    key: "route",
    label: "→ Destino",
    value: (r) => r.destination_name ?? "",
    render: (r) => codeName(r.destination_code, r.destination_name),
  },
  {
    key: "departed",
    label: "Partida",
    value: (r) => (r.departed_at ? new Date(r.departed_at).getTime() : null),
    render: (r) => fmtDateTime(r.departed_at),
  },
  {
    key: "arrived",
    label: "Chegada",
    value: (r) => new Date(r.arrived_at).getTime(),
    render: (r) => fmtDateTime(r.arrived_at),
  },
  {
    key: "duration",
    label: "Duração",
    align: "right",
    value: (r) => r.travel_seconds,
    render: (r) => fmtDuration(r.travel_seconds),
  },
  {
    key: "km",
    label: "Km",
    align: "right",
    value: (r) => r.leg_km,
    render: (r) => fmtKm(r.leg_km),
  },
  {
    key: "dwell",
    label: "Tempo parado",
    align: "right",
    value: (r) => r.destination_duration_minutes,
    render: (r) => fmtMinutes(r.destination_duration_minutes),
  },
];

// Free-text: store name / code (either end), plate, or numeric id.
function tripMatchesSearch(t: Trip, needle: string): boolean {
  if (!needle) return true;
  return [
    t.origin_name,
    t.destination_name,
    t.origin_code,
    t.destination_code,
    t.vehicle_plate,
    String(t.vehicle_id),
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

export function TrajetosClient({
  trips,
  tripsError,
  implausibleExcluded,
  implausibleThresholdHours,
  filterFrom,
  filterTo,
  today,
}: {
  trips: Trip[];
  tripsError: string | null;
  implausibleExcluded: number;
  implausibleThresholdHours: number;
  filterFrom: string;
  filterTo: string;
  today: string;
}) {
  const search = useDebouncedSearch();

  const filtered = useMemo(
    () =>
      search.value
        ? trips.filter((t) => tripMatchesSearch(t, search.value))
        : trips,
    [trips, search.value],
  );

  const exportXlsx = () =>
    exportToXlsx(
      tripsToExportRows(filtered),
      `trajetos-recentes-${todayStamp()}.xlsx`,
      "Trajetos",
      TRIP_HEADERS,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Trajetos recentes
          </h1>
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

      {tripsError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados:{" "}
            <code className="font-mono">{tripsError}</code>
            <br />
            Se a view não existe ou está desatualizada, aplica as migrações{" "}
            <code className="font-mono">0010</code>–
            <code className="font-mono">0015</code>.
          </Notice>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
        <DateRangeForm
          action="/dashboard/trajetos"
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
            placeholder="loja, código, matrícula, ID…"
            className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          />
        </label>
      </div>

      {!tripsError && (
        <SortableTable
          rows={filtered}
          columns={tripColumns}
          initialSort={{ key: "arrived", dir: "desc" }}
        />
      )}

      {implausibleExcluded > 0 && (
        <p className="mt-2 text-xs text-black/40 dark:text-white/40">
          {implausibleExcluded} trajeto
          {implausibleExcluded === 1 ? "" : "s"} excluído
          {implausibleExcluded === 1 ? "" : "s"} por duração implausível (&gt;{" "}
          {implausibleThresholdHours}h) — provável lacuna na ingestão de
          posições, não viagens reais.
        </p>
      )}
    </main>
  );
}
