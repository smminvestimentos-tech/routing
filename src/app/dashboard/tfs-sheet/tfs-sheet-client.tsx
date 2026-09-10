"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Notice, chipClass } from "../_shared";
import { EXPECTED_COLUMNS } from "@/lib/tfs-sheet/match";

type Summary = {
  total: number;
  ok: number;
  review: number;
  kept: number;
  swap: number;
  swapOutOfWindow: number;
  plateTypo: number;
  passthrough: number;
  discrepancy: number;
  dayStops: number;
  fleetTrucks: number | null;
  fleetError: string | null;
};

type Result = {
  filename: string;
  fileBase64: string;
  day: string;
  summary: Summary;
};

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function download(base64: string, filename: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function TfsSheetClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function process() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/tfs-sheet", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Erro ${res.status}.`);
        return;
      }
      setResult(json as Result);
      download((json as Result).fileBase64, (json as Result).filename);
    } catch {
      setError("Falha de rede ao processar o ficheiro.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Folha TFS</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Uso interno · sem autenticação
          </p>
        </div>
        <Link href="/dashboard" className={chipClass}>
          ← Dashboard
        </Link>
      </header>

      <div className="mb-6">
        <Notice>
          Carrega a folha de <strong>um dia</strong> de serviço. O ficheiro é
          processado e devolvido na hora — nada é guardado entre carregamentos.
        </Notice>
      </div>

      <section className="rounded-xl border border-black/10 bg-white/70 p-5 shadow-xs backdrop-blur-md dark:border-white/15 dark:bg-neutral-900/70">
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Ficheiro .xlsx</span>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
              setResult(null);
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-black/15 file:bg-white/75 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-white dark:file:border-white/20 dark:file:bg-neutral-900/75 dark:hover:file:bg-neutral-900"
          />
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void process()}
            disabled={!file || busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "A processar…" : "Processar e descarregar"}
          </button>
          {(file || result) && (
            <button
              type="button"
              onClick={reset}
              className={chipClass}
              disabled={busy}
            >
              Limpar
            </button>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-5 rounded-lg border border-black/10 bg-black/[.02] p-4 text-sm dark:border-white/15 dark:bg-white/[.03]">
            <p className="font-medium">
              Dia {result.day} · {result.summary.total} linhas
            </p>
            <ul className="mt-2 space-y-1 text-black/70 dark:text-white/70">
              <li>
                <span className="font-medium text-green-700 dark:text-green-400">
                  OK:
                </span>{" "}
                {result.summary.ok}
              </li>
              {result.summary.kept > 0 && (
                <li>
                  <span className="font-medium text-teal-700 dark:text-teal-400">
                    ✅ Já preenchido (mantido):
                  </span>{" "}
                  {result.summary.kept} (linha veio com Chegada e Saída — passou
                  intacta, sem matching)
                </li>
              )}
              {result.summary.swap > 0 && (
                <li>
                  <span className="font-medium text-blue-700 dark:text-blue-400">
                    🔄 Possível troca de viatura:
                  </span>{" "}
                  {result.summary.swap} (matrícula sugerida + horas; confirmar)
                </li>
              )}
              {result.summary.swapOutOfWindow > 0 && (
                <li>
                  <span className="font-medium text-orange-700 dark:text-orange-400">
                    🔄❗ Possível troca (fora da janela):
                  </span>{" "}
                  {result.summary.swapOutOfWindow} (fora da margem de ±3h;
                  confirmar com cuidado)
                </li>
              )}
              {result.summary.plateTypo > 0 && (
                <li>
                  <span className="font-medium text-violet-700 dark:text-violet-400">
                    🔤 Possível erro de matrícula:
                  </span>{" "}
                  {result.summary.plateTypo} (matrícula corrigida a 1 caractere +
                  horas; erro de transcrição, não troca — confirmar)
                </li>
              )}
              <li>
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  ⚠️ Rever manualmente:
                </span>{" "}
                {result.summary.review}
                {result.summary.discrepancy > 0
                  ? ` (${result.summary.discrepancy} por matrícula divergente ID × fleet_trucks)`
                  : ""}
              </li>
              <li className="text-black/50 dark:text-white/50">
                {result.summary.dayStops} paragens nossas nesse dia
                {result.summary.fleetTrucks != null
                  ? ` · ${result.summary.fleetTrucks} camiões na referência`
                  : ""}
                {result.summary.passthrough > 0
                  ? ` · ${result.summary.passthrough} linhas vazias ignoradas`
                  : ""}
              </li>
            </ul>
            {result.summary.fleetError && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Sem tabela fleet_trucks ({result.summary.fleetError}) — as linhas
                sem matrícula não puderam usar a referência.
              </p>
            )}
            <button
              type="button"
              onClick={() => download(result.fileBase64, result.filename)}
              className="mt-3 rounded-md border border-black/15 bg-white/75 px-3 py-1.5 text-sm font-medium hover:bg-white dark:border-white/20 dark:bg-neutral-900/75 dark:hover:bg-neutral-900"
            >
              Descarregar novamente
            </button>
          </div>
        )}
      </section>

      <section className="mt-8 text-sm text-black/60 dark:text-white/60">
        <h2 className="mb-2 font-medium text-black/80 dark:text-white/80">
          Como funciona
        </h2>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Linhas que já vêm com <strong>Hora de Chegada e Hora de Saída</strong>{" "}
            preenchidas passam <strong>intactas</strong> — não se lhes toca nem se
            faz matching. Ficam <strong>✅ Já preenchido (mantido)</strong>,
            distinto de <strong>OK</strong> (que é valor calculado por nós).
          </li>
          <li>
            Linhas <strong>com matrícula</strong>: ligadas diretamente às
            paragens desse dia (por matrícula, ignorando hífens) e emparelhadas
            pela paragem cujo código de loja bate certo.
          </li>
          <li>
            Linhas <strong>sem matrícula</strong>: tenta-se extrair a matrícula
            da coluna <strong>ID</strong> (
            <code>Transportador-Nº-Matrícula-VoltaªRota-Data</code>, ancorando no
            nº do camião). Se o ID não der, procura-se o nº em{" "}
            <Link href="/dashboard/camioes" className="underline">
              /dashboard/camioes
            </Link>{" "}
            e confirma-se só se sobrar uma paragem com o código de loja certo.
          </li>
          <li>
            Se o ID e o <code>fleet_trucks</code> derem matrículas{" "}
            <strong>diferentes</strong>, a linha fica{" "}
            <strong>⚠️ Rever manualmente</strong> sem escolher nenhuma — a coluna{" "}
            <strong>Real</strong> mostra as duas e onde cada uma esteve.
          </li>
          <li>
            <strong>🔄 Possível troca de viatura</strong>: se a matrícula da
            linha não bater com nenhuma paragem mas outra viatura tiver estado
            nessa loja a uma hora plausível (±3h da janela), sugere-se essa
            matrícula + horas. Linhas concorrentes planeadas para a mesma
            loja/janela em veículos <em>sem</em> GPS nosso são ignoradas; se
            houver mais que uma alternativa real, fica em Rever. Se{" "}
            <strong>não houver GPS nosso da viatura planeada</strong> a cobrir
            essa entrega, não se arrisca sugestão nenhuma — a linha fica{" "}
            <strong>⚠️ Rever manualmente</strong> com nota de{" "}
            <em>sem cobertura GPS</em>.
          </li>
          <li>
            <strong>🔤 Possível erro de matrícula</strong>: se a matrícula
            extraída não tiver <em>nenhum</em> dado GPS nosso e existir{" "}
            <strong>exatamente uma</strong> matrícula com GPS real a{" "}
            <strong>1 caractere de diferença</strong> (uma letra/número trocado,
            a mais ou a menos) que fez mesmo a rota — pelo menos 2–3 lojas
            seguidas conferem no código e na hora —, sugere-se essa matrícula
            corrigida + horas. É um erro de transcrição na folha, não uma troca
            de camião.
          </li>
          <li>
            Sem correspondência clara: a linha fica{" "}
            <strong>⚠️ Rever manualmente</strong> e a coluna <strong>Real</strong>{" "}
            mostra o que os nossos dados dizem para esse camião/dia (loja +
            horas).
          </li>
        </ol>
        <p className="mt-3">
          O ficheiro devolvido traz <strong>Hora de Chegada</strong> /{" "}
          <strong>Hora de Saída</strong> preenchidas (HH:MM) e as colunas{" "}
          <strong>Confiança</strong> e <strong>Real</strong>. A coluna{" "}
          <strong>Matrícula da Viatura</strong> é preenchida sempre que a
          matrícula foi identificada — mesmo nas linhas a rever sem paragem
          correspondente.
        </p>
        <p className="mt-3">
          <strong>Cores no Excel</strong> (protótipo): linhas{" "}
          <strong>⚠️ Rever manualmente</strong> ficam a{" "}
          <span className="rounded bg-amber-200 px-1 dark:text-black">
            amarelo
          </span>{" "}
          enquanto a Hora de Chegada estiver vazia — preenche-a e a cor
          desaparece. Linhas de sugestão (troca, troca fora da janela, erro de
          matrícula) ficam a{" "}
          <span className="rounded bg-red-300 px-1 dark:text-black">
            vermelho
          </span>{" "}
          até <em>ou</em> corrigires a matrícula <em>ou</em> escolheres{" "}
          <strong>OK</strong> na lista suspensa da célula Confiança. A coluna
          técnica <strong>ZZ</strong> (oculta) guarda a matrícula sugerida — não
          a apagues.
        </p>

        <h2 className="mt-5 mb-2 font-medium text-black/80 dark:text-white/80">
          Colunas esperadas
        </h2>
        <p className="text-black/50 dark:text-white/50">
          {EXPECTED_COLUMNS.join(" · ")}
        </p>
      </section>
    </main>
  );
}
