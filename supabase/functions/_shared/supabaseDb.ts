// supabase-js, narrowed to the two things a paged read needs: a count on a filter,
// and one ordered page of it.
//
// LIFTED OUT OF muse-read/index.ts on 2026-10-05, unchanged, because a second caller
// arrived: cron-audit runs the same self-checks on a schedule and has to load the
// ledger EXACTLY the way finance.audit does, or the scheduled answer and the spoken
// one could disagree about the same ledger. One adapter, two callers.
//
// It stays out of anything a test imports. Tests hand the loader a fake Db; this is
// the only file that turns that interface into real queries.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Db, DbQuery, DbRow, DbSelect } from "./muse/paging.ts";

export function supabaseDb(admin: SupabaseClient): Db {
  return {
    select(query: DbQuery): DbSelect {
      const base = () => {
        let q = admin.from(query.table).select("*");
        for (const [col, value] of Object.entries(query.eq ?? {})) q = q.eq(col, value);
        return q;
      };
      return {
        async count() {
          let q = admin.from(query.table).select("*", { count: "exact", head: true });
          for (const [col, value] of Object.entries(query.eq ?? {})) q = q.eq(col, value);
          const { count, error } = await q;
          if (error) throw new Error(error.message);
          return count ?? 0;
        },
        async page(from: number, to: number) {
          const { data, error } = await base()
            .order(query.orderBy, { ascending: true })
            .range(from, to);
          if (error) throw new Error(error.message);
          return (data ?? []) as DbRow[];
        },
      };
    },
  };
}
