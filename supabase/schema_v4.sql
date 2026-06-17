-- schema_v4.sql — the "pipeline" migration.
-- Gives the ledger the foreign keys so ONE money event can fan out to
-- cash + the matching bill + the linked debt + a goal.
-- Run once in the Supabase SQL editor. Afterward, re-seed once
-- (Settings → Clear all data → Set up my household) so every row gets the
-- new due-days / debt links baked in.

-- A transaction can now say what it satisfies: a bill, a debt, income, a goal,
-- a transfer, or a reconciliation adjustment.
alter table public.transactions add column if not exists applies_to jsonb;

-- A recurring row now carries its own due day(s) (so the calendar reads the
-- table instead of a hardcoded map) and an optional link to the debt it pays.
alter table public.recurring add column if not exists due_days int[];
alter table public.recurring add column if not exists linked_debt_id uuid;
