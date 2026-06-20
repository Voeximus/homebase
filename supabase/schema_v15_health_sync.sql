-- schema_v15_health_sync.sql
-- Cloud-sync the Health logs (meal days + workouts + routines) so they follow
-- both people across phones — the same role the `foods` table plays for the
-- library. Document-per-entity: the nested meals / exercises+sets live in JSONB
-- (the app already thinks of them as documents). authenticated-full RLS, like
-- every other table; Realtime so a write on one device reconciles on the other.
-- Idempotent — safe to re-run.

-- ── meal days: one row per (person, date), the whole day's meals ──
create table if not exists public.meal_days (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  date date not null,
  meals jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (person, date)
);

-- ── workouts: one row per logged session ──
create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  date date not null,
  name text not null default '',
  notes text not null default '',
  exercises jsonb not null default '[]'::jsonb,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workouts_person_date on public.workouts (person, date desc);

-- ── workout routines: one row per saved (custom) routine ──
create table if not exists public.workout_routines (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  name text not null,
  meta text not null default '',
  exercises jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists workout_routines_person on public.workout_routines (person);

-- ── RLS: authenticated-full (the household shares one login) ──
alter table public.meal_days enable row level security;
alter table public.workouts enable row level security;
alter table public.workout_routines enable row level security;

drop policy if exists "meal_days auth full" on public.meal_days;
create policy "meal_days auth full" on public.meal_days
  for all to authenticated using (true) with check (true);

drop policy if exists "workouts auth full" on public.workouts;
create policy "workouts auth full" on public.workouts
  for all to authenticated using (true) with check (true);

drop policy if exists "workout_routines auth full" on public.workout_routines;
create policy "workout_routines auth full" on public.workout_routines
  for all to authenticated using (true) with check (true);

-- ── Realtime: emit postgres_changes so both devices stay in step ──
do $$ begin
  alter publication supabase_realtime add table public.meal_days;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.workouts;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.workout_routines;
exception when duplicate_object then null; end $$;
