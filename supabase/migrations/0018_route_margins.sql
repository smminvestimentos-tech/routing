-- /dashboard/rotas: estimated total time per route = (load at origin + travel
-- + unload at destination) * (1 + margin/100). The margin is editable inline;
-- only per-route overrides are stored, everything else uses the global default.

-- Global settings — one row, kept singleton by the boolean PK + check.
create table dashboard_settings (
  id boolean primary key default true,
  default_margin_percent numeric not null default 15,
  updated_at timestamptz not null default now(),
  constraint dashboard_settings_singleton check (id)
);
insert into dashboard_settings (id) values (true) on conflict (id) do nothing;

-- Per-route margin overrides. No row => the route uses the global default.
create table route_margins (
  id uuid primary key default gen_random_uuid(),
  origin_location_id uuid not null references locations(id),
  destination_location_id uuid not null references locations(id),
  margin_percent numeric not null default 15,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (origin_location_id, destination_location_id)
);

-- v_route_estimates: one row per (origin, destination) across BOTH trip
-- pipelines (v_trip_legs_unified = stops + route_legs), joined to the "carga"
-- dwell average of each end. Margin and the estimated total are applied in the
-- app so the inline edit updates the total live.
create or replace view v_route_estimates as
with legs as (
  select
    u.origin_location_id,
    u.destination_location_id,
    count(*)                as trip_count,
    avg(u.duration_seconds) as avg_travel_seconds
  from v_trip_legs_unified u
  where u.origin_location_id is not null
    and u.destination_location_id is not null
    and u.origin_location_id <> u.destination_location_id
  group by u.origin_location_id, u.destination_location_id
)
select
  legs.origin_location_id,
  legs.destination_location_id,
  o.code as origin_code,
  o.name as origin_name,
  d.code as destination_code,
  d.name as destination_name,
  legs.trip_count,
  round((legs.avg_travel_seconds / 60.0)::numeric, 2) as avg_travel_minutes,
  co.avg_duration_minutes as origin_load_minutes,
  cd.avg_duration_minutes as destination_load_minutes
from legs
join locations o on o.id = legs.origin_location_id
join locations d on d.id = legs.destination_location_id
left join v_location_dwell_stats co
  on co.location_id = legs.origin_location_id and co.stop_kind = 'carga'
left join v_location_dwell_stats cd
  on cd.location_id = legs.destination_location_id and cd.stop_kind = 'carga';

grant select on v_route_estimates to anon, authenticated, service_role;
