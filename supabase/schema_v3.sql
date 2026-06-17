-- schema_v3.sql — synced "paid" state for the bill calendar.
-- Run this once in the Supabase SQL editor (like you did schema_v2.sql).
--
-- Stores only OVERRIDES: a row exists when the paid-state differs from the
-- auto-by-date default (e.g. a bill paid early, or a transfer not sent yet).
-- bill_key is "<label>@<day-of-month>", month is "YYYY-MM".

create table if not exists public.paid_bills (
  id uuid primary key default gen_random_uuid(),
  month text not null,
  bill_key text not null,
  paid boolean not null default true,
  created_at timestamptz not null default now(),
  unique (month, bill_key)
);

alter table public.paid_bills enable row level security;

-- Shared household: any authenticated user has full access.
drop policy if exists "Household access" on public.paid_bills;
create policy "Household access" on public.paid_bills
  for all to authenticated using (true) with check (true);

-- Live sync.
alter publication supabase_realtime add table public.paid_bills;
