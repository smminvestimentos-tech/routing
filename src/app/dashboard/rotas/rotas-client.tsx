"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SortableTable,
  useDebouncedSearch,
  Notice,
  ExportButton,
  chipClass,
  codeName,
  fmtMinutes,
  todayStamp,
  exportToXlsx,
  type Col,
  type ExportRow,
} from "../_shared";
import { MARGIN_MIN, MARGIN_MAX } from "@/lib/margins";

export type RouteEstimateRow = {
  origin_location_id: string;
  destination_location_id: string;
  origin_code: string | null;
  origin_name: string | null;
  destination_code: string | null;
  destination_name: string | null;
  trip_count: number;
  avg_travel_minutes: number | null;
  origin_load_minutes: number | null;
  destination_load_minutes: number | null;
};

export type ComputedRoute = RouteEstimateRow & {
  key: string;
  margin_percent: number;
  is_override: boolean;
  total_minutes: number;
};

export const routeKey = (r: {
  origin_location_id: string;
  destination_location_id: string;
}) => `${r.origin_location_id}|${r.destination_location_id}`;

// Effective margin (override or global default) + estimated total, per route.
export function computeRoutes(
  routes: RouteEstimateRow[],
  overrides: Record<string, number>,
  defaultMargin: number,
): ComputedRoute[] {
  return routes.map((r) => {
    const key = routeKey(r);
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
    const margin = hasOverride ? overrides[key] : defaultMargin;
    const base =
      (r.origin_load_minutes ?? 0) +
      (r.avg_travel_minutes ?? 0) +
      (r.destination_load_minutes ?? 0);
    return {
      ...r,
      key,
      margin_percent: margin,
      is_override: hasOverride,
      total_minutes: base * (1 + margin / 100),
    };
  });
}

export const ROTA_HEADERS = [
  "Origem",
  "Destino",
  "Carga",
  "Viagem",
  "Descarga",
  "Margem %",
  "Total estimado",
  "Viagens",
] as const;

export function rotasToExportRows(rows: ComputedRoute[]): ExportRow[] {
  return rows.map((r) => ({
    Origem: codeName(r.origin_code, r.origin_name),
    Destino: codeName(r.destination_code, r.destination_name),
    Carga: fmtMinutes(r.origin_load_minutes),
    Viagem: fmtMinutes(r.avg_travel_minutes),
    Descarga: fmtMinutes(r.destination_load_minutes),
    "Margem %": r.margin_percent,
    "Total estimado": fmtMinutes(r.total_minutes),
    Viagens: r.trip_count,
  }));
}

function routeMatchesSearch(r: ComputedRoute, needle: string): boolean {
  if (!needle) return true;
  return [
    r.origin_name,
    r.origin_code,
    r.destination_name,
    r.destination_code,
  ].some((v) => v != null && String(v).toLowerCase().includes(needle));
}

const DEFAULT_KEY = "__default__";
const SAVE_DEBOUNCE_MS = 500;

