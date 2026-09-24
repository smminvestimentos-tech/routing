-- Pátio de Vila Nova da Rainha: move the 7001 / 7005 pins onto their real
-- docks and reprocess the closed stops since 2026-09-01 against the new
-- geometry (same pattern as 0026/0029/0038/0041 — never leave labels from an
-- old geometry unreconciled).
--
-- Why: the two pins sat 61 m apart on the WEST side of the yard (0040 had to
-- clamp both radii to 30 m to stop them overlapping), while 7001's real dock
-- is on the EAST side. Pins confirmed against the Transpogest reference
-- (data/transpogest_coords_reference.csv):
--   7005  Aucham Congelados  -> doca oeste  39.042557, -8.920994  (~11 m from Transpogest)
--   7001  Armazém-Azambuja   -> doca leste  39.042563, -8.919161  (~50 m from Transpogest)
-- New pins are 158.3 m apart.
--
-- Radius: 75 m each. Same collision rule as 0040 (at most half the distance
-- to the nearest active neighbour = floor(158.3 / 2) = 79), so the circles
-- still never overlap (75 + 75 = 150 < 158.3). Nearest other active site is
-- 7003 Salvesen, 307 m from the west pin (150 + 75 < 307). The inactive '01'
-- (67 m from the east pin) is ignored by match_stop_location (0036).
-- 30 m was too small for the east dock: of the yard's closed stops since
-- 01/09, 145 sit within 30 m of the east pin but 1479 within 75 m.
--
-- Backfill (closed stops, arrived_at >= 2026-09-01, currently on 7001, 7005
-- or no location):
--   1. centroid inside a new circle -> that location (nearest centre wins,
--      location id only a determinism tie-break) — same rule as 0041;
--   2. currently 7001/7005 but centroid inside NEITHER new circle -> no
--      location (e.g. AA-32-CP 09/09 00:03-00:27, 103 m from the west pin:
--      a label left over from the old geometry, not a dock visit).
--
-- The sheet matcher's asymmetric 7001 <- 7005 acceptance (a 7001 row may use
-- a west-dock stop; a 7005 row never uses the east dock) lives in code:
-- YARD_ACCEPTS in src/lib/sheet-match/common.ts.
--
-- Expected impact (simulated in JS against production data on 2026-09-24):
--   null -> 7001: 618   null -> 7005: 473   7001 -> 7005: 275   7005 -> 7001: 0
--   7001 -> null: 471   7005 -> null: 1
--
-- PREVIEW — run this first (read-only; uses the NEW pins before they exist):
--
--   with new_pins(code, lat, lng, radius) as (
--     values ('7005', 39.042557, -8.920994, 75), ('7001', 39.042563, -8.919161, 75)
--   ),
--   scope as (
--     select s.*
--     from stops s
--     where s.status = 'closed'
--       and s.arrived_at >= '2026-09-01T00:00:00Z'
--       and (s.location_id is null
--            or s.location_id in (select id from locations where code in ('7001','7005') and active))
--   ),
--   cand as (
--     select sc.id as stop_id, l.id as location_id, p.code,
--            haversine_meters(sc.centroid_lat, sc.centroid_lng, p.lat, p.lng) as dist_m
--     from scope sc
--     join new_pins p on haversine_meters(sc.centroid_lat, sc.centroid_lng, p.lat, p.lng) <= p.radius
--     join locations l on l.code = p.code and l.active
--   ),
--   pick as (
--     select distinct on (stop_id) * from cand order by stop_id, dist_m, location_id
--   ),
--   target as (
--     select sc.id as stop_id, sc.location_id as from_id, pick.location_id as to_id
--     from scope sc left join pick on pick.stop_id = sc.id
--   )
--   select coalesce(f.code, 'null') as from_code, coalesce(t.code, 'null') as to_code, count(*) as n
--   from target
--   left join locations f on f.id = target.from_id
--   left join locations t on t.id = target.to_id
--   where target.from_id is distinct from target.to_id
--   group by 1, 2
--   order by 1, 2;
--   -- expected: the six rows in "Expected impact" above.

begin;

update locations
set latitude = 39.042557, longitude = -8.920994, radius_meters = 75, updated_at = now()
where code = '7005' and active;

update locations
set latitude = 39.042563, longitude = -8.919161, radius_meters = 75, updated_at = now()
where code = '7001' and active;

-- 1 + 2 in one statement: every in-scope stop gets its new-geometry location,
-- or null when no new circle contains it. Only rows that actually change are
-- written.
with scope as (
  select s.id, s.location_id, s.centroid_lat, s.centroid_lng
  from stops s
  where s.status = 'closed'
    and s.arrived_at >= '2026-09-01T00:00:00Z'
    and (s.location_id is null
         or s.location_id in (select id from locations where code in ('7001', '7005') and active))
),
pick as (
  select distinct on (sc.id) sc.id as stop_id, l.id as location_id
  from scope sc
  join locations l
    on l.active
   and l.code in ('7001', '7005')
   and haversine_meters(sc.centroid_lat, sc.centroid_lng, l.latitude, l.longitude) <= l.radius_meters
  order by sc.id,
           haversine_meters(sc.centroid_lat, sc.centroid_lng, l.latitude, l.longitude) asc,
           l.id asc
),
target as (
  select sc.id as stop_id, pick.location_id as to_id
  from scope sc
  left join pick on pick.stop_id = sc.id
  where sc.location_id is distinct from pick.location_id
)
update stops s
set location_id = target.to_id,
    updated_at  = now()
from target
where s.id = target.stop_id;

-- report ----------------------------------------------------------------
do $$
declare
  d double precision;
  r record;
  c_7001 int;
  c_7005 int;
begin
  select haversine_meters(a.latitude, a.longitude, b.latitude, b.longitude)
    into d
  from locations a, locations b
  where a.code = '7001' and a.active and b.code = '7005' and b.active;
  raise notice 'distance 7001<->7005 = % m (expected 158.3)', round(d::numeric, 1);

  for r in
    select code, latitude, longitude, radius_meters from locations
    where code in ('7001', '7005') and active order by code
  loop
    raise notice '  % lat=% lng=% radius_meters=%', r.code, r.latitude, r.longitude, r.radius_meters;
  end loop;

  select count(*) into c_7001 from stops s join locations l on l.id = s.location_id
  where l.code = '7001' and s.status = 'closed' and s.arrived_at >= '2026-09-01T00:00:00Z';
  select count(*) into c_7005 from stops s join locations l on l.id = s.location_id
  where l.code = '7005' and s.status = 'closed' and s.arrived_at >= '2026-09-01T00:00:00Z';
  raise notice 'closed stops since 01/09: 7001 = %, 7005 = %', c_7001, c_7005;
end $$;

commit;
