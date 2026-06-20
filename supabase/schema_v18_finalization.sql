-- schema_v18_finalization.sql  —  Build-finalization DB changes (RUN ONCE)
-- ---------------------------------------------------------------------------
-- (1) Transaction splitting: allocate one charge across categories. The row's
--     amount + cash are unchanged; `splits` only re-buckets it for budgets.
-- (2) Fix: reverse_money_event now restores a BILL-linked debt too. Bill
--     payments stored applies_to WITHOUT a debtId (only the recurringId), so the
--     prior `applies_to ? 'debtId'` check never fired and deleting a paid bill
--     restored the debt in the UI but never in the DB. Going forward the client
--     also stamps debtId (so the first branch fires); this second branch covers
--     rows written before that, resolving the debt via the recurring's linked
--     card. Manual debts only (the forward path no-ops on auto-tracked debts),
--     and mutually exclusive with the debtId branch, so never a double-restore.
--
-- SAFE TO RUN: additive column + create-or-replace function. Re-running is a no-op.
-- ---------------------------------------------------------------------------

alter table public.transactions add column if not exists splits jsonb;

create or replace function public.reverse_money_event(p_txn_id uuid)
returns void
language plpgsql
security invoker
as $$
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

  if v.account_id is not null then
    update public.accounts
      set balance = balance - (case when v.type = 'income' then v.amount else -v.amount end)
      where id = v.account_id;
  end if;

  if v.applies_to ? 'debtId' then
    v_applied := coalesce((v.applies_to->>'appliedAmount')::numeric, v.amount);
    update public.debts set balance = balance + v_applied
      where id = (v.applies_to->>'debtId')::uuid;
  elsif v.applies_to->>'kind' = 'bill' and v.applies_to ? 'recurringId' then
    -- legacy bill rows (no stamped debtId): restore via the recurring's linked
    -- card. Manual debts only; mutually exclusive with the branch above.
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
$$;
