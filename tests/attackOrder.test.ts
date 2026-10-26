// The debt attack order is the household's decision of 2026-10-24.
//
// The old ATTACK_ORDER was a smallest-first snowball — Affirm, Xinyan's card, Mom
// (China), then the …4728 card last — and by October it aimed money at the wrong debt:
// Affirm is closed, and the …4728 card is the only debt still charging interest. The
// household's order: Gino's card first, then Xinyan's card (paid in full by its due date),
// then Cherry (dental) at its normal payment, then Mom (China).
//
// The names are the debts table's own, matched exactly (orderedDebts). They are already
// in this repository's source; nothing here adds a figure. Every balance is invented.
import { describe, expect, it } from "vitest";
import { ATTACK_ORDER, orderedDebts, payoffSchedule } from "../src/lib/plan";
import * as door from "../supabase/functions/_shared/muse/lib/plan.ts";
import type { Debt } from "../src/types";

const debt = (over: Partial<Debt>): Debt => ({
  id: "d",
  name: "Loan",
  balance: 100,
  originalBalance: 100,
  color: "#888888",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("ATTACK_ORDER", () => {
  it("is the card charging interest, then the card paid in full, then Cherry, then Mom", () => {
    expect(ATTACK_ORDER).toEqual(["Credit card (…4728)", "Xinyan card (…6813)", "Cherry (dental)", "Mom (China)"]);
  });

  it("holds no closed debt", () => {
    expect(ATTACK_ORDER).not.toContain("Affirm");
  });

  it("orders the debts by it, whatever their balances, and puts anything else at the back", () => {
    const debts = [
      debt({ id: "mom", name: "Mom (China)", balance: 50 }),
      debt({ id: "other", name: "Some new loan", balance: 10 }),
      debt({ id: "cherry", name: "Cherry (dental)", balance: 60 }),
      debt({ id: "x", name: "Xinyan card (…6813)", balance: 70 }),
      debt({ id: "card", name: "Credit card (…4728)", balance: 9000 }),
    ];
    expect(orderedDebts(debts).map((d) => d.id)).toEqual(["card", "x", "cherry", "mom", "other"]);
  });

  it("the payoff plan's first dollars go to the card", () => {
    const debts = orderedDebts([
      debt({ id: "x", name: "Xinyan card (…6813)", balance: 70 }),
      debt({ id: "card", name: "Credit card (…4728)", balance: 900, apr: 20 }),
    ]);
    const events = payoffSchedule(debts, 400, new Date(2026, 9, 26, 12));
    expect(events[0].payments[0].debtId).toBe("card");
  });

  it("the read door's copy is the same list", () => {
    expect(door.ATTACK_ORDER).toEqual(ATTACK_ORDER);
  });
});
