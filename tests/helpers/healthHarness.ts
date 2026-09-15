/* eslint-disable @typescript-eslint/no-explicit-any */
// ── A real HealthProvider in node, with every network answer delivered by hand ──
// The store's worst bugs are ORDERINGS: a save landing after a newer one, a
// fetch answering after a delete, a provider unmounting with a write in the air.
// So nothing here answers on its own. Every request waits in `reqs` until the
// test calls deliver() (the fake server applies it) or fail() (offline).
//
// The test file must mock the client with this module's `fakeSupabase`:
//   vi.mock("../src/lib/supabase", async () => ({ supabase: (await import("./helpers/healthHarness")).fakeSupabase }));
// React is the real one (react-dom/client over a fake container, a tree with no
// host nodes), so render and commit order are the app's own.

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// ── browser globals the store touches ───────────────────────────────────────
export const mem = new Map<string, string>();
const g = globalThis as any;
g.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
  clear: () => mem.clear(),
};
const winListeners = new Map<string, Set<() => void>>();
g.window = globalThis;
g.addEventListener = (t: string, f: () => void) => {
  if (!winListeners.has(t)) winListeners.set(t, new Set());
  winListeners.get(t)!.add(f);
};
g.removeEventListener = (t: string, f: () => void) => winListeners.get(t)?.delete(f);
g.HTMLIFrameElement ??= class {};
g.document ??= { activeElement: null };
g.IS_REACT_ACT_ENVIRONMENT = true;
export const fireWindow = (t: string) => [...(winListeners.get(t) ?? [])].forEach((f) => f());

// ── the fake server ─────────────────────────────────────────────────────────
export const db: Record<string, any[]> = {};
export interface Req {
  id: number;
  table: string;
  op: "select" | "upsert" | "delete" | "insert" | "update";
  filters: [string, unknown][];
  single: boolean;
  payload?: any;
  conflict: string[];
  done: boolean;
  resolve: (v: any) => void;
}
export const reqs: Req[] = [];
let reqNo = 0;
const clone = (x: any) => JSON.parse(JSON.stringify(x));

function execute(r: Req): any {
  const rows = (db[r.table] ??= []);
  const match = (row: any) => r.filters.every(([c, v]) => row[c] === v);
  if (r.op === "select") {
    const out = rows.filter(match).map(clone);
    return r.single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
  }
  if (r.op === "upsert") {
    const i = rows.findIndex((x) => r.conflict.every((c) => x[c] === r.payload[c]));
    if (i >= 0) rows[i] = clone(r.payload);
    else rows.push(clone(r.payload));
  }
  if (r.op === "delete") db[r.table] = rows.filter((x) => !match(x));
  return { data: null, error: null };
}
export function deliver(r: Req) {
  if (r.done) throw new Error(`request ${r.id} already answered`);
  r.done = true;
  r.resolve(execute(r));
}
export function fail(r: Req) {
  if (r.done) throw new Error(`request ${r.id} already answered`);
  r.done = true;
  r.resolve({ data: null, error: { message: "offline" } });
}
export const open = (pred: (r: Req) => boolean = () => true) => reqs.filter((r) => !r.done && pred(r));
export const one = (pred: (r: Req) => boolean) => {
  const o = open(pred);
  if (o.length !== 1) throw new Error(`expected 1 open request, got ${o.length}: ${JSON.stringify(open().map((r) => [r.id, r.table, r.op]))}`);
  return o[0];
};
export const on = (table: string, op: Req["op"]) => (r: Req) => r.table === table && r.op === op;

function builder(table: string) {
  const r: Partial<Req> = { table, op: "select", filters: [], single: false, conflict: ["id"] };
  let promise: Promise<any> | null = null;
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => (r.filters!.push([c, v]), b),
    maybeSingle: () => ((r.single = true), b),
    upsert: (payload: any, opts?: { onConflict?: string }) => {
      r.op = "upsert";
      r.payload = payload;
      r.conflict = (opts?.onConflict ?? "id").split(",");
      return b;
    },
    insert: (payload: any) => ((r.op = "insert"), (r.payload = payload), b),
    update: (payload: any) => ((r.op = "update"), (r.payload = payload), b),
    delete: () => ((r.op = "delete"), b),
    then: (res: any, rej: any) => {
      promise ??= new Promise((resolve) => reqs.push({ ...(r as Req), id: ++reqNo, done: false, resolve }));
      return promise.then(res, rej);
    },
  };
  return b;
}
const channelHandlers: Record<string, (() => void)[]> = {};
/** A Realtime change on `table` (the other phone wrote something). */
export const emit = (table: string) => (channelHandlers[table] ?? []).forEach((f) => f());
export const fakeSupabase = {
  from: (t: string) => builder(t),
  channel: () => {
    const ch: any = {
      on: (_e: string, cfg: { table: string }, f: () => void) => ((channelHandlers[cfg.table] ??= []).push(f), ch),
      subscribe: () => ch,
    };
    return ch;
  },
  removeChannel: () => {},
};

// ── mounting ────────────────────────────────────────────────────────────────
/** Let every promise chain that can move, move, and commit what it set. */
export async function settle(fn?: () => unknown) {
  await act(async () => {
    await fn?.();
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

/**
 * Mount `Provider` around a child that reads the store with `use` on every
 * render. `onRender` runs inside that child's render — where MealBuilder calls
 * getDay — so a test can see what a screen would draw.
 */
export async function mountStore<T>(
  Provider: (p: { children: ReactNode }) => ReactNode,
  use: () => T,
  onRender?: (value: T) => void,
) {
  let value!: T;
  function Child() {
    value = use();
    onRender?.(value);
    return null;
  }
  const root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, addEventListener() {}, removeEventListener() {} } as any);
  await act(async () => root.render(createElement(Provider, null, createElement(Child))));
  return {
    get value() {
      return value;
    },
    /** Leave the screen (the Finance toggle): cleanup and flush run. */
    unmount: () => settle(() => root.unmount()),
  };
}

/** A fresh world: empty server, empty phone storage (migration already done), no listeners. */
export function resetWorld() {
  mem.clear();
  mem.set("hb-health-migrated", "1");
  reqs.length = 0;
  for (const k of Object.keys(db)) delete db[k];
  winListeners.clear();
  for (const k of Object.keys(channelHandlers)) delete channelHandlers[k];
}
/** The app process died: nothing it had in the air will ever answer, and it hears nothing more. */
export function forgetProcess() {
  reqs.length = 0;
  winListeners.clear();
  for (const k of Object.keys(channelHandlers)) delete channelHandlers[k];
}
