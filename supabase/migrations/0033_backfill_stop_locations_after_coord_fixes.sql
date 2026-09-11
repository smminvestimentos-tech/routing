-- Re-run of the 0029 fleet-wide backfill of location-less closed stops, now
-- that three more rounds of location coordinate/radius corrections have
-- landed since 0029 ran: 0030 (AUCHAN-4/7092 -> 206 merge), 0031 (Albufeira
-- warehouse AUCHAN-06 coords + legacy code 94), and 0032 (154 locations'
-- coordinate/radius synced against the Azambuja TRACKiT POI reference,
-- see scripts/compare-azambuja-poi.ts).
--
-- Same rule as 0029/0026: a closed stop with no location is attached to the
-- ACTIVE location whose circle (radius_meters, from the location's own row)
-- contains the stop's stored centroid, nearest centre winning, location id
-- only a final determinism tie-break. The query itself is byte-identical to
-- 0029's — it is naturally idempotent and fleet-wide, so simply re-running it
-- picks up every stop unlocked by the coordinate work since. No new logic.
--
-- Scope: status = 'closed' AND location_id IS NULL only. Stops that already
-- carry a location are untouched; open stops self-heal on the next
-- detect_stops run.
--
-- Idempotent: re-running matches nothing once these rows have a location.
--
-- Current state (before this migration): 1335 closed stops with
-- location_id IS NULL (up from 959 at 0029's write time — normal accrual
-- from ongoing operation, not a regression). All 1335 have a stored
-- centroid.
--
-- Expected impact (simulated via scripts/preview-backfill-0033.ts, at write
-- time): 292 of 1335 get a location; 1043 stay NULL (beyond the calibrated
-- radius of any active location — orphans / bad pins / missing stores,
-- tracked in scripts/report-unassociated-stops.ts, to be fixed by moving
-- pins or adding locations, not here). Top of the distribution of the 292:
--
--     CÓDIGO  NOME                              TIPO                 RAIO   N
--     206     Entreposto Auchan/Minipreço TN    centro_distribuicao  350   73
--     203     Entreposto Auchan/Minipreço Val   centro_distribuicao  350   47
--     14      Amadora                           loja                 270   25
--     26      Maia                              loja                 150   24
--     7002    STEF Portugal - Póvoa Stª Iria    loja                 250   16
--     25      Alfragide                         loja                 200   13
--     38      Sintra                            loja                 400    9
--     A91     MA Venda Pinheiro                 loja                  50    8
--     DAF     ACRV                              oficina              297    6
--     434     MA A Joao II Setubal              loja                  69    6
--     22      Cascais Nascente                  loja                 250    6
--     … 32 more locations with 1–5 stops each (see PREVIEW).
--
--   By trackit_account: azambuja 209, default 83.
--
-- PREVIEW — run this first to see the count per location:
--
--   select l.code, l.name, l.type, l.radius_meters,
--          count(*) as n_stops,
--          round(min(x.dist_m))::int  as d_min,
--          round(max(x.dist_m))::int  as d_max
--   from (
--     select distinct on (c.stop_id) c.stop_id, c.location_id, c.dist_m
--     from (
--       select s.id as stop_id, l.id as location_id,
--              haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) as dist_m
--       from stops s
--       join locations l
--         on l.active
--        and l.latitude is not null and l.longitude is not null
--        and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
--       where s.status = 'closed' and s.location_id is null
--     ) c
--     order by c.stop_id, c.dist_m asc, c.location_id asc
--   ) x
--   join locations l on l.id = x.location_id
--   group by l.code, l.name, l.type, l.radius_meters
--   order by n_stops desc, l.code;
--
--   -- and the totals:
--   -- select count(*) from stops where status = 'closed' and location_id is null;
--   -- select count(*) as would_match from ( <the DISTINCT ON (c.stop_id) block> ) x;

update stops s
set location_id = pick.location_id,
    updated_at  = now()
from (
  select distinct on (c.stop_id)
    c.stop_id,
    c.location_id
  from (
    select
      s.id as stop_id,
      l.id as location_id,
      haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) as dist_m
    from stops s
    join locations l
      on l.active
     and l.latitude is not null
     and l.longitude is not null
     and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
    where s.status = 'closed'
      and s.location_id is null
  ) c
  order by c.stop_id, c.dist_m asc, c.location_id asc
) pick
where s.id = pick.stop_id;
