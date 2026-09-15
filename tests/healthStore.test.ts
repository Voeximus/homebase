/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as H from "./helpers/healthHarness";
import { HealthProvider, useHealth } from "../src/store/HealthStore";
import type { Workout } from "../src/lib/workoutLog";

// The real HealthProvider against a fake server whose every answer is delivered
// by hand (tests/helpers/healthHarness.ts), for the orderings that lose data:
// an unmount with a save in the air, an offline reopen, a failed delete, a
// meal-screen render right after an edit.

vi.mock("../src/lib/supabase", async () => ({ supabase: (await import("./helpers/healthHarness")).fakeSupabase }));

const S = (sets: any[], over: Partial<Workout> = {}): Workout => ({
  id: "S",
  date: "2026-09-14",
  person: "gino",
  name: "Workout",
  notes: "",
  done: false,
  exercises: [{ id: "e1", exerciseId: "", name: "Bench", muscle: "chest", sets }],
  ...over,
});
const tk = (id: string, at = 1) => ({ id, reps: 5, weight: 100, done: true, doneAt: at });
const setIds = (w: Workout | undefined) => (w ? w.exercises[0].sets.map((s: any) => s.id) : null);
const serverS = () => H.db.workouts?.find((w) => w.id === "S");
const stateS = (app: { value: ReturnType<typeof useHealth> }) => app.value.workouts.find((w) => w.id === "S");
const W = (op: H.Req["op"]) => H.on("workouts", op);

