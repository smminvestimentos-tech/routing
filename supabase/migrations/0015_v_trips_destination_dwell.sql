-- "Tempo parado" for /dashboard: how long the vehicle stayed at the trip's
-- DESTINATION stop before leaving for the next one. That's the current window
-- row's own stops.duration_minutes (NOT lag() — lag is the origin stop).
--
-- Both views are rebuilt with create-or-replace and the new column appended at
-- the end, so existing columns keep their name/type/position and dependents
-- (v_trip_legs_unified, v_location_pair_matrix) stay valid untouched.

create or replace view v_trips as
select
  s.trackit_account,
  s.vehicle_id,
  lag(s.location_id)  over w                                              as origin_location_id,
  s.location_id                                                           as destination_location_id,
  lag(s.departed_at)  over w                                              as departed_at,
  s.arrived_at                                                            as arrived_at,
  extract(epoch from (s.arrived_at - lag(s.departed_at) over w))::double precision as travel_seconds,
  s.leg_km                                                                as leg_km,
  s.duration_minutes                                                      as destination_duration_minutes
from stops s
where s.status = 'closed'
window w as (partition by s.trackit_account, s.vehicle_id order by s.arrived_at);

-- Propagate the column to v_recent_trips (0013's definition + one appended col).
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
  t.leg_km,
  p.plate as vehicle_plate,
  o.code as origin_code,
  d.code as destination_code,
  t.destination_duration_minutes
from v_trips t
left join locations o on o.id = t.origin_location_id
left join locations d on d.id = t.destination_location_id
left join latest_vehicle_plate p
  on p.trackit_account = t.trackit_account and p.vehicle_id = t.vehicle_id
where t.departed_at is not null;

grant select on v_trips, v_recent_trips to anon, authenticated, service_role;
