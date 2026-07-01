-- v16 — editable daily macro targets (per person, household-shared).
-- Replaces the hardcoded DAILY constant in src/lib/nutrition.ts: the Meal
-- Builder now reads targets from here (falling back to DAILY if a row is
-- missing) and writes edits via HealthStore.setMacroTarget. SAFE TO RUN.

create table if not exists public.macro_targets (
  person     text primary key,          -- 'gino' | 'xinyan'
  kcal       numeric not null,
  p          numeric not null,           -- protein g
  c          numeric not null,           -- carbs g
  f          numeric not null,           -- fat g
  updated_at timestamptz not null default now()
);

alter table public.macro_targets enable row level security;

-- Household-shared, same policy shape as meal_days / saved_meals: any signed-in
-- household member can read + write. (Public signup stays disabled, so this is
-- the two of them only.)
drop policy if exists "macro_targets all" on public.macro_targets;
create policy "macro_targets all" on public.macro_targets
  for all to authenticated using (true) with check (true);

-- Seed with the starting plan; never clobber an existing edit.
insert into public.macro_targets (person, kcal, p, c, f) values
  ('gino',   2800, 130, 410, 70),
  ('xinyan', 1550, 140, 145, 45)
on conflict (person) do nothing;

-- Realtime so an edit on one phone reflects on the other.
alter publication supabase_realtime add table public.macro_targets;
