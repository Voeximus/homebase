// cron-notify — the daily scheduled pushes (run by pg_cron at 8 PM Arizona).
//   • Health: if a person hasn't logged any meals today, nudge them.
//   • Bills:  a heads-up for bills due today / tomorrow that aren't recorded paid.
// PUBLIC (verify_jwt=false), guarded by ?token=CRON_TOKEN (pg_cron passes it).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOKEN = Deno.env.get("CRON_TOKEN") ?? "";
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

// deno-lint-ignore no-explicit-any
function paidKey(at: any) {
  return at?.kind === "bill" ? `${at.recurringId}|${at.monthKey}|${at.day}` : null;
}

Deno.serve(async (req) => {
  // fail CLOSED: a missing/empty CRON_TOKEN denies everything (never disables auth)
  if (!TOKEN || new URL(req.url).searchParams.get("token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  // Arizona local time (UTC-7, no DST) — meal_days/bills are keyed to local date.
  const az = new Date(Date.now() - 7 * 3600 * 1000);
  const today = az.toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const dom = az.getUTCDate();
  const daysInMonth = new Date(Date.UTC(az.getUTCFullYear(), az.getUTCMonth() + 1, 0)).getUTCDate();

  let mealNudges = 0;
  let billPings = 0;

  try {
    // 1) meal-log nudge — per person, no meals logged today → push to that person
    for (const person of ["gino", "xinyan"]) {
      const { data: day } = await admin
        .from("meal_days")
        .select("meals")
        .eq("person", person)
        .eq("date", today)
        .maybeSingle();
      const logged = Array.isArray(day?.meals) && day!.meals.length > 0;
      if (!logged) {
        const owner = person === "gino" ? "Gino" : "Xinyan";
        const r = await sendPush(
          admin,
          { title: "🍽️ Log your meals", body: "Nothing logged today yet — tap to add what you ate.", url: APP, tag: `meal-${person}` },
          owner,
        );
        if (r.sent > 0) mealNudges++;
      }
    }

    // 2) bills due today / tomorrow that aren't recorded paid this month
    const { data: recs } = await admin
      .from("recurring")
      .select("id, name, due_days, amount, direction, active")
      .eq("active", true);
    const { data: paid } = await admin.from("transactions").select("applies_to").not("applies_to", "is", null);
    const paidSet = new Set<string>();
    for (const t of paid ?? []) {
      const k = paidKey((t as { applies_to: unknown }).applies_to);
      if (k) paidSet.add(k);
    }
    const due: { name: string; amount: number; rel: string }[] = [];
    for (const r of recs ?? []) {
      if (r.direction !== "out" || !Array.isArray(r.due_days)) continue;
      for (const d of r.due_days) {
        const dd = Math.min(d, daysInMonth);
        const rel = dd === dom ? "today" : dd === dom + 1 ? "tomorrow" : null;
        if (!rel) continue;
        if (paidSet.has(`${r.id}|${monthKey}|${d}`)) continue;
        due.push({ name: r.name, amount: Number(r.amount), rel });
      }
    }
    if (due.length === 1) {
      const b = due[0];
      await sendPush(admin, { title: `📅 Bill ${b.rel}`, body: `${b.name} · $${b.amount.toFixed(2)}`, url: APP, tag: "bill" });
      billPings = 1;
    } else if (due.length > 1) {
      await sendPush(admin, { title: "📅 Bills coming up", body: due.map((b) => b.name).join(", "), url: APP, tag: "bill" });
      billPings = due.length;
    }
  } catch (e) {
    console.error("cron-notify", String((e as Error)?.message ?? e));
  }

  return new Response(JSON.stringify({ ok: true, today, mealNudges, billPings }), {
    headers: { "Content-Type": "application/json" },
  });
});
