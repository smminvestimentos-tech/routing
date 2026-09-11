// Historical-impact audit for the "✅ Já preenchido (mantido)" placeholder bug
// (2026-09, BG-75-IP / azambuja-2026-09-10-conferido.xlsx): both sheet
// matchers used to trust ANY row that arrived with both Chegada and Saída
// already filled, with no plausibility check. A row whose input had
// Chegada === Saída (or Saída < Chegada) — a transporter-side placeholder,
// never a real visit; our own GPS-derived stops never close in zero minutes
// (fleet-wide DB audit, 2026-09) — was kept verbatim instead of being
// re-matched against real stops or sent to manual review.
//
// Nothing is persisted server-side between sheet uploads (see the NOTE in
// src/app/api/azambuja-sheet/route.ts / tfs-sheet's equivalent), so the only
// way to measure how many PAST exported lines were affected is to scan the
// actual .xlsx files still on disk. This does NOT touch the DB or re-run any
// matching — it only re-reads each file's own Confiança/Chegada/Saída cells
// exactly as they were exported, and flags the implausible-kept shape.
//
//   npx tsx scripts/audit-kept-placeholder-rows.ts [dir] [dir2 ...]
//
// Defaults to the user's Downloads folder if no directory is given.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

const KEPT = "✅ Já preenchido (mantido)";

function findWorkbooks(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.xlsx$/i.test(name)) continue;
      if (name.startsWith("~$")) continue; // Excel lock file
      if (!/(azambuja|tfs)/i.test(name)) continue;
      out.push(join(dir, name));
    }
  }
  return out;
}

// Best-effort minutes between two display strings, tolerant of either
// "DD/MM/YYYY HH:MM" or a bare "HH:MM". null when neither shape parses.
function minutesBetween(a: string, b: string): number | null {
  const parseFull = (s: string) => {
    const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const [, d, mo, y, h, mi] = m;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  };
  const ta = parseFull(a);
  const tb = parseFull(b);
  if (ta != null && tb != null) return (tb - ta) / 60_000;
  const parseHM = (s: string) => {
    const m = s.trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const ma = parseHM(a);
  const mb = parseHM(b);
  if (ma == null || mb == null) return null;
  return mb - ma;
}

function pickCol(header: string[], candidates: string[]): string | null {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  for (const c of candidates) {
    const hit = header.find((h) => norm(h) === norm(c));
    if (hit) return hit;
  }
  return null;
}

type Hit = {
  file: string;
  rota: string;
  code: string;
  plate: string;
  chegada: string;
  saida: string;
};

function auditFile(path: string): { total: number; kept: number; hits: Hit[] } {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", raw: false });
  if (rows.length === 0) return { total: 0, kept: 0, hits: [] };
  const header = Object.keys(rows[0]);

  const confCol = pickCol(header, ["Confiança"]);
  const chegadaCol = pickCol(header, ["Hora Chegada", "Hora de Chegada"]);
  const saidaCol = pickCol(header, ["Hora Saida", "Hora de Saída", "Hora Saída"]);
  const rotaCol = pickCol(header, ["ROTA"]);
  const codeCol = pickCol(header, ["N_LOJA", "Código de Loja"]);
  const plateCol = pickCol(header, ["MATRICULA", "Matrícula da Viatura"]);
  if (!confCol || !chegadaCol || !saidaCol) return { total: 0, kept: 0, hits: [] };

  let kept = 0;
  const hits: Hit[] = [];
  for (const r of rows) {
    const conf = String(r[confCol] ?? "");
    if (conf !== KEPT) continue;
    kept++;
    const chegada = String(r[chegadaCol] ?? "").trim();
    const saida = String(r[saidaCol] ?? "").trim();
    if (!chegada || !saida) continue;
    const dur = minutesBetween(chegada, saida);
    if (dur != null && dur <= 0) {
      hits.push({
        file: path,
        rota: rotaCol ? String(r[rotaCol] ?? "") : "",
        code: codeCol ? String(r[codeCol] ?? "") : "",
        plate: plateCol ? String(r[plateCol] ?? "") : "",
        chegada,
        saida,
      });
    }
  }
  return { total: rows.length, kept, hits };
}

function main() {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length > 0 ? argDirs : [join(process.env.USERPROFILE ?? "", "Downloads")];
  const files = findWorkbooks(dirs).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

  console.log(`Scanning ${files.length} azambuja/tfs .xlsx file(s) under: ${dirs.join(", ")}\n`);

  let totalRows = 0;
  let totalKept = 0;
  let totalHits = 0;
  const perFile: { file: string; kept: number; hits: number }[] = [];

  for (const f of files) {
    const { total, kept, hits } = auditFile(f);
    totalRows += total;
    totalKept += kept;
    totalHits += hits.length;
    perFile.push({ file: f, kept, hits: hits.length });
    if (hits.length > 0) {
      console.log(`AFFECTED: ${f}`);
      console.log(`  ${kept} kept rows total, ${hits.length} implausible (Chegada<=Saída placeholder)`);
      for (const h of hits.slice(0, 20)) {
        console.log(`    ROTA ${h.rota}  ${h.code}  ${h.plate}  ${h.chegada} -> ${h.saida}`);
      }
      if (hits.length > 20) console.log(`    … and ${hits.length - 20} more`);
      console.log("");
    }
  }

  console.log("=".repeat(90));
  console.log("RESUMO");
  console.log("=".repeat(90));
  console.log(`ficheiros analisados ........................... ${files.length}`);
  console.log(`linhas totais (todos os ficheiros) ............. ${totalRows}`);
  console.log(`linhas "✅ Já preenchido (mantido)" ............. ${totalKept}`);
  console.log(`das quais implausíveis (Chegada<=Saída) ........ ${totalHits}`);
  console.log("");
  console.log("ficheiros com pelo menos 1 linha afetada:");
  for (const p of perFile.filter((p) => p.hits > 0)) {
    console.log(`  ${p.file}  (${p.hits} linha(s))`);
  }
}

main();
