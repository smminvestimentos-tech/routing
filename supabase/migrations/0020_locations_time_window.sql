-- Free-text delivery time window per location (e.g. "08:00-12:00",
-- "qualquer hora"). Nullable, no format constraint for now — the exact format
-- the future data source will use isn't settled yet.
alter table locations add column if not exists time_window text;
