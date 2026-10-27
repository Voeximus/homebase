// The design handoff's acceptance tests (aurora-logic.test.mjs), ported 1:1.
// Expected values are pinned against the handoff's own sample data, which is
// illustrative — not household data.
import { describe, expect, test } from "vitest";
import fx from "./fixtures/aurora-fixtures.json";
import * as L from "../src/aurora/logic";

const recurring = fx.recurring as L.Recurring[];
const balance = fx.accounts.find((a) => a.id === "chk")!.balance;
const cushion = fx.settings.cushion;
const base = { today: fx.today, balance, recurring, goals: fx.goals as L.Goal[], discretionaryPerDay: fx.settings.discretionaryPerDay };
const forecast = L.buildForecast({ ...base, days: 20 }); // Horizon window: Oct 25 – Nov 14
const payday = L.nextPayday(recurring, fx.today);
const at = (f: L.ForecastDay[], d: string) => f.find((x) => x.date === d)!.balance;

describe("aurora logic (handoff acceptance tests)", () => {
  test("next payday", () => expect(payday).toBe("2026-11-06"));

  test("forecast story: rent cliff, low point, payday jump", () => {
    expect(at(forecast, "2026-10-25")).toBe(1830.42); // day 0 = current balance
    expect(at(forecast, "2026-10-28")).toBe(1665.42); // phone bill
    expect(at(forecast, "2026-11-01")).toBe(355.42); // rent
    expect(at(forecast, "2026-11-05")).toBe(179.93); // lowest before payday
    expect(at(forecast, "2026-11-06")).toBe(1999.93); // +2,060 pay − $200 goal auto-fills − $40
    expect(at(forecast, "2026-11-14")).toBe(1607.93); // after the power bill
  });

  test("goal auto-fill stops when a goal is full (running total across paydays)", () => {
    const goals = [{ id: "g", name: "Almost", target: 1000, saved: 960, autofillPerPayday: 80 }];
    const f = L.buildForecast({ ...base, goals, days: 30 });
    const fills = f.flatMap((d) => d.events).filter((e) => e.id === "autofill:g").map((e) => e.amount);
    expect(fills).toEqual([-40]); // Nov 6 tops it up; Nov 20 moves nothing
  });

  test("status pill (Home): rose when under the cushion within 7 days", () => {
    expect(L.statusPill(forecast, cushion, recurring)).toEqual({ tone: "warning", text: "Under your cushion from Nov 1" });
    expect(L.statusPill(forecast, 0, recurring)).toEqual({ tone: "calm", text: "Steady until rent on Nov 1" });
  });

  test("cushion advice (Horizon home card)", () => {
    expect(L.cushionAdvice(forecast, cushion, payday)).toEqual({
      lowest: 179.93,
      lowestDate: "2026-11-05",
      firstBelow: "2026-11-01",
      daysBelow: 5,
      amount: 350,
      moveBy: "2026-10-31",
    });
    // already under the cushion today -> move it today, not yesterday
    const low = L.buildForecast({ ...base, balance: 400, days: 20 });
    expect(L.cushionAdvice(low, cushion, payday)!.moveBy).toBe("2026-10-25");
  });

  test("Horizon key days", () => {
    expect(L.horizonKeyDays(forecast, payday).map((d) => d.label)).toEqual(["Today", "Nov 1", "Nov 5", "Nov 6", "Nov 14"]);
  });

  test("safe to spend — cushion included (default) and excluded", () => {
    const args = { today: fx.today, balance, spentToday: fx.spentToday, recurring, cushion };
    expect(L.safeToSpend({ ...args, includeCushion: true })).toEqual({ payday, days: 12, bills: 1210.49, dailyBudget: 13.95, safeToday: 0, overToday: 33.48 });
    expect(L.safeToSpend({ ...args, includeCushion: false })).toEqual({ payday, days: 12, bills: 1210.49, dailyBudget: 55.61, safeToday: 8.18, overToday: 0 });
  });

  test("orb mood and 7-day bars", () => {
    const s = L.safeToSpend({ today: fx.today, balance, spentToday: fx.spentToday, recurring, cushion });
    expect(L.mood({ ...s, forecast, cushion, today: fx.today })).toBe("tight");
    const bars = L.nextDaysBudget({ today: fx.today, forecast, recurring, cushion, budgetToday: s.dailyBudget });
    expect(bars.length).toBe(7);
    expect(bars.map((b) => b.label)).toEqual(["Today", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(bars.filter((b) => b.hasBill).map((b) => b.date)).toEqual(["2026-10-28"]);
  });

  test("goal fill dates", () => {
    const eta = Object.fromEntries(fx.goals.map((g) => [g.id, L.goalEta(g as L.Goal, recurring, fx.today)]));
    expect(eta).toEqual({ travel: "2027-01-29", emergency: "2027-08-27", laptop: null });
  });

  test("month insight (Insights screen)", () => {
    const m = L.monthInsights(fx.monthPlan as { categories: L.PlanCategory[] }, fx.today);
    expect(m.totalSpent).toBe(1128);
    expect(m.left).toBe(322);
    expect(m.daysLeft).toBe(6);
    expect(m.insight!.title).toBe("Groceries is running ahead");
    expect(m.insight!.body).toBe("$44 left for 6 days, about $7 a day.");
    // a category with no plan but spending is "over", and nothing divides by zero
    const odd = L.monthInsights({ categories: [{ id: "x", name: "Gifts", plan: 0, spent: 30 }] }, fx.today);
    expect(odd.insight!.title).toBe("Gifts is over plan");
  });

  test("weekly spend (Activity summary)", () => {
    const w = L.weeklySpend(fx.transactions, fx.today, fx.lastWeekSpent);
    expect(w.spent).toBe(215.41);
    expect(w.label).toBe("18% less than last week");
  });

  test("can I afford it — $180 today vs on payday", () => {
    const a = L.affordCheck({ ...base, cushion, price: fx.afford.price });
    expect(a.buyToday.lowest).toBe(-0.07);
    expect(a.buyToday.lowestDate).toBe("2026-11-05");
    expect(a.buyToday.copy.headline).toBe("You'd hit $0 on Nov 5.");
    expect(a.buyToday.copy.body).toBe("Buying today drains you the day before payday.");
    expect(a.waitForPayday!.lowest).toBe(179.93);
    expect(a.waitForPayday!.copy.headline).toBe("Yes — wait for payday.");
    expect(a.waitForPayday!.copy.body).toBe("Buy it on Nov 6 and nothing else has to give.");
    expect(a.recommended).toBe("wait");
  });

  test("can I afford it — too big even after payday", () => {
    const a = L.affordCheck({ ...base, cushion, price: 5000 });
    expect(a.waitForPayday!.fine).toBe(false);
    expect(a.waitForPayday!.copy.headline).toBe("Not this pay period.");
    expect(a.recommended).toBe("neither");
  });

  test("can I afford it — small purchase is fine today; no income known", () => {
    const rich = L.affordCheck({ ...base, balance: 5000, cushion, price: 50 });
    expect(rich.recommended).toBe("today");
    expect(rich.buyToday.copy.headline).toBe("Yes, you can.");
    const noIncome = L.affordCheck({ ...base, recurring: recurring.filter((r) => r.kind !== "income"), cushion, price: 50 });
    expect(noIncome.payday).toBe(null);
    expect(noIncome.waitForPayday).toBe(null);
  });

  test("formatting", () => {
    expect(L.heroParts(1830.42)).toEqual({ sign: "", symbol: "$", whole: "1,830", cents: ".42" });
    expect(L.heroParts(-212.4).sign).toBe("−");
    expect(L.money0(-0.07)).toBe("$0"); // never "−$0"
    expect(L.money0(179.93)).toBe("$180");
    expect(L.money0(-820)).toBe("−$820"); // typographic minus
  });
});

describe("app additions", () => {
  test("scheduled events forecast the same as the recurring items they expand", () => {
    const until = L.addDays(fx.today, 20);
    const scheduled: L.ScheduledEvent[] = recurring.flatMap((r) =>
      L.occurrences(r, until).map((date) => ({ id: r.id, name: r.name, date, amount: r.kind === "income" ? r.amount : -r.amount, kind: r.kind })),
    );
    const viaScheduled = L.buildForecast({ ...base, recurring: [], scheduled, days: 20 });
    expect(viaScheduled.map((d) => d.balance)).toEqual(forecast.map((d) => d.balance));
    expect(L.nextPayday([], fx.today, scheduled)).toBe("2026-11-06");
  });

  test("a pay-cycle period replaces the calendar month in the insight", () => {
    const m = L.monthInsights(fx.monthPlan as { categories: L.PlanCategory[] }, fx.today, { day: 12, days: 16 });
    expect(m.daysLeft).toBe(4);
    expect(m.daysInMonth).toBe(16);
  });

  test("money2 never shows −$0.00", () => {
    expect(L.money2(-0.001)).toBe("$0.00");
    expect(L.money2(-42.18)).toBe("−$42.18");
  });
});
