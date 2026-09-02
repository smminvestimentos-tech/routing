-- Follow-up to 0021. The public views still returned real rows to the anon
-- key: a view runs with its OWNER's privileges by default and so bypasses the
-- RLS that 0021 enabled on the underlying tables.
--
-- security_invoker = on makes each view run with the CALLER's privileges + RLS
-- instead:
--   * the app (service role, which has BYPASSRLS) keeps seeing everything —
--     unchanged;
--   * the anon / authenticated keys get nothing, because the base tables have
--     RLS enabled with no policies after 0021.
--
-- Every view in a chain needs the flag for RLS to reach the base tables
-- (v_recent_trips -> v_trips -> stops, etc.).

alter view v_trips                set (security_invoker = on);
alter view v_recent_trips         set (security_invoker = on);
alter view v_trip_legs_unified    set (security_invoker = on);
alter view v_location_pair_matrix set (security_invoker = on);
alter view v_location_dwell_stats set (security_invoker = on);
alter view v_route_estimates      set (security_invoker = on);
alter view latest_vehicle_plate  set (security_invoker = on);
