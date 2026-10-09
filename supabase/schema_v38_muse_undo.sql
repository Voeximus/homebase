-- schema_v38_muse_undo.sql  —  2026-09-26  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- The safety net that lets the write door stop asking.
--
-- WHAT CHANGED, AND WHY IT IS SAFE
--   Phase 1 split the writes two ways: three landed straight away, four only
--   ASKED — they wrote a row into muse_pending and waited for a tap in the app.
--   Two things then became clear:
--
--     1. Nothing in the app reads muse_pending. `grep -rn "muse_pending" src/`
--        returns nothing, so a queued write sat there until cron-reminders marked
--        it expired. The four "safer" tools were the four that did nothing.
--     2. Homebase never moves money. It records, categorises and computes. The
--        worst a wrong write can do is make DATA wrong — and wrong data can be
--        put back, as long as the change was written down before it happened.
--
--   So the rule flipped: expose everything, and make every change reversible.
--   This table is the "written down before it happened" half. Every write records
--   the state it is about to replace, as a small list of inverse steps, and hands
--   back a token. "Undo that" is then one tool call, and "what did you change"
--   reads this table.
--
-- WHAT IS STILL GATED, AND IS NOT IN THIS FILE
--   Anything that hard-deletes beyond recovery. A Plaid disconnect wipes the
--   accounts and their whole transaction history (see the `disconnect` action in
--   supabase/functions/_shared/callerAuth.ts), and no row in this table could put
--   that back — real bank history is the one thing the app cannot rebuild. That
--   takes a code he types, not a chat message.
--
-- WHY THE STEPS ARE DATA AND NOT SQL
--   `steps` is a short list of named operations — set these columns back, delete
--   the row we inserted, run the app's own reverse RPC. It is deliberately NOT a
--   SQL string: a table holding SQL that a door later executes is a door with an
--   arbitrary-write verb in it, and the whole design of this bridge is that the
--   set of things it can do is a list you can read in one sitting. The door
--   validates every step against an allowlist of tables AND of columns before it
--   runs one (supabase/functions/_shared/muse/undo.ts), so a step naming a column
--   no tool writes is refused even if it somehow got into this table.
--
-- THE LOCKS ARE THE POINT — same rule as v36. A new table in `public` starts with
-- every privilege granted to anon and authenticated, and the publishable key is
-- served to the whole internet inside the browser bundle on purpose. An undo log
-- a stranger can write is worse than no undo log: it is a list of statements the
-- door will run on request.
-- ---------------------------------------------------------------------------

-- ── 1. the undo log, which is also the change log ────────────────────────────
create table if not exists public.muse_undo (
  -- Short, lowercase, and sayable out loud, because he may read it back in a
  -- chat: "undo u-4k7m9qt2". Minted by the door, not by the database, so the
  -- token is known before the write is attempted and can go in the reply even if
  -- the reply is all he keeps.
  token      text primary key check (token ~ '^u-[0-9a-hjkmnp-tv-z]{8}$'),
  at         timestamptz not null default now(),
  person     text not null check (person in ('gino','xinyan')),
  tool       text not null,
  -- The sentence the door said when it made the change. Already scrubbed and
  -- capped by the door. This is what "what did you change" reads back, so it has
  -- to be the same words he was told at the time — not a re-wording.
  summary    text not null check (char_length(summary) between 1 and 300),
  -- The ordered inverse. Ordered because three of the writes touch more than one
  -- row (settling a reimbursable touches two; promoting a charge to a bill
  -- touches three), and putting those back in the wrong order leaves a half
  -- state. Applied in the order stored.
  steps      jsonb not null,
  -- FOUR STATES, and the reason is the same one v36 gives for muse_audit carrying
  -- 'pending': the row is written BEFORE the change is attempted, because a row
  -- that only appeared afterwards would leave a change nobody can account for if
  -- the door died between the write and the log.
  --
  --   pending    written, the change is being attempted. If a row sits here, the
  --              door stopped mid-call and NOBODY KNOWS whether it landed. That is
  --              the honest report, and it is what handler.ts already says about a
  --              crashed write: "we cannot prove nothing happened." Since 2026-10-09
  --              it is also where a write that FAILED stays, unless the door can show
  --              nothing landed (next line): a fetch that died after the commit, a
  --              refusal on the second row of a two-row write, or a refusal after the
  --              tool had already inserted its new row.
  --   undoable   the change landed. This is what system.undo will act on.
  --   abandoned  the change was refused before anything was written — usually
  --              because the row had moved since it was read. Nothing happened.
  --              Since 2026-10-09, also: Postgres refused the write's statement with
  --              a code that proves it rolled back, nothing had been inserted first,
  --              and no earlier statement in the same write had changed a row.
  --              commit() in supabase/functions/muse-write/toolsFinance.ts holds the
  --              rule and the 2026-09-27 json failure that prompted it. (Comment only:
  --              the column and its check are unchanged.)
  --   undone     it landed and has since been put back.
  --
  -- The alternative was to write the row afterwards and delete it on failure, which
  -- needs a delete verb on the log. An audit trail you can delete from looks like
  -- accountability and is not — v36 makes that argument about muse_audit and it is
  -- the same argument here.
  state      text not null default 'pending'
             check (state in ('pending','undoable','abandoned','undone')),
  undone_at  timestamptz,
  -- Undoing is itself a change, and it gets its own row so the log reads as a
  -- history rather than as a set of flags. This points at the row that undid this
  -- one, so "what happened to that" has an answer.
  undone_by  text
);

