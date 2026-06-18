import type { Category } from "../types";

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

