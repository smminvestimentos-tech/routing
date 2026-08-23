-- Tracks when trackit_pois was last refreshed per account, so
-- /api/sync/travels can skip the (slow) POI sync on most 15-minute cron
-- ticks — Hobby's fixed 10s-per-invocation limit makes every second count —
-- and only refresh it roughly once a day.
create table sync_metadata (
  trackit_account text primary key,
  pois_synced_at timestamptz
);
