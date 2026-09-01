-- Merge two confirmed sets of duplicate locations into one canonical row each,
-- re-pointing every reference so NO history is lost. The duplicate rows are
-- kept (not deleted) and flagged inactive; the dashboard aggregation views
-- start filtering on active = true so they stop showing up as distinct options.
--
--   Group 1 — same physical complex (Vialonga):
--     canonical : 7091  Armazém-Vialonga          (correct coordinate)
--     merged in : AUCHAN-03  ARMAZÉM ALVERCA
--     merged in : 201  Entreposto Minipreço/Auchan Vialonga
--
--   Group 2 — same site (Azambuja):
--     canonical : 01  Armazém Azambuja            (more history: 236 refs vs 71)
--     merged in : 7001  Armazém-Azambuja
--
-- route_margins is empty at authoring time; its re-point statements are
-- no-ops / future-proofing (if it has colliding pairs at apply time, dedupe
-- them by hand first).

begin;

-- 1. active flag -------------------------------------------------------------
alter table locations add column if not exists active boolean not null default true;

-- 2. re-point every reference: duplicate id -> canonical id -----------------
-- Group 1: AUCHAN-03, 201  ->  7091
update stops
   set location_id = (select id from locations where code = '7091')
 where location_id in (select id from locations where code in ('AUCHAN-03', '201'));

update route_legs
   set origin_id = (select id from locations where code = '7091')
 where origin_id in (select id from locations where code in ('AUCHAN-03', '201'));

update route_legs
   set destination_id = (select id from locations where code = '7091')
 where destination_id in (select id from locations where code in ('AUCHAN-03', '201'));

update route_margins
   set origin_location_id = (select id from locations where code = '7091')
 where origin_location_id in (select id from locations where code in ('AUCHAN-03', '201'));

update route_margins
   set destination_location_id = (select id from locations where code = '7091')
 where destination_location_id in (select id from locations where code in ('AUCHAN-03', '201'));

-- Group 2: 7001  ->  01
update stops
   set location_id = (select id from locations where code = '01')
 where location_id in (select id from locations where code = '7001');

update route_legs
   set origin_id = (select id from locations where code = '01')
 where origin_id in (select id from locations where code = '7001');

update route_legs
   set destination_id = (select id from locations where code = '01')
 where destination_id in (select id from locations where code = '7001');

update route_margins
   set origin_location_id = (select id from locations where code = '01')
 where origin_location_id in (select id from locations where code = '7001');

update route_margins
   set destination_location_id = (select id from locations where code = '01')
 where destination_location_id in (select id from locations where code = '7001');

-- Clean up references that collapsed onto themselves by the merge. route_legs
-- rows are KEPT (historical) — the pair views already ignore origin = destination.
-- route_margins self-pairs / duplicates are config, not history, so drop them.
delete from route_margins where origin_location_id = destination_location_id;
delete from route_margins a
  using route_margins b
 where a.origin_location_id = b.origin_location_id
   and a.destination_location_id = b.destination_location_id
   and a.ctid < b.ctid;

-- 3. flag the duplicates inactive (kept, not deleted) ----------------------
update locations
   set active = false, updated_at = now()
 where code in ('AUCHAN-03', '201', '7001');

-- 4. aggregation views filter on active = true ----------------------------
-- (Matriz, "Tempo médio parado por local", Rotas. The individual-record
--  surfaces — Trajetos, Paragens list — are left as-is: their rows simply
--  re-attribute to the canonical location.)

create or replace view v_location_dwell_stats as
select
  s.location_id,
  l.code                                    as location_code,
  l.name                                    as location_name,
  l.type                                    as location_type,
  stop_kind_of(s.arrived_at, s.departed_at) as stop_kind,
  count(*)                                  as stop_count,
  round(avg(s.duration_minutes), 2)         as avg_duration_minutes,
  round(
    (percentile_cont(0.5) within group (order by s.duration_minutes))::numeric,
    2
  )                                         as median_duration_minutes,
  round(min(s.duration_minutes), 2)         as min_duration_minutes,
  round(max(s.duration_minutes), 2)         as max_duration_minutes
from stops s
join locations l on l.id = s.location_id
where s.status = 'closed'
  and l.active
group by s.location_id, l.code, l.name, l.type,
         stop_kind_of(s.arrived_at, s.departed_at);

create or replace view v_location_pair_matrix as
select
  u.source,
  u.origin_location_id,
  u.destination_location_id,
  o.name as origin_name,
  d.name as destination_name,
  count(*)                                                                    as trip_count,
  round(avg(u.duration_seconds))::bigint                                      as avg_duration_seconds,
  round(percentile_cont(0.5) within group (order by u.duration_seconds))::bigint as median_duration_seconds,
  round(avg(u.distance_km)::numeric, 2)                                       as avg_distance_km,
  o.code as origin_code,
  d.code as destination_code
from v_trip_legs_unified u
join locations o on o.id = u.origin_location_id
join locations d on d.id = u.destination_location_id
where u.origin_location_id is not null
  and u.destination_location_id is not null
  and u.origin_location_id <> u.destination_location_id
  and o.active
  and d.active
group by u.source, u.origin_location_id, u.destination_location_id,
         o.name, d.name, o.code, d.code;

create or replace view v_route_estimates as
with legs as (
  select
    u.origin_location_id,
    u.destination_location_id,
    count(*)                as trip_count,
    avg(u.duration_seconds) as avg_travel_seconds
  from v_trip_legs_unified u
  where u.origin_location_id is not null
    and u.destination_location_id is not null
    and u.origin_location_id <> u.destination_location_id
  group by u.origin_location_id, u.destination_location_id
)
select
  legs.origin_location_id,
  legs.destination_location_id,
  o.code as origin_code,
  o.name as origin_name,
  d.code as destination_code,
  d.name as destination_name,
  legs.trip_count,
  round((legs.avg_travel_seconds / 60.0)::numeric, 2) as avg_travel_minutes,
  co.avg_duration_minutes as origin_load_minutes,
  cd.avg_duration_minutes as destination_load_minutes
from legs
join locations o on o.id = legs.origin_location_id and o.active
join locations d on d.id = legs.destination_location_id and d.active
left join v_location_dwell_stats co
  on co.location_id = legs.origin_location_id and co.stop_kind = 'carga'
left join v_location_dwell_stats cd
  on cd.location_id = legs.destination_location_id and cd.stop_kind = 'carga';

-- 5. now that the yard is one location, widen its radius (unmatched stops
--    reached ~294m from the point).
update locations set radius_meters = 350, updated_at = now() where code = '7091';

-- 6. report ----------------------------------------------------------------
do $$
declare
  r record;
begin
  raise notice 'stops.location_id not null: %', (select count(*) from stops where location_id is not null);
  raise notice 'route_legs.origin_id not null: %', (select count(*) from route_legs where origin_id is not null);
  raise notice 'route_legs.destination_id not null: %', (select count(*) from route_legs where destination_id is not null);
  for r in
    select l.code, l.active, l.radius_meters,
           (select count(*) from stops s where s.location_id = l.id) as stops,
           (select count(*) from route_legs x where x.origin_id = l.id) as rl_o,
           (select count(*) from route_legs x where x.destination_id = l.id) as rl_d
    from locations l
    where l.code in ('7091','AUCHAN-03','201','01','7001')
    order by l.code
  loop
    raise notice '  % active=% radius=% stops=% rl_origin=% rl_dest=%',
      r.code, r.active, r.radius_meters, r.stops, r.rl_o, r.rl_d;
  end loop;
end $$;

commit;
