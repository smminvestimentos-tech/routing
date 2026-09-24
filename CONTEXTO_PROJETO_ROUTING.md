# Contexto do Projeto "routing" — LEIA ANTES DE MEXER EM QUALQUER COISA

Este documento existe para uma ferramenta de IA nova (não é a que construiu este projeto) não se perder, não alucinar factos sobre a arquitetura, e não aplicar nada em produção sem cuidado. Se tiveres dúvidas sobre porque algo foi feito de certa forma, **procura primeiro nos comentários das migrações SQL referidas aqui** — estão bem documentadas com o raciocínio completo.

---

## 0. REGRAS DE SEGURANÇA — NUNCA QUEBRAR

1. **NUNCA aplicar SQL diretamente na base de dados de produção sem antes mostrar o ficheiro completo ao utilizador para revisão.** O utilizador cola o SQL manualmente no SQL Editor do Supabase — tu não tens (e não deves tentar obter) acesso direto de escrita à BD de produção.
2. **Toda a alteração de schema é uma migração numerada** em `supabase/migrations/`, formato `00XX_descricao.sql`, com:
   - Comentário no topo a explicar o contexto/porquê (não só o quê)
   - Uma query de `PREVIEW` (só `SELECT`) que o utilizador corre primeiro, para confirmar o impacto esperado antes do `UPDATE`/`INSERT`/`DDL` real
   - Envolvida em `begin; ... commit;` quando fizer sentido (várias operações relacionadas)
   - Nunca usa `DELETE` em dados operacionais (`stops`, `route_legs`, `vehicle_pings`) — só em tabelas de configuração (`route_margins`, e mesmo aí só para remover duplicados/self-pairs criados pela própria migração)
3. **Nunca fazer `git push` sem o utilizador pedir explicitamente.** Commit local é ok depois de confirmado, mas o push é sempre uma decisão consciente do utilizador.
4. **Nunca escolher sozinho entre duas fontes de dados que discordam** (ex. duas matrículas candidatas para a mesma linha) — nesses casos, sinaliza para revisão humana em vez de adivinhar.
5. **Sempre testar/simular antes de aplicar** — sempre que possível, escreve um script de simulação (só leitura) que mostra o impacto esperado (contagens antes/depois) antes de escrever a migração de verdade.
6. **O MCP do Supabase, se estiver ligado nesta sessão, pode estar a apontar para o projeto ERRADO** (`LOGISTICA ATIVA`, ref `eedihsqscrrzeravkuwq`). O projeto certo é `iiqsqzllsnppagqflfcq`. Confirma sempre via `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`) antes de usar qualquer ferramenta MCP da BD — se apontar para o projeto errado, usa scripts com `supabase-js` + a `service_role key` do `.env.local` em vez disso.
7. **Nunca inventar valores de coordenadas, matrículas, ou qualquer dado de negócio.** Se não tiveres a certeza, pergunta ao utilizador ou pede uma fonte de referência (ex. exportação do Transpogest/TRACKiT).

---

## 1. O que é este projeto

Sistema de routing/logística para frotas de camiões (TFS/Auchan), com dois objetivos principais:
1. **Rastrear a frota em tempo real** via GPS (TRACKiT), detetar paragens, e cruzar com uma rede de ~700+ locations (lojas, armazéns, fornecedores, oficinas).
2. **Cruzar automaticamente folhas de entrega** (exportações Excel de dois sistemas de planeamento — "TFS" e "Azambuja") com os dados reais de GPS, para confirmar/preencher horários de chegada e saída, poupando trabalho manual.

Stack: Next.js (App Router) + Supabase (Postgres) + Vercel (deploy) + TRACKiT API (GPS) + cron-job.org (scheduler externo).

Repositório: `github.com/smminvestimentos-tech/routing`. Projeto Supabase: `iiqsqzllsnppagqflfcq`.

---

## 2. Arquitetura de dados (tabelas principais)

