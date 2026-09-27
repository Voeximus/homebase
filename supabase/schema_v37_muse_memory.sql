-- schema_v37_muse_memory.sql  —  2026-09-26  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: the things an assistant learns about how this household works.
--
-- WHY IT IS HERE AND NOT IN META
--   Muse remembers things across conversations in Meta's own store, which is a
--   black box: he cannot read it, cannot correct it, cannot copy it, and it stops
--   existing for him the day he stops using Muse. Everything else this bridge does
--   is built so the app stays the place things are true. A memory held on the far
--   side of the connector is the one part of the arrangement that would not
--   survive leaving.
--
--   So the memory lives HERE, in his own Postgres, in five plain columns. Reading
--   the whole of what the assistant knows is one statement:
--
--     select key, kind, value, tags from public.muse_memory
--      where person = 'gino' and forgotten_at is null order by kind, key;
--
--   That statement is the portability promise. Any assistant that can hold a
--   secret and make an HTTP call can be handed the same memory tomorrow; nothing
--   in this table names Meta, Muse, or a model.
--
-- WHAT BELONGS IN IT — and this is the whole design, not a style note
--   The things the ledger CANNOT compute:
--     · standing rules      "$1,400 a check is a floor, never raise it"
--     · preferences         "plain language, no jargon"
--     · routines            "works nights, roughly 6 PM to 6 AM"
--     · decisions already made, so they are not reopened every month
--     · standing facts the app has no column for
--
-- WHAT MUST NEVER GO IN IT
--   Anything a tool can answer. A balance, a bill amount, what is left in
--   groceries, a weigh-in, yesterday's macros. Those are MEASURED, they change
--   under him, and a copy of one in this table is a number that was true once and
--   will be spoken as though it still is — with no screen beside it to disagree.
--   That failure already happened in this repo from a hand-copied bill amount
--   ("Electric $85" on every phone while every screen said $100), and a memory row
--   is a hand-copied anything that never expires.
--
--   The door refuses what it can see (a value that is nothing but a number) and
--   says the rest in words to the assistant. It cannot refuse "we have $1,193.77
--   available" by inspection, because "$1,400 a check is a floor" has to be
--   allowed — and the difference between those two is what the sentence MEANS.
--   That is a rule an assistant follows, stated once in API.md, not a regex.
--
-- ONE STEP OF UNDO, HELD IN THE ROW
--   Phase 2's rule is that every write records its before-state and can be
--   reversed. For this table that is exact and it costs one column: `previous`
--   holds the value, kind and tags this row had before the last change. Forgetting
--   is a soft delete — `forgotten_at` — so it is reversible too, and a recall of a
--   forgotten key says when it was forgotten instead of pretending it never
--   existed.
--
--   The before-state is deliberately NOT kept in `muse_audit`. That log is
--   readable by any signed-in household session and holds no reply bodies on
--   purpose — a second copy of the content in a log table is a second place for it
--   to leak from. The before-state belongs in the row it is the history of.
--
--   Depth is ONE step, on purpose. "Undo that" means the last thing; a full
--   revision history is a different feature with a different table, and an
--   unbounded one behind a tool an assistant can call in a loop.
--
-- THE LOCKS ARE THE POINT — same rule as schema_v36_muse_bridge.sql
--   A new table in `public` starts with every privilege already granted to the
--   anonymous and signed-in roles, and Homebase's publishable key is served to the
--   whole internet inside the browser bundle on purpose (see
--   supabase/functions/_shared/callerAuth.ts). Without RLS and a revoke, this
--   table is readable and writable by any stranger who reads our JavaScript — and
--   it is the one table whose contents are read straight back into an assistant's
--   context as trusted input. A stranger who can insert a row here can put words
--   in his assistant's head that persist across every future conversation.
--
--   Every `enable row level security` and every `revoke` below is load-bearing.
-- ---------------------------------------------------------------------------

