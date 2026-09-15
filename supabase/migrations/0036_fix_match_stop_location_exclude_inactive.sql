-- match_stop_location() (0009) joins against EVERY row in `locations`
-- regardless of `active` — unlike the one-off backfill migrations
-- (0026/0029/0033), which already scope their own geometry join to
-- `l.active`. A live-detected stop can therefore vote for an inactive,
-- merged-away location just as easily as its active canonical counterpart.
--
-- Real-world evidence (2026-09-15): 413 CLOSED stops in September alone
-- landed on the inactive '7001' row (merged into '01' by 0019) purely
-- because this function has no active filter — none of that is a GPS or
-- detection problem, it's this join picking a dead row. A second, unrelated
-- pair (code '94', merged into 'AUCHAN-06' by 0031) shows the same thing: 58
-- closed stops stuck on it today. This is a general bug, not specific to any
-- one merge.
--
-- Fix: add `l.active` to the join, mirroring the backfill migrations' own
-- condition, so a merged/deactivated location can never again absorb a live
-- stop — independently of which code ends up canonical in any future merge.
--
-- Same signature as the 0009 definition, so `create or replace` is enough
-- (no `drop function` needed first, unlike 0035's close_and_persist_stop,
-- which changed its parameter list).
--
-- PREVIEW — confirms today's function has no active filter (look for the
-- absence of "l.active" in the join condition):
--
--   select pg_get_functiondef('match_stop_location(stop_ping[], double precision, double precision)'::regprocedure);

begin;

create or replace function match_stop_location(
  p_buffer stop_ping[],
  p_centroid_lat double precision,
  p_centroid_lng double precision
) returns uuid language sql stable as $$
  select l.id
  from unnest(p_buffer) as b(lat, lng)
  join locations l
    on l.active
   and haversine_meters(b.lat, b.lng, l.latitude, l.longitude) <= l.radius_meters
  group by l.id, l.latitude, l.longitude
  order by count(*) desc,
           haversine_meters(p_centroid_lat, p_centroid_lng, l.latitude, l.longitude) asc,
           l.id asc
  limit 1;
$$;

-- report ----------------------------------------------------------------
do $$
begin
  raise notice 'match_stop_location redefined with "and l.active" in the join — verify with pg_get_functiondef (PREVIEW query above) that the new body contains it.';
end $$;

commit;
