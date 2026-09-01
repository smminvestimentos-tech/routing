"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

// Shared UI primitives + formatters for the /dashboard pages: the sortable
// table, the debounced search hook, the date-range filter, the .xlsx export
// machinery, and the value formatters. Anything section-specific (columns,
// search matchers, per-section export mappers) lives next to its own page.

export type Col<T> = {
  key: string;
  label: string;
  align?: "right";
  /** value used for sorting */
  value: (row: T) => string | number | null;
  /** display; falls back to value() */
  render?: (row: T) => ReactNode;
};

export type Sort = { key: string; dir: "asc" | "desc" };

const DEFAULT_PAGE_SIZE = 50;

export function SortableTable<T>({
  rows,
  columns,
  initialSort,
  onRowClick,
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  rows: T[];
  columns: Col<T>[];
  initialSort: Sort;
  /** when set, rows become clickable (pointer cursor + click handler) */
  onRowClick?: (row: T) => void;
  /** client-side rows per page; defaults to 50 */
  pageSize?: number;
}) {
  const [sort, setSort] = useState<Sort>(initialSort);
  const [page, setPage] = useState(1);

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

  // Pagination is client-side, over the already sorted+filtered rows (same
  // model as search/sort — no extra server round-trips). `sorted` gets a new
  // identity whenever `rows` (search changes it) or the sort changes, so this
  // snaps back to page 1 then — you never sit on a page that no longer holds
  // relevant rows. (Adjusting state during render, per the React docs, rather
  // than an effect.)
  const [pagedFrom, setPagedFrom] = useState(sorted);
  if (pagedFrom !== sorted) {
    setPagedFrom(sorted);
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );

  return (
    <div>
      {/* max-h + overflow-auto: keeps the existing horizontal scroll on narrow
          screens AND makes this the vertical scroll container, so the sticky
          <thead> pins to the top of the table as its rows scroll under it.
          Short tables never reach max-h, so nothing changes for them. */}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-black/10 dark:border-white/15">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background text-left">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggle(c.key)}
                  // Opaque via bg-background on <thead>; the .03/.04 tint on the
                  // cells reproduces the old header colour over it. inset shadow
                  // is the bottom divider (survives border-collapse + sticky,
                  // unlike border-b).
                  className={`cursor-pointer select-none whitespace-nowrap bg-black/[.03] px-3 py-2 font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] dark:bg-white/[.04] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.16)] ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {c.label}
                  <span className="text-black/40 dark:text-white/40">
                    {sort.key === c.key
                      ? sort.dir === "asc"
                        ? " ▲"
                        : " ▼"
                      : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-t border-black/[.06] hover:bg-black/[.02] dark:border-white/[.08] dark:hover:bg-white/[.03] ${
                  onRowClick ? "cursor-pointer" : ""
                }`}
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

      {pageCount > 1 && (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm text-black/60 dark:text-white/60">
          <span>
            Página {currentPage} de {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              className={`${chipClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
              disabled={currentPage >= pageCount}
              className={`${chipClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Próxima
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Text box + its debounced (~200ms), trimmed, lower-cased value.
export function useDebouncedSearch() {
  const [input, setInput] = useState("");
  const [value, setValue] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setValue(input.trim().toLowerCase()), 200);
    return () => clearTimeout(id);
  }, [input]);
  return { input, setInput, value };
}

export const chipClass =
  "rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/20 dark:hover:bg-white/[.06]";

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value formatters (shared by the tables and the .xlsx exports)
// ---------------------------------------------------------------------------

export function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  // Round to whole minutes first, then split — otherwise a value like 53970s
  // rounds the remainder minutes to 60 and prints "14h 60m" instead of "15h 00m".
  const totalMin = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// stops.duration_minutes / v_trips.destination_duration_minutes are in minutes.
export function fmtMinutes(min: number | null): string {
  return fmtDuration(min == null ? null : min * 60);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Table cells: 1 decimal. The .xlsx exports use fmtKm2 (2 decimals) per spec.
export function fmtKm(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} km`;
}

export function fmtKm2(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)} km`;
}

// "CODE — Name" when the location has a code; just the name otherwise; "—" when
// there's no location at all (unmatched end).
export function codeName(code: string | null, name: string | null): string {
  if (name == null) return "—";
  return code ? `${code} — ${name}` : name;
}

// YYYY-MM-DD minus n days, calendar arithmetic in UTC (no DST concerns for
// plain date math).
export function ymdMinus(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

export function intervalLabel(from: string, to: string, today: string): string {
  if (from === today && to === today) return "hoje";
  if (from === ymdMinus(today, 6) && to === today) return "últimos 7 dias";
  return from === to ? from : `${from} – ${to}`;
}

// ---------------------------------------------------------------------------
// Date-range filter — lives in the URL (?from=&to=) so it's shareable. Plain
// GET form: no params -> today (the page resolves it). key= re-mounts the
// inputs so their defaultValue tracks the range after nav. `action` is the
// page it belongs to, so it also drives the Hoje / Últimos 7 dias links.
// ---------------------------------------------------------------------------

export function DateRangeForm({
  action,
  filterFrom,
  filterTo,
  today,
}: {
  action: string;
  filterFrom: string;
  filterTo: string;
  today: string;
}) {
  return (
    <form
      key={`${filterFrom}-${filterTo}`}
      method="get"
      action={action}
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
      <span className="mx-1 hidden self-center text-black/20 sm:inline dark:text-white/20">
        |
      </span>
      <Link href={action} className={chipClass}>
        Hoje
      </Link>
      <Link
        href={`${action}?from=${ymdMinus(today, 6)}&to=${today}`}
        className={chipClass}
      >
        Últimos 7 dias
      </Link>
    </form>
  );
}

// ---------------------------------------------------------------------------
// .xlsx export (SheetJS). Runs entirely in the browser — xlsx is loaded lazily
// on first click so it stays out of the initial page bundle.
// ---------------------------------------------------------------------------

export type ExportRow = Record<string, string | number>;

export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A header-only sheet when there are no rows, so the section is visibly present
// in the workbook rather than a blank tab that reads as corrupt.
function makeSheet(
  XLSX: typeof import("xlsx"),
  rows: ExportRow[],
  headers: readonly string[],
) {
  return rows.length > 0
    ? XLSX.utils.json_to_sheet(rows)
    : XLSX.utils.aoa_to_sheet([[...headers]]);
}

export async function exportToXlsx(
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

export async function exportWorkbook(
  sheets: { name: string; rows: ExportRow[]; headers: readonly string[] }[],
  filename: string,
): Promise<void> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      XLSX.utils.book_append_sheet(wb, makeSheet(XLSX, s.rows, s.headers), s.name);
    }
    XLSX.writeFile(wb, filename);
  } catch (e) {
    console.error("xlsx export failed", e);
    alert("Falha ao exportar o ficheiro.");
  }
}

export function ExportButton({
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
