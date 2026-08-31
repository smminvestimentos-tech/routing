-- Raw position snapshots from TRACKiT's GET /api/vehiclesForUser, polled
-- every 5 minutes for the whole fleet in a single call (see
-- /api/sync/positions). This replaces per-vehicle vehicleTravels calls
-- (~15s each on TRACKiT's own end) as the source for stop detection.
create table vehicle_pings (
  id uuid primary key default gen_random_uuid(),
  trackit_account text not null default 'default',
  vehicle_id integer not null,          -- TRACKiT's numeric mid; no vehicle master table here
  plate text,
  latitude double precision,
  longitude double precision,
  speed_kmh integer,
  odometer_km double precision,
  recorded_at timestamptz not null,
  -- TRACKiT's own POI match against its own POI dataset (trackit_pois),
  -- returned for free alongside the position — kept for cross-validation
  -- against our own locations-based stop matching, not used to drive it.
  trackit_poi_id integer,
  trackit_poi_distance_m double precision,
  ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (trackit_account, vehicle_id, recorded_at)
);

-- Ordered per-vehicle scans are the core access pattern (stop detection).
create index vehicle_pings_account_vehicle_recorded_idx
  on vehicle_pings (trackit_account, vehicle_id, recorded_at);

create index vehicle_pings_recorded_at_idx on vehicle_pings (recorded_at);

-- Fast "latest odometer per vehicle" lookup, used by the ingestion sanity
-- clamp (a new reading more than 5% below the last known value is rejected
-- as a likely corrupted/cached TRACKiT read).
create or replace function latest_vehicle_odometers(p_trackit_account text)
returns table (vehicle_id integer, odometer_km double precision)
language sql stable as $$
  select distinct on (vp.vehicle_id) vp.vehicle_id, vp.odometer_km
  from vehicle_pings vp
  where vp.trackit_account = p_trackit_account
    and vp.odometer_km is not null
  order by vp.vehicle_id, vp.recorded_at desc;
$$;