- **`locations`** — mestre de todos os locais (lojas, armazéns, CDs, fornecedores, oficinas). Campos-chave: `code` (único), `name`, `type`, `latitude`/`longitude`, `radius_meters`, `active`, `merged_into_id`, `colocated_with_id`.
- **`vehicle_pings`** — posições GPS brutas, uma linha por poll (~5 min ao vivo). Colunas: `trackit_account`, `vehicle_id`, `recorded_at`, `latitude`, `longitude`, `speed_kmh`, `odometer_km`, `plate`.
- **`stops`** — paragens detetadas (agregação de pings), com `location_id` (pode ser `null` se não bater com nenhuma location). Gerada pela função `detect_stops()`.
- **`fleet_trucks`** — mapeamento auxiliar `truck_number → plate` (pode ficar desatualizado, é só uma pista, nunca fonte de verdade absoluta).
- **`route_margins`**, **`dashboard_settings`** — configuração de margens de tempo para estimativas de rota.

### Multi-conta TRACKiT
Há **duas contas TRACKiT em paralelo**: `default` (frota original, ~38 veículos) e `azambuja` (~182 veículos). Todas as tabelas relevantes têm uma coluna `trackit_account` para as distinguir. **Importante**: `vehicle_id` é único em toda a empresa (nunca colide entre contas) — a mesma frota física, os camiões podem prestar serviço em qualquer uma das duas áreas. Por isso, o matching das folhas de entrega é **fleet-wide, sem filtro de conta** (decisão deliberada, não esquecimento).

### Locations fundidas (`merged_into_id`)
Ao longo do tempo, descobriram-se vários códigos duplicados para o mesmo local físico (ex. `7001`/`AUCHAN-03`/`201` → `01`/`7091`; `AUCHAN-4`/`7092` → `206`). Em vez de apagar duplicados, marcam-se `active = false` e `merged_into_id` aponta para o canónico. **O matcher das folhas resolve automaticamente** um código antigo para o canónico antes de procurar paragens — nunca reescreve o código na célula da folha, só usa a resolução internamente.

### Locations colocadas (`colocated_with_id`)
Diferente de fusão: duas locations **ambas ativas e independentes** que partilham o mesmo espaço físico (ex. uma loja e uma plataforma/armazém anexo, como Almada `12`↔`7030`, Maia `26`↔`7004`, Albufeira `B78`↔`AUCHAN-06`). O matching aceita paragens de qualquer uma das duas como válidas para ambos os códigos, mas a coluna de saída da folha mantém sempre o código original pedido.

---

## 3. Pipeline de ingestão GPS

- `/api/sync/positions` — chamado a cada 5 min via **cron-job.org** (não GitHub Actions — descoberto que o cron nativo do GitHub Actions descarta execuções silenciosamente em intervalos curtos). Vai buscar `vehiclesForUser` à TRACKiT, grava em `vehicle_pings`.
- `/api/sync/stops` — chamado a cada ~10-15 min, corre `detect_stops()` para gerar/atualizar `stops`.
- Autenticação: header `Authorization: Bearer <SYNC_SECRET ou CRON_EXTERNAL_SECRET>`.
- Rate limit da TRACKiT: ~1 pedido/segundo, **por conta** (as duas contas correm em paralelo sem se atrasarem mutuamente).

### `detect_stops()` — como funciona (função PL/pgSQL)
- Percorre os pings de cada veículo desde a última paragem fechada.
- "Parado" = `speed_kmh ≤ 3` para **entrar** no buffer de uma paragem.
- Fecha a paragem por relocalização (>50m do centróide) ou movimento sustentado (≥2 min).
- **Limiar mínimo de duração**: normalmente 1 minuto — **exceto** para locations do tipo `armazem`/`centro_distribuicao`, onde cai para 0 segundos **se e só se** a velocidade mínima observada no buffer for ≤1km/h (proteção contra confundir "passagem lenta por uma zona grande" com "parou mesmo"). Ver migração `0035`.
- `match_stop_location()` decide a location por votação de pings dentro do raio, desempate pela mais próxima.
- **Corre ao vivo, incrementalmente** — nunca reprocessa automaticamente o passado. Se corrigires a lógica ou uma coordenada, as paragens **antigas** só se corrigem com um **backfill manual** (ver migrações `0026`, `0029`, `0033`, `0041`, `0042`).
- ⚠️ **Chamar `detect_stops()` sem filtro de veículo para a frota toda de uma vez pode dar timeout no Postgres** (limite real ≈8s por query, não os 25-30s que se podia assumir). Para reprocessar histórico, usar passos de tempo pequenos (`p_now` a avançar em incrementos de 30 min a 2h, ajustar conforme a resposta) — a função é idempotente e resumível, chamar repetidamente com `p_now` crescente reconstrói o mesmo resultado que uma chamada única, sem estourar o limite.

