// Shared bits for the editable route margins (/dashboard/rotas + its API
// routes). Pure — no framework imports.

export const MARGIN_MIN = 0;
export const MARGIN_MAX = 1000;
export const DEFAULT_MARGIN_PERCENT = 15;

// Accepts a number or a numeric string ("15", "15,5"). Returns null when it's
// missing, not a number, or outside [MARGIN_MIN, MARGIN_MAX].
export function parseMargin(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n =
    typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < MARGIN_MIN || n > MARGIN_MAX) return null;
  return n;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
