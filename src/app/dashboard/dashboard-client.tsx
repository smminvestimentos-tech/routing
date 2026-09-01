"use client";

import { useMemo, useState, type ReactNode } from "react";

export type Trip = {
  vehicle_id: number;
  origin_name: string | null;
  destination_name: string | null;
  departed_at: string | null;
  arrived_at: string;
  travel_seconds: number | null;
  leg_km: number | null;
};

export type MatrixRow = {
  source: string;
  origin_name: string | null;
  destination_name: string | null;
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

function fmtKm(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} km`;
}

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
  { key: "vehicle", label: "Veículo", value: (r) => r.vehicle_id },
  { key: "origin", label: "Origem", value: (r) => r.origin_name ?? "" , render: (r) => r.origin_name ?? "—" },
  {
    key: "route",
    label: "→ Destino",
    value: (r) => r.destination_name ?? "",
    render: (r) => r.destination_name ?? "—",
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
    render: (r) => r.origin_name ?? "—",
  },
  {
    key: "destination",
    label: "→ Destino",
    value: (r) => r.destination_name ?? "",
    render: (r) => r.destination_name ?? "—",
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
}: {
  trips: Trip[];
  tripsError: string | null;
  matrix: MatrixRow[];
  matrixError: string | null;
}) {
  const anyError = tripsError ?? matrixError;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Uso interno · sem autenticação
        </p>
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
        <h2 className="mb-3 text-lg font-medium">
          Trajetos recentes{" "}
          <span className="text-sm font-normal text-black/40 dark:text-white/40">
            (últimos {trips.length}, via stops)
          </span>
        </h2>
        {!tripsError && (
          <SortableTable
            rows={trips}
            columns={tripColumns}
            initialSort={{ key: "arrived", dir: "desc" }}
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">
          Matriz tempo / km por par de locais{" "}
          <span className="text-sm font-normal text-black/40 dark:text-white/40">
            ({matrix.length} pares · stops + route_legs)
          </span>
        </h2>
        {!matrixError && (
          <SortableTable
            rows={matrix}
            columns={matrixColumns}
            initialSort={{ key: "count", dir: "desc" }}
          />
        )}
      </section>
    </main>
  );
}
