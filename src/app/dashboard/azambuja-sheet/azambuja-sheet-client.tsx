"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Notice, chipClass } from "../_shared";
import { EXPECTED_COLUMNS } from "@/lib/azambuja-sheet/match";

type Summary = {
  total: number;
  ok: number;
  review: number;
  kept: number;
  swap: number;
  swapOutOfWindow: number;
  plateTypo: number;
  passthrough: number;
  routes: number;
  routesOk: number;
  dayStops: number;
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

export function AzambujaSheetClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [day, setDay] = useState("");
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
      if (day) body.append("day", day);
      const res = await fetch("/api/azambuja-sheet", { method: "POST", body });
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
    setDay("");
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Folha Azambuja
          </h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Uso interno · sem autenticação · rotas da Azambuja
          </p>
        </div>
        <Link href="/dashboard" className={chipClass}>
          ← Dashboard
        </Link>
      </header>

      <div className="mb-6">
        <Notice>
          Carrega a folha de rotas de <strong>um dia</strong> (estrutura ROTA /
          N_LOJA / MATRICULA). O ficheiro é processado e devolvido na hora — nada
          é guardado entre carregamentos.
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

        <label className="mt-4 flex flex-col gap-2 text-sm">
          <span className="font-medium">
            Dia de serviço{" "}
            <span className="font-normal text-black/50 dark:text-white/50">
              (opcional — deteta-se da coluna «Dia Serviço», do nome da folha ou
              do ficheiro; preenche aqui se a ferramenta não conseguir)
            </span>
          </span>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="w-44 rounded-md border border-black/15 bg-white/75 px-3 py-1.5 text-sm dark:border-white/20 dark:bg-neutral-900/75"
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
              Dia {result.day} · {result.summary.total} linhas ·{" "}
              {result.summary.routesOk}/{result.summary.routes} rotas OK
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
              </li>
              <li className="text-black/50 dark:text-white/50">
                {result.summary.dayStops} paragens nossas nesse dia
                {result.summary.passthrough > 0
                  ? ` · ${result.summary.passthrough} linhas vazias ignoradas`
                  : ""}
              </li>
            </ul>
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
            Linhas que já vêm com <strong>Hora Chegada e Hora Saida</strong>{" "}
            preenchidas passam <strong>intactas</strong> — não se lhes toca nem se
            faz matching. Ficam <strong>✅ Já preenchido (mantido)</strong>,
            distinto de <strong>OK</strong> (valor calculado por nós).
          </li>
          <li>
            As restantes linhas são agrupadas por <strong>(ROTA, N_LOJA)</strong>.
            A mesma loja repetida na rota (C + D, ou duas linhas C) é a{" "}
            <strong>mesma paragem física</strong> — as duas linhas ficam com a
            mesma Chegada/Saída. Uma ROTA pertence a <strong>um só dia</strong>;
            se o ficheiro trouxer a mesma ROTA em datas diferentes (coluna «Dia
            Serviço»), a ferramenta recusa em vez de misturar.
          </li>
          <li>
            A janela de pesquisa de paragens é o <strong>dia da folha</strong>{" "}
            (00:00–24:00). <strong>Só</strong> um CICLO com marca explícita{" "}
            <code>-1</code> (começa na véspera, «20:00-1 | …») ou <code>+1</code>{" "}
            (acaba no dia seguinte, «… | 00:30+1») é que alarga a janela para
            esse dia vizinho (+3h de folga). Ciclos de mesmo dia («02:00 |
            14:00») ou de texto livre («Crossdocking peixe») ficam presos ao dia
            da folha — uma paragem já do dia seguinte não é atribuída a essas
            linhas.
          </li>
          <li>
            Usa-se a <strong>MATRICULA</strong> já preenchida: para cada loja
            da rota, procura-se a <strong>paragem dessa viatura no mesmo código
            de loja</strong> (por hora de chegada, ignorando hífens na
            matrícula; a viatura é a mesma frota em todas as contas). As
            paragens em armazéns/oficinas que não estão na folha, e a ordem de
            condução, são ignoradas.
          </li>
          <li>
            <strong>🔄 Possível troca de viatura</strong>: se a matrícula da
            rota não cobrir uma paragem mas outra viatura tiver estado nessa
            loja a uma hora plausível (±3h da janela do CICLO), sugere-se essa
            matrícula + horas. Rotas concorrentes em veículos <em>sem</em> GPS
            nosso são ignoradas; havendo mais que uma alternativa real, fica em
            Rever. A variante <strong>🔄❗ fora da janela</strong> aparece quando
            a paragem é a única hipótese mas cai fora da margem habitual. Se{" "}
            <strong>não houver GPS nosso da viatura planeada</strong> a cobrir a
            janela da entrega (o caso da frota nova sem histórico), não se
            sugere nada — fica <strong>⚠️ Rever manualmente</strong> com nota de{" "}
            <em>sem cobertura GPS</em>.
          </li>
          <li>
            <strong>🔤 Possível erro de matrícula</strong>: se a MATRICULA da
            folha não tiver <em>nenhum</em> dado GPS nosso e existir{" "}
            <strong>exatamente uma</strong> matrícula com GPS real a{" "}
            <strong>1 caractere de diferença</strong> que fez mesmo a rota (pelo
            menos 2–3 lojas seguidas conferem no código e na hora), sugere-se
            essa matrícula corrigida + horas — erro de transcrição, não troca de
            viatura.
          </li>
          <li>
            Sem correspondência clara: <strong>⚠️ Rever manualmente</strong>, com
            a coluna <strong>Real</strong> a mostrar o que os nossos dados dizem
            para a matrícula dessa rota nesse dia (loja + horas).
          </li>
        </ol>
        <p className="mt-3">
          O ficheiro devolvido traz <strong>Hora Chegada</strong> /{" "}
          <strong>Hora Saida</strong> preenchidas com{" "}
          <strong>data + hora de Lisboa</strong> (DD/MM/AAAA HH:MM — os ciclos
          atravessam a meia-noite, a hora sozinha seria ambígua) e as colunas{" "}
          <strong>Confiança</strong>, <strong>Real</strong> e{" "}
          <strong>Dia Serviço</strong> (para poder recarregar o ficheiro
          conferido sem ambiguidade quanto ao dia). A <strong>MATRICULA</strong>{" "}
          só é reescrita quando há sugestão de troca.
        </p>
        <p className="mt-3">
          <strong>Cores no Excel</strong> (protótipo): as células{" "}
          <strong>Hora Chegada</strong> / <strong>Hora Saida</strong> ficam a{" "}
          <span className="rounded bg-amber-200 px-1 dark:text-black">amarelo</span>{" "}
          enquanto vazias numa linha <strong>⚠️ Rever manualmente</strong> — ou
          se apagares por engano uma hora que já tínhamos preenchido. Linhas de
          sugestão (troca / troca fora da janela / erro de matrícula) ficam com a{" "}
          <strong>MATRICULA</strong> + <strong>Confiança</strong> a{" "}
          <span className="rounded bg-red-300 px-1 dark:text-black">vermelho</span>{" "}
          até corrigires a matrícula ou escolheres <strong>OK</strong> na
          Confiança. E a <strong>MATRICULA</strong> fica a{" "}
          <span className="rounded bg-red-300 px-1 dark:text-black">vermelho</span>{" "}
          nos casos de <strong>«sem cobertura GPS»</strong> — não há dados nossos
          para confirmar a rota, é preciso verificar à mão (Transpogest). Colunas
          técnicas ocultas <strong>ZZ / YY / XX</strong> guardam a sugestão e as
          horas originais — não as apagues.
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
