-- Average / median / min / max load-unload time (dwell) per location — the
-- dwell-time analogue of v_location_pair_matrix, which does the same for trips
-- between location pairs. Aggregates ALL closed stops; no date filter, like
-- the trip matrix. Stops with no matched location are excluded (inner join).

create or replace view v_location_dwell_stats as
select
  s.location_id,
  l.code                            as location_code,
  l.name                            as location_name,
  l.type                            as location_type,
  count(*)                          as stop_count,
  round(avg(s.duration_minutes), 2) as avg_duration_minutes,
  round(
    (percentile_cont(0.5) within group (order by s.duration_minutes))::numeric,
    2
  )                                 as median_duration_minutes,
  round(min(s.duration_minutes), 2) as min_duration_minutes,
  round(max(s.duration_minutes), 2) as max_duration_minutes
from stops s
join locations l on l.id = s.location_id
where s.status = 'closed'
group by s.location_id, l.code, l.name, l.type;

grant select on v_location_dwell_stats to anon, authenticated, service_role;