-- ── 1. the table ─────────────────────────────────────────────────────────────
create table if not exists public.muse_memory (
  id     uuid primary key default gen_random_uuid(),

  -- WHOSE memory. Forced from the secret on every call, exactly like every other
  -- tool on both doors — never read from a request body. Her secret reaches her
  -- memory and not his, so losing one phone costs one person's memory.
  person text not null check (person in ('gino','xinyan')),

  -- The handle the assistant recalls by: a slug it chooses and then reuses, so
  -- "remember" twice under one key is a correction and not a second row saying
  -- something slightly different. Lower-case, dashes, no spaces — a key is an
  -- identifier, not a sentence, and the door checks the shape.
  key    text not null check (key ~ '^[a-z][a-z0-9-]{1,47}$'),

  -- Five kinds, and they are a closed list because the list is what stops this
  -- table turning into a diary. Anything that does not fit one of these is either
  -- a reminder (which has its own table) or a number the ledger already holds.
  --   standing    a rule that does not expire
  --   preference  how he wants things done
  --   routine     what he does, and when
  --   decided     a question already settled — do not reopen it
  --   fact        a standing fact the app has no column for
  kind   text not null check (kind in ('standing','preference','routine','decided','fact')),

  -- The fact itself, in words, one line. Capped here as well as in the door: the
  -- door scrubs and refuses, and these checks are the belt underneath, because
  -- this column's contents are read back into a model's context as trusted
  -- output from a connector he installed. A newline is how a stored string starts
  -- looking like a second message.
  value  text not null check (char_length(value) between 1 and 300)
                        check (position(E'\n' in value) = 0)
                        check (position(E'\r' in value) = 0),

  -- For narrowing a search without reading everything. Slugs, same shape as the
  -- key; the door caps the count.
  tags   text[] not null default '{}',

  -- Who taught it this. 'muse' today. It exists for the day he moves: memories
  -- imported from somewhere else arrive stamped with where they came from, and a
  -- row he types into the app himself says so.
  source text not null default 'muse',

  learned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Soft delete. "Forget that" must not be the one irreversible thing in a phase
  -- whose whole promise is that every change can be undone.
  forgotten_at timestamptz,

  -- The one step of undo: {"value":…, "kind":…, "tags":[…], "at":…} as this row
  -- was before the last change, or null when this row has never been changed.
  previous jsonb,

  -- One row per person per key, forever — including a forgotten one. Remembering
  -- a forgotten key REVIVES that row rather than leaving two rows with the same
  -- handle, one of them invisible. So "forget it, then tell it again" ends with
  -- one row and a readable history instead of a duplicate.
  unique (person, key)
);

-- What every read does: this person's live memories, in a stable order.
create index if not exists muse_memory_live
  on public.muse_memory (person, kind, key) where forgotten_at is null;

comment on table public.muse_memory is
  'What an assistant has learned about how the household works: standing rules, preferences, routines, decisions already made. Never a figure the app can compute — those change, and a copy here would be spoken as current forever.';
comment on column public.muse_memory.previous is
  'The value, kind and tags this row had before the last change. One step, so "undo that" works from a new conversation. Not kept in muse_audit: that log deliberately holds no content.';

-- ── 2. the locks ─────────────────────────────────────────────────────────────
alter table public.muse_memory enable row level security;
revoke all on public.muse_memory from anon, authenticated;

-- The household may read, add, correct and remove its own memory in the app. The
-- app has no screen for it today; the grant is here so growing one is app code
-- and not another migration, and so a wrong memory can be fixed by hand in the
-- SQL editor without turning RLS off.
--
-- Note what this grant does NOT do: `anon` gets nothing, so the publishable key
-- compiled into the browser bundle cannot reach this table. That is the whole
-- reason the revoke above is not redundant with RLS.
grant select, insert, update, delete on public.muse_memory to authenticated;
drop policy if exists "muse_memory household" on public.muse_memory;
create policy "muse_memory household" on public.muse_memory
  for all to authenticated using (true) with check (true);

-- NOT added to supabase_realtime, deliberately. Nothing in the app reads this
-- table yet, and a publication entry for a table no screen watches is cost with
-- no reader. One line to add the day a memory screen exists.

-- ── 3. housekeeping, by hand ─────────────────────────────────────────────────
-- Forgotten rows are kept so a forget can be undone. They are not kept forever
-- by anything automatic — an unattended delete is exactly what this project keeps
-- out of its cron jobs. Run this when it gets big enough to notice, and know what
-- it costs: after this, those forgets can no longer be undone.
--
--   delete from public.muse_memory
--    where forgotten_at is not null and forgotten_at < now() - interval '90 days';
