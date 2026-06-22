-- schema_v22_notify_triggers.sql  —  Notification triggers (reference / setup notes)
-- ---------------------------------------------------------------------------
-- The notification pipeline is mostly edge functions + secrets, not SQL. This
-- file documents the DB-side piece (the daily cron) so it's reproducible.
--
-- Edge functions (deployed via `supabase functions deploy`):
--   notify         (verify_jwt)     — send a Web Push to the household's devices
--   plaid-webhook  (no verify_jwt)  — Plaid pings it on new charges → sync + push
--   cron-notify    (no verify_jwt)  — daily: meal-log nudge + bills-due heads-up
--
-- Secrets (set via `supabase secrets set`, NEVER committed):
--   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT  — Web Push
--   PLAID_WEBHOOK_URL  = .../functions/v1/plaid-webhook?token=<PLAID_WEBHOOK_TOKEN>
--   PLAID_WEBHOOK_TOKEN — shared secret guarding the webhook
--   CRON_TOKEN          — shared secret guarding cron-notify
--   APP_URL             — where a tapped notification opens
--
-- Plaid webhooks are registered on each item by the plaid function's
-- `set_webhook` action (POST {action:"set_webhook"}); new links get the webhook
-- via the link_token. The daily cron (8 PM Arizona = 03:00 UTC):
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (run with the real CRON_TOKEN; the live job stores it in cron.job, not here)
-- do $g$ begin
--   if exists (select 1 from cron.job where jobname='homebase-daily-notify')
--     then perform cron.unschedule('homebase-daily-notify'); end if;
-- end $g$;
-- select cron.schedule('homebase-daily-notify', '0 3 * * *',
--   $j$ select net.http_post(
--         url := 'https://<ref>.supabase.co/functions/v1/cron-notify?token=<CRON_TOKEN>',
--         headers := '{"Content-Type":"application/json"}'::jsonb,
--         body := '{}'::jsonb) $j$);
