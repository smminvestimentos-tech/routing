-- Split the old TRACKiT-POI-backed `locations` table into two:
--   trackit_pois: raw POIs from TRACKiT (GET /api/poi/0), reference/history only
--   locations:    business master data imported from data/locations_import.csv,
--                 identified by `code`. This is what route_legs now matches against.
alter table locations rename to trackit_pois;

alter table route_legs drop constraint if exists route_legs_origin_id_fkey;
alter table route_legs drop constraint if exists route_legs_destination_id_fkey;

-- Old origin_id/destination_id pointed at trackit_pois rows. They'll be recomputed
-- by coordinate-proximity matching against the new `locations` table on next sync.
update route_legs set origin_id = null, destination_id = null;

create table locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  arp2_code text,
  name text,
  type text check (type in ('loja', 'armazem', 'centro_distribuicao', 'fornecedor', 'oficina')),
  address text,
  locality text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists locations_type_idx on locations (type);

alter table route_legs
  add constraint route_legs_origin_id_fkey foreign key (origin_id) references locations(id),
  add constraint route_legs_destination_id_fkey foreign key (destination_id) references locations(id);
