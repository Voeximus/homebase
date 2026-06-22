-- schema_v21_push_subscriptions.sql  —  Web Push subscriptions (RUN ONCE)
-- ---------------------------------------------------------------------------
-- One row per device that has opted into phone notifications. The notify
-- function (+ Plaid webhook + crons) read these with the service role and send
-- a Web Push via VAPID. The VAPID PRIVATE key lives only in function secrets.
--
-- SAFE / IDEMPOTENT.
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  owner      text not null default 'Joint',   -- 'Gino' | 'Xinyan' | 'Joint'
  endpoint   text not null unique,            -- the push service endpoint (dedup key)
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
do $pol$ begin
  if not exists (select 1 from pg_policies where tablename='push_subscriptions' and policyname='push_subs_auth_all') then
    create policy push_subs_auth_all on public.push_subscriptions for all to authenticated using (true) with check (true);
  end if;
end $pol$;