async function boot() {
  const app = await H.mountStore(HealthProvider, useHealth);
  await H.settle();
  for (const r of H.open((r) => r.op === "select")) H.deliver(r);
  await H.settle();
  return app;
}
/** Run the debounced save of S to completion (read + upsert answered). */
async function saveNow() {
  await H.settle(() => vi.advanceTimersByTimeAsync(700));
  H.deliver(H.one(W("select")));
  await H.settle();
  H.deliver(H.one(W("upsert")));
  await H.settle();
}
/** The app process died: no cleanup, no flush, nothing in the air ever answers. */
function kill() {
  vi.clearAllTimers();
  H.forgetProcess();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-14T10:00:00-07:00"));
  H.resetWorld();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("leaving Health with a save in the air", () => {
  it("the unmount flush waits behind the save of the same session still in the air, so the older save can't land last", async () => {
    const app = await boot();
    await H.settle(() => app.value.upsertWorkout(S([tk("a")])));
    await saveNow();
    expect(setIds(serverS())).toEqual(["a"]);

    // save A of [a, b]: its read answered, its upsert still in the air
    await H.settle(() => app.value.upsertWorkout(S([tk("a"), tk("b")])));
    await H.settle(() => vi.advanceTimersByTimeAsync(700));
    H.deliver(H.one(W("select")));
    await H.settle();
    const upsertA = H.one(W("upsert"));

    // tick c, then the Finance toggle inside the debounce: the flush
    await H.settle(() => app.value.upsertWorkout(S([tk("a"), tk("b"), tk("c")])));
    await app.unmount();
    // the flushed save must not start beside A
    expect(H.open(W("select"))).toHaveLength(0);

    H.deliver(upsertA);
    await H.settle();
    H.deliver(H.one(W("select")));
    await H.settle();
    H.deliver(H.one(W("upsert")));
    await H.settle();
    expect(setIds(serverS())).toEqual(["a", "b", "c"]);

    const back = await boot();
    expect(setIds(stateS(back))).toEqual(["a", "b", "c"]);
  });

  it("a backoff retry waiting at unmount is still flushed, once", async () => {
    const app = await boot();
    await H.settle(() => app.value.upsertWorkout(S([tk("a")])));
    await H.settle(() => vi.advanceTimersByTimeAsync(700));
    H.fail(H.one(W("select"))); // offline: a retry is armed
    await H.settle();
    await app.unmount();
    H.deliver(H.one(W("select")));
    await H.settle();
    H.deliver(H.one(W("upsert")));
    await H.settle();
    expect(setIds(serverS())).toEqual(["a"]);
    await H.settle(() => vi.advanceTimersByTimeAsync(60000));
    expect(H.open()).toHaveLength(0);
  });

  it("a meal save whose debounce fired while an earlier save of that day was in the air still writes after unmount", async () => {
    const D = "2026-09-14";
    const MD = (op: H.Req["op"]) => H.on("meal_days", op);
    const app = await boot();
    await H.settle(() => app.value.setDay({ person: "gino", date: D, meals: [{ id: "A", name: "Lunch", items: [] } as any] }));
    await H.settle(() => vi.advanceTimersByTimeAsync(700)); // write 1 starts: its read hangs
    const read1 = H.one(MD("select"));
    await H.settle(() => app.value.setDay({ person: "gino", date: D, meals: [{ id: "A", name: "Lunch", items: [] } as any, { id: "B", name: "Snack", items: [] } as any] }));
    await H.settle(() => vi.advanceTimersByTimeAsync(700)); // B's debounce fired: queued behind write 1
    await app.unmount();
    H.deliver(read1);
    await H.settle();
    H.deliver(H.one(MD("upsert")));
    await H.settle();
    H.deliver(H.one(MD("select")));
    await H.settle();
    H.deliver(H.one(MD("upsert")));
    await H.settle();
    expect(H.db.meal_days.find((r) => r.date === D)?.meals.map((m: any) => m.id)).toEqual(["A", "B"]);
  });
});

describe("opening the app offline", () => {
  // Server: S with a (open) and z (ticked). Offline: z deleted, a b c ticked,
  // every save failed, then the app was killed (or Health was left and reopened).
  async function offlineReopen() {
    const app = await boot();
    await H.settle(() => app.value.upsertWorkout(S([{ id: "a", reps: 0, weight: 0 }, tk("z")])));
    await saveNow();
    await H.settle(() => app.value.upsertWorkout(S([tk("a"), tk("b"), tk("c")])));
    await H.settle(() => vi.advanceTimersByTimeAsync(700));
    H.fail(H.one(W("select")));
    await H.settle();
    kill();
    const again = await H.mountStore(HealthProvider, useHealth);
    await H.settle();
    for (const r of H.open()) H.fail(r);
    await H.settle();
    return again;
  }

  it("the session with unsaved sets is shown before any load succeeds, so Start isn't offered beside it", async () => {
    const app = await offlineReopen();
    expect(app.value.loading).toBe(false);
    const s = stateS(app);
    expect(s?.done).toBe(false);
    expect(setIds(s)).toEqual(["a", "b", "c"]);
  });

  it("logging on in it offline, then reconnecting, saves every set and never brings back the deleted one", async () => {
    const app = await offlineReopen();
    await H.settle(() => app.value.upsertWorkout(S([tk("a"), tk("b"), tk("c"), tk("d")])));
    await H.settle(() => vi.advanceTimersByTimeAsync(700));
    H.fail(H.one(W("select"))); // still offline
    await H.settle();
    H.fireWindow("online");
    await H.settle();
    H.deliver(H.one(W("select")));
    await H.settle();
    expect(setIds(stateS(app))).toEqual(["a", "b", "c", "d"]);
    await H.settle(() => vi.advanceTimersByTimeAsync(1000)); // the retry
    H.deliver(H.one(W("select")));
    await H.settle();
    H.deliver(H.one(W("upsert")));
    await H.settle();
    expect(setIds(serverS())).toEqual(["a", "b", "c", "d"]);
  });

  it("left untouched, it is merged back and saved once a load reaches the server", async () => {
    const app = await offlineReopen();
    H.fireWindow("online");
    await H.settle();
    H.deliver(H.one(W("select")));
    await H.settle();
    await saveNow();
    expect(setIds(serverS())).toEqual(["a", "b", "c"]);
    expect(setIds(stateS(app))).toEqual(["a", "b", "c"]);
  });
});

describe("deleting a session", () => {
  async function savedS() {
    const app = await boot();
    await H.settle(() => app.value.upsertWorkout(S([tk("a")])));
    await saveNow();
    return app;
  }

  it("a delete that fails offline is retried, and no fetch meanwhile brings the session back", async () => {
    const app = await savedS();
    await H.settle(() => app.value.deleteWorkout("S"));
    H.fail(H.one(W("delete")));
    await H.settle();
    H.fireWindow("online");
    await H.settle();
    H.deliver(H.one(W("select")));
    await H.settle();
    expect(stateS(app)).toBeUndefined();
    await H.settle(() => vi.advanceTimersByTimeAsync(1000));
    H.deliver(H.one(W("delete")));
    await H.settle();
    expect(serverS()).toBeUndefined();
    expect(H.mem.has("hb-del-S")).toBe(false);
  });

  it("killed before the delete landed: the next open keeps it hidden and sends it again", async () => {
    const app = await savedS();
    await H.settle(() => app.value.deleteWorkout("S"));
    H.fail(H.one(W("delete")));
    await H.settle();
    kill();
    const again = await boot(); // the server still has S
    expect(stateS(again)).toBeUndefined();
    H.deliver(H.one(W("delete")));
    await H.settle();
    expect(serverS()).toBeUndefined();
    expect(H.mem.has("hb-del-S")).toBe(false);
  });

  it("a fetch already in the air when the session is deleted doesn't bring it back", async () => {
    const app = await savedS();
    H.emit("workouts"); // the other phone saved something
    await H.settle();
    const fetch = H.one(W("select"));
    await H.settle(() => app.value.deleteWorkout("S"));
    const del = H.one(W("delete"));
    H.deliver(fetch); // answers with the row from before the delete
    await H.settle();
    expect(stateS(app)).toBeUndefined();
    H.deliver(del);
    await H.settle();
    expect(stateS(app)).toBeUndefined();
  });
});

describe("the meal screen", () => {
  it("getDay read during render shows the day as committed, on the same render", async () => {
    const D = "2026-09-14";
    H.db.meal_days = [{ person: "gino", date: D, meals: [{ id: "m1", name: "Breakfast", items: [] }], status: null, note: null }];
    const seen: { getDay: number; context: number }[] = [];
    const app = await H.mountStore(HealthProvider, useHealth, (v) =>
      seen.push({ getDay: v.getDay("gino", D).meals.length, context: v.mealDays[`gino|${D}`]?.meals.length ?? 0 }),
    );
    await H.settle();
    for (const r of H.open((r) => r.op === "select")) H.deliver(r);
    await H.settle();
    expect(seen.at(-1)).toEqual({ getDay: 1, context: 1 });
    await H.settle(() => {
      const day = app.value.getDay("gino", D);
      app.value.setDay({ ...day, meals: [...day.meals, { id: "m2", name: "Lunch", items: [] } as any] });
    });
    expect(seen.at(-1)).toEqual({ getDay: 2, context: 2 });
  });
});

describe("the phone copy's counts", () => {
  it("a late save of the unmounted provider doesn't confirm a tick made after remounting", async () => {
    const first = await boot();
    await H.settle(() => first.value.upsertWorkout(S([tk("a")])));
    await saveNow();
    await H.settle(() => first.value.upsertWorkout(S([tk("a"), tk("b")])));
    await first.unmount(); // the flush: save of [a, b]
    H.deliver(H.one(W("select")));
    await H.settle();
    const lateUpsert = H.one(W("upsert")); // bad signal: in the air
    // back to Health before it lands
    const second = await H.mountStore(HealthProvider, useHealth);
    await H.settle();
    for (const r of H.open((r) => r.op === "select")) H.deliver(r);
    await H.settle();
    expect(setIds(stateS(second))).toEqual(["a", "b"]);
    await H.settle(() => second.value.upsertWorkout(S([tk("a"), tk("b"), tk("c")])));
    H.deliver(lateUpsert);
    await H.settle();
    const copy = JSON.parse(H.mem.get("hb-active-gino:S")!);
    expect(copy.confirmed).toBeLessThan(copy.edits);
    kill(); // before the save of c lands
    const third = await boot();
    expect(setIds(stateS(third))).toEqual(["a", "b", "c"]);
  });

  it("a save that lands while a newer edit waits marks the copy on the server, so a delete elsewhere stays a delete", async () => {
    const app = await boot();
    await H.settle(() => app.value.upsertWorkout(S([tk("a")])));
    await H.settle(() => vi.advanceTimersByTimeAsync(700));
    H.deliver(H.one(W("select")));
    await H.settle();
    await H.settle(() => app.value.upsertWorkout(S([tk("a"), tk("b")])));
    H.deliver(H.one(W("upsert"))); // lands, unsettled
    await H.settle();
    expect(JSON.parse(H.mem.get("hb-active-gino:S")!).onServer).toBe(true);
    kill();
    H.db.workouts = []; // deleted on the other device
    const again = await boot();
    expect(stateS(again)).toBeUndefined();
    expect(H.mem.has("hb-active-gino:S")).toBe(false);
    expect(H.open(W("upsert"))).toHaveLength(0);
  });
});
