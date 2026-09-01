-- Bug: detect_stops() could leave more than one status='open' stop per
-- vehicle. Its resume subquery
--   (select s.arrived_at from stops s where ... and s.status = 'open')
-- then returns >1 row and the whole function aborts with
--   "more than one row returned by a subquery used as an expression".
--
-- Root cause (deterministic, NOT a concurrency race — confirmed from the
-- affected rows: the two open stops per vehicle were created ~6h apart, in
-- different cron runs, with the odometer hundreds of km further on):
--   1. A run parks an open stop O (vehicle stopped, 1 ping, ran out of pings).
--   2. Next run resumes from O.arrived_at. The first re-scanned ping is O's own
--      slow ping, the next is already "moving" (vehicle left) -> the walk builds
--      a zero-duration phantom at O.arrived_at, close_and_persist_stop()
--      discards it via the <1min filter WITHOUT closing O, and the run ends in
--      state 'none', so upsert_open_stop() is never called -> O is orphaned.
--   3. When the vehicle stops again in a later run, upsert_open_stop() inserts
--      a second open row with a different arrived_at. Every run after that
--      hits the >1-row subquery and fails.

-- 1. Clean up existing duplicates: keep the most recent open stop per vehicle,
--    delete the older phantom(s). They are 1-ping, 0-duration, departed_at
--    null — they represent nothing, and closing them would inject bogus
--    0-minute trips into v_trips / the dashboard.
delete from stops s
using (
  select id,
         row_number() over (
           partition by trackit_account, vehicle_id
           order by arrived_at desc
         ) as rn
  from stops
  where status = 'open'
) d
where s.id = d.id and d.rn > 1;

-- 2. Hard backstop: at most one open stop per vehicle.
create unique index if not exists stops_one_open_per_vehicle
  on stops (trackit_account, vehicle_id)
  where status = 'open';

-- 3. upsert_open_stop(): drop any other open stop for the vehicle before
--    writing this run's open stop, so the index above can never be violated
--    even if a stale open row is still around.
create or replace function upsert_open_stop(
  p_trackit_account text,
  p_vehicle_id integer,
  p_location_id uuid,
  p_centroid_lat double precision,
  p_centroid_lng double precision,
  p_arrived_at timestamptz,
  p_duration_minutes numeric,
  p_odometer_arrival double precision,
  p_ping_count integer
) returns void language plpgsql as $$
begin
  delete from stops s
  where s.trackit_account = p_trackit_account
    and s.vehicle_id = p_vehicle_id
    and s.status = 'open'
    and s.arrived_at <> p_arrived_at;

  insert into stops (
    trackit_account, vehicle_id, location_id, centroid_lat, centroid_lng,
    arrived_at, departed_at, duration_minutes,
    odometer_km_arrival, odometer_km_departure, leg_km, ping_count, status
  ) values (
    p_trackit_account, p_vehicle_id, p_location_id, p_centroid_lat, p_centroid_lng,
    p_arrived_at, null, p_duration_minutes,
    p_odometer_arrival, null, null, p_ping_count, 'open'
  )
  on conflict (trackit_account, vehicle_id, arrived_at) do update set
    location_id = excluded.location_id,
    centroid_lat = excluded.centroid_lat,
    centroid_lng = excluded.centroid_lng,
    duration_minutes = excluded.duration_minutes,
    ping_count = excluded.ping_count,
    updated_at = now();
end;
$$;

