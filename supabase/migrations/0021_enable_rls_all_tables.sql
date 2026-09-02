-- Security advisor: RLS is disabled on tables in the public schema, which
-- exposes them through the public REST API (anon / authenticated keys).
--
-- The whole app talks to the database through createAdminClient() (the service
-- role key, which BYPASSES RLS), so enabling RLS with NO policies blocks the
-- anon / authenticated keys without affecting the app at all.
--
-- Table list verified against the live database (PostgREST relation catalog):
-- 11 tables. Most already had RLS on; at the time of writing only
-- `sync_metadata` was actually still readable by the anon key. `gps_pings` and
-- `location_events` are NOT part of this migration history — they exist
-- directly in the database — so they are guarded below. ENABLE ROW LEVEL
-- SECURITY is a no-op on a table that already has it, so this is safe to
-- re-run.
--
-- NOTE (out of scope here): the views v_trips, v_recent_trips,
-- v_trip_legs_unified, v_location_pair_matrix, v_location_dwell_stats,
-- v_route_estimates and latest_vehicle_plate still return rows to the anon key
-- because a view runs with its owner's privileges and bypasses the underlying
-- tables' RLS. Closing that needs `alter view <name> set (security_invoker = on)`
-- on each — a separate change.

alter table locations          enable row level security;
alter table route_legs         enable row level security;
alter table sync_runs          enable row level security;
alter table sync_metadata      enable row level security;
alter table trackit_pois       enable row level security;
alter table vehicle_pings      enable row level security;
alter table stops              enable row level security;
alter table dashboard_settings enable row level security;
alter table route_margins      enable row level security;

do $$
begin
  if to_regclass('public.gps_pings') is not null then
    execute 'alter table public.gps_pings enable row level security';
  end if;
  if to_regclass('public.location_events') is not null then
    execute 'alter table public.location_events enable row level security';
  end if;
end $$;
