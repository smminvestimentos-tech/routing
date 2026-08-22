-- locations: POIs sincronizados a partir da TRACKiT (GET /api/poi/0)
-- trackit_account distingue POIs de contas/credenciais TRACKiT diferentes
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  trackit_account text not null default 'default',
  id_poi_trackit integer not null,
  name text,
  type text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trackit_account, id_poi_trackit)
);

-- route_legs: viagens processadas sincronizadas a partir da TRACKiT (POST /api/vehicleTravels)
create table if not exists route_legs (
  id uuid primary key default gen_random_uuid(),
  trackit_account text not null default 'default',
  trackit_mid text not null,
  vehicle_id text not null,
  travel_date date,
  origin_id uuid references locations(id),
  destination_id uuid references locations(id),
  origin_poi_trackit integer,
  destination_poi_trackit integer,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  distance_km numeric,
  avg_speed numeric,
  created_at timestamptz not null default now(),
  unique (trackit_account, trackit_mid)
);

create index if not exists route_legs_vehicle_id_idx on route_legs (vehicle_id);
create index if not exists route_legs_travel_date_idx on route_legs (travel_date);
create index if not exists route_legs_origin_id_idx on route_legs (origin_id);
create index if not exists route_legs_destination_id_idx on route_legs (destination_id);
