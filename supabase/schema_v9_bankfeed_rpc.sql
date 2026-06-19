-- schema_v9_bankfeed_rpc.sql — Bank-feed write path (RUN ONCE in the SQL editor)
-- ---------------------------------------------------------------------------
-- Two service-role-only functions the Edge Function calls. They are NOT
-- callable by the browser (anon/authenticated), so the bank token and the
-- balance-write path are sealed server-side.
--
--   store_connection  — stash the Plaid access_token in Vault + open a
--                       bank_connections row. Returns the connection id.
--   apply_bank_sync   — atomically upsert one account's POSTED feed rows
--                       (idempotent on provider+provider_txn_id), delete any
--                       reversed rows, then set that account's balance to the
--                       bank-reported number ("bank = truth"). Pending rows are
--                       handled separately by the function (display-only).
--
-- SAFE TO RUN: only creates functions; changes no data; re-running is a no-op.
-- ---------------------------------------------------------------------------

create or replace function public.store_connection(
  p_owner        text,
  p_provider     text,
  p_institution  text,
  p_item_id      text,
  p_access_token text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_conn_id uuid := gen_random_uuid();
  v_name    text := 'plaid_token_' || replace(v_conn_id::text, '-', '');
begin
  perform vault.create_secret(p_access_token, v_name,
            'Plaid access_token for connection ' || v_conn_id);

  insert into public.bank_connections
    (id, owner, provider, institution, item_id, vault_secret_name, status)
  values
    (v_conn_id, p_owner, p_provider, p_institution, p_item_id, v_name, 'ok');

  return v_conn_id;
end;
$$;

revoke all  on function public.store_connection(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.store_connection(text, text, text, text, text)
  to service_role;


create or replace function public.apply_bank_sync(
  p_account_id       uuid,
  p_provider         text,
  p_reported_balance numeric,
  p_balance_date     timestamptz,
  p_posted           jsonb,   -- [{provider_txn_id, provider_account_id, date, amount(+), type, category_id, description, needs_review}]
  p_reverse          jsonb    -- ["provider_txn_id", ...]
) returns void
language plpgsql
security invoker
as $$
declare
  r     jsonb;
  v_id  text;
begin
  -- Upsert posted rows. Record-only (no balance delta) — the balance is set
  -- below from the bank's own number, so transactions can never drift it.
  for r in select value from jsonb_array_elements(coalesce(p_posted, '[]'::jsonb))
  loop
    insert into public.transactions
      (date, amount, type, category_id, description, account_id,
       provider, provider_txn_id, provider_account_id, status, needs_review)
    values (
      (r->>'date')::date,
      (r->>'amount')::numeric,
      r->>'type',
      coalesce(r->>'category_id', 'other'),
      coalesce(r->>'description', ''),
      p_account_id,
      p_provider,
      r->>'provider_txn_id',
      r->>'provider_account_id',
      'posted',
      coalesce((r->>'needs_review')::boolean, false)
    )
    on conflict (provider, provider_txn_id) where provider_txn_id is not null
    do update set
      date        = excluded.date,
      amount      = excluded.amount,
      type        = excluded.type,
      description = excluded.description,
      status      = 'posted';
      -- category_id / needs_review intentionally preserved on update, so a
      -- manual re-categorization sticks across re-syncs.
  end loop;

  -- Remove reversed / cancelled feed rows (record-only → plain delete).
  for v_id in select value from jsonb_array_elements_text(coalesce(p_reverse, '[]'::jsonb))
  loop
    delete from public.transactions
      where provider = p_provider and provider_txn_id = v_id;
  end loop;

  -- Bank = truth: overwrite the account balance with the reported number.
  if p_account_id is not null and p_reported_balance is not null then
    update public.accounts
      set balance = p_reported_balance,
          balance_synced_at = coalesce(p_balance_date, now())
      where id = p_account_id;
  end if;
end;
$$;

revoke all  on function public.apply_bank_sync(uuid, text, numeric, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_bank_sync(uuid, text, numeric, timestamptz, jsonb, jsonb)
  to service_role;
