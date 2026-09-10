-- Fleet-wide re-match of location-less closed stops, using the radii calibrated
-- by 0028.
--
-- Same rule as 0026 (which only covered ~22 F21/Vialonga stops): a closed stop
-- with no location is attached to the ACTIVE location whose circle
-- (radius_meters, from the location's own row) contains the stop's stored
-- centroid, nearest centre winning; location id is only a final determinism
-- tie-break. This is the centroid-only form of match_stop_location() (0009) —
-- that function votes per raw ping for the dominant POI, but the ping buffer
-- isn't persisted on the stop, so the centroid is the best signal we still
-- have.
--
-- Why now: detect_stops() (0009) resolves location_id only at the moment it
-- closes a stop and never revisits a closed one. 0028 widened ~550 radii
-- (150 -> 250/300/350, clamped near neighbours), so stops that physically sat
-- just outside the old 150 m circle of a distribution centre / supplier now
-- fall inside the calibrated one — but only for NEW stops. This re-matches the
-- history once.
--
--   * `l.active` — 0019 keeps de-duplicated locations as inactive rows with the
--     same coordinates as their canonical twin; filtering to active rows keeps
--     "nearest" decisive.
--   * DISTINCT ON (stop_id) + ORDER BY dist ASC, location_id ASC — nearest
--     wins; id is only a tie-break.
--
-- Scope: status = 'closed' AND location_id IS NULL only. Stops that already
-- carry a location are untouched; open stops self-heal on the next
-- detect_stops run.
--
-- Idempotent: re-running matches nothing once these rows have a location.
--
-- Expected impact (simulated against production after 0028, at write time):
-- 206 of 959 location-less closed stops get a location; 753 stay NULL (they
-- are > the calibrated radius from any active location — orphans / bad pins /
-- missing stores, tracked in scripts/report-unassociated-stops.ts, to be fixed
-- by moving pins or adding locations, not here). Distribution of the 206:
--
--     CÓDIGO  NOME                              TIPO                RAIO   N
--     206     Entreposto Auchan/Minipreço TN    centro_distribuicao  350   73
--     203     Entreposto Auchan/Minipreço Val   centro_distribuicao  350   47
--     7002    STEF Portugal - Póvoa Stª Iria    loja                 250   16
--     25      Alfragide                         loja                 250   13
--     22      Cascais Nascente                  loja                 250    6
--     DAF     ACRV                              oficina              297    6
--     B85     SU Av Novas_MercadoS              loja                 150    5   (already inside — pure backfill)
--     E64     Setúbal III                       loja                 239    5
--     38      Sintra                            loja                 211    4
--     … 21 more locations with 1–3 stops each (see PREVIEW).
--
--   By trackit_account: default 78, azambuja 128.
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
