-- v25 — keep the bank's RAW descriptor next to the clean merchant name.
--
-- WHY: Plaid reports a tidy `merchant_name` and the importer stored only that.
-- It is lossy in a way that silently corrupts categories: the bank writes
-- "SAMSCLUB 4956 GAS 07/16" for the pump and "SAMS CLUB #4956" for the store, and
-- Plaid flattens BOTH to merchant "Sam's Club". The one token that says which
-- department the money went to was discarded before the categorizer ever ran, so
-- every warehouse-club charge became a coin flip between fuel and groceries.
--
-- Cost of that, measured: July 2026 showed $402 of "gas" against a real ~$259 —
-- $143 of grocery runs sitting in the fuel line — and the wrong figure was used to
-- re-cut the household budget before a statement review caught it.
--
-- Storing the raw descriptor also means the evidence lives in the app: a category
-- dispute is now answerable from the ledger instead of from a downloaded PDF.

alter table public.transactions
  add column if not exists raw_description text;

comment on column public.transactions.raw_description is
  'The untouched bank descriptor from the feed (Plaid `name`). `description` holds the clean merchant name for display; this holds what the bank actually wrote, which is the only place same-brand departments (a club''s pump vs its store) are distinguishable. NULL for manual rows.';

create or replace function public.apply_bank_sync(
  p_account_id uuid, p_provider text, p_reported_balance numeric,
  p_balance_date timestamptz, p_posted jsonb, p_reverse jsonb
) returns void language plpgsql as $function$
declare r jsonb; v_id text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_posted,'[]'::jsonb)) loop
    insert into public.transactions
      (date, amount, type, category_id, description, raw_description, account_id,
       provider, provider_txn_id, provider_account_id, status, needs_review, applies_to)
    values (
      (r->>'date')::date, (r->>'amount')::numeric, r->>'type',
      coalesce(r->>'category_id','other'), coalesce(r->>'description',''),
      r->>'raw_description', p_account_id,
      p_provider, r->>'provider_txn_id', r->>'provider_account_id', 'posted',
      coalesce((r->>'needs_review')::boolean,false), r->'applies_to'
    )
    on conflict (provider, provider_txn_id) where provider_txn_id is not null
    do update set
      date=excluded.date, amount=excluded.amount, type=excluded.type,
      description=excluded.description, status='posted',
      -- Backfill the raw descriptor onto rows imported before v25, but never blank
      -- an existing one if a later delivery happens to omit it.
      raw_description=coalesce(excluded.raw_description, public.transactions.raw_description),
      -- A category the USER picked is sacred. An AUTO one is only ever the
      -- classifier's best guess at import time, so let a re-sync improve it.
      category_id = case when public.transactions.user_categorized
                         then public.transactions.category_id
                         else excluded.category_id end,
      needs_review = case when public.transactions.user_categorized
                          then public.transactions.needs_review
                          else excluded.needs_review end,
      applies_to=coalesce(public.transactions.applies_to, excluded.applies_to);
  end loop;
  for v_id in select value from jsonb_array_elements_text(coalesce(p_reverse,'[]'::jsonb)) loop
    delete from public.transactions where provider=p_provider and provider_txn_id=v_id;
  end loop;
  if p_account_id is not null and p_reported_balance is not null then
    update public.accounts set balance=p_reported_balance, balance_synced_at=coalesce(p_balance_date,now())
      where id=p_account_id;
  end if;
end; $function$;
