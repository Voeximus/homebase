-- schema_v8_bankfeed.sql  —  Live bank-feed foundation (RUN ONCE in the SQL editor)
-- ---------------------------------------------------------------------------
-- Why: this adds the structure a read-only Plaid feed needs, WITHOUT touching
-- the existing money engine. The model is "bank = truth": a connected account's
-- balance is overwritten by what the bank reports each sync, and transactions
-- become history + budget fuel rather than balance-movers — so drift becomes
-- structurally impossible. Debts and the snowball plan are untouched (manual).
--
-- The one secret that must never leak — the Plaid access_token — is NOT stored
-- in any of these tables. It lives in Supabase Vault and is readable only by a
-- service-role-only function. Everything here is safe under the existing
-- "authenticated users see everything" RLS because it holds no secret.
--
-- SAFE TO RUN: additive only (add column if not exists / create table if not
-- exists / create or replace). It changes no existing data and the app keeps
-- working unchanged until the feed is wired in. Re-running it is a no-op.
--
-- NOTE: Supabase Vault is enabled by default. If the get_connection_token
-- function errors with 'schema "vault" does not exist', enable it once under
-- Database → Extensions → search "vault".
-- ---------------------------------------------------------------------------

-- 1) transactions: provenance + idempotency -------------------------------------
alter table public.transactions add column if not exists provider            text;
alter table public.transactions add column if not exists provider_txn_id     text;
alter table public.transactions add column if not exists provider_account_id text;
alter table public.transactions add column if not exists status              text not null default 'posted'; -- 'posted' | 'pending'
alter table public.transactions add column if not exists needs_review        boolean not null default false; -- low-confidence auto-category → batch confirm

-- One physical bank transaction is inserted exactly once. The partial index
-- only constrains rows that came from a provider, leaving hand-entered rows free.
create unique index if not exists uq_txn_provider
  on public.transactions (provider, provider_txn_id)
  where provider_txn_id is not null;

-- 2) accounts: map to a connection + carry the bank's reported balance ----------
alter table public.accounts add column if not exists connection_id       uuid;
alter table public.accounts add column if not exists provider_account_id text;
alter table public.accounts add column if not exists balance_synced_at   timestamptz; -- when 'balance' was last written from the bank (drives the "as of" label)

-- 3) bank_connections: one row per linked bank login (NO secret stored) ---------
create table if not exists public.bank_connections (
  id                   uuid primary key default gen_random_uuid(),
  owner                text not null,                 -- 'Gino' | 'Xinyan' | 'Joint'
  provider             text not null default 'plaid',
  institution          text,                          -- 'Bank of America'
  item_id              text,                          -- Plaid item_id (non-secret)
  vault_secret_name    text,                          -- NAME of the Vault secret holding the access_token (not the token)
  cursor               text,                          -- Plaid /transactions/sync next_cursor
  status               text not null default 'ok',    -- 'ok' | 'stale' | 'needs_reauth' | 'error'
  last_sync_at         timestamptz,
  last_error           text,
  consecutive_failures int  not null default 0,
  created_at           timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_connection_fk') then
    alter table public.accounts
      add constraint accounts_connection_fk
      foreign key (connection_id) references public.bank_connections(id) on delete set null;
  end if;
end $$;

alter table public.bank_connections enable row level security;
drop policy if exists "Household access" on public.bank_connections;
create policy "Household access" on public.bank_connections
  for all to authenticated using (true) with check (true);
alter table public.bank_connections replica identity full;

-- 4) pending_preview: display-only in-flight charges (maintained each sync) ------
-- Pending charges NEVER hit the ledger (that is what prevents double-counting).
-- They live here purely to show "in-flight" under an account, and are upserted /
-- removed by the sync as charges appear and then post.
create table if not exists public.pending_preview (
  id                   uuid primary key default gen_random_uuid(),
  connection_id        uuid references public.bank_connections(id) on delete cascade,
  account_id           uuid references public.accounts(id) on delete cascade,
  provider             text not null default 'plaid',
  provider_txn_id      text not null,
  provider_account_id  text,
  date                 date,
  amount               numeric(12,2),                 -- signed: negative = spend
  description          text,
  category_id          text,
  owner                text,
  created_at           timestamptz not null default now(),
  unique (provider, provider_txn_id)
);

alter table public.pending_preview enable row level security;
drop policy if exists "Household access" on public.pending_preview;
create policy "Household access" on public.pending_preview
  for all to authenticated using (true) with check (true);
alter table public.pending_preview replica identity full;

-- 5) get_connection_token: the ONLY way to read a stored bank token -------------
-- SECURITY DEFINER + granted to service_role only, so the React client (anon /
-- authenticated) literally cannot decrypt the Vault secret. Edge Functions call
-- this with the service-role key; nobody else can.
create or replace function public.get_connection_token(p_conn_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_name   text;
  v_secret text;
begin
  select vault_secret_name into v_name
    from public.bank_connections where id = p_conn_id;
  if v_name is null then return null; end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = v_name;
  return v_secret;
end;
$$;

revoke all  on function public.get_connection_token(uuid) from public, anon, authenticated;
grant execute on function public.get_connection_token(uuid) to service_role;

-- 6) realtime: both phones see connection health + pending changes live ---------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'bank_connections') then
    alter publication supabase_realtime add table public.bank_connections;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'pending_preview') then
    alter publication supabase_realtime add table public.pending_preview;
  end if;
end $$;
