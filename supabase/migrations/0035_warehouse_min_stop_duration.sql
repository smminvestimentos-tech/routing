-- Fleet-wide evidence (2026-09-11, AD-49-DH / 03-QA-31, day 2026-09-10):
-- stops persisted at 'armazem'/'centro_distribuicao' locations are
-- systematically fewer than confirmed store deliveries for the same vehicle,
-- same day. Raw vehicle_pings show why: real, brief reload/pass-through
-- touches at a warehouse (truck slows near/at the dock, then leaves before
-- the next ~5min poll) are frequently captured by a SINGLE low-speed ping —
-- measured duration 0 — which the 0009 "< interval '1 minute'" filter
-- discards outright, before a location is even matched. This is NOT the
-- merge-into-previous-stop logic (that only runs for the first close after a
-- detect_stops() resume, and only for a matching location_id) — the discard
-- in close_and_persist_stop happens unconditionally, first, before location
-- matching or merging are even reached.
--
-- Example (AD-49-DH, 2026-09-09/10, speed <= 3km/h entry criterion honoured):
--   20:44:38  1 ping  speed=3km/h    9m from '01' (Armazém Azambuja)
--   20:50:08  1 ping  speed=0km/h   42m from '7005' (Auchan Congelados)
--   21:39:08  1 ping  speed=0km/h   52m from '01'
--   23:40:10  1 ping  speed=0km/h   64m from '7001' (-> merged into '01')
--
-- SAFETY CHECK raised during review: dropping the duration floor to zero for
-- armazem/centro_distribuicao on its own would let a vehicle merely CRAWLING
-- through a large-radius zone (several active warehouses run 350m radii —
-- 700m across) register a false "stop" off one lucky <=3km/h sample, since
-- <=3km/h at entry doesn't by itself distinguish "queued/creeping through"
-- from "actually stopped to load". The old 1-minute floor used to catch this
-- incidentally (a genuine crawl-through rarely sustains <=3km/h for a full
-- minute) — removing it for warehouses removes that protection exactly where
-- the radius is largest. Fix: a SECOND, independent, stricter gate — the
-- minimum speed observed across the stop's own buffered pings must be
-- <= 1km/h (near-true-standstill, not just "slow") for the zero floor to
-- apply; otherwise the ordinary 1-minute floor still applies even at an
-- armazem/CD. detect_stops now tracks that per-stop minimum and passes it to
-- close_and_persist_stop as p_min_speed_kmh.
--
-- PREVIEW — run first:
--
--   select code, name, type, radius_meters from locations
--   where type in ('armazem', 'centro_distribuicao') order by radius_meters desc;

begin;

-- close_and_persist_stop gains a new trailing parameter (p_min_speed_kmh) --
-- a different signature to Postgres, so `create or replace` alone would
-- ADD an overload rather than replace the 0009 one. Drop the old signature
-- explicitly first.
drop function if exists close_and_persist_stop(
  text, integer, timestamptz, timestamptz, double precision, double precision,
  double precision, double precision, integer, stop_ping[],
  double precision, double precision, uuid, timestamptz, double precision, uuid, boolean
);

create or replace function close_and_persist_stop(
  p_trackit_account text,
  p_vehicle_id integer,
  p_arrived_at timestamptz,
  p_departed_at timestamptz,
  p_centroid_lat double precision,
  p_centroid_lng double precision,
  p_sum_lat double precision,
  p_sum_lng double precision,
  p_n integer,
  p_buffer stop_ping[],
  p_odometer_arrival double precision,
  p_odometer_departure double precision,
  p_prev_stop_id uuid,
  p_prev_departed_at timestamptz,
  p_prev_odometer_departure double precision,
  p_prev_location_id uuid,
  p_allow_merge boolean,
  -- min speed_kmh observed across this stop's own buffered pings (0 if every
  -- ping was NULL/0). Gates the armazem/CD zero-duration floor below — see
  -- the SAFETY CHECK note above.
  p_min_speed_kmh double precision
) returns stop_close_result language plpgsql as $$
declare
  r stop_close_result;
  v_location_id uuid;
  v_location_type text;
  v_min_duration interval;
  v_leg_km double precision;
  v_existing_ping_count integer;
  v_existing_centroid_lat double precision;
  v_existing_centroid_lng double precision;
