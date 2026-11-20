// Relatório diário do armazém (DHL / Salvesen) — leitura em memória, sem base
// de dados. Folhas "Real Time - DHL" (7001/7005: hora real de início/fim da
// carga no cais, cais, matrícula real) e "Real Time - SLV" (7003: idem + hora
// de entrada/saída na portaria).
//
// NÃO substitui as horas da folha (a folha continua com a entrada e a saída do
// pátio, pelo GPS). Serve para:
//   • corrigir a matrícula quando o camião real não é o da folha;
//   • escolher a visita GPS certa ao pátio (a que contém a carga real);
//   • comparar, linha a linha, a hora da app com a do armazém (coluna «Armazém»).
//
// Os dados são colados à mão no relatório e às vezes vêm de outro dia (07-11 e
// 16-11 traziam 04/05-11) — quem chama verifica que as rotas coincidem com as
// da folha (relatorioOverlap) antes de o usar.
//
// Horas: o relatório só tem HH:MM. O dia sai da hora planeada da linha
// («Hora Inicio» da rota + «HORA CHEGADA»): fica o dia (-1/0/+1) que põe a
// hora real mais perto da planeada.

import * as XLSX from "xlsx";
import { lisbonEpoch, normalizeStoreCode } from "@/lib/sheet-match/common";
import { normalizePlate } from "@/lib/fleet/validate";

export type WarehouseLine = {
  rota: string;
  seq: number;
  code: string;
  tipo: string;
  /** matrícula real (normalizada), null se vazia */
  plate: string | null;
  /** carga no cais (epoch-ms), null se o armazém não registou */
  iniMs: number | null;
  fimMs: number | null;
  /** portaria (só Salvesen/7003) */
  portaInMs: number | null;
  portaOutMs: number | null;
  cais: string;
};

/** Folha «RAQ»: lojas que o Auchan trocou (ALTERADA) ou cancelou (ANULADA) */
export type StoreChange = {
  rota: string;
  from: string;
  fromName: string;
  /** "ALTERADA" | "ANULADA" | outra ação, em maiúsculas */
  action: string;
  motivo: string;
  /** loja nova (só em ALTERADA) */
  to: string | null;
  toName: string;
};

