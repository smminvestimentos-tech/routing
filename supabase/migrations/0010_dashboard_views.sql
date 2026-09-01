-- Read models for the /dashboard page. No data of their own — plain views
-- over stops (new pipeline) and route_legs (old pipeline, kept as history).

-- One trip per adjacent pair of a vehicle's closed stops: the previous stop
-- is the origin, the current stop is the destination. lag() over the vehicle's
-- stops ordered by arrival time. The first closed stop of each vehicle yields
-- null origin columns and is filtered out downstream.
create or replace view v_trips as
select
  s.trackit_account,
  s.vehicle_id,
  lag(s.location_id)  over w                                              as origin_location_id,
  s.location_id                                                           as destination_location_id,
  lag(s.departed_at)  over w                                              as departed_at,
  s.arrived_at                                                            as arrived_at,
  extract(epoch from (s.arrived_at - lag(s.departed_at) over w))::double precision as travel_seconds,
  s.leg_km                                                                as leg_km
from stops s
where s.status = 'closed'
window w as (partition by s.trackit_account, s.vehicle_id order by s.arrived_at);

-- Section 1 (Recent trips): v_trips with location names, stops only.
create or replace view v_recent_trips as
select
  t.trackit_account,
  t.vehicle_id,
  t.origin_location_id,
  t.destination_location_id,
  o.name as origin_name,
  d.name as destination_name,
  t.departed_at,
  t.arrived_at,
  t.travel_seconds,
  t.leg_km
from v_trips t
left join locations o on o.id = t.origin_location_id
left join locations d on d.id = t.destination_location_id
where t.departed_at is not null;

-- Section 2 building block: stops-derived trips + historical route_legs,
-- normalised to one shape, tagged by source.
create or replace view v_trip_legs_unified as
select
  'stops'::text        as source,
  t.trackit_account,
  t.vehicle_id::text   as vehicle_id,
  t.origin_location_id,
  t.destination_location_id,
  t.departed_at        as started_at,
  t.arrived_at         as ended_at,
  t.travel_seconds     as duration_seconds,
  t.leg_km             as distance_km
from v_trips t
where t.departed_at is not null
union all
select
  'route_legs'::text   as source,
  rl.trackit_account,
  rl.vehicle_id,
  rl.origin_id,
  rl.destination_id,
  rl.started_at,
  rl.ended_at,
  rl.duration_seconds::double precision,
  rl.distance_km::double precision
from route_legs rl;

-- Section 2 (Matrix): average/median time and average km per (origin,
-- destination) pair, split by source so the sparse new data and the bulky
-- historical data stay distinguishable.
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
  round(avg(u.distance_km)::numeric, 2)                                       as avg_distance_km
from v_trip_legs_unified u
left join locations o on o.id = u.origin_location_id
left join locations d on d.id = u.destination_location_id
where u.origin_location_id is not null
  and u.destination_location_id is not null
  -- same-location pairs (X -> X: a return visit, or depot GPS jitter) aren't a
  -- meaningful "par de locais" for a time/km matrix.
  and u.origin_location_id <> u.destination_location_id
group by u.source, u.origin_location_id, u.destination_location_id, o.name, d.name;

-- Supabase normally auto-grants these via default privileges; explicit for safety.
grant select on v_trips, v_recent_trips, v_trip_legs_unified, v_location_pair_matrix
  to anon, authenticated, service_role;
