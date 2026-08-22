-- Tracks progress of a /api/sync/travels run across multiple invocations, so a
-- run interrupted mid-way (e.g. a serverless execution time limit) can resume
-- from `cursor` instead of restarting and re-processing every vehicle.
create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  trackit_account text not null default 'default',
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  date_begin text not null,
  date_end text not null,
  vehicle_ids jsonb not null,
  vehicles_total integer not null,
  vehicles_processed integer not null default 0,
  cursor integer not null default 0,
  travels_upserted integer not null default 0,
  vehicle_errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists sync_runs_status_idx on sync_runs (trackit_account, status);
