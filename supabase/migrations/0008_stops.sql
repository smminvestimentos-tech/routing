-- Materialized output of detect_stops() (see 0009) — a real stop (arrival,
-- optional departure, duration, km since the previous stop), matched to a
-- known location where possible. This is the new pipeline's equivalent of
-- route_legs, but stop-centric rather than trip-centric; route_legs itself
-- is left untouched as a historical archive of the old vehicleTravels-based
-- sync and is not migrated into this table.
create table stops (
  id uuid primary key default gen_random_uuid(),
  trackit_account text not null default 'default',
  vehicle_id integer not null,
  location_id uuid references locations(id),
  centroid_lat double precision not null,
  centroid_lng double precision not null,
  arrived_at timestamptz not null,
  departed_at timestamptz,
  duration_minutes numeric,
  odometer_km_arrival double precision,
  odometer_km_departure double precision,
  leg_km double precision,
  ping_count integer not null default 0,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- arrived_at never changes once a stop starts, so this is what lets an
  -- open stop be safely re-upserted (not duplicated) across cron ticks
  -- until it's confirmed closed.
  unique (trackit_account, vehicle_id, arrived_at)
);

create index stops_account_vehicle_arrived_idx on stops (trackit_account, vehicle_id, arrived_at);
create index stops_location_id_idx on stops (location_id);
create index stops_status_idx on stops (trackit_account, status);
