-- Ported from a sibling project's proven stop-detection algorithm (a
-- running-centroid walk over ordered pings, not a simple time/distance
-- gap grouping), expressed here as PL/pgSQL so it can be materialized by
-- a periodic job instead of computed on demand.

-- Haversine distance in meters. Mirrors src/lib/geo.ts's haversineMeters
-- exactly, so app-code and DB-side proximity checks agree.
create or replace function haversine_meters(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

-- One buffered ping belonging to the stop currently being accumulated —
-- only lat/lng are needed, kept for the dominant-location vote at close time.
create type stop_ping as (lat double precision, lng double precision);

-- Matches a stop's buffered pings against `locations` by proximity
-- (haversine <= the location's own radius_meters). The location containing
-- the most buffered pings wins ("dominant POI" by vote, not nearest-to-
-- centroid); ties broken by distance from the stop's centroid, then by
-- location id for full determinism. Returns null if no location matches.
create or replace function match_stop_location(
  p_buffer stop_ping[],
  p_centroid_lat double precision,
  p_centroid_lng double precision
) returns uuid language sql stable as $$
  select l.id
  from unnest(p_buffer) as b(lat, lng)
  join locations l
    on haversine_meters(b.lat, b.lng, l.latitude, l.longitude) <= l.radius_meters
  group by l.id, l.latitude, l.longitude
  order by count(*) desc,
           haversine_meters(p_centroid_lat, p_centroid_lng, l.latitude, l.longitude) asc,
           l.id asc
  limit 1;
$$;

-- Upserts the currently-accumulating (not yet closed) stop as 'open'. A
-- separate function (rather than inlined in detect_stops) so its INSERT's
-- `on conflict (..., vehicle_id, ...)` column list can't be misread as the
-- OUT parameter `vehicle_id` from detect_stops's `returns table (...)` —
-- that ambiguity is exactly what broke the first version of this migration.
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

create type stop_close_result as (
  stop_id uuid,
  departed_at timestamptz,
  odometer_km_departure double precision,
  location_id uuid,
  closed boolean  -- false if discarded by the 1-minute minimum-duration filter
);

-- Closes one accumulated stop and persists it: applies the minimum-duration
-- filter, matches a location, either merges into the previous run's last
-- persisted stop (same location, <=30min gap, only when p_allow_merge) or
-- inserts a new row, and computes leg_km (null, not clamped, if the
-- odometer decreased since the previous stop's departure).
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
  p_allow_merge boolean
) returns stop_close_result language plpgsql as $$
declare
  r stop_close_result;
  v_location_id uuid;
  v_leg_km double precision;
  v_existing_ping_count integer;
  v_existing_centroid_lat double precision;
  v_existing_centroid_lng double precision;
begin
  if p_departed_at - p_arrived_at < interval '1 minute' then
    r.closed := false;
    r.stop_id := p_prev_stop_id;
    r.departed_at := p_prev_departed_at;
    r.odometer_km_departure := p_prev_odometer_departure;
    r.location_id := p_prev_location_id;
    return r;
  end if;

  v_location_id := match_stop_location(p_buffer, p_centroid_lat, p_centroid_lng);

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

-- Main entry point: for each vehicle with pings, resumes from its
-- currently-open stop (or the end of its last closed stop, or its first
-- ever ping) and walks pings chronologically, accumulating/closing stops.
--
-- Resume-without-duplicating: arrived_at never changes once a stop starts,
-- so re-processing an open stop's pings on every run just re-upserts the
-- same row (unique on trackit_account, vehicle_id, arrived_at) until it
-- truly closes.
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
    end if;

    vehicle_id := v_vehicle.vehicle_id;
    stops_upserted := v_stops_count;
    still_open := (v_state = 'in_stop');
    return next;
  end loop; -- vehicles
end;
$$;
