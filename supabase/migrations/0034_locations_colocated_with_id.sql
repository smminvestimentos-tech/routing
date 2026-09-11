-- Generalises the same-site / co-location equivalence that used to live as a
-- hardcoded SAME_SITE_GROUPS constant in src/lib/sheet-match/common.ts (the
-- Albufeira B78/94/AUCHAN-06 case) into DB data, editable from
-- /dashboard/locations, so a new store+platform collision never needs a
-- deploy again.
--
-- colocated_with_id is deliberately UNLIKE merged_into_id:
--   - merged_into_id says "this row is a dead duplicate, absorbed into that
--     canonical row" — the merged row is inactive, history was re-pointed.
--   - colocated_with_id says "this row and that row are two distinct, both
--     ACTIVE locations that happen to share one physical site" (e.g. a store
--     and its attached cross-dock platform, close enough that GPS proximity
--     stop-detection can't tell them apart) — for matching purposes only, a
--     stop detected at either code should be accepted as confirming either.
--
-- Star topology, same convention as merged_into_id: every member of a group
-- points its OWN colocated_with_id directly at one shared hub location; the
-- hub's own colocated_with_id stays null. The app resolves a group in one
-- hop (a location's group = itself + the hub it points to + every other
-- location pointing at that same hub) — do not chain (A -> B -> C), it won't
-- be picked up transitively.
--
-- PREVIEW — run first:
--
--   select l.code, l.name, l.active,
--          c.code as colocated_with_code
--   from locations l
--   left join locations c on c.id = l.colocated_with_id
--   where l.code in ('B78','94','AUCHAN-06','12','7030','26','7004')
--   order by l.code;

begin;

alter table locations
  add column if not exists colocated_with_id uuid references locations(id);

alter table locations
  add constraint locations_colocated_with_id_not_self
  check (colocated_with_id is null or colocated_with_id <> id);

create index if not exists locations_colocated_with_id_idx
  on locations (colocated_with_id)
  where colocated_with_id is not null;

-- 1. Migrate the existing hardcoded Albufeira group off SAME_SITE_GROUPS.
--    AUCHAN-06 is the hub (94 already merged_into_id -> AUCHAN-06; keep the
--    same target here for one consistent canonical site).
update locations
   set colocated_with_id = (select id from locations where code = 'AUCHAN-06'),
       updated_at = now()
 where code in ('B78', '94');

-- 2. New confirmed case: Almada — loja '12' + 'Plataforma Almada' (7030) sit
--    45m apart (200m / 150m radii), so GPS stop-detection resolves visits to
--    either one essentially at random. Investigated 2026-09-11 (AT-45-AC,
--    405 Pescadores route): 6 clean 14-34min stops in the gaps between 405
--    visits, ALL location-matched to '12', none to '7030' — not a detection
--    filter issue, a geographic collision. Hub = '12' (the store).
update locations
   set colocated_with_id = (select id from locations where code = '12'),
       updated_at = now()
 where code = '7030';

-- 3. New confirmed case: Maia — loja '26' (41.249499, -8.623163) + 'Plataforma
--    Maia' (7004, 41.249225, -8.621099) are ~150m apart, same pattern. Hub =
--    '26' (the store).
update locations
   set colocated_with_id = (select id from locations where code = '26'),
       updated_at = now()
 where code = '7004';

do $$
declare
  r record;
begin
  for r in
    select l.code, l.active, c.code as colocated_with_code
    from locations l
    left join locations c on c.id = l.colocated_with_id
    where l.code in ('B78', '94', 'AUCHAN-06', '12', '7030', '26', '7004')
    order by l.code
  loop
    raise notice '  % active=% colocated_with=%', r.code, r.active, coalesce(r.colocated_with_code, '-');
  end loop;
end $$;

commit;
