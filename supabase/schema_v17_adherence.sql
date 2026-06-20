-- schema_v17_adherence.sql
-- Macro-plan adherence: a per-day status + optional note on meal_days.
--   status: null (untracked) | 'estimated' (followed, roughly) | 'skipped' (off-plan)
--   note:   the rough "what did you eat" description for an estimated day
-- A day with logged meals is "followed" implicitly. Idempotent.

alter table public.meal_days add column if not exists status text;
alter table public.meal_days add column if not exists note text;
