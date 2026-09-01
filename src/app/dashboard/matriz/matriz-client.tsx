"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  SortableTable,
  useDebouncedSearch,
  Notice,
  ExportButton,
  chipClass,
  codeName,
  fmtDuration,
  fmtKm,
  fmtKm2,
  todayStamp,
  exportToXlsx,
  type Col,
  type ExportRow,
} from "../_shared";

export type MatrixRow = {
  source: string;
  origin_name: string | null;
  destination_name: string | null;
  origin_code: string | null;
  destination_code: string | null;
  trip_count: number;
  avg_duration_seconds: number | null;
  median_duration_seconds: number | null;
  avg_distance_km: number | null;
};

export const MATRIX_HEADERS = [
  "Fonte",
  "Origem",
  "Destino",
  "Viagens",
  "Tempo médio",
  "Tempo mediano",
  "Km médio",
] as const;

export function matrixToExportRows(matrix: MatrixRow[]): ExportRow[] {
  return matrix.map((m) => ({
    Fonte: m.source,
    Origem: codeName(m.origin_code, m.origin_name),
    Destino: codeName(m.destination_code, m.destination_name),
    Viagens: m.trip_count,
    "Tempo médio": fmtDuration(m.avg_duration_seconds),
    "Tempo mediano": fmtDuration(m.median_duration_seconds),
    "Km médio": fmtKm2(m.avg_distance_km),
  }));
}

const matrixColumns: Col<MatrixRow>[] = [
  { key: "source", label: "Fonte", value: (r) => r.source },
  {
    key: "origin",
    label: "Origem",
    value: (r) => r.origin_name ?? "",
    render: (r) => codeName(r.origin_code, r.origin_name),
  },
  {
    key: "destination",
    label: "→ Destino",
    value: (r) => r.destination_name ?? "",
    render: (r) => codeName(r.destination_code, r.destination_name),
  },
  { key: "count", label: "Viagens", align: "right", value: (r) => r.trip_count },
  {
    key: "avg",
    label: "Tempo médio",
    align: "right",
    value: (r) => r.avg_duration_seconds,
    render: (r) => fmtDuration(r.avg_duration_seconds),
  },
  {
    key: "median",
    label: "Tempo mediano",
    align: "right",
    value: (r) => r.median_duration_seconds,
    render: (r) => fmtDuration(r.median_duration_seconds),
  },
  {
    key: "avgkm",
    label: "Km médio",
    align: "right",
    value: (r) => r.avg_distance_km,
    render: (r) => fmtKm(r.avg_distance_km),
  },
];

// Free-text: store name / code (either end) — no vehicle, it's aggregated.
function matrixMatchesSearch(m: MatrixRow, needle: string): boolean {
  if (!needle) return true;
  return [
    m.origin_name,
    m.destination_name,
    m.origin_code,
    m.destination_code,
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

export function MatrizClient({
  matrix,
  matrixError,
}: {
  matrix: MatrixRow[];
  matrixError: string | null;
}) {
  const search = useDebouncedSearch();

  const filtered = useMemo(
    () =>
      search.value
        ? matrix.filter((m) => matrixMatchesSearch(m, search.value))
        : matrix,
    [matrix, search.value],
  );

  const exportXlsx = () =>
    exportToXlsx(
      matrixToExportRows(filtered),
      `matriz-tempo-km-${todayStamp()}.xlsx`,
      "Matriz",
      MATRIX_HEADERS,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Matriz tempo / km por par de locais
          </h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            {filtered.length} pares · stops + route_legs
            {search.value ? ` · “${search.value}”` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className={chipClass}>
            ← Dashboard
          </Link>
          <ExportButton onClick={() => void exportXlsx()}>
            Exportar .xlsx
          </ExportButton>
        </div>
      </header>

      {matrixError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados:{" "}
            <code className="font-mono">{matrixError}</code>
            <br />
            Se a view não existe ou está desatualizada, aplica as migrações{" "}
            <code className="font-mono">0010</code>–
            <code className="font-mono">0015</code>.
          </Notice>
        </div>
      )}

      <div className="mb-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-black/50 dark:text-white/50">Pesquisar</span>
          <input
            type="search"
            value={search.input}
            onChange={(e) => search.setInput(e.target.value)}
            placeholder="loja ou código…"
            className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          />
        </label>
      </div>

      {!matrixError && (
        <SortableTable
          rows={filtered}
          columns={matrixColumns}
          initialSort={{ key: "count", dir: "desc" }}
        />
      )}
    </main>
  );
}
