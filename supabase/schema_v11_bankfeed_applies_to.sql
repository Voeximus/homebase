-- schema_v11_bankfeed_applies_to.sql — let the bank-feed write path carry
-- applies_to, so a POSTED bill payment is recorded LINKED to its recurring row
-- (auto-marking it paid + logging the real amount, instead of being skipped).
-- Re-creates apply_bank_sync additively (same signature). SAFE TO RUN.
-- ---------------------------------------------------------------------------
create or replace function public.apply_bank_sync(
  p_account_id       uuid,
  p_provider         text,
  p_reported_balance numeric,
  p_balance_date     timestamptz,
  p_posted           jsonb,
  p_reverse          jsonb
) returns void
language plpgsql
security invoker
as $$
declare r jsonb; v_id text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_posted, '[]'::jsonb))
  loop
    insert into public.transactions
      (date, amount, type, category_id, description, account_id,
       provider, provider_txn_id, provider_account_id, status, needs_review, applies_to)
    values (
      (r->>'date')::date,
      (r->>'amount')::numeric,
      r->>'type',
      coalesce(r->>'category_id', 'other'),
      coalesce(r->>'description', ''),
      p_account_id, p_provider,
      r->>'provider_txn_id', r->>'provider_account_id',
      'posted',
      coalesce((r->>'needs_review')::boolean, false),
      r->'applies_to'                        -- jsonb or null: the bill link
    )
    on conflict (provider, provider_txn_id) where provider_txn_id is not null
    do update set
      date        = excluded.date,
      amount      = excluded.amount,         -- re-sync picks up a corrected amount
      type        = excluded.type,
      description = excluded.description,
      status      = 'posted',
      -- set the bill link if we now have one and the row didn't; never clobber a
      -- manual re-link back to null. category_id / needs_review stay (manual sticks).
      applies_to  = coalesce(public.transactions.applies_to, excluded.applies_to);
  end loop;

  for v_id in select value from jsonb_array_elements_text(coalesce(p_reverse, '[]'::jsonb))
  loop
    delete from public.transactions where provider = p_provider and provider_txn_id = v_id;
  end loop;

  if p_account_id is not null and p_reported_balance is not null then
    update public.accounts
      set balance = p_reported_balance, balance_synced_at = coalesce(p_balance_date, now())
      where id = p_account_id;
  end if;
end;
$$;

revoke all  on function public.apply_bank_sync(uuid, text, numeric, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_bank_sync(uuid, text, numeric, timestamptz, jsonb, jsonb)
  to service_role;
