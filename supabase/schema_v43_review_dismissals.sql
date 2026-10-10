-- schema_v43_review_dismissals.sql  —  2026-10-10  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: the "worth a look" suggestions somebody has waved away, for both of them.
--
-- THE FAILURE THIS EXISTS FOR
--   A dismissal has only ever lived in the phone that tapped it — localStorage key
--   'hb-review-dismissed' (src/lib/doctorDismissals.ts, whose own header says a
--   household table was always the plan: spec §B.9, "spec piece 3"). That had three
--   costs, and the third is the one that made it urgent:
--     · dismissing on one phone did nothing on the other;
--     · finance.worth_a_look could not know what had been waved away, so it answered
--       `dismissals_known: false` and listed everything, every time;
--     · nothing on either door could dismiss anything at all. With the Activity tab
--       being retired, every suggestion anybody had decided about would come back on
--       every call, for ever.
--
-- WHAT A ROW MEANS
--   One suggestion, by the review engine's own key — `drift:<bill>:<amount in cents>`,
--   `unlinked:<bill>:<month>:<charge>` and so on (src/lib/reviewTypes.ts lists the
--   shapes) — or the door's hashed stand-in for a key it could not say safely
--   (`h:` and sixteen hex digits; see suggestionKey in
--   supabase/functions/_shared/muse/worthALook.ts). The evidence is INSIDE the key, so
--   a dismissed suggestion comes back on its own the moment the facts change. That is
--   why there is no snooze, no expiry and no "re-ask" column anywhere here: a row is
--   a fact about one key and nothing else.
--
-- WHO WRITES IT
--   finance.dismiss_suggestion on the write door, which records the delete of the row
--   as its undo in muse_undo — so "undo that" puts a suggestion back. The app may
--   write here too one day: mergeDismissed() in doctorDismissals.ts already folds a
--   household list into the phone's own, and the grant below is so growing that is
--   app code and not another migration.
--
-- WHAT THE DOORS DO BEFORE THIS IS RUN
--   They keep working. finance.worth_a_look answers `dismissals_known: false` and says
--   the table is not set up; finance.dismiss_suggestion refuses in one plain sentence
--   naming this file. Neither one guesses, and neither one fails a call it could
--   answer without the table.
--
-- THE LOCKS ARE THE POINT — same rule as schema_v36_muse_bridge.sql and v40
--   A new table in `public` starts with every privilege already granted to the
--   anonymous and signed-in roles, and Homebase's publishable key is served to the
--   whole internet inside the browser bundle on purpose. A stranger who could insert
--   a row here could hide a real warning about the household's money from both of
--   them — a duplicate charge, a bill that stopped — by dismissing it. Every
--   `enable row level security` and every `revoke` below is load-bearing.
-- ---------------------------------------------------------------------------

-- ── 1. the table ─────────────────────────────────────────────────────────────
create table if not exists public.review_dismissals (
  id     uuid primary key default gen_random_uuid(),

  -- The suggestion's key, exactly as the door handed it out. Capped and kept to one
  -- line here as well as in the door: the door refuses a key the cleaner would change,
  -- and these checks are the belt underneath it, because this column is compared
  -- against what the engine produces and is never meant to hold prose.
  key    text not null check (char_length(key) between 3 and 200)
                       check (position(E'\n' in key) = 0)
                       check (position(E'\r' in key) = 0),

  -- Who waved it away. Forced from the caller's secret on the door, never read from a
  -- request body. It does NOT scope the dismissal — a suggestion is about the
  -- household's ledger, so a dismissal by either of them holds for both — it is only
  -- there so "who dismissed that?" has an answer.
  person text not null check (person in ('gino','xinyan')),

  at     timestamptz not null default now(),

  -- One row per key, household-wide. A second dismissal of the same suggestion is
  -- "already done", whoever did the first — and it is this index that says so, so the
  -- two phones dismissing the same thing in the same second cannot leave two rows.
  unique (key)
);

comment on table public.review_dismissals is
  'The "worth a look" suggestions somebody waved away, by the review engine''s own key. Household-wide: a dismissal by either person holds for both. The evidence is inside the key, so a suggestion comes back by itself when the facts change.';
comment on column public.review_dismissals.key is
  'The suggestion key exactly as finance.worth_a_look handed it out — the engine''s own (drift:…, unlinked:…) or the door''s h:<16 hex> stand-in.';

-- ── 2. the locks ─────────────────────────────────────────────────────────────
alter table public.review_dismissals enable row level security;
revoke all on public.review_dismissals from anon, authenticated;

-- The household may read, add and remove its own dismissals in the app — the same
-- shape v40 gives muse_memory, and for the same reason: nothing in the app reads this
-- table yet, and the grant is here so the day doctorDismissals.ts merges it in is app
-- code, not another migration. No UPDATE: a dismissal is a fact about one key, and
-- changing its key would be a different dismissal.
--
-- `anon` gets nothing, so the publishable key compiled into the browser bundle cannot
-- reach this table. That is the whole reason the revoke above is not redundant with
-- RLS.
grant select, insert, delete on public.review_dismissals to authenticated;
drop policy if exists "review_dismissals household" on public.review_dismissals;
create policy "review_dismissals household" on public.review_dismissals
  for all to authenticated using (true) with check (true);

-- NOT added to supabase_realtime, deliberately. No screen watches it, and a
-- publication entry for a table nobody subscribes to is cost with no reader.

-- ── 3. housekeeping, by hand ─────────────────────────────────────────────────
-- Keys churn by design — an amount changes, a month closes — so old rows stop matching
-- anything. They are harmless (a key that matches nothing hides nothing) and small, so
-- nothing prunes them automatically: an unattended delete is exactly what this project
-- keeps out of its cron jobs. If it ever gets big enough to notice, this is safe for
-- any row old enough that its suggestion cannot recur, and it costs one thing: those
-- dismissals can no longer be undone from the change log.
--
--   delete from public.review_dismissals where at < now() - interval '400 days';
