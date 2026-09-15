-- Reverses the direction of the 0019 "Group 2" merge for the Azambuja main
-- warehouse. 0019 picked '01' as canonical because it had more history at
-- the time (236 refs vs 71) — but the user has confirmed the operation
-- itself (folhas, administradores) uses code '7001', not '01'. '7001' should
-- be the active/canonical row; '01' should be the inactive/merged one.
--
-- Coordinates: '7001' already carries the more reliable data — migration
-- 0032 synced its latitude/longitude from the Azambuja TrackIt POI
-- reference (user-confirmed source, cross-checked by name similarity; see
-- 0032's own header comment), giving it 39.043191355535 / -8.9206650853157.
-- '01's coordinate (39.0430977552197 / -8.91879872883603) is the original
-- 2026-08-22 CSV import, never independently verified since. Both currently
-- have radius_meters = 150 (equal, no conflict). So this migration keeps
-- '7001's own latitude/longitude/radius_meters as-is and copies NOTHING
-- from '01' — there is nothing on '01' more reliable to bring over.
--
-- Depends on 0036 (match_stop_location no longer votes for inactive rows)
-- already being applied, so that once this flips which side is active, no
-- new stop can land back on the now-inactive '01'.
--
-- PREVIEW — run first:
--
--   select code, active, merged_into_id, latitude, longitude, radius_meters, updated_at
--   from locations where code in ('01', '7001');
--
--   select
--     (select count(*) from stops where location_id = (select id from locations where code = '01')) as stops_01,
--     (select count(*) from stops where location_id = (select id from locations where code = '7001')) as stops_7001,
--     (select count(*) from route_legs where origin_id = (select id from locations where code = '01')
--        or destination_id = (select id from locations where code = '01')) as route_legs_01,
--     (select count(*) from route_legs where origin_id = (select id from locations where code = '7001')
--        or destination_id = (select id from locations where code = '7001')) as route_legs_7001,
--     (select count(*) from route_margins where origin_location_id = (select id from locations where code = '01')
--        or destination_location_id = (select id from locations where code = '01')) as route_margins_01,
--     (select count(*) from route_margins where origin_location_id = (select id from locations where code = '7001')
--        or destination_location_id = (select id from locations where code = '7001')) as route_margins_7001;
--   -- as of 2026-09-15: stops_01=820 (growing), stops_7001=417 (growing),
--   --   route_legs_01=148+157, route_legs_7001=0, route_margins_01=1+0, route_margins_7001=0

begin;

-- 1. re-point every reference: '01' -> '7001' (mirror of 0019's Group 2,
--    reversed) -------------------------------------------------------------
update stops
   set location_id = (select id from locations where code = '7001')
 where location_id in (select id from locations where code = '01');

update route_legs
   set origin_id = (select id from locations where code = '7001')
 where origin_id in (select id from locations where code = '01');

update route_legs
   set destination_id = (select id from locations where code = '7001')
 where destination_id in (select id from locations where code = '01');

update route_margins
   set origin_location_id = (select id from locations where code = '7001')
 where origin_location_id in (select id from locations where code = '01');

update route_margins
   set destination_location_id = (select id from locations where code = '7001')
 where destination_location_id in (select id from locations where code = '01');

-- Same collision guard 0019/0030 use: route_legs self-pairs are KEPT
-- (historical, the pair views already ignore origin = destination);
-- route_margins self-pairs / duplicates are config, not history, so drop them.
delete from route_margins where origin_location_id = destination_location_id;
delete from route_margins a
  using route_margins b
 where a.origin_location_id = b.origin_location_id
   and a.destination_location_id = b.destination_location_id
   and a.ctid < b.ctid;

-- 2. flip which side is canonical -------------------------------------------
-- '7001' first: clears merged_into_id and activates in one statement, so the
-- locations_merged_into_id_requires_inactive check never sees an invalid
-- intermediate state regardless of statement order.
update locations
   set active = true,
       merged_into_id = null,
       updated_at = now()
 where code = '7001';

update locations
   set active = false,
       merged_into_id = (select id from locations where code = '7001'),
       updated_at = now()
 where code = '01';

-- 3. report ------------------------------------------------------------------
do $$
declare
  r record;
begin
  raise notice 'TOTAL stops=% route_legs=% route_margins=% (nothing here should ever drop from a re-point)',
    (select count(*) from stops),
    (select count(*) from route_legs),
    (select count(*) from route_margins);
  for r in
    select l.code, l.active, l.merged_into_id,
           (select c.code from locations c where c.id = l.merged_into_id) as merged_into_code,
           (select count(*) from stops s where s.location_id = l.id) as stops,
           (select count(*) from route_legs x where x.origin_id = l.id) as rl_o,
           (select count(*) from route_legs x where x.destination_id = l.id) as rl_d,
           (select count(*) from route_margins m where m.origin_location_id = l.id) as rm_o,
           (select count(*) from route_margins m where m.destination_location_id = l.id) as rm_d
    from locations l
    where l.code in ('01', '7001')
    order by l.code
  loop
    raise notice '  % active=% merged_into=% stops=% rl_origin=% rl_dest=% rm_origin=% rm_dest=%',
      r.code, r.active, r.merged_into_code, r.stops, r.rl_o, r.rl_d, r.rm_o, r.rm_d;
  end loop;
  raise notice 'expected: 01 active=f merged_into=7001 stops=0 rl_origin=0 rl_dest=0 rm_origin=0 rm_dest=0';
  raise notice 'expected: 7001 active=t merged_into=<null> stops=>0 rl_origin=>0 rl_dest=>0 rm_origin=>0 rm_dest=0';
end $$;

commit;