---

## 4. Histórico de Migrações Recentes (0036 a 0042)

- **`0036`** — `match_stop_location()` passa a ignorar explicitamente locations com `active = false`.
- **`0037`** — Reversão da fusão incorreta `01` / `7001`.
- **`0038`** — Backfill de paragens antigas associadas a locations inativas.
- **`0039`** — Adição de índice composto em `vehicle_pings(trackit_account, vehicle_id)` para acelerar queries da frota.
- **`0040`** — Redução emergencial dos raios de `7001` e `7005` para 30m para eliminar colisão temporária.
- **`0041`** — Backfill de paragens `7001` / `7005` pós-0040.
- **`0042`** — **Calibração definitiva dos pinos de Azambuja (7001 e 7005)**:
  - `7001` (Armazém-Azambuja / docas leste): `(39.042563, -8.919161)`, raio de 75m.
  - `7005` (Auchan Congelados / docas oeste): `(39.042557, -8.920994)`, raio de 75m.
  - Distância entre centros = 158.3m (círculos de 75m com folga de 8.3m, sem sobreposição).
  - Backfill de paragens fechadas desde `2026-09-01` aplicado a 2026-09-24 10:02 UTC.
  - Acompanhado de regra assimétrica no matcher (`YARD_ACCEPTS`: linhas `7001` aceitam paragens `7005` em rotas onde só há paragem na doca oeste; `7005` nunca aceita paragens leste).

---

## 5. Segurança de acesso (RLS)

Todas as tabelas têm RLS ativado + `REVOKE ALL FROM anon, authenticated, public`. A app só acede via `service_role key` (`createAdminClient()`), que ignora RLS.

⚠️ **Gotcha importante**: o pipeline de migrações (o "runner" automático) corre com um role **diferente** de `postgres`, e **falha silenciosamente** em instruções que exigem especificamente o role `postgres` (`ALTER DEFAULT PRIVILEGES FOR ROLE postgres`, `REVOKE` em objetos pertencentes a `postgres`). Essas instruções têm de ser coladas e corridas **manualmente no SQL Editor do Supabase** (que corre como `postgres`), nunca confiar que o pipeline as aplicou só porque não deu erro.

⚠️ **Views herdam privilégios do dono, não de quem consulta** — `security_invoker = on` pode não resolver isto de forma fiável (dependendo da versão do Postgres); a correção mais robusta e testada foi `REVOKE ALL ... FROM anon, authenticated` diretamente nas views.

---

## 6. As ferramentas de folha de entrega (`/dashboard/tfs-sheet` e `/dashboard/azambuja-sheet`)

Cada uma lê um `.xlsx` de um sistema de planeamento diferente (layouts diferentes — ver `src/lib/tfs-sheet/match.ts` e `src/lib/azambuja-sheet/match.ts`), tenta preencher Hora de Chegada/Saída com dados reais de `stops`, e devolve o ficheiro anotado. Lógica partilhada em `src/lib/sheet-match/common.ts`.

### Categorias de resultado (coluna "Confiança")
1. **✅ Já preenchido (mantido)** — a linha já veio com Chegada E Saída preenchidas na origem; não mexer. **Mas**: um par com duração ≤0 (Chegada ≥ Saída) é tratado como placeholder inválido, não como dado real — cai para matching normal em vez de ser aceite cegamente (bug histórico corrigido, ver commit `fa26052`).
2. **OK** — matrícula resolvida (da própria coluna, extraída do `ID`, ou via `fleet_trucks`) e emparelhada com sucesso a uma paragem real, pela ordem cronológica **de todas as rotas do veículo nesse dia** (não só a rota atual — um veículo pode ter várias rotas no mesmo dia).
3. **🔄 Possível troca de viatura** — a matrícula planeada não bate com nada, mas sobra exatamente uma paragem real de **outro** veículo na loja certa, dentro da janela planeada (±3h), sem rival credível (outro veículo GPS-tracked também candidato).
4. **🔄❗ Possível troca (fora da janela)** — o mesmo, mas a paragem candidata está fora da janela ±3h (sinal mais fraco, pede confirmação mais cuidadosa).
5. **🔤 Possível erro de matrícula** — a matrícula planeada nunca teve GPS nenhum, mas existe uma matrícula a distância de edição 1 (um caractere trocado) com paragens que corroboram uma sequência de 2-3+ lojas da rota, por ordem.
6. **⚠️ Rever manualmente** — nenhuma das anteriores; a coluna "Real" explica a razão exata (sem cobertura GPS, sem paragens sobrantes, discrepância entre fontes, etc.).

