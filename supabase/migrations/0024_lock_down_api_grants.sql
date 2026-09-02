-- Root cause of the view leak (found via pg_default_acl): Supabase's default
-- project setup runs
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated;
-- so every new OR recreated relation (tables AND views) automatically gets full
-- anon/authenticated access. That's why the REVOKEs in 0022 / 0023 did not
-- hold: 0019 recreates v_location_dwell_stats (DROP + CREATE) and the apply
-- pipeline re-runs the blanket grant, so the default ACL kept re-granting.
--
-- Moving the views to a `private` schema (the other common suggestion) does not
-- work with this app: it only talks to the DB through supabase-js / PostgREST,
-- which refuses any schema that isn't in "Exposed schemas" — the service role
-- included. So the fix is to remove the anon/authenticated privilege at the
-- source and keep the views in public.
--
-- After this: anon/authenticated hold no privilege on these views (or on any
-- future public table), so PostgREST returns "permission denied". The app is
-- unaffected — it uses the service role, whose access comes from a separate
-- default-privileges entry (postgres -> service_role) that is left intact.
--
-- !!! MUST BE RUN AS `postgres` (Supabase SQL Editor), NOT via the normal
-- migration pipeline. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` and REVOKE
-- on postgres-owned views require the postgres role; the migration runner uses
-- a lesser role and silently no-ops these statements (verified: 0022/0023 and
-- a pipeline run of this file had no effect; running this file by hand in the
-- SQL Editor locked everything down). On a `supabase db reset` / rebuild from
-- migrations, re-run this file manually in the SQL Editor.

-- 1. stop the automatic re-grant for future / recreated objects
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

-- 2. strip the grant the 7 views already carry (nothing re-grants them now)
revoke all on
  v_trips,
  v_recent_trips,
  v_trip_legs_unified,
  v_location_pair_matrix,
  v_location_dwell_stats,
  v_route_estimates,
  latest_vehicle_plate
from anon, authenticated, public;

-- 3. same for the base tables — already covered by RLS (0021), but there is no
--    reason for anon/authenticated to hold any privilege on them either.
revoke all on
  locations,
  route_legs,
  sync_runs,
  sync_metadata,
  trackit_pois,
  vehicle_pings,
  stops,
  dashboard_settings,
  route_margins
from anon, authenticated, public;

do $$
begin
  if to_regclass('public.gps_pings') is not null then
    execute 'revoke all on public.gps_pings from anon, authenticated, public';
  end if;
  if to_regclass('public.location_events') is not null then
    execute 'revoke all on public.location_events from anon, authenticated, public';
  end if;
end $$;
