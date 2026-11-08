// Plano de Cargas (transportador) — leitura em memória, sem base de dados.
//
// O plano traz, por linha (ROTA × SEQ × Nº_LOJA): a hora PREVISTA de chegada e
// saída e a carga (TOTAL de paletes). A folha de horários não traz nada disto,
// por isso o matcher (azambuja-sheet/match.ts) usa o plano, quando vem junto
// no upload, para:
//   • escolher, entre as paragens possíveis, a mais próxima da hora prevista
//     (em vez da mais cedo) e rejeitar paragens a mais de PLAN_MAX_DEV_MIN;
//   • distinguir carga (TOTAL > 0) de regresso sem carga: uma carga que só
//     tem um toque de < MIN_LOAD_DWELL_MIN no armazém vai para "Rever".
//
// Ligação plano ↔ folha: por ROTA e código de loja, na ordem SEQ (a folha
// lista as lojas de cada rota pela mesma ordem — 127/127 rotas em 07-11-2026).

import * as XLSX from "xlsx";
import { lisbonEpoch, normalizeStoreCode, type SheetRecord } from "@/lib/sheet-match/common";

export type PlanLine = {
  rota: string;
  seq: number;
  code: string;
  /** epoch-ms (Lisbon wall-clock resolved), null when the cell is empty/unreadable */
  arrMs: number | null;
  depMs: number | null;
  /** TOTAL de paletes previstas (0 = sem carga) */
  carga: number;
  tipo: string;
  /** nº de frota (coluna MATRICULA do plano) — informativo */
  frota: string;
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Excel serial or "YYYY-MM-DD HH:MM[:SS]" / "DD-MM-YYYY HH:MM[:SS]" (wall clock, Lisboa) -> epoch ms */
export function parsePlanTime(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const wall = new Date(Math.round((v - 25569) * 86400000));
    const ymd = wall.toISOString().slice(0, 10);
    const min = wall.getUTCHours() * 60 + wall.getUTCMinutes() + wall.getUTCSeconds() / 60;
    return lisbonEpoch(ymd, min);
  }
  if (v instanceof Date) return parsePlanTime(v.getTime() / 86400000 + 25569);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return lisbonEpoch(`${m[1]}-${m[2]}-${m[3]}`, +m[4] * 60 + +m[5] + (m[6] ? +m[6] / 60 : 0));
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const ymd = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return lisbonEpoch(ymd, +m[4] * 60 + +m[5] + (m[6] ? +m[6] / 60 : 0));
  }
  return null;
}

/** Reads the first sheet of a Plano de Cargas workbook. Returns lines or an error. */
export function parsePlanoCargas(wb: XLSX.WorkBook): { lines: PlanLine[] } | { error: string } {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { error: "O plano de cargas não tem nenhuma folha." };
  const rows = XLSX.utils.sheet_to_json<SheetRecord>(ws, { raw: true, defval: "", blankrows: false });
  if (rows.length === 0) return { error: "O plano de cargas está vazio." };
  const header = Object.keys(rows[0]);
  const find = (...names: string[]) => {
    for (const n of names) {
      const h = header.find((x) => norm(x) === n);
      if (h) return h;
    }
    return null;
  };
  const cRota = find("rota");
  const cSeq = find("seq", "sequencia");
  const cLoja = find("n loja", "no loja", "nº loja", "n_loja", "loja");
  const cCheg = find("hora chegada", "chegada");
  const cSaida = find("hora saida", "saida");
  const cTotal = find("total");
  const cTipo = find("tipo");
  const cFrota = find("matricula");
  const missing = [
    !cRota && "ROTA",
    !cLoja && "Nº_LOJA",
    !cCheg && "HORA CHEGADA",
  ].filter(Boolean);
  if (missing.length) return { error: `Plano de cargas sem coluna(s): ${missing.join(", ")}.` };

  const lines: PlanLine[] = [];
  rows.forEach((r, i) => {
    const rota = String(r[cRota!] ?? "").trim();
    const code = normalizeStoreCode(r[cLoja!]);
    if (!rota || !code) return;
    const seqN = cSeq ? Number(r[cSeq]) : NaN;
    lines.push({
      rota,
      seq: Number.isFinite(seqN) ? seqN : i,
      code,
      arrMs: parsePlanTime(r[cCheg!]),
      depMs: cSaida ? parsePlanTime(r[cSaida]) : null,
      carga: cTotal ? Number(r[cTotal]) || 0 : 0,
      tipo: cTipo ? String(r[cTipo] ?? "").trim().toUpperCase() : "",
      frota: cFrota ? String(r[cFrota] ?? "").trim() : "",
    });
  });
  if (lines.length === 0) return { error: "O plano de cargas não tem linhas com ROTA e loja." };
  return { lines };
}
