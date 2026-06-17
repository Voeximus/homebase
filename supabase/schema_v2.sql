-- ============================================================================
--  Homebase schema v2 — Accounts + Recurring ("pipelines")
--  Run ONCE in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- ============================================================================

-- 1. ACCOUNTS -----------------------------------------------------------------
create table if not exists public.accounts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,                 -- "Geo", "Xinyan", "Joint"
  owner      text not null,                 -- "Gino" | "Xinyan" | "Joint"
  last4      text,                           -- "4662"
  type       text not null default 'checking',
  balance    numeric(12,2) not null default 0,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

-- 2. RECURRING (fixed income, bills, and transfers) ---------------------------
create table if not exists public.recurring (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  amount        numeric(12,2) not null,                 -- always positive
  direction     text not null check (direction in ('in','out','transfer')),
  cadence       text not null check (cadence in ('weekly','biweekly','semimonthly','monthly','yearly')),
  category_id   text,
  account_id    uuid references public.accounts(id) on delete set null,  -- source account
  to_account_id uuid references public.accounts(id) on delete set null,  -- destination (transfers only)
  owner         text,                                   -- "Gino" | "Xinyan" | "Shared"
  active        boolean not null default true,
  note          text,
  created_at    timestamptz not null default now()
);

-- 3. Link transactions to an account (for variable spend logged going forward)
alter table public.transactions
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

-- 4. Row-Level Security -------------------------------------------------------
alter table public.accounts  enable row level security;
alter table public.recurring enable row level security;

drop policy if exists "Household access" on public.accounts;
drop policy if exists "Household access" on public.recurring;

create policy "Household access" on public.accounts
  for all to authenticated using (true) with check (true);
create policy "Household access" on public.recurring
  for all to authenticated using (true) with check (true);

-- 5. Realtime -----------------------------------------------------------------
alter table public.accounts  replica identity full;
alter table public.recurring replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.accounts;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.recurring;
exception when duplicate_object then null; end $$;
