-- schema_v20_anomaly_ack_saved_meals.sql  —  (RUN ONCE)
-- ---------------------------------------------------------------------------
-- (1) transactions.anomaly_ack: the user dismissed the "unusual purchase" flag
--     for a charge — it must never resurface (synced across both phones).
-- (2) saved_meals: household-shared favorite meals (a name + logged items),
--     re-addable in the Meal Builder (solo → a meal; together → the dish).
--
-- SAFE / IDEMPOTENT: additive column + create-if-not-exists table.
-- ---------------------------------------------------------------------------

alter table public.transactions add column if not exists anomaly_ack boolean not null default false;

create table if not exists public.saved_meals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.saved_meals enable row level security;
do $pol$ begin
  if not exists (select 1 from pg_policies where tablename = 'saved_meals' and policyname = 'saved_meals_auth_all') then
    create policy saved_meals_auth_all on public.saved_meals for all to authenticated using (true) with check (true);
  end if;
end $pol$;
-- add to the realtime publication (ignore if already a member)
do $rt$ begin
  begin
    alter publication supabase_realtime add table public.saved_meals;
  exception when duplicate_object then null;
  end;
end $rt$;
