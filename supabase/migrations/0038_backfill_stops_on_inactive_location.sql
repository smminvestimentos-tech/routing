-- Final sweep, same rule and same query shape as 0026/0029/0033 (a closed
-- stop's location is re-derived from its stored centroid against the ACTIVE
-- location whose radius_meters circle contains it, nearest centre winning,
-- location id only a final determinism tie-break) — but generalized to any
-- stop currently attached to an INACTIVE location, not just NULL ones.
--
-- Why this is needed even after 0036 (match_stop_location no longer votes
-- for inactive rows) and 0037 (01 -> 7001 re-point): those two fix the root
-- cause and this one specific pair going forward, but this sweep is kept as
-- a standing, generic safety net — and it isn't a no-op today. Besides
-- whatever 0037 didn't already move, the SAME bug independently left 58
-- closed stops stuck on code '94' (merged into 'AUCHAN-06' by 0031) — this
-- migration re-attaches those too, for free, without needing a 94-specific
-- migration.
--
-- Scope: status = 'closed' only (an open stop can still change under
-- detect_stops' own resumption logic — this shouldn't race it) AND
-- location_id pointing at a currently INACTIVE location. Idempotent:
-- re-running matches nothing once a stop has an active location.
--
-- PREVIEW — run first to see what this will move:
--
--   select l.code as from_code, l.name as from_name,
--          count(*) as n_stops
--   from stops s
--   join locations l on l.id = s.location_id
--   where l.active = false and s.status = 'closed'
--   group by l.code, l.name
--   order by n_stops desc;
--
--   -- and the resulting distribution (byte-identical shape to 0033's PREVIEW,
--   -- scoped to inactive-location stops instead of null-location ones):
--
--   select l.code, l.name, l.type, l.radius_meters,
--          count(*) as n_stops
--   from (
--     select distinct on (c.stop_id) c.stop_id, c.location_id
--     from (
--       select s.id as stop_id, l.id as location_id,
--              haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) as dist_m
--       from stops s
--       join locations l
--         on l.active
--        and l.latitude is not null and l.longitude is not null
--        and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
--       where s.status = 'closed'
--         and s.location_id in (select id from locations where active = false)
--     ) c
--     order by c.stop_id, c.dist_m asc, c.location_id asc
--   ) x
--   join locations l on l.id = x.location_id
--   group by l.code, l.name, l.type, l.radius_meters
--   order by n_stops desc, l.code;
--
--   -- as of 2026-09-15 (before 0037): code '7001' ~413, code '94' 58.
--   -- after 0037 has already moved the 7001 rows onto 7001's own (now active)
--   -- id, only the '94' rows (and anything else already inactive) remain here.

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
     and l.latitude is not null
     and l.longitude is not null
     and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
    where s.status = 'closed'
      and s.location_id in (select id from locations where active = false)
  ) c
  order by c.stop_id, c.dist_m asc, c.location_id asc
) pick
where s.id = pick.stop_id;

-- report ----------------------------------------------------------------
do $$
declare
  n_remaining int;
  r record;
begin
  select count(*) into n_remaining
  from stops s
  join locations l on l.id = s.location_id
  where l.active = false and s.status = 'closed';
  raise notice 'closed stops still on an inactive location after sweep: % (expect 0, or a genuine geometry miss with no active location nearby)', n_remaining;

  if n_remaining > 0 then
    for r in
      select l.code, l.name, count(*) as n
      from stops s
      join locations l on l.id = s.location_id
      where l.active = false and s.status = 'closed'
      group by l.code, l.name
      order by n desc
    loop
      raise notice '  still stuck: % (%) - % stop(s)', r.code, r.name, r.n;
    end loop;
  end if;
end $$;

commit;
