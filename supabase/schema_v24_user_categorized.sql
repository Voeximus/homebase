-- v24 — let a re-sync HEAL an auto-categorization, without ever clobbering a manual one.
--
-- WHY: apply_bank_sync's ON CONFLICT refreshed date/amount/type/description but
-- never category_id or needs_review. Since Plaid's cursor delivers each txn once,
-- the category assigned on that first delivery was frozen forever — so fixing a
-- bad merchant rule healed nothing already imported. Live example: the AMAZON rule
-- was repointed electronics -> shopping, yet every Amazon row imported under the old
-- rule kept `electronics`, and Gino's 189-row review queue could never drain by
-- re-syncing.
--
-- The fix needs to distinguish "the app guessed this" from "Gino decided this".
-- user_categorized marks the latter: set by setTransactionCategory / the split
-- editor / the one-tap clarify UI. On conflict we refresh the category ONLY when
-- it's false, so improved rules propagate to old rows while every manual call
-- survives untouched.

alter table public.transactions
  add column if not exists user_categorized boolean not null default false;

comment on column public.transactions.user_categorized is
  'TRUE when a human chose this category (recategorize / split / clarify). apply_bank_sync will not overwrite it on re-sync; FALSE rows are re-classified so a fixed rule can heal them.';

create or replace function public.apply_bank_sync(
  p_account_id uuid, p_provider text, p_reported_balance numeric,
  p_balance_date timestamptz, p_posted jsonb, p_reverse jsonb
) returns void language plpgsql as $function$
declare r jsonb; v_id text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_posted,'[]'::jsonb)) loop
    insert into public.transactions
      (date, amount, type, category_id, description, account_id,
       provider, provider_txn_id, provider_account_id, status, needs_review, applies_to)
    values (
      (r->>'date')::date, (r->>'amount')::numeric, r->>'type',
      coalesce(r->>'category_id','other'), coalesce(r->>'description',''), p_account_id,
      p_provider, r->>'provider_txn_id', r->>'provider_account_id', 'posted',
      coalesce((r->>'needs_review')::boolean,false), r->'applies_to'
    )
    on conflict (provider, provider_txn_id) where provider_txn_id is not null
    do update set
      date=excluded.date, amount=excluded.amount, type=excluded.type,
      description=excluded.description, status='posted',
      -- A category the USER picked is sacred. An AUTO one is only ever the
      -- classifier's best guess at import time, so let a re-sync improve it —
      -- otherwise a repointed rule can never fix the rows it already mislabelled.
      category_id = case when public.transactions.user_categorized
                         then public.transactions.category_id
                         else excluded.category_id end,
      needs_review = case when public.transactions.user_categorized
                          then public.transactions.needs_review
                          else excluded.needs_review end,
      -- applies_to stays coalesce-preserved on purpose: it carries settled bill and
      -- debt links, and re-deriving those on every sync risks un-settling a bill.
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