export function RotasClient({
  routes,
  routesError,
  initialOverrides,
  initialDefaultMargin,
}: {
  routes: RouteEstimateRow[];
  routesError: string | null;
  initialOverrides: Record<string, number>;
  initialDefaultMargin: number;
}) {
  const search = useDebouncedSearch();

  const [overrides, setOverrides] =
    useState<Record<string, number>>(initialOverrides);
  const [defaultMargin, setDefaultMargin] = useState(initialDefaultMargin);
  // Raw text of a field being edited, so "1." / "" don't fight the parsed value.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [errorKeys, setErrorKeys] = useState<Set<string>>(new Set());

  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(
    () => () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
      Object.values(flashTimers.current).forEach(clearTimeout);
    },
    [],
  );

  const flash = (key: string, kind: "ok" | "err") => {
    const setter = kind === "ok" ? setSavedKeys : setErrorKeys;
    setter((s) => new Set(s).add(key));
    clearTimeout(flashTimers.current[key + kind]);
    flashTimers.current[key + kind] = setTimeout(
      () =>
        setter((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        }),
      kind === "ok" ? 1000 : 2500,
    );
  };

  const saveMargin = async (key: string, value: number) => {
    const [origin_location_id, destination_location_id] = key.split("|");
    try {
      const res = await fetch("/api/route-margins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_location_id,
          destination_location_id,
          margin_percent: value,
        }),
      });
      if (!res.ok) return flash(key, "err");
      // Drop the raw-text override; display falls back to the (now saved) value.
      setEdits((e) => {
        const n = { ...e };
        delete n[key];
        return n;
      });
      flash(key, "ok");
    } catch {
      flash(key, "err");
    }
  };

  const saveDefault = async (value: number) => {
    try {
      const res = await fetch("/api/dashboard-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_margin_percent: value }),
      });
      if (!res.ok) return flash(DEFAULT_KEY, "err");
      setEdits((e) => {
        const n = { ...e };
        delete n[DEFAULT_KEY];
        return n;
      });
      flash(DEFAULT_KEY, "ok");
    } catch {
      flash(DEFAULT_KEY, "err");
    }
  };

  const onMarginInput = (key: string, rawInput: string) => {
    setEdits((e) => ({ ...e, [key]: rawInput }));
    const n =
      rawInput.trim() === ""
        ? NaN
        : Number(rawInput.trim().replace(",", "."));
    if (!Number.isFinite(n) || n < MARGIN_MIN || n > MARGIN_MAX) return;
    setOverrides((o) => ({ ...o, [key]: n }));
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(
      () => void saveMargin(key, n),
      SAVE_DEBOUNCE_MS,
    );
  };

  const onDefaultInput = (rawInput: string) => {
    setEdits((e) => ({ ...e, [DEFAULT_KEY]: rawInput }));
    const n =
      rawInput.trim() === ""
        ? NaN
        : Number(rawInput.trim().replace(",", "."));
    if (!Number.isFinite(n) || n < MARGIN_MIN || n > MARGIN_MAX) return;
    setDefaultMargin(n);
    clearTimeout(saveTimers.current[DEFAULT_KEY]);
    saveTimers.current[DEFAULT_KEY] = setTimeout(
      () => void saveDefault(n),
      SAVE_DEBOUNCE_MS,
    );
  };

  const computed = useMemo(
    () => computeRoutes(routes, overrides, defaultMargin),
    [routes, overrides, defaultMargin],
  );
  const filtered = useMemo(
    () =>
      search.value
        ? computed.filter((r) => routeMatchesSearch(r, search.value))
        : computed,
    [computed, search.value],
  );

  const marginFieldClass = (key: string, isOverride: boolean) =>
    `w-20 rounded-md border bg-transparent px-2 py-1 text-right tabular-nums outline-none transition-colors ${
      savedKeys.has(key)
        ? "border-green-500 bg-green-500/10"
        : errorKeys.has(key)
          ? "border-red-500 bg-red-500/10"
          : isOverride
            ? "border-black/40 dark:border-white/50"
            : "border-black/15 dark:border-white/20"
    }`;

  // Rebuilt each render (cheap; the table is paginated). The Margem column's
  // render returns a live <input>.
  const columns: Col<ComputedRoute>[] = [
    {
      key: "origin",
      label: "Origem",
      value: (r) => r.origin_name ?? "",
      render: (r) => codeName(r.origin_code, r.origin_name),
    },
    {
      key: "dest",
      label: "→ Destino",
      value: (r) => r.destination_name ?? "",
      render: (r) => codeName(r.destination_code, r.destination_name),
    },
    {
      key: "load",
      label: "Carga",
      align: "right",
      value: (r) => r.origin_load_minutes,
      render: (r) => fmtMinutes(r.origin_load_minutes),
    },
    {
      key: "travel",
      label: "Viagem",
      align: "right",
      value: (r) => r.avg_travel_minutes,
      render: (r) => fmtMinutes(r.avg_travel_minutes),
    },
    {
      key: "unload",
      label: "Descarga",
      align: "right",
      value: (r) => r.destination_load_minutes,
      render: (r) => fmtMinutes(r.destination_load_minutes),
    },
    {
      key: "margin",
      label: "Margem %",
      align: "right",
      value: (r) => r.margin_percent,
      render: (r) => (
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          min={MARGIN_MIN}
          max={MARGIN_MAX}
          value={edits[r.key] ?? String(r.margin_percent)}
          onChange={(e) => onMarginInput(r.key, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className={marginFieldClass(r.key, r.is_override)}
          title={
            r.is_override
              ? "Margem própria desta rota"
              : "A usar a margem global"
          }
        />
      ),
    },
    {
      key: "total",
      label: "Total estimado",
      align: "right",
      value: (r) => r.total_minutes,
      render: (r) => fmtMinutes(r.total_minutes),
    },
    {
      key: "trips",
      label: "Viagens",
      align: "right",
      value: (r) => r.trip_count,
    },
  ];

  const exportXlsx = () =>
    exportToXlsx(
      rotasToExportRows(filtered),
      `rotas-${todayStamp()}.xlsx`,
      "Rotas",
      ROTA_HEADERS,
    );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rotas</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            {filtered.length} rotas · carga + viagem + descarga, com margem
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

      {routesError && (
        <div className="mb-8">
          <Notice>
            Erro a carregar dados:{" "}
            <code className="font-mono">{routesError}</code>
            <br />
            Se a view não existe, aplica a migração{" "}
            <code className="font-mono">0018</code>.
          </Notice>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-black/50 dark:text-white/50">
            Margem global por defeito (%)
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min={MARGIN_MIN}
            max={MARGIN_MAX}
            value={edits[DEFAULT_KEY] ?? String(defaultMargin)}
            onChange={(e) => onDefaultInput(e.target.value)}
            className={`w-28 rounded-md border bg-transparent px-2 py-1 tabular-nums outline-none transition-colors ${
              savedKeys.has(DEFAULT_KEY)
                ? "border-green-500 bg-green-500/10"
                : errorKeys.has(DEFAULT_KEY)
                  ? "border-red-500 bg-red-500/10"
                  : "border-black/15 dark:border-white/20"
            }`}
          />
        </label>
        <p className="max-w-md text-xs text-black/40 dark:text-white/40">
          Usada nas rotas sem margem própria. As rotas com valor próprio
          aparecem com a borda mais forte.
        </p>
      </div>

      <div className="mb-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-black/50 dark:text-white/50">Pesquisar</span>
          <input
            type="search"
            value={search.input}
            onChange={(e) => search.setInput(e.target.value)}
            placeholder="origem ou destino…"
            className="w-56 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          />
        </label>
      </div>

      {!routesError && (
        <SortableTable
          rows={filtered}
          columns={columns}
          initialSort={{ key: "trips", dir: "desc" }}
        />
      )}
    </main>
  );
}