-- What "undo that" asks for: this person's newest undoable change. And what
-- "what did you change" asks for: this person's newest changes, in order.
create index if not exists muse_undo_recent on public.muse_undo (person, at desc);

-- ── 2. putting a deleted charge back, exactly ────────────────────────────────
-- The one inverse that needed new SQL.
--
-- Every other write this door makes is an UPDATE, so its inverse is an UPDATE
-- back. Deleting a charge is not: the app deletes through reverse_money_event
-- (schema_v7_rpc.sql, fixed in schema_v28_record_only.sql), which removes the row
-- AND undoes its fan-out — the cash it moved, the debt it paid down by the exact
-- stamped `appliedAmount`, the goal it fed. Putting that back means re-inserting
-- the row under its ORIGINAL id and redoing all three, in one transaction.
--
-- This is written as the mirror image of reverse_money_event, branch for branch,
-- so the two can be read side by side. Every gate there has its twin here:
--   · a settled marker moved no money, so it is re-inserted and nothing else;
--   · cash is re-debited only for a row that actually moved cash — not a bank-feed
--     row (the balance comes from the bank's own number) and not an imported
--     record of history already inside the anchored balance;
--   · the debt comes down by the stamped appliedAmount, not by the full charge,
--     because a payment that cleared a debt came off by less than its face value;
--   · the legacy bill-payment branch (a row written before debtId was stamped)
--     mirrors the `elsif` there, so it can never double-apply with the branch above.
--
-- The id is preserved on purpose. The undo row's other steps may name that id, and
-- an undo that put the row back under a new id would leave them pointing at
-- nothing — and the assistant would go on quoting an id that no longer exists.
-- It returns NULL when a row with that id is ALREADY there, and does nothing else.
-- Restoring twice would insert nothing (the primary key refuses it) but would move
-- cash, a debt and a goal a second time if it were written any other way, so the
-- existence check is the guard and the NULL is how the door hears about it: it says
-- "that charge is already back" rather than raising a 500 the assistant cannot
-- explain.
create or replace function public.restore_money_event(p_row jsonb)
returns public.transactions
language plpgsql
as $function$
declare
  v_row     public.transactions;
  v_applied numeric;
begin
  if exists (select 1 from public.transactions where id = (p_row->>'id')::uuid) then
    return null;
  end if;

  insert into public.transactions
    (id, date, amount, type, category_id, description, account_id, applies_to,
     splits, anomaly_ack, user_categorized, needs_review, record_only, created_at, person)
  values (
    (p_row->>'id')::uuid,
    (p_row->>'date')::date,
    (p_row->>'amount')::numeric,
    p_row->>'type',
    p_row->>'category_id',
    coalesce(p_row->>'description', ''),
    nullif(p_row->>'account_id', '')::uuid,
    -- nullif against jsonb 'null': a JSON null stored in this column is NOT the
    -- same as SQL NULL to the budget partition, which gates on `!appliesTo`.
    nullif(p_row->'applies_to', 'null'::jsonb),
    nullif(p_row->'splits', 'null'::jsonb),
    coalesce((p_row->>'anomaly_ack')::boolean, false),
    coalesce((p_row->>'user_categorized')::boolean, false),
    coalesce((p_row->>'needs_review')::boolean, false),
    coalesce((p_row->>'record_only')::boolean, false),
    coalesce((p_row->>'created_at')::timestamptz, now()),
    nullif(p_row->>'person', '')
  )
  returning * into v_row;

  -- A settled marker records paid-state and moved nothing. Mirrors the
  -- short-circuit at the top of reverse_money_event.
  if coalesce((v_row.applies_to->>'settled')::boolean, false) then
    return v_row;
  end if;

  if v_row.account_id is not null
     and v_row.provider is null
     and not coalesce(v_row.record_only, false) then
    update public.accounts
      set balance = balance + (case when v_row.type = 'income' then v_row.amount else -v_row.amount end)
      where id = v_row.account_id;
  end if;

  if v_row.applies_to ? 'debtId' then
    v_applied := coalesce((v_row.applies_to->>'appliedAmount')::numeric, v_row.amount);
    update public.debts set balance = greatest(0, balance - v_applied)
      where id = (v_row.applies_to->>'debtId')::uuid;
  elsif v_row.applies_to->>'kind' = 'bill' and v_row.applies_to ? 'recurringId' then
    v_applied := coalesce((v_row.applies_to->>'appliedAmount')::numeric, v_row.amount);
    update public.debts d
      set balance = greatest(0, balance - v_applied)
      from public.recurring r
      where r.id = (v_row.applies_to->>'recurringId')::uuid
        and r.linked_debt_id is not null
        and d.id = r.linked_debt_id
        and d.provider_account_id is null
        and d.track_pattern is null;
  end if;

  if v_row.applies_to ? 'goalId' then
    update public.savings_goals set saved = saved + v_row.amount
      where id = (v_row.applies_to->>'goalId')::uuid;
  end if;

  return v_row;
end;
$function$;

comment on function public.restore_money_event(jsonb) is
  'Put a deleted charge back under its original id and redo its fan-out. The exact '
  'mirror of reverse_money_event, branch for branch. Called only by the Muse write '
  'door''s undo, from a row the door itself captured before deleting.';

-- ── 3. the one write that cannot be undone from a snapshot ───────────────────
-- Named here so the absence is deliberate rather than discovered. `accounts.balance`
-- is the bank-truth anchor every other number is derived from, and a Plaid sync
-- re-anchors it from the bank's own figure. So an undo of a hand-set balance holds
-- only until the next sync, and the door says so in the reply rather than promising
-- an exactness it does not have. Nothing in this file can change that; it is a fact
-- about where the number comes from.

-- ── 4. the locks ────────────────────────────────────────────────────────────
alter table public.muse_undo enable row level security;
revoke all on public.muse_undo from anon, authenticated;

-- The app's settings screen shows the change log beside the call log, read-only.
-- Only the door writes here, and only the door undoes.
grant select on public.muse_undo to authenticated;
drop policy if exists "muse_undo read" on public.muse_undo;
create policy "muse_undo read" on public.muse_undo
  for select to authenticated using (true);

-- A function in `public` is executable by everyone unless you say otherwise, and
-- this one inserts a ledger row and moves cash, a debt and a goal.
revoke all on function public.restore_money_event(jsonb) from public, anon, authenticated;
grant execute on function public.restore_money_event(jsonb) to service_role;

-- ── 5. housekeeping, by hand ────────────────────────────────────────────────
-- Not scheduled, for the same reason as v36's: an unattended delete is exactly
-- what this project keeps out of its cron jobs. An undone row is history and worth
-- keeping; a very old undoable one is only worth keeping while he might still want
-- it back.
--
--   delete from public.muse_undo where at < now() - interval '180 days';
