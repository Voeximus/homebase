import type { AppData } from "../types";

// Local persistence. This is the only place that knows *where* data lives —
// when we move to Supabase, we replace these two functions (and the store's
// actions) with cloud calls, and nothing in the UI changes.

const KEY = "homebase.v1";

export function loadData(): AppData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppData;
  } catch {
    return null;
  }
}

export function saveData(data: AppData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // storage full or unavailable — ignore for now
  }
}
