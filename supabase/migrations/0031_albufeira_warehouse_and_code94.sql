-- Two related changes for the Albufeira warehouse:
--
--   1. AUCHAN-06 (ARMAZÉM ALBUFEIRA - Plataforma Albufeira) has never had
--      coordinates — it's an active location that the proximity sync could
--      never have matched anything to. Confirmed with the user: it's
--      physically the same site as B78 (Albufeira, loja) — the warehouse
--      sits right next to the store. Copy B78's coordinate to AUCHAN-06 and
--      widen its radius to 350m, the armazem/centro_distribuicao standard
--      from 0028 (not B78's own 250m loja radius). Nearest other active
--      location to that point is I685 "Cruz Caliços" at ~3040m — no
--      collision risk at 350m.
--
--      B78 itself is NOT touched: it stays its own active `loja` row with
--      its own 250m radius. This only gives AUCHAN-06 real coordinates.
--
--   2. New row for code '94': active=false, merged_into_id -> AUCHAN-06,
--      from the start — never active. Same resolution path as 0030
--      (AUCHAN-4 / 7092 -> 206): any sheet still citing store code 94
--      resolves straight to AUCHAN-06 in the matcher instead of landing on
--      "⚠️ Rever manualmente". No stops/route_legs/route_margins to
--      re-point — this code never had its own locations row before.
--
-- PREVIEW — run first to confirm state before applying:
--
--   select code, name, type, active, latitude, longitude, radius_meters, merged_into_id
--   from locations where code in ('B78', 'AUCHAN-06', '94');
--   -- expect: B78 active/loja with coords; AUCHAN-06 active/armazem, lat/lng NULL;
--   -- '94' not found (0 rows).

begin;

-- 1. AUCHAN-06 <- B78's coordinate, armazem-standard radius --------------
update locations
   set latitude = (select latitude from locations where code = 'B78'),
       longitude = (select longitude from locations where code = 'B78'),
       radius_meters = 350,
       updated_at = now()
 where code = 'AUCHAN-06';

-- 2. code '94', inactive from birth, resolves to AUCHAN-06 ---------------
insert into locations (code, name, type, active, merged_into_id)
values (
  '94',
  'Armazém Albufeira (código legado 94)',
  'armazem',
  false,
  (select id from locations where code = 'AUCHAN-06')
);

-- 3. report ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select l.code, l.active, l.type, l.latitude, l.longitude, l.radius_meters,
           (select c.code from locations c where c.id = l.merged_into_id) as merged_into_code
    from locations l
    where l.code in ('B78', 'AUCHAN-06', '94')
    order by l.code
  loop
    raise notice '  % active=% type=% lat=% lng=% radius=% merged_into=%',
      r.code, r.active, r.type, r.latitude, r.longitude, r.radius_meters, r.merged_into_code;
  end loop;
end $$;

commit;
