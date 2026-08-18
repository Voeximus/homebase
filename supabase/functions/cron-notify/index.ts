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

// How many months apart a bill repeats, for the cadences that DON'T fire every
// month. Mirrors PERIOD_MONTHS in src/lib/schedule.ts — the app learned this in
// schema_v23 and this function did not, so a semiannual insurance bill and a
// yearly membership were pinging the phones on their due DAY of EVERY month.
const PERIOD_MONTHS: Record<string, number> = { quarterly: 3, semiannual: 6, yearly: 12 };

/** Does a longer-than-monthly bill fire in this month? Its anchor names one month
 *  it's known to hit and it repeats every `period` months from there. No anchor →
 *  let it through rather than silently hide a real bill. */
function firesInMonth(cadence: string, anchorDate: string | null, monthKey: string): boolean {
  const period = PERIOD_MONTHS[cadence];
  if (!period) return true;
  if (!anchorDate) return true;
  const [ay, am] = anchorDate.slice(0, 7).split("-").map(Number);
  const [y, m] = monthKey.split("-").map(Number);
  const delta = (y - ay) * 12 + (m - am);
  return ((delta % period) + period) % period === 0;
}

/** Is this bill alive on `clampedDay` of `monthKey`? Mirrors inWindow() in
 *  src/lib/schedule.ts — the app learned start/end windows in schema_v27 and
 *  this function did not, so the phones were being told a support payment paused
 *  until November, a car payment that starts in September, and a dental plan that
 *  ends in January were all due tonight.
 *
 *  `clampedDay` must ALREADY be clamped to the month length, which is how the app
 *  resolves a day-30 bill in February to the 28th. Clamping here too would be
 *  harmless but would hide that requirement from the caller. */
function inWindow(
  startsOn: string | null,
  endsOn: string | null,
  monthKey: string,
  clampedDay: number,
): boolean {
  if (!startsOn && !endsOn) return true;
  const iso = `${monthKey}-${String(clampedDay).padStart(2, "0")}`;
  if (startsOn && iso < startsOn) return false;
  if (endsOn && iso > endsOn) return false;
  return true;
}

// deno-lint-ignore no-explicit-any
type Row = any;

/** The MONTHLY figure for a bill. Mirrors billExpected() in src/lib/plan.ts.
 *
 *  A fixed bill is its modeled amount. A VARIABLE bill is either the amount you
 *  actually read off it (known_amount, which beats any estimate) or the rolling
 *  average of its last 3 recorded payments. Without this, a push said "Electric
 *  $85" while every screen in the app said $100.
 *
 *  Returns a MONTHLY total. The caller must divide by the FULL due-day count —
 *  see the convention note at the call site. */
function billExpectedMonthly(r: Row, txns: Row[]): number {
  const stored = Number(r.amount);
  if (r.variable !== true) return stored;
  // `!= null` deliberately, not a truthiness test: 0 is a legitimate override.
  if (r.known_amount != null) return Number(r.known_amount);
  const actuals = txns
    .filter(
      (t) =>
        t.type === "expense" &&
        t.applies_to?.kind === "bill" &&
        t.applies_to?.recurringId === r.id,
    )
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // most recent first
      const am = a.applies_to?.monthKey ?? "";
      const bm = b.applies_to?.monthKey ?? "";
      if (am !== bm) return am < bm ? 1 : -1;
      return (b.applies_to?.day ?? 0) - (a.applies_to?.day ?? 0);
    })
    .slice(0, 3)
    .map((t) => Number(t.amount));
  if (actuals.length < 1) return stored;
  return actuals.reduce((s, a) => s + a, 0) / actuals.length;
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
      .select(
        "id, name, due_days, amount, direction, active, cadence, anchor_date, linked_debt_id, starts_on, ends_on, variable, known_amount",
      )
      .eq("active", true);
    // amount/date/type are needed for the rolling-average estimate, not just the
    // paid-check. The applies_to filter stays: billExpectedMonthly only consumes
    // rows whose applies_to.kind is "bill", so it is a strict superset.
    const { data: paid } = await admin
      .from("transactions")
      .select("applies_to, amount, date, type")
      .not("applies_to", "is", null);
    // A card-payment bill exists only to service its debt: clear the debt and the
    // minimum stops existing, so the reminder must stop too. The app gates on this
    // live (src/lib/schedule.ts); without it here, a paid-off card kept pinging its
    // $35 minimum every month.
    const { data: debts } = await admin.from("debts").select("id, balance");
    const clearedDebts = new Set(
      (debts ?? []).filter((d: { balance: number }) => Number(d.balance) <= 0).map((d: { id: string }) => d.id),
    );
    const paidSet = new Set<string>();
    for (const t of paid ?? []) {
      const k = paidKey((t as { applies_to: unknown }).applies_to);
      if (k) paidSet.add(k);
    }
    // Evaluate two REAL dates — today and tomorrow — running the identical gate
    // body over each, instead of testing `dd === dom + 1` for tomorrow.
    //
    // `dom + 1` can never match a clamped due day on the last day of a month, so
    // every bill due on the 1st silently lost its day-before warning: on Aug 31,
    // dom is 31, rent's day is 1, and 1 is neither 31 nor 32. Rent's only
    // reminder arrived at 8 PM on the 1st — after the draft had already been
    // attempted. Deriving tomorrow as a date makes the month boundary ordinary.
    //
    // Two passes over one body (rather than a `dom === daysInMonth` special case)
    // also means a future change to these gates cannot be applied to one arm and
    // forgotten on the other — the exact drift this file has a history of.
    const tmr = new Date(az.getTime() + 86_400_000);
    const passes = [
      { rel: "today", key: monthKey, day: dom, dim: daysInMonth },
      {
        rel: "tomorrow",
        key: tmr.toISOString().slice(0, 7),
        day: tmr.getUTCDate(),
        dim: new Date(Date.UTC(tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, 0)).getUTCDate(),
      },
    ];

    const due: { name: string; amount: number; rel: string }[] = [];
    for (const p of passes) {
      for (const r of recs ?? []) {
        if (r.direction !== "out" || !Array.isArray(r.due_days) || !r.due_days.length) continue;
        if (r.linked_debt_id && clearedDebts.has(r.linked_debt_id)) continue;
        if (!firesInMonth(r.cadence ?? "monthly", r.anchor_date ?? null, p.key)) continue;
        // Divide the monthly figure by the FULL due-day count, BEFORE any
        // window filtering. Dividing by the surviving days would inflate every
        // remaining payment in a month a bill starts or stops partway.
        const perPayment = billExpectedMonthly(r, paid ?? []) / r.due_days.length;
        for (const d of r.due_days) {
          const dd = Math.min(d, p.dim);
          if (dd !== p.day) continue;
          if (!inWindow(r.starts_on ?? null, r.ends_on ?? null, p.key, dd)) continue;
          // Key on the CLAMPED day: both writers store the clamped installment,
          // so a day-30 bill paid on Feb 28 is stored as day 28. Keying on the
          // raw 30 missed it and re-pinged a bill already recorded paid.
          if (paidSet.has(`${r.id}|${p.key}|${dd}`)) continue;
          due.push({ name: r.name, amount: perPayment, rel: p.rel });
        }
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
