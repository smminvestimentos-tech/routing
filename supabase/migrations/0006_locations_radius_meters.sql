-- Detection radius for the new ping-based stop matching (see 0007-0009).
-- 150m matches the reference implementation's default.
alter table locations
  add column radius_meters integer not null default 150;
