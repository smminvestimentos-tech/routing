-- One-off backfill: attach a `location_id` to closed stops that were detected
-- BEFORE their location existed (or had coordinates) in the table.
--
-- Context: `detect_stops` (0009) only resolves `location_id` at the moment it
-- closes a stop, and it resumes forward from each vehicle's last stop — it
-- never revisits an already-closed stop. So when a location is added later
-- (e.g. the 29 rows imported from locations_all_missing_import.csv, F21/AMOR
-- among them), the historical stops that physically sat inside that location's
-- radius stay `location_id = null` forever. This re-matches them once.
--
-- Rule: a closed stop with no location is matched to the ACTIVE location whose
-- circle (radius_meters, from the location's own row) contains the stop's
-- stored centroid and whose centre is NEAREST to it. This is the centroid-only
-- form of match_stop_location() (0009) — that function votes per raw ping for
-- the "dominant POI", but the ping buffer isn't persisted on the stop, so the
-- centroid is the best signal we still have. For a clean stop that sits well
-- inside one location's radius the two agree.
--
--   * `l.active` — 0019 keeps de-duplicated locations as inactive rows with
--     the same coordinates as their canonical twin (e.g. AUCHAN-03 kept next
--     to 7091 "Armazém-Vialonga"). Without this filter every stop near that
--     spot would be an artificial exact tie between the two. Filtering to
--     active rows makes "nearest" decisive again.
--   * DISTINCT ON (stop_id) + ORDER BY dist ASC, location_id ASC — nearest
--     wins; the id is only a final determinism tie-break, never the primary
--     selector.
--
-- Scope: status = 'closed' AND location_id IS NULL only. Stops that already
-- carry a location are left untouched; open stops self-heal on the next
-- detect_stops run (it re-processes an open stop's pings every tick).
--
-- Idempotent: re-running matches nothing once these rows have a location.
--
-- Expected impact (simulated against production at write time): 22 stops —
-- 17 -> 7091 "Armazém-Vialonga" (31 Aug – 1 Sep, Alverca platform cluster),
-- 5 -> F21 "AMOR" (2 – 8 Sep). 158 other location-less closed stops have no
-- active location within radius and stay null.

update stops s
set location_id = pick.location_id,
    updated_at  = now()
from (
  select distinct on (c.stop_id)
    c.stop_id,
    c.location_id
  from (
    select
      s.id as stop_id,
      l.id as location_id,
      haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) as dist_m
    from stops s
    join locations l
      on l.active
     and l.latitude is not null
     and l.longitude is not null
     and haversine_meters(s.centroid_lat, s.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
    where s.status = 'closed'
      and s.location_id is null
  ) c
  order by c.stop_id, c.dist_m asc, c.location_id asc
) pick
where s.id = pick.stop_id;
