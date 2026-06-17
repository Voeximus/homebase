import { createClient } from "@supabase/supabase-js";

// Single Supabase client for the whole app. The publishable key is safe to
// ship in the browser bundle — data is protected by Row-Level Security, not
// by hiding this key. Session is persisted in localStorage automatically.

const url = import.meta.env.VITE_SUPABASE_URL as string;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !publishableKey) {
  console.error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY — check .env.local",
  );
}

export const supabase = createClient(url, publishableKey);
