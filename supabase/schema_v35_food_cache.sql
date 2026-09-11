-- schema_v35_food_cache.sql — 2026-09-10
--
-- The household's own barcode memory.
--
-- Every scan that resolves anywhere gets written here under its canonical
-- (EAN-13) number, so the second time either phone scans that product the answer
-- is one local query instead of a fan-out to Open Food Facts and USDA. Over a
-- year of groceries this becomes the fastest and most complete food database
-- they have, because it is made of exactly the things they actually buy.
--
-- Negative results are recorded too, with a timestamp — see the TTL note in the
-- function. "Not found" is a statement about today, not about the product.

create table if not exists public.food_cache (
  -- Canonical EAN-13. Storing one canonical form is the whole point: the same
  -- product scanned off a UPC-A label and a UPC-E label must land on ONE row.
  code        text primary key,
  payload     jsonb,                  -- the normalized FoodHit, null on a miss
  found       boolean not null default false,
  source      text,                   -- openfoodfacts | usda
  checked_at  timestamptz not null default now()
);

create index if not exists food_cache_found_idx on public.food_cache (found, checked_at);

alter table public.food_cache enable row level security;

-- Readable by the household so the app can warm results without a function
-- call; written ONLY by the service role (the edge function). A client that
-- could write here could poison a shared nutrition database for both people.
drop policy if exists "food_cache read" on public.food_cache;
create policy "food_cache read" on public.food_cache
  for select to authenticated using (true);
