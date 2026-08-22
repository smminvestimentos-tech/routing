-- TRACKiT's vehicleTravels "mid" field is NOT a per-travel id — it's always
-- identical to the vehicleId (confirmed across 1555 travels / 7 days / 38
-- vehicles, 0 exceptions). Using it as the upsert conflict key meant every
-- trip after a vehicle's first got silently collapsed into one row.
--
-- (vehicle_id, started_at) is the real unique key: 0 collisions in the same
-- 7-day sample. trackit_mid duplicated vehicle_id exactly, so it's dropped.
alter table route_legs drop constraint if exists route_legs_trackit_account_trackit_mid_key;
alter table route_legs drop column if exists trackit_mid;

alter table route_legs
  add constraint route_legs_account_vehicle_started_key
  unique (trackit_account, vehicle_id, started_at);
