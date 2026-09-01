-- Add the store/warehouse code (locations.code, e.g. "H58") for both ends of
-- each location pair, so /dashboard can show "CODE — Name" in the matrix too.
--
-- Same as 0013 did for v_recent_trips: the locations joins already exist in the
-- view (o, d) for the names — this only adds o.code / d.code to the select (and
-- to GROUP BY, since this view aggregates). Appended at the end so
-- create-or-replace stays valid.
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
left join locations o on o.id = u.origin_location_id
left join locations d on d.id = u.destination_location_id
where u.origin_location_id is not null
  and u.destination_location_id is not null
  -- same-location pairs (X -> X: a return visit, or depot GPS jitter) aren't a
  -- meaningful "par de locais" for a time/km matrix.
  and u.origin_location_id <> u.destination_location_id
group by u.source, u.origin_location_id, u.destination_location_id,
         o.name, d.name, o.code, d.code;
