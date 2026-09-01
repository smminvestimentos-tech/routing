-- Most recent plate seen per vehicle in vehicle_pings. Mirrors
-- latest_vehicle_odometers (0007); a view here rather than a function since it
-- takes no arguments and is only ever joined.
create or replace view latest_vehicle_plate as
select distinct on (vp.trackit_account, vp.vehicle_id)
  vp.trackit_account,
  vp.vehicle_id,
  vp.plate
from vehicle_pings vp
where vp.plate is not null
order by vp.trackit_account, vp.vehicle_id, vp.recorded_at desc;

grant select on latest_vehicle_plate to anon, authenticated, service_role;

-- Carry the plate into v_recent_trips (0010). Appending a column keeps
-- create-or-replace valid, so the existing column list is unchanged.
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
  p.plate as vehicle_plate
from v_trips t
left join locations o on o.id = t.origin_location_id
left join locations d on d.id = t.destination_location_id
left join latest_vehicle_plate p
  on p.trackit_account = t.trackit_account and p.vehicle_id = t.vehicle_id
where t.departed_at is not null;
