-- Backfill of closed stops in the Azambuja warehouse cluster (7001 / 7005)
-- following migration 0040 (which recalibrated 7001 radius from 150m to 30m
-- and 7005 from 50m to 30m, eliminating their 139m circle overlap).
--
-- Why: Under the old radii (150m on 7001), vehicles stopped at the docks of
-- 7005 ("Aucham Congelados") fell well inside the 150m circle of 7001
-- ("Armazém-Azambuja"), causing stops at 7005 to be misattributed to 7001.
-- Conversely, stops near 7001 were occasionally misattributed to 7005.
--
-- Same rule as 0026/0029/0033/0038: a closed stop is assigned to the ACTIVE
-- location whose circle (radius_meters) contains the stop's stored centroid,
-- nearest centre winning, location id only a final determinism tie-break.
--
-- Scope:
--   status = 'closed'
--   arrived_at >= '2026-09-01T00:00:00Z'
--   location_id IN (7001, 7005) OR location_id IS NULL
--
-- Expected impact (simulated against production data on 2026-09-17):
--   - Exactly 6 stops change location:
--       5 stops: 7001 -> 7005 (centroids 10.2m to 29.5m from 7005; >45m from 7001)
--       1 stop:  7005 -> 7001 (centroid 24.6m from 7001; 36.4m from 7005)
--       0 stops: NULL -> 7001 / 7005
--   - Stops on 7001 with centroids between 30m and 150m are left untouched
--     (dock/yard dispersion per 0040 design).
--
-- PREVIEW — run this first to inspect the 6 affected stops:
--
--   select
--     s.id as stop_id,
--     vp.plate,
--     s.trackit_account,
--     curr.code as from_code,
--     curr.name as from_name,
--     target.code as to_code,
--     target.name as to_name,
--     s.arrived_at at time zone 'Europe/Lisbon' as arrived_lisbon,
--     s.departed_at at time zone 'Europe/Lisbon' as departed_lisbon,
--     round(haversine_meters(s.centroid_lat, s.centroid_lng, l7001.latitude, l7001.longitude)::numeric, 1) as d_7001_m,
--     round(haversine_meters(s.centroid_lat, s.centroid_lng, l7005.latitude, l7005.longitude)::numeric, 1) as d_7005_m
--   from (
--     select distinct on (c.stop_id)
--       c.stop_id,
--       c.location_id
--     from (
--       select
--         s.id as stop_id,
--         l.id as location_id,
--         haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) as dist_m
--       from stops s
--       join locations l
--         on l.active
--        and l.code in ('7001', '7005')
--        and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
--       where s.status = 'closed'
--         and s.arrived_at >= '2026-09-01T00:00:00Z'
--         and (s.location_id is null or s.location_id in (select id from locations where code in ('7001', '7005')))
--     ) c
--     order by c.stop_id, c.dist_m asc, c.location_id asc
--   ) pick
--   join stops s on s.id = pick.stop_id
--   left join locations curr on curr.id = s.location_id
--   join locations target on target.id = pick.location_id
--   cross join (select latitude, longitude from locations where code = '7001' and active limit 1) l7001
--   cross join (select latitude, longitude from locations where code = '7005' and active limit 1) l7005
--   left join lateral (
--     select plate from vehicle_pings p where p.vehicle_id = s.vehicle_id and p.plate is not null limit 1
--   ) vp on true
--   where s.location_id is distinct from pick.location_id
--   order by s.arrived_at;

begin;

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
     and l.code in ('7001', '7005')
     and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
    where s.status = 'closed'
      and s.arrived_at >= '2026-09-01T00:00:00Z'
      and (s.location_id is null or s.location_id in (select id from locations where code in ('7001', '7005')))
  ) c
  order by c.stop_id, c.dist_m asc, c.location_id asc
) pick
where s.id = pick.stop_id
  and s.location_id is distinct from pick.location_id;

-- report ----------------------------------------------------------------
do $$
declare
  c_7001 int;
  c_7005 int;
begin
  select count(*) into c_7001
  from stops s
  join locations l on l.id = s.location_id
  where l.code = '7001' and s.status = 'closed' and s.arrived_at >= '2026-09-01T00:00:00Z';

  select count(*) into c_7005
  from stops s
  join locations l on l.id = s.location_id
  where l.code = '7005' and s.status = 'closed' and s.arrived_at >= '2026-09-01T00:00:00Z';

  raise notice 'Backfill 7001/7005 concluído com sucesso.';
  raise notice 'Total paragens fechadas desde 01/09: 7001 = %, 7005 = %', c_7001, c_7005;
end $$;

commit;

