-- Classify each closed stop as 'carga' (load/unload) or 'estacionamento'
-- (parking — the vehicle was just sitting there).
--
-- A stop is 'estacionamento' when:
--   * it lasted more than 6h — no real load/unload runs that long; OR
--   * it lasted more than 4h AND it touches the night: started in the evening
--     (>= 18h Lisbon), ended early morning (< 8h Lisbon), or ran across
--     midnight into another Lisbon calendar day.
-- Otherwise it's 'carga'.
--
-- Thresholds tuned against the real data: genuine load/unload stops cluster at
-- <= 2h and then there's a gap up to 6h+; the 4h + overnight arm catches the
-- shorter overnight parking that the plain 6h cut would miss.

create or replace function stop_kind_of(
  p_arrived timestamptz,
  p_departed timestamptz
) returns text
language sql stable as $$
  select case
    when p_departed is null then 'carga'
    when p_departed - p_arrived > interval '6 hours' then 'estacionamento'
    when p_departed - p_arrived > interval '4 hours'
     and (
       extract(hour from (p_arrived  at time zone 'Europe/Lisbon')) >= 18
       or extract(hour from (p_departed at time zone 'Europe/Lisbon')) < 8
       or (p_departed at time zone 'Europe/Lisbon')::date
          <> (p_arrived at time zone 'Europe/Lisbon')::date
     )
    then 'estacionamento'
    else 'carga'
  end
$$;

-- PostgREST computed column: lets /dashboard/paragens ask for `stop_kind`
-- straight in its stops select.
create or replace function stop_kind(s stops) returns text
language sql stable as $$
  select stop_kind_of(s.arrived_at, s.departed_at)
$$;

-- v_location_dwell_stats now splits the aggregation by classification: a
-- location that gets both unloaded at and parked at shows up as two rows
-- ("… Carga" / "… Estacionamento") instead of one blended average.
drop view if exists v_location_dwell_stats;
create view v_location_dwell_stats as
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
group by s.location_id, l.code, l.name, l.type,
         stop_kind_of(s.arrived_at, s.departed_at);

grant execute on function stop_kind_of(timestamptz, timestamptz)
  to anon, authenticated, service_role;
grant execute on function stop_kind(stops) to anon, authenticated, service_role;
grant select on v_location_dwell_stats to anon, authenticated, service_role;
