-- schema_v46_week_plans.sql  —  2026-10-25  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: the household's weekly spending plan, Sunday to Saturday.
--
-- THE GAP
--   Muse's daily allowance — the pay cycle's target less what the cycle already spent,
--   over the days left — was the headline answer to "what can we spend?", and on
--   2026-10-25 Gino called it "annoying, almost inaccurate". It swung hard after one big
--   shop, it sat at $0 for days after a cycle that ran over, it never showed its sum,
--   and a day is the wrong unit for spending that is weekly (groceries, gas) for a
--   household where one person works nights. He approved replacing it with a WEEKLY
--   view, and a weekly view needs somewhere to keep the week's plan: per budget line,
--   in dollars per week. Nothing could hold that — cycle_budgets (v45) is per pay
--   cycle, and LEAN_VARIABLE in src/lib/plan.ts is a monthly constant in a public
--   repository, where a household's real figures must never be typed at all.
--
-- WHAT A ROW MEANS — A STANDING PLAN
--   One row is the whole plan (every budget line, in `lines`) FROM the week that starts
--   on `week_start` ON. The plan for any week is the latest row whose week_start is on
--   or before that week's Sunday — so setting it once holds for every week after, until
--   another row is set, and nobody has to re-enter the same plan every Sunday. A week
--   with no row on or before it falls back to the pay cycle's budget per day × 7, and
--   the read door says so in words. src/lib/weekPlan.ts is the one place that turns
--   these rows into a week's figures; both Muse doors call it.
--
--   `lines` is {budget line key: dollars per week} — the six LEAN_VARIABLE keys. Never a
--   cycle figure and never a monthly one.
--
-- WHO WRITES IT
--   finance.set_weekly_plan on the write door, through the same undo-fenced
--   compare-and-set as every other door write: setting a week records how to put the
--   old `lines` back (or remove the new row), and clearing a week records how to put
--   the cleared row back under its own id, so "undo that" restores the previous plan
--   exactly — or its absence.
--
-- WHO READS IT
--   finance.week on the read door, which answers "what can we spend?" with the week's
--   plan against what the budget counts as spent, and a ready picture both assistants
--   show as it is. The app's screens do not read it (their look does not change).
--
-- WHAT THE DOORS DO BEFORE THIS IS RUN
--   They keep working. finance.week plans every week from the pay-cycle budget and says
--   the plan table is not set up yet; finance.set_weekly_plan refuses in one plain
--   sentence naming this file. Nothing guesses.
--
-- THE LOCKS ARE THE POINT — same rule as schema_v36, v40, v43 and v45
--   A new table in `public` starts with every privilege already granted to the anonymous
--   and signed-in roles, and Homebase's publishable key is served to the whole internet
--   inside the browser bundle on purpose. A stranger who could write here could raise
--   the weekly plan until every overspend read as on track. Every
--   `enable row level security` and every `revoke` below is load-bearing.
-- ---------------------------------------------------------------------------

-- ── 1. the table ─────────────────────────────────────────────────────────────
create table if not exists public.week_plans (
  id          uuid primary key default gen_random_uuid(),

  -- The Sunday the plan starts on. Checked here, unlike cycle_budgets' payday: a Sunday
  -- is the calendar's own fact, not a rule that lives in code, so a second copy of it
  -- cannot drift. A plan filed under a Wednesday would match no week's start and LOOK
  -- set, which is the worst way for a plan to fail. (isodow 7 is Sunday.)
  week_start  date not null unique
              check (extract(isodow from week_start) = 7),

  -- {line key: dollars per week}. An object; only the six budget lines the plan has
  -- (if a line is ever added to or renamed in LEAN_VARIABLE, this list changes in the
  -- same commit, as cycle_budgets' does); every value a number, 0 or more. Zero is a
  -- real plan ("nothing on this line this week"); a negative one means nothing.
  --
  -- STRICT, on purpose (2026-10-25, found in review). A jsonpath is lax unless it says
  -- otherwise, and lax mode unwraps arrays: {"groceries": [80]} passed the lax check,
  -- because [80] was read as 80. The door reads such a value as no number and plans the
  -- line from the pay cycle — but it could never change or clear that row, because its
  -- compare-and-set would expect a value JSON cannot write. In strict mode an array is
  -- an array, and the row is refused here. Checked with pure selects on the live
  -- database: strict refuses a value of [80], "80", null, an object or -1, and accepts
  -- 80 and an empty plan.
  lines       jsonb not null
              check (jsonb_typeof(lines) = 'object')
              check (lines - array['groceries','gas','dining','household','pets','misc'] = '{}'::jsonb)
              check (not jsonb_path_exists(lines, 'strict $.* ? (@.type() != "number" || @ < 0)')),

  -- Whose key last set it. Forced from the caller's secret on the write door, never read
  -- from a request body. It does not scope the plan — a plan is the household's and
  -- holds on both phones — it is there so "who set that?" has an answer. Null is allowed
  -- for a row written some other way (by hand in the dashboard, say).
  set_by      text check (set_by in ('gino','xinyan')),

  created_at  timestamptz not null default now(),
  -- When `lines` last changed. Kept by the trigger below rather than by the door, so an
  -- undo that puts old figures back also says when, and no write can forget to.
  updated_at  timestamptz not null default now()
);

comment on table public.week_plans is
  'The household''s weekly spending plan, Sunday to Saturday: one row is every budget line''s dollars per week FROM week_start on, standing until a later row. A week with no row on or before it uses the pay-cycle budget per day x 7. Written by the Muse write door''s finance.set_weekly_plan; read by finance.week through src/lib/weekPlan.ts.';
comment on column public.week_plans.week_start is
  'The Sunday this plan starts on. The plan for any week is the latest row on or before that week''s Sunday.';
comment on column public.week_plans.lines is
  '{budget line key: dollars per week} — the six LEAN_VARIABLE keys, never a cycle or a monthly figure.';

-- ── 2. updated_at, kept by the database ──────────────────────────────────────
create or replace function public.week_plans_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_week_plans_touch on public.week_plans;
create trigger trg_week_plans_touch
  before update on public.week_plans
  for each row execute function public.week_plans_touch();

-- ── 3. the locks ─────────────────────────────────────────────────────────────
alter table public.week_plans enable row level security;
revoke all on public.week_plans from anon, authenticated;

-- The household may read its plan in the app and may add, change and remove it — the
-- same shape v45 gives cycle_budgets: nothing in the app reads or writes here yet, and
-- the grant is here so the day a screen shows the week is app code, not another
-- migration. The write door writes with the service role.
--
-- `anon` gets nothing, so the publishable key compiled into the browser bundle cannot
-- reach this table. That is the whole reason the revoke above is not redundant with RLS.
grant select, insert, update, delete on public.week_plans to authenticated;
drop policy if exists "week_plans household" on public.week_plans;
create policy "week_plans household" on public.week_plans
  for all to authenticated using (true) with check (true);

-- ── 4. live sync to both phones ──────────────────────────────────────────────
-- Added to the realtime publication like cycle_budgets, so the day a screen shows the
-- week, one person's assistant setting the plan moves the other phone without a reload.
-- Guarded, so re-running this file is harmless.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'week_plans'
  ) then
    alter publication supabase_realtime add table public.week_plans;
  end if;
end $$;

-- ── 5. housekeeping, by hand ─────────────────────────────────────────────────
-- Nothing to prune. A row is one plan change, not one week — a household that changes
-- its plan every single week writes 52 rows a year — and an old row is what tells the
-- read door what an old week was planned at. Nothing deletes here automatically; an
-- unattended delete is exactly what this project keeps out of its cron jobs.
