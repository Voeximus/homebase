import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  loadRest,
  parseRest,
  REST_IDLE,
  restAdd,
  restDefault,
  restIsOver,
  restKey,
  restMarkFired,
  restRemaining,
  restShouldFire,
  restSkip,
  restStart,
  saveRest,
  serializeRest,
  type RestState,
} from "../src/lib/restTimer";
import { RestDock } from "../src/components/workout/RestDock";
import type { Exercise, SetEntry } from "../src/lib/workoutLog";

// The rest timer stores an END TIME. Every test here drives it with a plain
// number for "now", so a reload, a sleeping phone or a late tick is just a
// different number passed in — no fake timers needed.

/** A tiny in-memory stand-in for localStorage. */
function memoryStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const ex = (over: Partial<Exercise> & Record<string, unknown>): Exercise =>
  ({ id: "ex-x", name: "X", muscle: "chest", equipment: "barbell", type: "compound", ...over }) as Exercise;
const working = { reps: 5, weight: 185 } as SetEntry;
const warmup = { reps: 5, weight: 95, kind: "warmup" } as SetEntry;

describe("restStart / restAdd / restSkip", () => {
  it("start at 0 with 90 s ends at 90000; +15 moves it to 105000", () => {
    const s = restStart(0, 90);
    expect(s.endsAt).toBe(90000);
    expect(restRemaining(s, 0)).toBe(90);
    const plus = restAdd(s, 0, 15);
    expect(plus.endsAt).toBe(105000);
    expect(restRemaining(plus, 0)).toBe(105);
  });

  it("0 seconds (cardio) starts no timer", () => {
    expect(restStart(1000, 0)).toEqual(REST_IDLE);
  });

  it("−15 never puts the end before now", () => {
    const s = restStart(0, 90); // ends 90000
    expect(restAdd(s, 80000, -15).endsAt).toBe(80000);
    expect(restAdd(s, 10000, -15).endsAt).toBe(75000);
    // already over: −15 changes nothing
    expect(restAdd(s, 95000, -15)).toEqual(s);
  });

  it("+15 after the rest is over counts from now and re-arms the alert", () => {
    const fired = restMarkFired(restStart(0, 90));
    const plus = restAdd(fired, 100000, 15);
    expect(plus.endsAt).toBe(115000);
    expect(plus.fired).toBe(false);
  });

  it("Skip clears the rest", () => {
    const s = restSkip();
    expect(s).toEqual(REST_IDLE);
    expect(restRemaining(s, 5000)).toBe(0);
    expect(restIsOver(s, 5000)).toBe(false);
    expect(restAdd(s, 0, 15)).toEqual(REST_IDLE);
  });

  it("remaining rounds up, so the clock reads 0 exactly when over", () => {
    const s = restStart(0, 90);
    expect(restRemaining(s, 89001)).toBe(1);
    expect(restIsOver(s, 89999)).toBe(false);
    expect(restRemaining(s, 90000)).toBe(0);
    expect(restIsOver(s, 90000)).toBe(true);
    expect(restRemaining(s, 500000)).toBe(0);
  });
});

describe("end-of-rest alert fires once", () => {
  it("fires at zero, not before, and not again once marked — even if checked twice", () => {
    let s: RestState = restStart(0, 60);
    expect(restShouldFire(s, 59999)).toBe(false);
    expect(restShouldFire(s, 60000)).toBe(true);

    let alerts = 0;
    for (const now of [60000, 60250, 60250, 61000]) {
      if (restShouldFire(s, now)) {
        alerts++;
        s = restMarkFired(s);
      }
    }
    expect(alerts).toBe(1);
    expect(restIsOver(s, 61000)).toBe(true); // still says "Rest over" until Skip
  });

  it("a reload after the alert played does not play it again", () => {
    const store = memoryStore();
    saveRest("gino", restMarkFired(restStart(0, 60)), store);
    const reloaded = loadRest("gino", store);
    expect(restIsOver(reloaded, 120000)).toBe(true);
    expect(restShouldFire(reloaded, 120000)).toBe(false);
  });
});

