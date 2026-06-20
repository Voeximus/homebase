import type { Account } from "../types";
import type { Owner } from "./owner";

// The owner becomes a LENS. "me" shows only this person's distinctly-own slice
// of each mode; "all" is the full household picture. Shared things (the debt
// next-move, the payoff mission) stay visible in both — they belong to the
// household, not a person.
export type Lens = "me" | "all";

const KEY = "hb-lens";

export function getLens(): Lens {
  try {
    return localStorage.getItem(KEY) === "all" ? "all" : "me";
  } catch {
    return "me";
  }
}

export function saveLens(l: Lens) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
}

// Device owner ("gino") → the AccountOwner / Recurring owner label ("Gino").
const LABEL: Record<Owner, "Gino" | "Xinyan"> = { gino: "Gino", xinyan: "Xinyan" };

export function ownAccounts(accounts: Account[], owner: Owner): Account[] {
  return accounts.filter((a) => a.owner === LABEL[owner]);
}

export function jointAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.owner === "Joint");
}
