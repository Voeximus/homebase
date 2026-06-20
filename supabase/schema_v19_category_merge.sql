-- schema_v19_category_merge.sql  —  Merge "health" into "shopping" (RUN ONCE)
-- ---------------------------------------------------------------------------
-- The separate "health" (grooming) category was merged into the single
-- "shopping" = Household + Hygiene category (covers personal care/hygiene AND
-- general household). Categories are code-defined (src/lib/seed.ts), so this
-- only migrates the DATA that referenced the retired id. The categorizer no
-- longer emits "health" (src/lib/categorize.ts), so this is a one-time backfill.
--
-- SAFE / IDEMPOTENT: re-running finds 0 'health' rows and is a no-op.
-- ---------------------------------------------------------------------------

update public.transactions   set category_id = 'shopping' where category_id = 'health';
update public.recurring      set category_id = 'shopping' where category_id = 'health';
update public.merchant_rules set category_id = 'shopping' where category_id = 'health';

-- split slices (jsonb): rewrite any {"categoryId":"health"} → "shopping"
update public.transactions
set splits = (
  select jsonb_agg(
    case when e->>'categoryId' = 'health'
      then jsonb_set(e, '{categoryId}', '"shopping"')
      else e end
  )
  from jsonb_array_elements(splits) e
)
where splits is not null and splits @> '[{"categoryId":"health"}]'::jsonb;
