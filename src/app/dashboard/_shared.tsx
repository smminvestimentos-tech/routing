"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

// Shared UI primitives for the /dashboard pages: the sortable table, the
// debounced search box hook, and a couple of small styling helpers. Extracted
// from dashboard-client.tsx so /dashboard/locations reuses the exact pattern.

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

export function SortableTable<T>({
  rows,
  columns,
  initialSort,
  onRowClick,
}: {
  rows: T[];
  columns: Col<T>[];
  initialSort: Sort;
  /** when set, rows become clickable (pointer cursor + click handler) */
  onRowClick?: (row: T) => void;
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
