-- schema_v7_rpc.sql  —  Atomic money engine (RUN ONCE in the Supabase SQL editor)
-- ---------------------------------------------------------------------------
-- Why: today the client inserts the ledger row and then updates cash / debt /
-- goal in separate calls, writing ABSOLUTE balances computed from a local
-- snapshot. Two failure modes:
--   (1) a failure after the insert leaves a ledger row whose money never moved
--       (drift from the bank, non-reversible);
--   (2) two phones writing the same row inside the sub-second pre-refetch
--       window silently overwrite each other (lost update).
--
-- These two functions fix both: each runs inside a single implicit transaction
-- (all four writes commit or roll back together) and moves balances with an
-- in-row DELTA (balance = balance + x) so concurrent edits COMPOSE.
--
-- SAFE TO RUN: this only creates functions; it changes no data. After running
-- it, the app keeps working unchanged until the client is switched to call
-- these (a small follow-up). Re-running it is a no-op (create or replace).
-- ---------------------------------------------------------------------------

-- Apply one money event atomically. Returns the inserted ledger row.
-- p_debt_id / p_goal_id are the already-resolved targets (the client resolves a
-- bill's linked card before calling). The debt paydown is clamped to what is
-- actually owed and the applied amount is stamped onto the row for exact reversal.
create or replace function public.apply_money_event(
  p_date         date,
  p_amount       numeric,
  p_type         text,        -- 'income' | 'expense'
  p_category_id  text,
  p_description  text,
  p_account_id   uuid    default null,
  p_debt_id      uuid    default null,
  p_goal_id      uuid    default null,
  p_applies_to   jsonb   default null
) returns public.transactions
language plpgsql
security invoker
as $$
declare
  v_applied numeric := 0;
  v_applies jsonb   := p_applies_to;
  v_row     public.transactions;
begin
  -- Clamp the debt paydown to the live balance, atomically (row-locked).
  if p_debt_id is not null then
    select least(p_amount, balance) into v_applied
      from public.debts where id = p_debt_id for update;
    v_applied := coalesce(v_applied, 0);
    v_applies := coalesce(v_applies, '{}'::jsonb)
                 || jsonb_build_object('appliedAmount', v_applied);
  end if;

  insert into public.transactions
    (date, amount, type, category_id, description, account_id, applies_to)
  values
    (p_date, p_amount, p_type, p_category_id, p_description, p_account_id, v_applies)
  returning * into v_row;

  if p_account_id is not null then
    update public.accounts
      set balance = balance + (case when p_type = 'income' then p_amount else -p_amount end)
      where id = p_account_id;
  end if;

  if p_debt_id is not null then
    update public.debts
      set balance = greatest(0, balance - v_applied)
      where id = p_debt_id;
  end if;

  if p_goal_id is not null then
    update public.savings_goals
      set saved = saved + p_amount
      where id = p_goal_id;
  end if;

  return v_row;
end;
$$;

-- Reverse one money event atomically (delete the row AND undo its fan-out),
-- using the stamped appliedAmount so a payment that cleared a debt adds back
-- exactly what it removed. Settled / imported rows moved no money → just delete.
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
  end if;

  if v.applies_to ? 'goalId' then
    update public.savings_goals set saved = greatest(0, saved - v.amount)
      where id = (v.applies_to->>'goalId')::uuid;
  end if;

  delete from public.transactions where id = p_txn_id;
end;
$$;