### Regras importantes de matching
- **`codeEq()`** compara códigos de loja com tolerância (mesmo prefixo+dígitos ignorando zeros à esquerda; um código é o "segmento base" do outro, ex. `B97` ≡ `B97-E72`) — **mas nunca** reduz só a dígitos ignorando a letra (`B97` ≠ `E97`; um bug antigo fazia isto e gerava sugestões de troca falsas).
- **Janela de tempo do CICLO** (Azambuja): formato `HH:MM[-1|+1] | HH:MM[-1|+1]`. Uma paragem só conta se **couber inteira** dentro da janela (chegada E saída, não só a chegada — um bug antigo só verificava a chegada).
- **`merged_into_id`** e **`colocated_with_id`** são resolvidos antes do matching, como já descrito na secção 2.
- **Nunca escrever/sugerir sem verificar cobertura GPS do veículo planeado primeiro** — se o veículo planeado não tem sequer dados GPS na janela em causa, não faz sentido sugerir outro veículo como "troca" (podia ser só falta de dados, não uma troca real). Ver função `plannedPlateHasCoverage`/`noGpsCoverageNote`.

### PostgREST corta a 1000 linhas por defeito
Mesmo pedindo `.limit(20000)` explicitamente numa query, o Supabase/PostgREST pode devolver só 1000 linhas silenciosamente. Sempre que uma query puder devolver mais que isso (ex. `stops` de um dia com muito volume), usar paginação explícita (`scripts/... fetchAllRows` já existe como padrão).

---

## 7. Scripts utilitários já existentes (reaproveitar, não recriar)

- `scripts/import-locations.ts` — upsert de locations a partir de um CSV.
- `scripts/import-fleet-trucks.ts` — upsert de `fleet_trucks` a partir de um CSV.
- `scripts/report-unassociated-stops.ts` — relatório de paragens sem `location_id`, agrupadas por distância à location mais próxima.
- `scripts/compare-transpogest-coords.ts` / `scripts/compare-azambuja-poi.ts` — comparação de coordenadas contra fontes de referência externas (Transpogest, POI TRACKiT).
- `scripts/backfill-azambuja-pings.ts` — backfill de histórico via `vehicleHistoric` (mais lento, ~28s/ponto sem thinning; thinning para ~90-180s de resolução antes de gravar).
- `scripts/audit-kept-placeholder-rows.ts` — auditoria de ficheiros de folha já processados, à procura de linhas "mantidas" com dados de placeholder inválidos.

---

## 8. Convenções de trabalho a seguir

1. Antes de qualquer alteração a `detect_stops`, `match_stop_location`, ou à lógica de matching das folhas — **procurar um caso real primeiro**, nunca corrigir "no abstrato". Este projeto tem um histórico forte de bugs subtis que só apareciam com dados reais, não em testes sintéticos.
2. Sempre que corrigires um bug de matching, verifica se precisa de **regressão** contra casos já validados antes (há suites de teste: `npm run test:sheet-match`, `test:azambuja-window`, `test:sheet-workbook`, `test:plate-typo`).
3. Documenta o "porquê" nos comentários das migrações, não só o "o quê" — o histórico deste projeto mostra que isso poupa tempo a quem vier depois (incluindo o próprio autor, semanas depois).
4. Se encontrares algo que parece um erro de dados (coordenada estranha, matrícula duplicada, código repetido) — **confirma com o utilizador antes de assumir**. Muitas "anomalias" aparentes tinham explicação operacional legítima (camiões partilhados entre frotas, armazéns colados a lojas, turnos que atravessam a meia-noite).

---

*Este documento reflete o estado do projeto até à sessão em que foi escrito. Se encontrares uma migração numerada mais alta que a última mencionada aqui (0042), lê o comentário dela primeiro — o histórico mais recente pode ter mudado algo descrito acima.*