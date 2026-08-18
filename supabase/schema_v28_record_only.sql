-- schema_v28_record_only.sql
--
-- Stop deleting a record-only transaction from CREDITING the account balance.
--
-- THE BUG. reverse_money_event reversed cash for ANY row carrying an account_id,
-- gated only on applies_to.settled. But two of the three insert paths write
-- account_id while deliberately moving NO cash:
--
--   * apply_bank_sync — every posted feed row gets account_id, and the balance is
--     set separately from the bank's own number precisely so per-row inserts can
--     never drift it ("Record-only (no balance delta)", schema_v9_bankfeed_rpc.sql).
--   * commitImport — statement-import rows are history already inside the anchored
--     balance ("Imported rows are records only; no balance moves.",
--     FinanceStore.tsx). Its VARIABLE rows carry no applies_to at all, so they were
--     neither `settled` nor account-less, and fell straight through the gate.
--
-- Deleting one of those rows therefore moved money that never moved. Concretely:
-- Geo anchored at $1,240.00, a $63.41 imported dining charge deleted as a
-- duplicate → `balance = balance - (-63.41)` → $1,303.41. Cash reads $63.41 above
-- the bank, permanently for a non-connected account, and until the next sync
-- re-anchors it for a connected one — wrong on screen rather than merely absent.
--
-- THE FIX, in two additive parts:
--
-- 1. `and v.provider is null` on the cash branch. Every bank-feed row is excluded
--    outright. No schema change, no backfill, and it closes the entire feed half.
--
-- 2. A `record_only` column, defaulting FALSE. commitImport stamps it true on the
--    rows it writes as history. Default false is deliberate: it leaves every
--    pre-existing row behaving exactly as it does today.
--
-- WHY NOT A `moved_cash` FLAG defaulting false, as first proposed: the rows with
-- provider IS NULL + account_id + applies_to IS NULL come from BOTH commitImport
-- (record-only) and addTransaction / apply_money_event (genuine cash movers), and
-- nothing stored distinguishes them. Defaulting such a flag to false would stop
-- deleting a REAL manual expense from restoring cash — the same class of wrong
-- number in the opposite direction, applied to all history.
--
-- WHY NOT stamp applies_to = {"recordOnly": true} instead of a column: the budget
-- partition (spentByCategoryBetween) gates on `!t.appliesTo`, so giving these rows
-- an applies_to would silently drop every imported charge out of the variable
-- budget. A separate column keeps the budget untouched.
--
-- KNOWN RESIDUAL, deliberately accepted: imported rows written BEFORE this
-- migration have record_only = false and can still mis-reverse. There is no way to
-- identify them after the fact. New imports are correct from here.

alter table public.transactions
  add column if not exists record_only boolean not null default false;

comment on column public.transactions.record_only is
  'True when this row is a RECORD of money that moved outside the app (a statement '
  'import, history already inside the anchored balance). Its account_id is carried '
  'for display and per-person activity only. reverse_money_event must not restore '
  'cash for it. Bank-feed rows are excluded separately, by provider is not null.';

create or replace function public.reverse_money_event(p_txn_id uuid)
returns void
language plpgsql
as $function$
declare
  v         public.transactions;
  v_applied numeric;
begin
  select * into v from public.transactions where id = p_txn_id for update;
  if not found then return; end if;

  if coalesce((v.applies_to->>'settled')::boolean, false) then
    delete from public.transactions where id = p_txn_id;
    return;
  end if;

  -- Restore cash ONLY for a row that actually moved cash. A bank-feed row never
  -- does (the balance comes from the bank's own number), and neither does an
  -- imported record of history that was already inside the anchored balance.
  -- Reversing either one credits money that never left.
  if v.account_id is not null
     and v.provider is null
     and not coalesce(v.record_only, false) then
    update public.accounts
      set balance = balance - (case when v.type = 'income' then v.amount else -v.amount end)
      where id = v.account_id;
  end if;

  if v.applies_to ? 'debtId' then
    v_applied := coalesce((v.applies_to->>'appliedAmount')::numeric, v.amount);
    update public.debts set balance = balance + v_applied
      where id = (v.applies_to->>'debtId')::uuid;
  elsif v.applies_to->>'kind' = 'bill' and v.applies_to ? 'recurringId' then
    -- Bill payments written before debtId was stamped on applies_to: restore the
    -- debt the bill paid via the recurring's linked card. Manual debts only (the
    -- forward path no-ops on auto-tracked debts). Mutually exclusive with the
    -- debtId branch above, so never a double-restore.
    v_applied := coalesce((v.applies_to->>'appliedAmount')::numeric, v.amount);
    update public.debts d
      set balance = balance + v_applied
      from public.recurring r
      where r.id = (v.applies_to->>'recurringId')::uuid
        and r.linked_debt_id is not null
        and d.id = r.linked_debt_id
        and d.provider_account_id is null
        and d.track_pattern is null;
  end if;

  if v.applies_to ? 'goalId' then
    update public.savings_goals set saved = greatest(0, saved - v.amount)
      where id = (v.applies_to->>'goalId')::uuid;
  end if;

  delete from public.transactions where id = p_txn_id;
end;
$function$;
