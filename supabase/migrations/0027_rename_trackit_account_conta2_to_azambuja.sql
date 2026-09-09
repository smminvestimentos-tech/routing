-- Rename the second TRACKiT account's id from the placeholder "conta2" to
-- "azambuja" in the rows already written for it.
--
-- Context: the multi-account support (src/lib/trackit/client.ts ACCOUNT_ENV)
-- was first wired up and end-to-end tested under the id "conta2", which left
-- real rows behind:
--   vehicle_pings  ~468 rows  trackit_account = 'conta2'
--   stops           151 rows  trackit_account = 'conta2'
-- Every other table carrying a trackit_account column (route_legs, trackit_pois,
-- sync_runs, sync_metadata) was checked and had NO 'conta2' rows — only
-- /api/sync/positions and /api/sync/stops had run for that account, not
-- /api/sync/travels. If travels is later run for it before this migration is
-- applied, add the matching updates for those tables.
--
-- The code now uses id "azambuja"; this realigns the historical data so its
-- pings/stops stay attached to the account instead of being orphaned.

update vehicle_pings set trackit_account = 'azambuja' where trackit_account = 'conta2';
update stops         set trackit_account = 'azambuja' where trackit_account = 'conta2';
