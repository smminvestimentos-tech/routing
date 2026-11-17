-- 0044 — Pátio Azambuja: 7005 reduzido ao cais real + docas do 7001 na fachada SO
--
-- Contexto (análise 16/17-11-2026, ficheiros de 07-11 e 16-11):
--   • O cais 7005 (Congelados) são ~5 docas (~20–25 m) a meio da fachada
--     sudoeste do armazém Auchan — confirmado no mapa pelo utilizador. O resto
--     dessa fachada são docas do 7001.
--   • O 7005 era um círculo de 75 m centrado ~17 m dentro da parede, e cobria
--     ~150 m de fachada: 15 das 21 cargas "só 7001" do plano de 07-11 caíam no
--     7005, e as linhas 7001 ficavam só com o toque no portão (0 min).
--   • A noroeste do círculo, as docas do 7001 não tinham local (≈420 paragens
--     "sem local" em 14 dias, mediana 29 min).
--
-- Alterações:
--   1. 7005: centro movido para a linha onde o GPS regista as cabines em frente
--      ao cais (mesma posição ao longo da fachada), raio 75 -> 25 m.
--   2. Dois locais novos, tipo centro_distribuicao, ligados ao 7001
--      (colocated_with_id) — o matcher já trata "7001-SON"/"7001-SOS" como 7001
--      (codeBaseEq: prefixo "7001-", e o grupo co-localizado):
--        7001-SON  docas SO a noroeste do cais 7005  (raio 75 m)
--        7001-SOS  docas SO a sudeste do cais 7005   (raio 30 m)
--      A deteção de paragens escolhe o local MAIS PRÓXIMO entre os que contêm o
--      ponto (0040), por isso as pequenas sobreposições entre círculos são
--      resolvidas pela distância.
--   3. Backfill desde 2026-09-01 (mesmo âmbito da 0042): paragens fechadas
--      sem local ou em 7001/7005 recebem o local mais próximo entre
--      7001, 7005, 7001-SON, 7001-SOS (ou nenhum).
--
-- Impacto estimado (simulação 03–16/11, 14 dias):
--   sem local -> 7001-SON  ~419    sem local -> 7001-SOS  ~12
--   7005      -> 7001-SON  ~301    7005      -> 7001-SOS  ~191
--   7005      -> sem local ~21  (estacionamentos longos / outro lado da via)
--   Validação: cargas "só 7001" do plano de 07-11 com paragem: 19/27 passam a
--   7001 (antes 0), 7 continuam no cais 7005.
--
-- Reverter: repor 7005 (39.042528952161, -8.92070763033689, 75), desativar
-- 7001-SON/7001-SOS e voltar a correr o passo 3 só com 7001/7005.

begin;

-- 1. 7005 = só o cais
update locations
set latitude = 39.04244, longitude = -8.920872, radius_meters = 25, updated_at = now()
where code = '7005' and active;

-- 2. docas SO do 7001
insert into locations (code, name, type, address, locality, latitude, longitude, radius_meters, active, colocated_with_id)
select v.code, v.name, 'centro_distribuicao', l.address, l.locality, v.lat, v.lng, v.r, true, l.id
from (values
  ('7001-SON', 'Armazém-Azambuja — docas SO (noroeste)', 39.043163, -8.921499, 75),
  ('7001-SOS', 'Armazém-Azambuja — docas SO (sudeste)',  39.042083, -8.920562, 30)
) as v(code, name, lat, lng, r)
cross join (select id, address, locality from locations where code = '7001' and active) l
on conflict do nothing;

-- 3. backfill
with yard as (
  select id from locations where active and code in ('7001', '7005', '7001-SON', '7001-SOS')
),
scope as (
  select s.id, s.location_id, s.centroid_lat, s.centroid_lng
  from stops s
  where s.status = 'closed'
    and s.arrived_at >= '2026-09-01T00:00:00Z'
    and s.centroid_lat is not null
    and (s.location_id is null or s.location_id in (select id from yard))
    and haversine_meters(s.centroid_lat, s.centroid_lng, 39.042529, -8.920708) <= 400
),
pick as (
  select distinct on (sc.id) sc.id as stop_id, l.id as location_id
  from scope sc
  join locations l
    on l.id in (select id from yard)
   and haversine_meters(sc.centroid_lat, sc.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
  order by sc.id,
           haversine_meters(sc.centroid_lat, sc.centroid_lng, l.latitude, l.longitude) asc,
           l.id asc
),
target as (
  select sc.id as stop_id, pick.location_id as to_id
  from scope sc
  left join pick on pick.stop_id = sc.id
  where sc.location_id is distinct from pick.location_id
    -- o pino do 7001 não mudou: não tirar paragens ao 7001 (algumas ficam
    -- fora do raio pelo centroide mas foram atribuídas pela deteção ao vivo)
    and not (pick.location_id is null
             and sc.location_id = (select id from locations where code = '7001' and active))
)
update stops s
set location_id = target.to_id,
    updated_at  = now()
from target
where s.id = target.stop_id;

-- relatório
do $$
declare r record;
begin
  for r in
    select l.code, count(*) as n
    from stops s join locations l on l.id = s.location_id
    where l.code in ('7001', '7005', '7001-SON', '7001-SOS')
      and s.arrived_at >= '2026-11-03T00:00:00Z'
    group by l.code order by l.code
  loop
    raise notice '  % : % paragens desde 03-11', r.code, r.n;
  end loop;
end $$;

commit;
