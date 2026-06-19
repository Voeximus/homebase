// Which spouse this physical device belongs to. The household login is shared,
// so the *device* — not the account — remembers who is holding it. Picked once
// on first launch (see WelcomeScreen) and used to personalize the greeting.
export type Owner = "gino" | "xinyan";

const KEY = "hb-owner";

export function getOwner(): Owner | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "gino" || v === "xinyan" ? v : null;
  } catch {
    return null;
  }
}

export function saveOwner(o: Owner) {
  try {
    localStorage.setItem(KEY, o);
  } catch {
    /* ignore */
  }
}

export function clearOwner() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const OWNER_NAME: Record<Owner, string> = {
  gino: "Gino",
  xinyan: "Xinyan",
};

// Same person accents the health side uses, so identity feels consistent.
export const OWNER_COLOR: Record<Owner, string> = {
  gino: "#ef8136",
  xinyan: "#2dd1c0",
};
