-- ============================================================================
--  Homebase database schema
--  Run this ONCE in your Supabase project: Dashboard -> SQL Editor -> paste ->
--  Run. Safe to re-run (guards included).
-- ============================================================================

-- 1. Tables -------------------------------------------------------------------

create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  amount      numeric(12,2) not null,
  type        text not null check (type in ('income','expense')),
  category_id text not null,
  description text not null default '',
  account     text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.debts (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  balance          numeric(12,2) not null,
  original_balance numeric(12,2) not null,
  apr              numeric(6,2),
  min_payment      numeric(12,2),
  color            text not null default '#ef4444',
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);

create table if not exists public.savings_goals (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  saved      numeric(12,2) not null default 0,
  target     numeric(12,2) not null,
  icon       text not null default '💰',
  color      text not null default '#10b981',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 2. Row-Level Security -------------------------------------------------------
--  Shared household: any signed-in account (you + your wife) can read & write
--  everything. Security comes from controlling who is allowed to have an
--  account (lock down sign-ups once you've both registered).

alter table public.transactions  enable row level security;
alter table public.debts         enable row level security;
alter table public.savings_goals enable row level security;

drop policy if exists "Household access" on public.transactions;
drop policy if exists "Household access" on public.debts;
drop policy if exists "Household access" on public.savings_goals;

create policy "Household access" on public.transactions
  for all to authenticated using (true) with check (true);
create policy "Household access" on public.debts
  for all to authenticated using (true) with check (true);
create policy "Household access" on public.savings_goals
  for all to authenticated using (true) with check (true);

-- 3. Realtime -----------------------------------------------------------------
--  Broadcast changes so both devices update live. replica identity full makes
--  delete events carry the old row.

alter table public.transactions  replica identity full;
alter table public.debts         replica identity full;
alter table public.savings_goals replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.debts;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.savings_goals;
exception when duplicate_object then null; end $$;
