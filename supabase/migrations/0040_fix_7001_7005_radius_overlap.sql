-- 7001 ("Armazém-Azambuja", centro_distribuicao) and 7005 ("Aucham
-- Congelados", armazem) are two DISTINCT, physically separate warehouses —
-- not a co-located pair, not the same site. They must never be treated as
-- interchangeable. But their pins sit only 60.99 m apart (measured via
-- haversine_meters, same function detect_stops uses) while carrying radii of
-- 150 m and 50 m respectively — sum 200 m, so the circles overlap by ~139 m.
-- match_stop_location (0009/0036) votes among EVERY location whose circle
-- contains a buffered ping; a ping genuinely at 7005's dock but also inside
-- 7001's oversized 150 m circle can tip the vote to the wrong warehouse
-- (confirmed 2026-09-15: a 20-min real stop at 7005 was matched to 7001-
-- adjacent geometry purely from this overlap, investigated against
-- BG-96-ID / ROTA 185840969 / 15/09).
--
-- 0028 already flagged this exact pair as part of the "Vila Nova da Rainha
-- cluster" and deliberately left it alone (comment: "clamp keeps them at
-- 150; the stray stops there are a pin-placement problem, not a radius
-- one") — but 0028 only ever GROWS a radius (floor of 150, never shrinks).
-- This migration applies the same collision guard in the other direction:
-- cap each radius at HALF the distance to its nearest ACTIVE neighbour, so
-- two adjacent circles meet at the midpoint at worst and can never both
-- claim the same ping. For this pair, nearest-active-neighbour is each
-- other (60.99 m) on both sides, so both are capped identically at
-- floor(60.99 / 2) = 30 m. This can only ever REDUCE a radius here (least()
-- below), never grow one — unlike 0028's greatest(150, ...).
--
-- What this deliberately does NOT fix: pins/circles this small will leave
-- some genuine yard pings unmatched (location_id null) rather than
-- mis-assigned — that's the correct trade-off (unmatched > confidently
-- wrong) and is a separate pin-placement problem, same as 0028 already
-- noted. It also does nothing for the running-centroid fragmentation that
-- split one continuous visit into 3 `stops` rows that same day — that is a
-- detect_stops algorithm question, not a radius question, and is not
-- addressed here.
--
-- PREVIEW — run first:
--
--   select l.code, l.name, l.type, l.radius_meters,
--          (select o.code from locations o
--             where o.id <> l.id and o.active
--               and o.latitude between 32 and 43 and o.longitude between -32 and -6
--             order by haversine_meters(l.latitude, l.longitude, o.latitude, o.longitude)
--             limit 1) as nearest_active_code,
--          (select min(haversine_meters(l.latitude, l.longitude, o.latitude, o.longitude))
--             from locations o
--             where o.id <> l.id and o.active
--               and o.latitude between 32 and 43 and o.longitude between -32 and -6) as nearest_m
--   from locations l
--   where l.code in ('7001', '7005');
--   -- expected: both rows show nearest_active_code = the other, nearest_m ≈ 60.99

begin;

update locations l
set radius_meters = least(
      l.radius_meters,
      floor(
        (select min(haversine_meters(l.latitude, l.longitude, o.latitude, o.longitude))
           from locations o
          where o.id <> l.id
            and o.active
            and o.latitude between 32 and 43
            and o.longitude between -32 and -6)
        / 2
      )::int
    ),
    updated_at = now()
where l.code in ('7001', '7005')
  and l.active;

-- report ----------------------------------------------------------------
do $$
declare
  r record;
  d double precision;
begin
  select haversine_meters(a.latitude, a.longitude, b.latitude, b.longitude)
    into d
  from locations a, locations b
  where a.code = '7001' and b.code = '7005';

  raise notice 'distance 7001<->7005 = % m', round(d::numeric, 2);
  for r in
    select code, name, radius_meters from locations where code in ('7001', '7005') order by code
  loop
    raise notice '  % (%) radius_meters=%', r.code, r.name, r.radius_meters;
  end loop;
  raise notice 'expected: both radius_meters=30, circles no longer overlap (30+30=60 < %)', round(d::numeric, 2);
end $$;

commit;