-- 4. detect_stops():
--    (a) the resume subquery takes the most recent open stop only, so it can
--        never error even if a duplicate somehow reappears;
--    (b) if a vehicle's walk processed pings but ended not-stopped (state
--        'none'), delete any open row left for it — the orphaned-phantom case.
--        Guarded by "processed >= 1 ping" so a vehicle with no new data keeps
--        its open stop untouched.
create or replace function detect_stops(
  p_trackit_account text default 'default',
  p_now timestamptz default now()
) returns table (
  vehicle_id integer,
  stops_upserted integer,
  still_open boolean
) language plpgsql as $$
declare
  v_vehicle record;
  v_ping record;
  v_start_ts timestamptz;

  v_state text;
  v_arrived_at timestamptz;
  v_sum_lat double precision;
  v_sum_lng double precision;
  v_n integer;
  v_centroid_lat double precision;
  v_centroid_lng double precision;
  v_last_stopped_at timestamptz;
  v_last_stopped_odometer double precision;
  v_odometer_arrival double precision;
  v_buffer stop_ping[];
  v_move_since timestamptz;
  v_pings_seen integer;

  v_prev_stop_id uuid;
  v_prev_departed_at timestamptz;
  v_prev_odometer_departure double precision;
  v_prev_location_id uuid;
  v_merge_eligible boolean;
  v_stops_count integer;
  v_close_result stop_close_result;
