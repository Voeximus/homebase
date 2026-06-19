-- schema_v12_card_debt.sql
-- Link a connected credit-card account to a debt so the bank feed keeps the
-- debt's balance in lockstep with what's actually owed on the card.
--
-- "Bank = truth": every sync SETS (never decrements) the debt balance to the
-- card's current balance. That means optimistic in-app payments (a card-payment
-- bill, an extra snowball payment) reconcile to the bank automatically on the
-- next sync — no drift, no double-counting. original_balance is preserved, so
-- payoff progress keeps its history.

-- 1. The link: a debt may point at exactly one Plaid credit account.
alter table public.debts
  add column if not exists provider_account_id text;

create index if not exists debts_provider_account_id_idx
  on public.debts (provider_account_id);

-- 2. Mirror an account's balance onto any debt linked to it. Floors at 0 (an
--    over-paid card reads as a negative balance = a credit, not a debt).
create or replace function public.sync_debt_from_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.provider_account_id is not null then
    update public.debts
      set balance = greatest(new.balance, 0)
      where provider_account_id = new.provider_account_id
        and balance is distinct from greatest(new.balance, 0);
  end if;
  return new;
end;
$$;

-- 3. Fire it whenever a connected account's balance lands (insert or change).
drop trigger if exists trg_sync_debt_from_account on public.accounts;
create trigger trg_sync_debt_from_account
  after insert or update of balance on public.accounts
  for each row
  execute function public.sync_debt_from_account();
