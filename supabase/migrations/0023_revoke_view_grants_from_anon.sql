-- 0022 set security_invoker = on, but a verification GET with the anon key
-- still returned real rows from the views — including latest_vehicle_plate, a
-- single-hop view over vehicle_pings, which has RLS after 0021. So
-- security_invoker isn't taking effect here (Postgres version and/or apply
-- issue). The definitive, version-independent fix is to drop the anon /
-- authenticated SELECT grant on these views.
--
-- The app talks to the DB through the service role, which keeps its own grant
-- and has BYPASSRLS, so it is unaffected. CREATE OR REPLACE VIEW preserves a
-- view's ACL, so this survives future view edits (only a DROP + CREATE would
-- re-grant).

revoke select on
  v_trips,
  v_recent_trips,
  v_trip_legs_unified,
  v_location_pair_matrix,
  v_location_dwell_stats,
  v_route_estimates,
  latest_vehicle_plate
from anon, authenticated;