begin
  for v_vehicle in
    select distinct vp.vehicle_id
    from vehicle_pings vp
    where vp.trackit_account = p_trackit_account
  loop
    select coalesce(
      (select s.arrived_at from stops s
        where s.trackit_account = p_trackit_account and s.vehicle_id = v_vehicle.vehicle_id and s.status = 'open'
        order by s.arrived_at desc limit 1),
      (select s.departed_at from stops s
        where s.trackit_account = p_trackit_account and s.vehicle_id = v_vehicle.vehicle_id and s.status = 'closed'
        order by s.departed_at desc limit 1),
      (select min(vp2.recorded_at) from vehicle_pings vp2
        where vp2.trackit_account = p_trackit_account and vp2.vehicle_id = v_vehicle.vehicle_id)
    ) into v_start_ts;

    if v_start_ts is null then
      continue;
    end if;

    select s.id, s.departed_at, s.odometer_km_departure, s.location_id
      into v_prev_stop_id, v_prev_departed_at, v_prev_odometer_departure, v_prev_location_id
    from stops s
    where s.trackit_account = p_trackit_account and s.vehicle_id = v_vehicle.vehicle_id and s.status = 'closed'
    order by s.departed_at desc limit 1;

    v_state := 'none';
    v_buffer := array[]::stop_ping[];
    v_move_since := null;
    v_merge_eligible := true;
    v_stops_count := 0;
    v_pings_seen := 0;

    for v_ping in
      select vp.* from vehicle_pings vp
      where vp.trackit_account = p_trackit_account
        and vp.vehicle_id = v_vehicle.vehicle_id
        and vp.recorded_at >= v_start_ts
        and vp.recorded_at <= p_now
        and vp.latitude is not null and vp.longitude is not null
      order by vp.recorded_at asc
    loop
      v_pings_seen := v_pings_seen + 1;

      if v_state = 'none' then
        if coalesce(v_ping.speed_kmh, 0) <= 3 then
          v_arrived_at := v_ping.recorded_at;
          v_sum_lat := v_ping.latitude; v_sum_lng := v_ping.longitude; v_n := 1;
          v_centroid_lat := v_ping.latitude; v_centroid_lng := v_ping.longitude;
          v_last_stopped_at := v_ping.recorded_at;
          v_last_stopped_odometer := v_ping.odometer_km;
          v_odometer_arrival := v_ping.odometer_km;
          v_buffer := array[row(v_ping.latitude, v_ping.longitude)::stop_ping];
          v_state := 'in_stop';
        end if;

      elsif v_state = 'in_stop' then
        if coalesce(v_ping.speed_kmh, 0) <= 3 then
          if haversine_meters(v_ping.latitude, v_ping.longitude, v_centroid_lat, v_centroid_lng) <= 50 then
            v_sum_lat := v_sum_lat + v_ping.latitude;
            v_sum_lng := v_sum_lng + v_ping.longitude;
            v_n := v_n + 1;
            v_centroid_lat := v_sum_lat / v_n;
            v_centroid_lng := v_sum_lng / v_n;
            v_last_stopped_at := v_ping.recorded_at;
            v_last_stopped_odometer := v_ping.odometer_km;
            v_buffer := array_append(v_buffer, row(v_ping.latitude, v_ping.longitude)::stop_ping);
            v_move_since := null;
          else
            -- relocated beyond 50m: close the current stop as of the last
            -- confirmed-stopped ping, then start a fresh one right here.
            v_close_result := close_and_persist_stop(
              p_trackit_account, v_vehicle.vehicle_id,
              v_arrived_at, v_last_stopped_at, v_centroid_lat, v_centroid_lng,
              v_sum_lat, v_sum_lng, v_n, v_buffer,
              v_odometer_arrival, v_last_stopped_odometer,
              v_prev_stop_id, v_prev_departed_at, v_prev_odometer_departure, v_prev_location_id,
              v_merge_eligible
            );
            if v_close_result.closed then
              v_prev_stop_id := v_close_result.stop_id;
              v_prev_departed_at := v_close_result.departed_at;
              v_prev_odometer_departure := v_close_result.odometer_km_departure;
              v_prev_location_id := v_close_result.location_id;
              v_merge_eligible := false;
              v_stops_count := v_stops_count + 1;
            end if;

            v_arrived_at := v_ping.recorded_at;
            v_sum_lat := v_ping.latitude; v_sum_lng := v_ping.longitude; v_n := 1;
            v_centroid_lat := v_ping.latitude; v_centroid_lng := v_ping.longitude;
            v_last_stopped_at := v_ping.recorded_at;
            v_last_stopped_odometer := v_ping.odometer_km;
            v_odometer_arrival := v_ping.odometer_km;
            v_buffer := array[row(v_ping.latitude, v_ping.longitude)::stop_ping];
          end if;
        else
          -- moving ping
          if v_move_since is null then
            v_move_since := v_ping.recorded_at;
          elsif v_ping.recorded_at - v_move_since >= interval '2 minutes' then
            v_close_result := close_and_persist_stop(
              p_trackit_account, v_vehicle.vehicle_id,
              v_arrived_at, v_last_stopped_at, v_centroid_lat, v_centroid_lng,
              v_sum_lat, v_sum_lng, v_n, v_buffer,
              v_odometer_arrival, v_last_stopped_odometer,
              v_prev_stop_id, v_prev_departed_at, v_prev_odometer_departure, v_prev_location_id,
              v_merge_eligible
            );
            if v_close_result.closed then
              v_prev_stop_id := v_close_result.stop_id;
              v_prev_departed_at := v_close_result.departed_at;
              v_prev_odometer_departure := v_close_result.odometer_km_departure;
              v_prev_location_id := v_close_result.location_id;
              v_merge_eligible := false;
              v_stops_count := v_stops_count + 1;
            end if;

            v_state := 'none';
            v_move_since := null;
            v_buffer := array[]::stop_ping[];
          end if;
        end if;
      end if;
    end loop; -- pings

    if v_state = 'in_stop' then
      -- ran out of pings mid-stop: upsert as open, resumed/extended next run
      perform upsert_open_stop(
        p_trackit_account, v_vehicle.vehicle_id,
        match_stop_location(v_buffer, v_centroid_lat, v_centroid_lng),
        v_centroid_lat, v_centroid_lng,
        v_arrived_at, extract(epoch from (v_last_stopped_at - v_arrived_at)) / 60,
        v_odometer_arrival, v_n
      );
    elsif v_pings_seen > 0 then
      -- processed pings and ended not-stopped: any open row for this vehicle
      -- is a leftover phantom from a resume that never re-parked it.
      -- Alias the table: bare "vehicle_id" here would bind to this function's
      -- OUT parameter, not stops.vehicle_id (the trap 0009 called out).
      delete from stops s
      where s.trackit_account = p_trackit_account
        and s.vehicle_id = v_vehicle.vehicle_id
        and s.status = 'open';
    end if;

    vehicle_id := v_vehicle.vehicle_id;
    stops_upserted := v_stops_count;
    still_open := (v_state = 'in_stop');
    return next;
  end loop; -- vehicles
end;
$$;
