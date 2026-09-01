-- Add the store/warehouse code (locations.code, e.g. "H58") for both ends of
-- each trip, so /dashboard's free-text search can match on it.
--
-- No new joins: v_recent_trips already left-joins locations twice (o, d) for
-- the names — this only appends two columns to the select list. Appended at
-- the end so create-or-replace stays valid.
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
  d.code as destination_code
from v_trips t
left join locations o on o.id = t.origin_location_id
left join locations d on d.id = t.destination_location_id
left join latest_vehicle_plate p
  on p.trackit_account = t.trackit_account and p.vehicle_id = t.vehicle_id
where t.departed_at is not null;
