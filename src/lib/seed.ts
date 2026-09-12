import type { Category } from "../types";

// Default categories. IDs are stable slugs so transactions reference them safely.
export const DEFAULT_CATEGORIES: Category[] = [
  // income
  { id: "salary", name: "Salary", icon: "💼", color: "#2bb277", type: "income" },
  { id: "freelance", name: "Freelance", icon: "🧾", color: "#2bb277", type: "income" },
  { id: "gift", name: "Gift", icon: "🎁", color: "#2bb277", type: "income" },
  { id: "refund", name: "Refund", icon: "↩️", color: "#2bb277", type: "income" },
  { id: "other-income", name: "Other Income", icon: "➕", color: "#3fd08a", type: "income" },
  // expense
  { id: "groceries", name: "Groceries", icon: "🛒", color: "#c9982b", type: "expense" },
  { id: "dining", name: "Dining Out", icon: "🍽️", color: "#c07a1e", type: "expense" },
  { id: "transport", name: "Transport", icon: "⛽", color: "#c07a1e", type: "expense" },
  { id: "housing", name: "Housing", icon: "🏠", color: "#6a75e0", type: "expense" },
  { id: "utilities", name: "Utilities", icon: "💡", color: "#c9982b", type: "expense" },
  // "shopping" = the single Household + Hygiene category (covers personal care /
  // hygiene AND general household items). The old separate "health" (grooming)
  // category was merged in — legacy `health` rows are migrated to this id.
  { id: "shopping", name: "Household + Hygiene", icon: "🧴", color: "#c07a1e", type: "expense" },
  { id: "entertainment", name: "Entertainment", icon: "🎬", color: "#a3468c", type: "expense" },
  { id: "subscriptions", name: "Subscriptions", icon: "🔁", color: "#7b64d6", type: "expense" },
  // Electronics = tech purchases (monitors, gadgets). Often fronted for someone
  // and paid back, so kept as its own line rather than muddying groceries/dining.
  { id: "electronics", name: "Electronics", icon: "🖥️", color: "#7b64d6", type: "expense" },
  // Car = the cost of OWNING the vehicle, not of driving it. Down payment,
  // pre-purchase inspection, registration/title, repairs. Deliberately OUTSIDE
  // the budget envelope (it's on no line, so it's ungraded) but still real cash,
  // so it cuts debt firepower — same carve-out shape as electronics.
  //
  // GAS STAYS IN `transport`. That's ongoing consumption and it should be graded
  // every cycle; a $1,250 down payment is a one-time capital event and grading it
  // would blow the envelope for a month over a decision already made. Assigned by
  // hand on purpose — the categorizer does NOT auto-route here, or routine
  // maintenance would quietly escape the budget.
  { id: "car", name: "Car", icon: "🚗", color: "#c9982b", type: "expense" },
  { id: "kids", name: "Kids", icon: "🧸", color: "#c25a86", type: "expense" },
  { id: "pets", name: "Pets", icon: "🐾", color: "#c25a86", type: "expense" },
  // What the debt COSTS: card interest + late fees. Deliberately NOT on a budget
  // line — it isn't discretionary living spend, and it's already inside the card
  // balance the debt total reads from (so it must never be re-added). Its own id
  // purely so the price of carrying a balance is visible instead of buried in
  // "other" next to a coffee.
  { id: "interest", name: "Interest + Fees", icon: "🩸", color: "#d9483f", type: "expense" },
  // A payment on a modeled bill that lands OUTSIDE that bill's normal cycle — a
  // catch-up, or a second payment in one month. It is real money and it reduces
  // what can go at the debt, but it is not discretionary living spend, so it must
  // not be graded against an envelope. On no budget line, and listed in
  // OUTSIDE_BUDGET_CASH_CATS. Before it existed, such a payment inherited its
  // bill's category — and 8 of the 16 active bills carry "other", which IS the
  // $125/mo Misc line.
  { id: "bills", name: "Bill payment", icon: "🧾", color: "#1f9fc0", type: "expense" },
  // Travel and tuition are NOT new budget money — both sit on the same Misc line
  // as `other` (see LEAN_VARIABLE), so nothing about what is graded or how much
  // changes. They exist so a hotel reads as "Travel" and a university fee reads as
  // "Education" instead of both showing up as "Misc / uncategorized", which is
  // what a person reading their own ledger cannot make sense of.
  { id: "travel", name: "Travel", icon: "✈️", color: "#38c6e8", type: "expense" },
  { id: "education", name: "Education", icon: "🎓", color: "#3fd08a", type: "expense" },
  { id: "other", name: "Other", icon: "📦", color: "#8b96a5", type: "expense" },
];

export function getCategory(
  categories: Category[],
  id: string,
): Category {
  return (
    categories.find((c) => c.id === id) ?? {
      id: "other",
      name: "Other",
      icon: "📦",
      color: "#8b96a5",
      type: "expense",
    }
  );
}

