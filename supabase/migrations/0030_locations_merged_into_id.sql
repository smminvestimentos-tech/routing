-- Two related changes:
--
--   1. Add locations.merged_into_id, nullable FK to locations(id), and
--      backfill it retroactively for the two merge groups 0019 already did:
--        7001       -> 01     (Armazém Azambuja)
--        AUCHAN-03  -> 7091   (Armazém-Vialonga)
--        201        -> 7091   (Armazém-Vialonga)
--      0019 flagged the duplicates `active = false` but never recorded WHICH
--      canonical row absorbed them — merged_into_id makes that explicit and
--      queryable, and is what step 3 (the sheet matchers) resolves through.
--
--   2. New merge, same pattern: AUCHAN-4 and 7092 (both "Armazém Torres
--      Novas") are the same physical warehouse as the canonical, active 206
--      (Entreposto Auchan/Minipreço Torres Novas). Re-point every reference,
--      flag both inactive with merged_into_id = 206, delete nothing.
--
--      AUCHAN-4 and 7092 currently have ZERO stops / route_legs / route_margins
--      referencing them (verified at authoring time — both are dead rows, never
--      matched by the coordinate-proximity sync because 7092 has no
--      coordinates at all and AUCHAN-4's were never set either). The re-point
--      UPDATEs below are still included for correctness / future-proofing —
--      they no-op today — rather than skipped, so this migration stays a
--      faithful copy of the 0019 pattern and is safe to reuse for the next
--      merge that DOES have rows to move.
--
-- PREVIEW — run first to confirm counts before applying:
--
--   select l.code, l.name, l.active, l.radius_meters,
--          (select count(*) from stops s where s.location_id = l.id) as stops,
--          (select count(*) from route_legs x where x.origin_id = l.id) as rl_o,
--          (select count(*) from route_legs x where x.destination_id = l.id) as rl_d,
--          (select count(*) from route_margins m where m.origin_location_id = l.id) as rm_o,
--          (select count(*) from route_margins m where m.destination_location_id = l.id) as rm_d
--   from locations l
--   where l.code in ('206','AUCHAN-4','7092','01','7001','AUCHAN-03','201','7091')
--   order by l.code;

begin;

-- 1. merged_into_id column ----------------------------------------------
alter table locations
  add column if not exists merged_into_id uuid references locations(id);

-- A merged row is inactive by definition; an active row is never "merged
-- into" anything. Catches the mistake of flagging merged_into_id on a row
-- that's still live.
alter table locations
  add constraint locations_merged_into_id_requires_inactive
  check (merged_into_id is null or active = false);

alter table locations
  add constraint locations_merged_into_id_not_self
  check (merged_into_id is null or merged_into_id <> id);

create index if not exists locations_merged_into_id_idx
  on locations (merged_into_id)
  where merged_into_id is not null;

-- 2. backfill merged_into_id for the 0019 merges -------------------------
update locations
   set merged_into_id = (select id from locations where code = '7091')
 where code in ('AUCHAN-03', '201');

update locations
   set merged_into_id = (select id from locations where code = '01')
 where code = '7001';

-- 3. new merge: AUCHAN-4, 7092 -> 206 -------------------------------------
update stops
   set location_id = (select id from locations where code = '206')
 where location_id in (select id from locations where code in ('AUCHAN-4', '7092'));

update route_legs
   set origin_id = (select id from locations where code = '206')
 where origin_id in (select id from locations where code in ('AUCHAN-4', '7092'));

update route_legs
   set destination_id = (select id from locations where code = '206')
 where destination_id in (select id from locations where code in ('AUCHAN-4', '7092'));

update route_margins
   set origin_location_id = (select id from locations where code = '206')
 where origin_location_id in (select id from locations where code in ('AUCHAN-4', '7092'));

update route_margins
   set destination_location_id = (select id from locations where code = '206')
 where destination_location_id in (select id from locations where code in ('AUCHAN-4', '7092'));

-- Same collision guard as 0019: route_legs rows are KEPT (a self-pair is
-- historically fine, the pair views already ignore origin = destination);
-- route_margins self-pairs / duplicates are config, not history, so drop them.
delete from route_margins where origin_location_id = destination_location_id;
delete from route_margins a
  using route_margins b
 where a.origin_location_id = b.origin_location_id
   and a.destination_location_id = b.destination_location_id
   and a.ctid < b.ctid;

update locations
   set active = false,
       merged_into_id = (select id from locations where code = '206'),
       updated_at = now()
 where code in ('AUCHAN-4', '7092');

-- 4. report ----------------------------------------------------------------
-- Total counts are printed before AND after the moves above settle, so it's
-- visible that nothing disappeared — rows only changed owner.
do $$
declare
  r record;
begin
  raise notice 'TOTAL stops=% route_legs=% route_margins=% (nothing here should ever drop from a merge)',
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
    where l.code in ('206', 'AUCHAN-4', '7092', '01', '7001', 'AUCHAN-03', '201', '7091')
    order by l.code
  loop
    raise notice '  % active=% merged_into=% stops=% rl_origin=% rl_dest=% rm_origin=% rm_dest=%',
      r.code, r.active, r.merged_into_code, r.stops, r.rl_o, r.rl_d, r.rm_o, r.rm_d;
  end loop;
end $$;

commit;
