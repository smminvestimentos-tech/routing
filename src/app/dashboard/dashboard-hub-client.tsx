"use client";

import Link from "next/link";
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
import { stopsToExportRows, STOP_HEADERS } from "./paragens/paragens-client";

const CARDS = [
  {
    href: "/dashboard/trajetos",
    title: "Trajetos recentes",
    desc: "Viagens entre locais conhecidos — origem, destino, duração, km e tempo parado. Com filtro de datas e pesquisa.",
  },
  {
    href: "/dashboard/matriz",
    title: "Matriz tempo / km",
    desc: "Tempo médio/mediano e km médio por par de locais, agregando stops e route_legs (todo o histórico).",
  },
  {
    href: "/dashboard/paragens",
    title: "Paragens",
    desc: "Paragens detetadas — local, tipo, chegada/partida, tempo parado e nº de pings. Com filtro de datas e pesquisa.",
  },
] as const;

export function DashboardHubClient({
  trips,
  matrix,
  stops,
  anyError,
}: {
  trips: Trip[];
  matrix: MatrixRow[];
  stops: StopRow[];
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
      ],
      `dashboard-completo-${todayStamp()}.xlsx`,
    );

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Uso interno · sem autenticação
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-xl border border-black/10 p-5 transition-colors hover:border-black/25 hover:bg-black/[.02] dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-white/[.03]"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">{c.title}</h2>
              <span className="text-black/30 transition-transform group-hover:translate-x-0.5 dark:text-white/30">
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
