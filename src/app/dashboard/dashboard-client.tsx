"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

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
};

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

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Table cells: 1 decimal. The .xlsx export uses fmtKm2 (2 decimals) per spec.
function fmtKm(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} km`;
}

function fmtKm2(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)} km`;
}

// "CODE — Name" when the location has a code; just the name otherwise; "—" when
// there's no location at all (unmatched end).
function codeName(code: string | null, name: string | null): string {
  if (name == null) return "—";
  return code ? `${code} — ${name}` : name;
}

// ---------------------------------------------------------------------------
// .xlsx export (SheetJS). Runs entirely in the browser — xlsx is loaded lazily
// on first click so it stays out of the initial /dashboard bundle.
// ---------------------------------------------------------------------------

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type ExportRow = Record<string, string | number>;

// Explicit column order per export. Kept as constants so an empty section can
// still produce a header-only sheet. Must match the keys built in
// tripsToExportRows / matrixToExportRows below.
const TRIP_HEADERS = [
  "Veículo",
  "Origem",
  "Destino",
  "Partida",
  "Chegada",
  "Duração",
  "Km",
] as const;

const MATRIX_HEADERS = [
  "Fonte",
  "Origem",
  "Destino",
  "Viagens",
  "Tempo médio",
  "Tempo mediano",
  "Km médio",
] as const;

// Human-readable rows — same formatting as the on-screen tables (durations as
// "1h 23m", dates in pt-PT), km at 2 decimals — never the raw seconds/ISO.
function tripsToExportRows(trips: Trip[]): ExportRow[] {
  return trips.map((t) => ({
    Veículo: t.vehicle_plate ?? String(t.vehicle_id),
    Origem: codeName(t.origin_code, t.origin_name),
    Destino: codeName(t.destination_code, t.destination_name),
    Partida: fmtDateTime(t.departed_at),
    Chegada: fmtDateTime(t.arrived_at),
    Duração: fmtDuration(t.travel_seconds),
    Km: fmtKm2(t.leg_km),
  }));
}

function matrixToExportRows(matrix: MatrixRow[]): ExportRow[] {
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

// A header-only sheet when there are no rows, so the section is visibly
// present in the workbook rather than a blank tab that reads as corrupt.
function makeSheet(
  XLSX: typeof import("xlsx"),
  rows: ExportRow[],
  headers: readonly string[],
) {
  return rows.length > 0
    ? XLSX.utils.json_to_sheet(rows)
    : XLSX.utils.aoa_to_sheet([[...headers]]);
}

async function exportToXlsx(
  rows: ExportRow[],
  filename: string,
  sheetName: string,
  headers: readonly string[],
): Promise<void> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, makeSheet(XLSX, rows, headers), sheetName);
    XLSX.writeFile(wb, filename);
  } catch (e) {
    console.error("xlsx export failed", e);
    alert("Falha ao exportar o ficheiro.");
  }
}

async function exportWorkbook(
  sheets: { name: string; rows: ExportRow[]; headers: readonly string[] }[],
  filename: string,
): Promise<void> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      XLSX.utils.book_append_sheet(
        wb,
        makeSheet(XLSX, s.rows, s.headers),
        s.name,
      );
    }
    XLSX.writeFile(wb, filename);
  } catch (e) {
    console.error("xlsx export failed", e);
    alert("Falha ao exportar o ficheiro.");
  }
}

function ExportButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/[.06]"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

type Col<T> = {
  key: string;
  label: string;
  align?: "right";
  /** value used for sorting */
  value: (row: T) => string | number | null;
  /** display; falls back to value() */
  render?: (row: T) => ReactNode;
};

type Sort = { key: string; dir: "asc" | "desc" };

function SortableTable<T>({
  rows,
  columns,
  initialSort,
}: {
  rows: T[];
  columns: Col<T>[];
  initialSort: Sort;
}) {
  const [sort, setSort] = useState<Sort>(initialSort);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "pt");
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, columns, sort]);

  const toggle = (key: string) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-black/[.03] text-left dark:bg-white/[.04]">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => toggle(c.key)}
                className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 font-medium ${
                  c.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {c.label}
                <span className="text-black/40 dark:text-white/40">
                  {sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={i}
              className="border-t border-black/[.06] hover:bg-black/[.02] dark:border-white/[.08] dark:hover:bg-white/[.03]"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`whitespace-nowrap px-3 py-1.5 ${
                    c.align === "right" ? "text-right tabular-nums" : ""
                  }`}
                >
                  {c.render ? c.render(row) : (c.value(row) ?? "—")}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-6 text-center text-black/50 dark:text-white/50"
              >
                Sem dados
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
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
];

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

// YYYY-MM-DD minus n days, calendar arithmetic in UTC (no DST concerns for
// plain date math).
function ymdMinus(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

function intervalLabel(from: string, to: string, today: string): string {
  if (from === today && to === today) return "hoje";
  if (from === ymdMinus(today, 6) && to === today) return "últimos 7 dias";
  return from === to ? from : `${from} – ${to}`;
}

// Free-text match, partial and case-insensitive.
// Trips: store name / code (either end), plate, or numeric id.
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

// Matrix: store name / code (either end) — no vehicle, it's aggregated.
function matrixMatchesSearch(m: MatrixRow, needle: string): boolean {
  if (!needle) return true;
  return [
    m.origin_name,
    m.destination_name,
    m.origin_code,
    m.destination_code,
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

// Text box + its debounced (~200ms), trimmed, lower-cased value.
function useDebouncedSearch() {
  const [input, setInput] = useState("");
  const [value, setValue] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setValue(input.trim().toLowerCase()), 200);
    return () => clearTimeout(id);
  }, [input]);
  return { input, setInput, value };
}

