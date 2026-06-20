-- schema_v16_weights.sql
-- Daily body-weight log → the app does ALL the weekly-averaging + trend math
-- automatically (no more "weeks on plan" / manual calibration). One row per
-- (person, date). authenticated-full RLS + Realtime, like the other Health
-- tables. Idempotent.

create table if not exists public.body_weights (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  date date not null,
  weight numeric not null,
  updated_at timestamptz not null default now(),
  unique (person, date)
);
create index if not exists body_weights_person_date on public.body_weights (person, date);

alter table public.body_weights enable row level security;
drop policy if exists "body_weights auth full" on public.body_weights;
create policy "body_weights auth full" on public.body_weights
  for all to authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table public.body_weights;
exception when duplicate_object then null; end $$;
