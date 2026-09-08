-- fleet_trucks: manual "nº do camião -> matrícula" reference table, edited in
-- /dashboard/camioes. Same shape/role as `locations` (master data maintained by
-- hand), but deliberately lightweight: it is only a *hint* for matching the TFS
-- delivery sheet (/dashboard/tfs-sheet) when a row has no plate of its own, and
-- it is assumed to drift out of date — nothing in the pipeline treats it as
-- authoritative.
create table fleet_trucks (
  id uuid primary key default gen_random_uuid(),
  truck_number text not null unique,
  plate text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Matching looks trucks up the other way too (plate -> nº), and the table is
-- small, but the index is cheap and keeps that lookup honest.
create index fleet_trucks_plate_idx on fleet_trucks (plate);

-- Same stance as every other table here (see 0021 / 0024): the app only ever
-- talks to the DB through the service-role key, which bypasses RLS. Enabling
-- RLS with no policies + revoking the anon/authenticated grants keeps the
-- public REST API from ever returning a row.
alter table fleet_trucks enable row level security;
revoke all on fleet_trucks from anon, authenticated, public;
