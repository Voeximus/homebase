-- schema_v45_cycle_budgets.sql  —  2026-10-10  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: a budget goal for ONE pay cycle, one row per budget line.
--
-- THE GAP
--   Every budget target in the app is a constant in src/lib/plan.ts (LEAN_VARIABLE): a
--   monthly figure per line, halved for each pay cycle. That is the standard budget, and
--   it is the right default. What it cannot do is the conversation the household has
--   before a paycheck — "this cycle we hold groceries here, aim lower on dining, nothing
--   for the dog" — because changing the constant changes every cycle for ever, through a
--   commit, in a public repository where a household's real figures must never appear.
--   Neither phone and neither assistant had anywhere to put a goal for one cycle.
--
-- WHAT A ROW MEANS
--   One line's target for the pay cycle that opens on `cycle_start`, in dollars for that
--   cycle — never a monthly figure, never halved. A line with no row for a cycle keeps the
--   standard budget's share. src/lib/cycleBudget.ts is the one place that turns these rows
--   into targets, and the app's budget bars and both Muse doors all call it.
--
--   `cycle_start` is the payday that opens the cycle, exactly as the app's payCycleFor()
--   spells it. The write door refuses any other date: a goal filed under a day that is
--   not a cycle's first day would match nothing and LOOK set, which is the worst way for
--   a goal to fail. It is not checked here because the paydays live in code
--   (plan.ts PAY_DAYS), and a second copy of them in a CHECK would drift from the first.
--
-- WHO WRITES IT
--   finance.set_cycle_budget on the write door, through the same undo-fenced
--   compare-and-set as every other door write: setting a line records how to put the old
--   amount back (or remove the new row), and clearing a cycle records how to put every
--   cleared row back, so "undo that" restores the previous goal exactly — or its absence.
--
-- WHO READS IT
--   · the app's store (src/store/FinanceStore.tsx), paged, and the budget bars for the
--     cycle in progress use the goal when one is set — same screens, same layout, only
--     the numbers come from the goal;
--   · finance.budget_status on the read door, which says plainly whether each target is
--     "this cycle's goal" or "the standard budget", and lists goals already set for the
--     next cycles.
--
-- WHAT THE DOORS AND THE APP DO BEFORE THIS IS RUN
--   They keep working. The app and finance.budget_status use the standard budget (the
--   read door says the goal table is not set up yet); finance.set_cycle_budget refuses in
--   one plain sentence naming this file. Nothing guesses, and nothing fails a call it
--   could answer without the table.
--
-- THE LOCKS ARE THE POINT — same rule as schema_v36, v40 and v43
--   A new table in `public` starts with every privilege already granted to the anonymous
--   and signed-in roles, and Homebase's publishable key is served to the whole internet
--   inside the browser bundle on purpose. A stranger who could write here could raise
--   the household's budget targets until every overspend read as on track. Every
--   `enable row level security` and every `revoke` below is load-bearing.
-- ---------------------------------------------------------------------------

-- ── 1. the table ─────────────────────────────────────────────────────────────
create table if not exists public.cycle_budgets (
  id          uuid primary key default gen_random_uuid(),

  -- The payday that opens the cycle (see above for why the day is not checked here).
  cycle_start date not null,

  -- One of the six budget lines, by the key src/lib/plan.ts LEAN_VARIABLE gives it.
  -- A line the plan does not have would be a goal nothing grades against. If a line is
  -- ever added to or renamed in LEAN_VARIABLE, this list changes in the same commit.
  line        text not null
              check (line in ('groceries','gas','dining','household','pets','misc')),

  -- Dollars for that one cycle. Zero is a real goal ("nothing on this line this
  -- cycle"); a negative target means nothing and is refused.
  amount      numeric(10,2) not null check (amount >= 0),

  -- Whose key set it. Forced from the caller's secret on the write door, never read from
  -- a request body. It does not scope the goal — a goal is the household's, and holds on
  -- both phones — it is there so "who set that?" has an answer. Null is allowed for a
  -- row written some other way (by hand in the dashboard, say).
  set_by      text check (set_by in ('gino','xinyan')),

  at          timestamptz not null default now(),

  -- One goal per line per cycle. A second write for the same line is an UPDATE of this
  -- row, and it is this index — not a read made a moment earlier — that stops two phones
  -- setting the same line in the same second from leaving two rows.
  unique (cycle_start, line)
);

comment on table public.cycle_budgets is
  'A budget goal for one pay cycle: one row per budget line, in dollars for that cycle. A line with no row keeps the standard budget''s share (src/lib/plan.ts LEAN_VARIABLE, halved). Written by the Muse write door''s finance.set_cycle_budget; read by the app and finance.budget_status.';
comment on column public.cycle_budgets.cycle_start is
  'The payday that opens the cycle, exactly as the app''s payCycleFor() spells it.';
comment on column public.cycle_budgets.amount is
  'Dollars for that one cycle — never a monthly figure, never halved.';

-- ── 2. the locks ─────────────────────────────────────────────────────────────
alter table public.cycle_budgets enable row level security;
revoke all on public.cycle_budgets from anon, authenticated;

-- The household may read its goals in the app — that is what the budget bars do — and
-- may add, change and remove them, the same shape v36 gives `reminders`: nothing in the
-- app writes here yet, and the grant is here so the day a screen can set a goal is app
-- code, not another migration. The write door writes with the service role.
--
-- `anon` gets nothing, so the publishable key compiled into the browser bundle cannot
-- reach this table. That is the whole reason the revoke above is not redundant with RLS.
grant select, insert, update, delete on public.cycle_budgets to authenticated;
drop policy if exists "cycle_budgets household" on public.cycle_budgets;
create policy "cycle_budgets household" on public.cycle_budgets
  for all to authenticated using (true) with check (true);

-- ── 3. live sync to both phones ──────────────────────────────────────────────
-- Added to the realtime publication, unlike review_dismissals, because a screen DOES
-- watch this one: when one person's assistant sets a goal, the other phone's budget
-- bars should move without a reload. Guarded, so re-running this file is harmless.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cycle_budgets'
  ) then
    alter publication supabase_realtime add table public.cycle_budgets;
  end if;
end $$;

-- ── 4. housekeeping, by hand ─────────────────────────────────────────────────
-- A cycle's goal stops mattering once the cycle is a few weeks gone, and it is harmless
-- to keep: six rows a cycle at most. Nothing prunes it automatically — an unattended
-- delete is exactly what this project keeps out of its cron jobs. If it is ever worth
-- trimming, this is safe for any cycle long finished, and it costs one thing: a goal
-- cleared that way can no longer be put back from the change log.
--
--   delete from public.cycle_budgets where cycle_start < current_date - interval '400 days';
