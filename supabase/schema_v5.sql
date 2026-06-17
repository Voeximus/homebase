-- schema_v5.sql — the categorizer's memory.
-- One row per merchant the auto-categorizer has LEARNED from you. When the
-- importer is unsure, it asks you a one-tap question; your answer is saved here
-- and checked before the built-in dictionary, so it never asks twice.
-- Run once in the Supabase SQL editor.

create table if not exists public.merchant_rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,        -- normalized merchant key (see merchantKey)
  kind text not null,           -- 'variable' | 'skip' | 'bill'
  category_id text,             -- app category id, for kind 'variable'
  bill_name text,               -- recurring row name, for kind 'bill'
  created_at timestamptz not null default now()
);

-- One rule per merchant; re-answering updates it.
create unique index if not exists merchant_rules_pattern_key
  on public.merchant_rules (pattern);

alter table public.merchant_rules enable row level security;

-- Same shared-household policy as the rest of the app: any authenticated user
-- has full access (it's a two-person household).
drop policy if exists "household full access" on public.merchant_rules;
create policy "household full access" on public.merchant_rules
  for all to authenticated using (true) with check (true);

-- Live-sync across both devices.
alter publication supabase_realtime add table public.merchant_rules;