begin
  -- Location first: the minimum-duration floor below depends on its type.
  v_location_id := match_stop_location(p_buffer, p_centroid_lat, p_centroid_lng);

  if v_location_id is not null then
    select l.type into v_location_type from locations l where l.id = v_location_id;
  end if;

  v_min_duration := case
    when v_location_type in ('armazem', 'centro_distribuicao')
      and coalesce(p_min_speed_kmh, 0) <= 1
      then interval '0 seconds'
    else interval '1 minute'
  end;

  if p_departed_at - p_arrived_at < v_min_duration then
    r.closed := false;
    r.stop_id := p_prev_stop_id;
    r.departed_at := p_prev_departed_at;
    r.odometer_km_departure := p_prev_odometer_departure;
    r.location_id := p_prev_location_id;
    return r;
  end if;

  if p_allow_merge and p_prev_stop_id is not null and v_location_id is not null
     and v_location_id = p_prev_location_id
     and p_arrived_at - p_prev_departed_at <= interval '30 minutes' then

    select ping_count, centroid_lat, centroid_lng
      into v_existing_ping_count, v_existing_centroid_lat, v_existing_centroid_lng
    from stops where id = p_prev_stop_id;

    update stops set
      departed_at = p_departed_at,
      duration_minutes = extract(epoch from (p_departed_at - arrived_at)) / 60,
      odometer_km_departure = p_odometer_departure,
      -- weighted-mean approximation of the merged centroid (the earlier
      -- run's raw buffer no longer exists to recompute exactly)
      centroid_lat = ((v_existing_centroid_lat * v_existing_ping_count) + p_sum_lat) / (v_existing_ping_count + p_n),
      centroid_lng = ((v_existing_centroid_lng * v_existing_ping_count) + p_sum_lng) / (v_existing_ping_count + p_n),
      ping_count = v_existing_ping_count + p_n,
      status = 'closed',
      updated_at = now()
    where id = p_prev_stop_id;

    r.stop_id := p_prev_stop_id;
    r.departed_at := p_departed_at;
    r.odometer_km_departure := p_odometer_departure;
    r.location_id := v_location_id;
    r.closed := true;
    return r;
  end if;

  v_leg_km := case
    when p_prev_odometer_departure is null or p_odometer_arrival is null then null
    when p_odometer_arrival - p_prev_odometer_departure < 0 then null
    else p_odometer_arrival - p_prev_odometer_departure
  end;

  insert into stops (
    trackit_account, vehicle_id, location_id, centroid_lat, centroid_lng,
    arrived_at, departed_at, duration_minutes,
    odometer_km_arrival, odometer_km_departure, leg_km, ping_count, status
  ) values (
    p_trackit_account, p_vehicle_id, v_location_id, p_centroid_lat, p_centroid_lng,
    p_arrived_at, p_departed_at, extract(epoch from (p_departed_at - p_arrived_at)) / 60,
    p_odometer_arrival, p_odometer_departure, v_leg_km, p_n, 'closed'
  )
  on conflict (trackit_account, vehicle_id, arrived_at) do update set
    location_id = excluded.location_id,
    centroid_lat = excluded.centroid_lat,
    centroid_lng = excluded.centroid_lng,
    departed_at = excluded.departed_at,
    duration_minutes = excluded.duration_minutes,
    odometer_km_departure = excluded.odometer_km_departure,
    leg_km = excluded.leg_km,
    ping_count = excluded.ping_count,
    status = 'closed',
    updated_at = now()
  returning id into r.stop_id;

  r.departed_at := p_departed_at;
  r.odometer_km_departure := p_odometer_departure;
  r.location_id := v_location_id;
  r.closed := true;
  return r;
end;
$$;

-- detect_stops: unchanged control flow, only tracks v_min_speed_kmh (the
-- minimum coalesce(speed_kmh, 0) seen across the CURRENT stop's own buffered
-- pings, reset every time a new stop starts) and threads it through to both
-- close_and_persist_stop call sites.
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
  v_min_speed_kmh double precision;

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
        where s.trackit_account = p_trackit_account and s.vehicle_id = v_vehicle.vehicle_id and s.status = 'open'),
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

    for v_ping in
      select vp.* from vehicle_pings vp
      where vp.trackit_account = p_trackit_account
        and vp.vehicle_id = v_vehicle.vehicle_id
        and vp.recorded_at >= v_start_ts
        and vp.recorded_at <= p_now
        and vp.latitude is not null and vp.longitude is not null
      order by vp.recorded_at asc
    loop
      if v_state = 'none' then
        if coalesce(v_ping.speed_kmh, 0) <= 3 then
          v_arrived_at := v_ping.recorded_at;
          v_sum_lat := v_ping.latitude; v_sum_lng := v_ping.longitude; v_n := 1;
          v_centroid_lat := v_ping.latitude; v_centroid_lng := v_ping.longitude;
          v_last_stopped_at := v_ping.recorded_at;
          v_last_stopped_odometer := v_ping.odometer_km;
          v_odometer_arrival := v_ping.odometer_km;
          v_buffer := array[row(v_ping.latitude, v_ping.longitude)::stop_ping];
          v_min_speed_kmh := coalesce(v_ping.speed_kmh, 0);
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
            v_min_speed_kmh := least(v_min_speed_kmh, coalesce(v_ping.speed_kmh, 0));
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
              v_merge_eligible, v_min_speed_kmh
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
            v_min_speed_kmh := coalesce(v_ping.speed_kmh, 0);
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
              v_merge_eligible, v_min_speed_kmh
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
    end if;

    vehicle_id := v_vehicle.vehicle_id;
    stops_upserted := v_stops_count;
    still_open := (v_state = 'in_stop');
    return next;
  end loop; -- vehicles
end;
$$;

commit;
