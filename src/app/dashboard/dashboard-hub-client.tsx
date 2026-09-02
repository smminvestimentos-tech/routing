"use client";

import Link from "next/link";
import { Route, Table2, MapPin, Compass } from "lucide-react";
import {
  Notice,
  ExportButton,
  chipClass,
  todayStamp,
  exportWorkbook,
} from "./_shared";
import type { StopRow } from "./_server";
import {
  tripsToExportRows,
  TRIP_HEADERS,
  type Trip,
} from "./trajetos/trajetos-client";
import {
  matrixToExportRows,
  MATRIX_HEADERS,
  type MatrixRow,
} from "./matriz/matriz-client";
import {
  stopsToExportRows,
  STOP_HEADERS,
  dwellStatsToExportRows,
  DWELL_STAT_HEADERS,
  type DwellStatRow,
} from "./paragens/paragens-client";
import {
  computeRoutes,
  rotasToExportRows,
  ROTA_HEADERS,
  type RouteEstimateRow,
} from "./rotas/rotas-client";

const CARDS = [
  {
    href: "/dashboard/trajetos",
    title: "Trajetos recentes",
    Icon: Route,
    desc: "Viagens entre locais conhecidos — origem, destino, duração, km e tempo parado. Com filtro de datas e pesquisa.",
  },
  {
    href: "/dashboard/matriz",
    title: "Matriz tempo / km",
    Icon: Table2,
    desc: "Tempo médio/mediano e km médio por par de locais, agregando stops e route_legs (todo o histórico).",
  },
  {
    href: "/dashboard/paragens",
    title: "Paragens",
    Icon: MapPin,
    desc: "Paragens detetadas (local, chegada/partida, tempo parado, pings) e o tempo médio parado por local.",
  },
  {
    href: "/dashboard/rotas",
    title: "Rotas",
    Icon: Compass,
    desc: "Estimativa de tempo total por rota — carga + viagem + descarga, com margem editável por rota.",
  },
] as const;

// Reuses the geometry of the PWA icon glyph (see gen-icons), monochrome.
function TruckGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <rect x="92" y="182" width="210" height="100" rx="10" />
      <path d="M298 282V230h34l24-28h36a12 12 0 0 1 12 12v68Z" />
      <circle cx="150" cy="300" r="30" />
      <circle cx="356" cy="300" r="30" />
    </svg>
  );
}

export function DashboardHubClient({
  trips,
  matrix,
  stops,
  dwellStats,
  routes,
  routeOverrides,
  defaultMargin,
  anyError,
}: {
  trips: Trip[];
  matrix: MatrixRow[];
  stops: StopRow[];
  dwellStats: DwellStatRow[];
  routes: RouteEstimateRow[];
  routeOverrides: Record<string, number>;
  defaultMargin: number;
  anyError: string | null;
}) {
  // "Exportar tudo" — one workbook, one sheet per section, at today's range.
  const exportAll = () =>
    exportWorkbook(
      [
        {
          name: "Trajetos",
          rows: tripsToExportRows(trips),
          headers: TRIP_HEADERS,
        },
        {
          name: "Matriz",
          rows: matrixToExportRows(matrix),
          headers: MATRIX_HEADERS,
        },
        {
          name: "Paragens",
          rows: stopsToExportRows(stops),
          headers: STOP_HEADERS,
        },
        {
          name: "Tempo por local",
          rows: dwellStatsToExportRows(dwellStats),
          headers: DWELL_STAT_HEADERS,
        },
        {
          name: "Rotas",
          rows: rotasToExportRows(
            computeRoutes(routes, routeOverrides, defaultMargin),
          ),
          headers: ROTA_HEADERS,
        },
      ],
      `dashboard-completo-${todayStamp()}.xlsx`,
    );

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      {/* thin brand accent, monochrome */}
      <div className="mb-7 h-[3px] w-full rounded-full bg-gradient-to-r from-black/70 via-black/25 to-transparent dark:from-white/60 dark:via-white/20" />

      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-black/[.03] dark:border-white/15 dark:bg-white/[.05]">
            <TruckGlyph className="h-[22px] w-[22px] text-black/75 dark:text-white/75" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-0.5 text-sm text-black/50 dark:text-white/50">
              Uso interno · sem autenticação
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard/locations" className={chipClass}>
            Gerir locations
          </Link>
          <ExportButton onClick={() => void exportAll()}>
            Exportar tudo
          </ExportButton>
        </div>
      </header>

      {anyError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados para a exportação:{" "}
            <code className="font-mono">{anyError}</code>
          </Notice>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-xl border border-black/10 p-5 transition-colors hover:border-black/25 hover:bg-black/[.02] dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-white/[.03]"
          >
            <div className="flex items-center gap-2.5">
              <c.Icon
                size={18}
                strokeWidth={1.75}
                className="shrink-0 text-black/35 transition-colors group-hover:text-black/65 dark:text-white/35 dark:group-hover:text-white/65"
              />
              <h2 className="text-lg font-medium">{c.title}</h2>
              <span className="ml-auto text-black/25 transition-transform group-hover:translate-x-0.5 dark:text-white/25">
                →
              </span>
            </div>
            <p className="mt-2 text-sm text-black/50 dark:text-white/50">
              {c.desc}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