const SHEETS = ["Real Time - DHL", "Real Time - SLV"];

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const hm = (v: unknown): number | null => {
  const m = String(v ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};

const ymdAdd = (ymd: string, d: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);

/** "17/11/26 19:55" | "17/11/2026 19:55" -> { ymd, min } */
function dmy(v: unknown): { ymd: string; min: number } | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return { ymd: `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, min: m[4] ? +m[4] * 60 + +m[5] : 0 };
}

/** HH:MM on the day (-1/0/+1 around refYmd) closest to refMs */
function nearest(min: number, refYmd: string, refMs: number): number {
  let best = 0;
  let bd = Infinity;
  for (const d of [-1, 0, 1]) {
    const t = lisbonEpoch(ymdAdd(refYmd, d), min);
    if (Math.abs(t - refMs) < bd) [best, bd] = [t, Math.abs(t - refMs)];
  }
  return best;
}

// RAQ (19-11: 186408319 8 Auchan Gaia → 38 Auchan Sintra). Linhas sem rota
// numérica (EXTRA 1) ficam de fora.
function parseRaq(wb: XLSX.WorkBook): StoreChange[] {
  const ws = wb.Sheets["RAQ"];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  const hi = aoa.findIndex((r) => r.some((c) => norm(c) === "rota") && r.some((c) => norm(c) === "acao"));
  if (hi < 0) return [];
  const head = aoa[hi].map(norm);
  const c = (n: string) => head.indexOf(n);
  const [cRota, cFrom, cFromN, cAct, cMot, cTo, cToN] = [
    c("rota"),
    c("cod loja inicial"),
    c("loja inicial"),
    c("acao"),
    c("motivo"),
    c("cod loja alterada"),
    c("loja alterada"),
  ];
  if (cRota < 0 || cFrom < 0 || cAct < 0) return [];
  const out: StoreChange[] = [];
  for (const r of aoa.slice(hi + 1)) {
    const rota = String(r[cRota] ?? "").trim();
    const from = normalizeStoreCode(r[cFrom]);
    if (!/^\d{6,}$/.test(rota) || !from) continue;
    const to = cTo >= 0 ? normalizeStoreCode(r[cTo]) : "";
    out.push({
      rota,
      from,
      fromName: cFromN >= 0 ? String(r[cFromN] ?? "").trim() : "",
      action: norm(r[cAct]).toUpperCase(),
      motivo: cMot >= 0 ? String(r[cMot] ?? "").trim() : "",
      to: to || null,
      toName: cToN >= 0 ? String(r[cToN] ?? "").trim() : "",
    });
  }
  return out;
}

export function parseRelatorioDiario(
  wb: XLSX.WorkBook,
): { lines: WarehouseLine[]; changes: StoreChange[] } | { error: string } {
  const present = SHEETS.filter((n) => wb.Sheets[n]);
  if (present.length === 0) {
    return { error: `O relatório diário não tem as folhas «${SHEETS.join("» / «")}».` };
  }
  const lines: WarehouseLine[] = [];
  for (const name of present) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const hi = aoa.findIndex((r) => r.some((c) => norm(c) === "rota"));
    if (hi < 0) continue;
    const head = aoa[hi].map(norm);
    const col = (...names: string[]) => {
      for (const n of names) {
        const i = head.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const cRota = col("rota");
    const cSeq = col("seq");
    const cLoja = col("n loja", "no loja", "nº loja");
    const cTipo = col("tipo");
    const cPlan = col("hora chegada");
    const cIniRota = col("hora inicio");
    const cMat = col("matricula");
    const cIni = col("hora real inicio");
    const cFim = col("hora real fim");
    const cCais = col("cais");
    const cPIn = col("hora chegada real portaria");
    const cPOut = col("hora saida real portaria");
    if (cRota < 0 || cLoja < 0 || cIni < 0) continue;

    for (const r of aoa.slice(hi + 1)) {
      const rota = String(r[cRota] ?? "").trim();
      if (!/^\d{6,}$/.test(rota)) continue;
      const code = normalizeStoreCode(r[cLoja]);
      if (!code) continue;
      // reference: the route's start (date + time) and this line's planned hour
      const start = cIniRota >= 0 ? dmy(r[cIniRota]) : null;
      const planMin = cPlan >= 0 ? hm(r[cPlan]) : null;
      let refMs: number | null = null;
      let refYmd: string | null = null;
      if (start) {
        const startMs = lisbonEpoch(start.ymd, start.min);
        refMs = startMs;
        refYmd = start.ymd;
        if (planMin != null) {
          // planned hour on the start day, or the next one when it's earlier
          // than the start by more than 6 h (route crosses midnight)
          let p = lisbonEpoch(start.ymd, planMin);
          if (p < startMs - 6 * 36e5) p = lisbonEpoch(ymdAdd(start.ymd, 1), planMin);
          refMs = p;
          refYmd = new Date(p).toISOString().slice(0, 10);
        }
      }
      const at = (v: unknown, ref: number | null): number | null => {
        const m = hm(v);
        if (m == null || ref == null || refYmd == null) return null;
        return nearest(m, refYmd, ref);
      };
      const iniMs = at(r[cIni], refMs);
      let fimMs = cFim >= 0 ? at(r[cFim], iniMs ?? refMs) : null;
      if (iniMs != null && fimMs != null && fimMs < iniMs) fimMs += 864e5;
      const portaInMs = cPIn >= 0 ? at(r[cPIn], iniMs ?? refMs) : null;
      let portaOutMs = cPOut >= 0 ? at(r[cPOut], portaInMs ?? iniMs ?? refMs) : null;
      if (portaInMs != null && portaOutMs != null && portaOutMs < portaInMs) portaOutMs += 864e5;
      const seqN = cSeq >= 0 ? Number(r[cSeq]) : NaN;
      const rawPlate = cMat >= 0 ? String(r[cMat] ?? "").trim() : "";
      lines.push({
        rota,
        seq: Number.isFinite(seqN) ? seqN : lines.length,
        code,
        tipo: cTipo >= 0 ? String(r[cTipo] ?? "").trim().toUpperCase() : "",
        plate: rawPlate ? normalizePlate(rawPlate) || null : null,
        iniMs,
        fimMs,
        portaInMs,
        portaOutMs,
        cais: cCais >= 0 ? String(r[cCais] ?? "").trim() : "",
      });
    }
  }
  // a rota aparece nas duas folhas (DHL lista também a linha do 7003, sem
  // dados): uma linha por (ROTA, SEQ, loja), com o que cada folha tiver
  const byKey = new Map<string, WarehouseLine>();
  for (const l of lines) {
    const k = `${l.rota}|${l.seq}|${l.code}`;
    const o = byKey.get(k);
    if (!o) {
      byKey.set(k, l);
      continue;
    }
    o.plate ??= l.plate;
    o.iniMs ??= l.iniMs;
    o.fimMs ??= l.fimMs;
    o.portaInMs ??= l.portaInMs;
    o.portaOutMs ??= l.portaOutMs;
    o.cais ||= l.cais;
    o.tipo ||= l.tipo;
  }
  const out = [...byKey.values()];
  if (out.length === 0) return { error: "O relatório diário não tem linhas de rotas." };
  return { lines: out, changes: parseRaq(wb) };
}

/** how many of the sheet's routes the report covers */
export function relatorioOverlap(lines: readonly WarehouseLine[], sheetRotas: Iterable<string>) {
  const rel = new Set(lines.map((l) => l.rota));
  const sheet = new Set([...sheetRotas].map((r) => String(r).trim()).filter(Boolean));
  let common = 0;
  for (const r of sheet) if (rel.has(r)) common++;
  return { sheetRoutes: sheet.size, reportRoutes: rel.size, common };
}
