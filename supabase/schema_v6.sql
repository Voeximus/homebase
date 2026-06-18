-- Homebase schema v6 — the shared food library for the Health-mode meal builder.
-- Foods Gino or Xinyan add (manually or via barcode scan) live here so they
-- sync across both phones. Same household-full RLS as the rest of the app.
-- Run this ONCE in the Supabase SQL editor.

create table if not exists public.foods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'other',
  kcal numeric not null default 0,
  p numeric not null default 0,
  c numeric not null default 0,
  f numeric not null default 0,
  serving numeric,
  note text,
  barcode text,
  created_at timestamptz not null default now()
);

alter table public.foods enable row level security;

-- Shared household: any signed-in user has full access (matches the app's model).
drop policy if exists "foods household full access" on public.foods;
create policy "foods household full access"
  on public.foods for all
  to authenticated
  using (true)
  with check (true);

-- Live sync to both devices (idempotent — safe to re-run).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'foods'
  ) then
    alter publication supabase_realtime add table public.foods;
  end if;
end $$;
