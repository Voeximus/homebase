import type { AppData, Category, Debt, SavingsGoal, Transaction } from "../types";

// Default categories. IDs are stable slugs so transactions reference them safely.
export const DEFAULT_CATEGORIES: Category[] = [
  // income
  { id: "salary", name: "Salary", icon: "💼", color: "#10b981", type: "income" },
  { id: "freelance", name: "Freelance", icon: "🧾", color: "#14b8a6", type: "income" },
  { id: "gift", name: "Gift", icon: "🎁", color: "#22c55e", type: "income" },
  { id: "refund", name: "Refund", icon: "↩️", color: "#84cc16", type: "income" },
  { id: "other-income", name: "Other Income", icon: "➕", color: "#34d399", type: "income" },
  // expense
  { id: "groceries", name: "Groceries", icon: "🛒", color: "#f59e0b", type: "expense" },
  { id: "dining", name: "Dining Out", icon: "🍽️", color: "#fb923c", type: "expense" },
  { id: "transport", name: "Transport", icon: "⛽", color: "#f97316", type: "expense" },
  { id: "housing", name: "Housing", icon: "🏠", color: "#6366f1", type: "expense" },
  { id: "utilities", name: "Utilities", icon: "💡", color: "#eab308", type: "expense" },
  { id: "health", name: "Health", icon: "💊", color: "#ef4444", type: "expense" },
  { id: "shopping", name: "Shopping", icon: "🛍️", color: "#ec4899", type: "expense" },
  { id: "entertainment", name: "Entertainment", icon: "🎬", color: "#a855f7", type: "expense" },
  { id: "subscriptions", name: "Subscriptions", icon: "🔁", color: "#8b5cf6", type: "expense" },
  { id: "kids", name: "Kids", icon: "🧸", color: "#f472b6", type: "expense" },
  { id: "other", name: "Other", icon: "📦", color: "#64748b", type: "expense" },
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
      color: "#64748b",
      type: "expense",
    }
  );
}

/** Believable sample data so an empty app can show its full shape in one tap. */
export function makeSampleData(): AppData {
  const today = new Date();
  const iso = (daysAgo: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  const now = new Date().toISOString();
  const tx = (
    daysAgo: number,
    type: "income" | "expense",
    categoryId: string,
    amount: number,
    description: string,
  ): Transaction => ({
    id: crypto.randomUUID(),
    date: iso(daysAgo),
    type,
    categoryId,
    amount,
    description,
    createdAt: now,
  });

  const transactions: Transaction[] = [
    tx(1, "expense", "groceries", 82.47, "Trader Joe's"),
    tx(2, "expense", "dining", 34.2, "Thai takeout"),
    tx(3, "expense", "transport", 48.1, "Gas — Shell"),
    tx(4, "expense", "subscriptions", 15.99, "Netflix"),
    tx(5, "income", "salary", 2400, "Paycheck"),
    tx(6, "expense", "utilities", 120.34, "Electric bill"),
    tx(7, "expense", "groceries", 64.18, "Costco"),
    tx(9, "expense", "health", 25.0, "Pharmacy"),
    tx(11, "expense", "entertainment", 42.0, "Movie night"),
    tx(13, "expense", "housing", 1450, "Rent"),
    tx(15, "income", "freelance", 350, "Design gig"),
    tx(16, "expense", "shopping", 78.5, "Target"),
    tx(20, "income", "salary", 2400, "Paycheck"),
    tx(22, "expense", "groceries", 91.12, "Whole Foods"),
    tx(24, "expense", "dining", 56.8, "Date night"),
  ];

  const debts: Debt[] = [
    { id: crypto.randomUUID(), name: "Credit Card", balance: 3200, originalBalance: 5000, apr: 19.99, minPayment: 120, color: "#ef4444", createdAt: now },
    { id: crypto.randomUUID(), name: "Car Loan", balance: 11400, originalBalance: 18000, apr: 5.9, minPayment: 320, color: "#f59e0b", createdAt: now },
    { id: crypto.randomUUID(), name: "Student Loan", balance: 8750, originalBalance: 12000, apr: 4.5, minPayment: 150, color: "#6366f1", createdAt: now },
  ];

  const goals: SavingsGoal[] = [
    { id: crypto.randomUUID(), name: "Emergency Fund", target: 10000, saved: 4200, icon: "🛟", color: "#10b981", createdAt: now },
    { id: crypto.randomUUID(), name: "Vacation", target: 3000, saved: 1150, icon: "🏖️", color: "#0ea5e9", createdAt: now },
    { id: crypto.randomUUID(), name: "New Laptop", target: 2000, saved: 600, icon: "💻", color: "#8b5cf6", createdAt: now },
  ];

  return {
    transactions,
    debts,
    goals,
    categories: DEFAULT_CATEGORIES,
    accounts: [],
    recurring: [],
    paidBills: [],
    merchantRules: [],
  };
}