const chipClass =
  "rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/20 dark:hover:bg-white/[.06]";

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
      {children}
    </div>
  );
}

export function DashboardClient({
  trips,
  tripsError,
  matrix,
  matrixError,
  filterFrom,
  filterTo,
  today,
}: {
  trips: Trip[];
  tripsError: string | null;
  matrix: MatrixRow[];
  matrixError: string | null;
  filterFrom: string;
  filterTo: string;
  today: string;
}) {
  const anyError = tripsError ?? matrixError;

  // Client-side free-text search over the already-loaded rows (trips are also
  // date-filtered server-side). Debounced; no server round-trip.
  const tripSearch = useDebouncedSearch();
  const matrixSearch = useDebouncedSearch();

  const filteredTrips = useMemo(
    () =>
      tripSearch.value
        ? trips.filter((t) => tripMatchesSearch(t, tripSearch.value))
        : trips,
    [trips, tripSearch.value],
  );
  const filteredMatrix = useMemo(
    () =>
      matrixSearch.value
        ? matrix.filter((m) => matrixMatchesSearch(m, matrixSearch.value))
        : matrix,
    [matrix, matrixSearch.value],
  );

  // Exports reflect what each section shows (date + text filters).
  const exportTrips = () =>
    exportToXlsx(
      tripsToExportRows(filteredTrips),
      `trajetos-recentes-${todayStamp()}.xlsx`,
      "Trajetos",
      TRIP_HEADERS,
    );
  const exportMatrix = () =>
    exportToXlsx(
      matrixToExportRows(filteredMatrix),
      `matriz-tempo-km-${todayStamp()}.xlsx`,
      "Matriz",
      MATRIX_HEADERS,
    );
  const exportAll = () =>
    exportWorkbook(
      [
        {
          name: "Trajetos",
          rows: tripsToExportRows(filteredTrips),
          headers: TRIP_HEADERS,
        },
        {
          name: "Matriz",
          rows: matrixToExportRows(filteredMatrix),
          headers: MATRIX_HEADERS,
        },
      ],
      `dashboard-completo-${todayStamp()}.xlsx`,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Uso interno · sem autenticação
          </p>
        </div>
        <ExportButton onClick={() => void exportAll()}>
          Exportar tudo
        </ExportButton>
      </header>

      {anyError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados: <code className="font-mono">{anyError}</code>
            <br />
            Se as views não existem, aplica a migração{" "}
            <code className="font-mono">0010_dashboard_views.sql</code>.
          </Notice>
        </div>
      )}

      <section className="mb-12">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Trajetos recentes{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filteredTrips.length},{" "}
              {intervalLabel(filterFrom, filterTo, today)}
              {tripSearch.value ? ` · “${tripSearch.value}”` : ""})
            </span>
          </h2>
          <ExportButton onClick={() => void exportTrips()}>
            Exportar .xlsx
          </ExportButton>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
          {/* Date-range filter — lives in the URL (?from=&to=) so it's shareable.
              Plain GET form: no params -> today (see page.tsx). key= re-mounts
              the inputs so their defaultValue tracks the range after nav. */}
          <form
            key={`${filterFrom}-${filterTo}`}
            method="get"
            action="/dashboard"
            className="flex flex-wrap items-end gap-3"
          >
          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">De</span>
            <input
              type="date"
              name="from"
              defaultValue={filterFrom}
              max={today}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Até</span>
            <input
              type="date"
              name="to"
              defaultValue={filterTo}
              max={today}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
          <button type="submit" className={chipClass}>
            Aplicar
          </button>
          <span className="mx-1 self-center text-black/20 dark:text-white/20">
            |
          </span>
          <Link href="/dashboard" className={chipClass}>
            Hoje
          </Link>
          <Link
            href={`/dashboard?from=${ymdMinus(today, 6)}&to=${today}`}
            className={chipClass}
          >
            Últimos 7 dias
          </Link>
          </form>

          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Pesquisar</span>
            <input
              type="search"
              value={tripSearch.input}
              onChange={(e) => tripSearch.setInput(e.target.value)}
              placeholder="loja, código, matrícula, ID…"
              className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
        </div>

        {!tripsError && (
          <SortableTable
            rows={filteredTrips}
            columns={tripColumns}
            initialSort={{ key: "arrived", dir: "desc" }}
          />
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            Matriz tempo / km por par de locais{" "}
            <span className="text-sm font-normal text-black/40 dark:text-white/40">
              ({filteredMatrix.length} pares · stops + route_legs
              {matrixSearch.value ? ` · “${matrixSearch.value}”` : ""})
            </span>
          </h2>
          <ExportButton onClick={() => void exportMatrix()}>
            Exportar .xlsx
          </ExportButton>
        </div>

        <div className="mb-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-black/50 dark:text-white/50">Pesquisar</span>
            <input
              type="search"
              value={matrixSearch.input}
              onChange={(e) => matrixSearch.setInput(e.target.value)}
              placeholder="loja ou código…"
              className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
        </div>

        {!matrixError && (
          <SortableTable
            rows={filteredMatrix}
            columns={matrixColumns}
            initialSort={{ key: "count", dir: "desc" }}
          />
        )}
      </section>
    </main>
  );
}
