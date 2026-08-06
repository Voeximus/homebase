-- v26 — a GUESS may seed a row, but it must never re-decide one.
--
-- WHY. v24 made a re-sync able to heal auto-categories: if the row wasn't
-- user_categorized, the importer's latest answer wins. That is right when the
-- importer HAS an answer. It is wrong when the importer has explicitly said it
-- does not know.
--
-- The case that proved it: a warehouse club runs a fuel station and a store under
-- one merchant name. The bank sometimes tags the pump ("SAMSCLUB 4956 GAS") and
-- sometimes doesn't — the descriptor truncates at ~28 chars, so "SAMS CLUB #495"
-- may simply have lost the token. Measured against Gino's own hand-labels, four
-- token-less charges were fuel and three were the store: absence of the token
-- carries no information. The categorizer correctly reports "ambiguous" there.
--
-- But it still has to put SOMETHING in category_id, and under v24 that placeholder
-- was treated as a finding. One cursor-reset re-pull re-decided 12 such rows at
-- once and moved $702.57 — ten of them into fuel — overwriting categories that had
-- been right. Precisely the corruption v25 was written to end, arriving through
-- the healing path instead of the import path.
--
-- So `keep_category` lets the importer say "seed this if it's new, but if a row
-- already exists leave its category alone and just flag it for a one-tap answer."
-- INSERT still takes the pre-fill (a new row has nothing to preserve).

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
      -- classifier's best guess at import time, so let a re-sync improve it —
      -- UNLESS the classifier flagged that it cannot tell (keep_category), in
      -- which case there is nothing to improve it WITH and overwriting would
      -- destroy a good answer with a coin flip.
      category_id = case when public.transactions.user_categorized
                          or coalesce((r->>'keep_category')::boolean, false)
                         then public.transactions.category_id
                         else excluded.category_id end,
      -- needs_review still updates: an ambiguous row SHOULD start asking again.
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
