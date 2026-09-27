// muse-read — the READ door. An assistant asks a question; this answers it with
// the app's own numbers and changes nothing.
//
// PUBLIC (verify_jwt = false), guarded by its own per-person secret. It has to be
// public for the same reason announce-update, plaid-webhook and cron-notify are:
// the caller cannot present a Supabase session. And it must NOT be given one —
// _shared/callerAuth.ts records the audit where an anonymous caller holding
// nothing but the public publishable key reached a hard-delete, and 17 of the 18
// tables let any signed-in account read and write every row. A session handed to
// an assistant is not a door.
//
// THIS FILE IS DELIBERATELY THIN. Everything that decides anything lives in
// _shared/muse/, with no Deno global and no Supabase import in it, so
// tests/museRead.test.ts can run every tool for real — under two different
// timezones — instead of testing a mock of the door. What is left here is the
// runtime: read the secrets, adapt supabase-js to the door's narrow read seam,
// serve.
//
// There is no write verb anywhere in this function, and no path from here to
// another edge function.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleMuseRead } from "../_shared/muse/handler.ts";
import { createAuditSink } from "../_shared/muse/audit.ts";
import type { Db, DbQuery, DbRow, DbSelect } from "../_shared/muse/paging.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Fails CLOSED: an unset or empty secret is a person who cannot open this door, not
// a door left open. auth.ts also refuses anything shorter than a real secret, so a
// placeholder value locks it rather than opening it.
const SECRETS = {
  gino: Deno.env.get("MUSE_READ_GINO") ?? "",
  xinyan: Deno.env.get("MUSE_READ_XINYAN") ?? "",
};

const BASE_URL =
  Deno.env.get("MUSE_READ_URL") ?? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/muse-read`;

/** supabase-js, narrowed to the two things a paged read needs: a count on a filter,
 *  and one ordered page of it. Kept here so nothing under test imports a client. */
const db: Db = {
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

const audit = createAuditSink({
  async insert(table, row) {
    const { error } = await admin.from(table).insert(row);
    if (error) throw new Error(error.message);
  },
});

/** The hourly read cap, counted in `muse_calls`. One statement, so two calls that
 *  arrive together cannot both read the same number — the counting is the database's
 *  job, and `muse_bump` is executable by the service role only. A count that comes
 *  back unreadable throws, and the handler turns that into a refusal rather than
 *  treating it as room to spare. */
const limit = {
  async bump(person: "gino" | "xinyan", bucket: string) {
    const { data, error } = await admin.rpc("muse_bump", { p_person: person, p_bucket: bucket });
    if (error) throw new Error(error.message);
    const n = Number(data);
    if (!Number.isFinite(n)) throw new Error("muse_bump returned no count");
    return n;
  },
};

Deno.serve((req) => handleMuseRead(req, { db, secrets: SECRETS, audit, limit, baseUrl: BASE_URL }));