describe("persistence", () => {
  it("a reload computes remaining from the stored endsAt", () => {
    const store = memoryStore();
    saveRest("gino", restStart(1_000_000, 90), store); // ends 1_090_000
    expect(store.m.has(restKey("gino"))).toBe(true);
    expect(restKey("gino")).toBe("hb-rest-gino");

    // The phone slept for 40 s and the app reloaded.
    const reloaded = loadRest("gino", store);
    expect(reloaded.endsAt).toBe(1_090_000);
    expect(restRemaining(reloaded, 1_040_000)).toBe(50);
    // Another person's timer is separate.
    expect(loadRest("xinyan", store)).toEqual(REST_IDLE);
  });

  it("state survives a JSON round trip", () => {
    for (const s of [restStart(123, 90), restMarkFired(restStart(5, 60)), restAdd(restStart(0, 90), 0, 15)]) {
      expect(parseRest(serializeRest(s))).toEqual(s);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it("Skip removes the stored rest", () => {
    const store = memoryStore();
    saveRest("xinyan", restStart(0, 60), store);
    saveRest("xinyan", restSkip(), store);
    expect(store.m.has(restKey("xinyan"))).toBe(false);
    expect(serializeRest(REST_IDLE)).toBeNull();
  });

  it("anything unreadable is treated as not resting", () => {
    for (const raw of [null, "", "not json", "{}", '{"endsAt":"soon"}', "null", '{"endsAt":null}']) {
      expect(parseRest(raw)).toEqual(REST_IDLE);
    }
    // an older stored value with no fired flag still loads
    expect(parseRest('{"endsAt":90000}')).toEqual({ endsAt: 90000, fired: false });
  });

  it("blocked storage never throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadRest("gino", broken)).toEqual(REST_IDLE);
    expect(() => saveRest("gino", restStart(0, 90), broken)).not.toThrow();
  });
});

describe("restDefault", () => {
  it("uses the v1 defaults", () => {
    expect(restDefault(ex({ type: "compound" }), working)).toBe(120);
    expect(restDefault(ex({ type: "isolation" }), working)).toBe(90);
    expect(restDefault(ex({ type: "compound" }), warmup)).toBe(60);
    expect(restDefault(ex({ type: "compound", mode: "bodyweight" }), working)).toBe(60);
    expect(restDefault(ex({ type: "isolation", mode: "band" }), working)).toBe(60);
    expect(restDefault(ex({ type: "isolation", mode: "timed" }), working)).toBe(60);
    expect(restDefault(ex({ type: "cardio" }), working)).toBe(0);
    expect(restDefault(ex({ type: "compound", mode: "cardio" }), working)).toBe(0);
    expect(restDefault(ex({ type: "cardio" }), warmup)).toBe(0); // cardio has no timer, warm-up or not
    expect(restDefault(ex({ type: "compound", mode: "weighted" }), working)).toBe(120);
  });

  it("an exercise not in the library gets 90 s (60 s for a warm-up)", () => {
    expect(restDefault(undefined, working)).toBe(90);
    expect(restDefault(undefined, warmup)).toBe(60);
  });
});

describe("RestDock", () => {
  const noop = () => {};
  const html = (remaining: number, over: boolean, label = "Bench press") =>
    renderToStaticMarkup(createElement(RestDock, { remaining, over, label, onAdd: noop, onSkip: noop }));

  it("shows the countdown as m:ss with −15, +15 and Skip", () => {
    const out = html(84, false);
    expect(out).toContain("1:24");
    expect(out).toContain("Rest · Bench press");
    expect(out).toContain("−15");
    expect(out).toContain("+15");
    expect(out).toContain("Skip");
    expect(html(5, false)).toContain("0:05");
    expect(html(125, false)).toContain("2:05");
  });

  it("says Rest over at zero", () => {
    const out = html(0, true);
    expect(out).toContain("Rest over");
    expect(out).not.toContain("−15");
    expect(out).toContain("+15");
  });
});
