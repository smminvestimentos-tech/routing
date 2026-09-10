-- Calibrate location.radius_meters by type, from the uncalibrated default.
--
-- Context: 705 of 709 active locations still sit at the seed default
-- radius_meters = 150 (only 4 were ever hand-tuned). A one-off analysis of
-- every closed stop with location_id IS NULL (scripts/report-unassociated-stops.ts)
-- found ~954 unassociated stops; ~296 of them fall within 150 m *outside* an
-- active location's circle — i.e. the radius is simply too tight for the site
-- (a distribution centre's yard, a supplier's loading area). The two biggest
-- offenders alone (206 "Entreposto Auchan Torres Novas", 203 "…Valongo",
-- centro_distribuicao) account for 130 stops, each ~160 m from a pin that is
-- itself well-placed.
--
-- Per-type target radius (a warehouse yard is bigger than a street shop):
--     centro_distribuicao, armazem -> 350
--     oficina, fornecedor          -> 300
--     loja                         -> 250
--
-- Collision guard (the reason this is not a flat bump): 208 pairs of active
-- locations sit < 550 m apart — many Lisboa "MA …" market stalls next to an
-- "SU …" store, and co-located rows at 0 m ("Amadora" + "Amadora Comércio
-- Electrónico", "Maia" + "Talho P4F", the Fayal/Hipercais supplier cluster).
-- Growing every circle to the type target would make ~170 of those overlap and
-- let a drifting stop match the wrong neighbour. So each row is clamped to at
-- most HALF the distance to its nearest *other* active location: two adjacent
-- circles then meet at the midpoint at worst, and "nearest centre wins" (0009 /
-- 0026) stays decisive. A row whose neighbour is closer than 300 m keeps 150.
--
-- Deliberately NOT touched by this migration (need their own follow-up):
--   * rows with NULL / out-of-Portugal coordinates (7092, AUCHAN-02/05/06/4
--     have no coords; H73 has a longitude sign error at (41, 7)) — a radius is
--     meaningless until the point is fixed;
--   * co-located pairs like 14/141 (Amadora) and 26/142/7004 (Maia) — same
--     physical spot, can't be separated by radius; merge or move instead;
--   * the Vila Nova da Rainha cluster (01 "Armazém Azambuja", 7005, 7003,
--     Serviroda all within ~200 m) — clamp keeps them at 150; the stray stops
--     there are a pin-placement problem, not a radius one;
--   * bad geocodes where the stops cluster hundreds of metres off the pin
--     (C744 "Jacquot" ~450 m, Dhollandia ~290 m) — those get relocated, not
--     widened.
--
-- Expected impact (simulated against production at write time): 551 rows
-- updated of the 684 at radius 150 inside the Portugal coordinate box —
--     loja        483 changed (412 -> 250, 71 clamped 152..247)
--     fornecedor   57 changed ( 52 -> 300,  5 clamped 155..291)
--     oficina       8 changed (  6 -> 300,  2 clamped 297)
--     centro_distribuicao 2 -> 350  (203, 206)
--     armazem       1 -> 200 (243A, clamped; the other armazem/CD rows are the
--                   NULL-coord AUCHAN-* rows or the Vila Nova da Rainha
--                   cluster and stay 150)
--   133 rows stay at 150 (neighbour too close). Re-running is a no-op —
--   nothing is left at 150 that the formula would move.
--
-- PREVIEW — run this first to see every row that would change:
--
--   with cand as (
--     select l.id, l.code, l.name, l.type, l.radius_meters,
--            (select min(haversine_meters(l.latitude, l.longitude, o.latitude, o.longitude))
--             from locations o
--             where o.id <> l.id and o.active
--               and o.latitude between 32 and 43 and o.longitude between -32 and -6) as nn_m
--     from locations l
--     where l.radius_meters = 150
--       and l.latitude between 32 and 43 and l.longitude between -32 and -6
--   )
--   select code, name, type, radius_meters as from_r,
--          greatest(150, least(
--            case type when 'centro_distribuicao' then 350 when 'armazem' then 350
--                      when 'oficina' then 300 when 'fornecedor' then 300 else 250 end,
--            floor(nn_m / 2)::int)) as to_r,
--          round(nn_m)::int as nearest_m
--   from cand
--   where greatest(150, least(
--           case type when 'centro_distribuicao' then 350 when 'armazem' then 350
--                     when 'oficina' then 300 when 'fornecedor' then 300 else 250 end,
--           floor(nn_m / 2)::int)) <> 150
--   order by to_r desc, nearest_m desc;

with cand as (
  select
    l.id,
    l.type,
    (
      select min(haversine_meters(l.latitude, l.longitude, o.latitude, o.longitude))
      from locations o
      where o.id <> l.id
        and o.active
        and o.latitude between 32 and 43
        and o.longitude between -32 and -6
    ) as nn_m
  from locations l
  where l.radius_meters = 150
    and l.latitude between 32 and 43
    and l.longitude between -32 and -6
),
target as (
  select
    id,
    greatest(
      150,
      least(
        case type
          when 'centro_distribuicao' then 350
          when 'armazem'             then 350
          when 'oficina'             then 300
          when 'fornecedor'          then 300
          else 250
        end,
        floor(coalesce(nn_m, 1e9) / 2)::int
      )
    ) as new_radius
  from cand
)
update locations l
set radius_meters = t.new_radius,
    updated_at    = now()
from target t
where l.id = t.id
  and t.new_radius <> 150;
