// ── The rest timer ──────────────────────────────────────────────────────────
// Stores the END TIME, never a counter (SPEC §7.1). A phone that sleeps, a tab
// that is paused, or an app that is killed and reopened all come back to the
// same `endsAt`, and the screen always shows `endsAt − now`. A counter would
// have stopped the moment the page stopped running.
//
// Every state change is a pure function of (state, now) so it can be tested
// with a fake clock; the hook at the bottom only wires them to React, a 250 ms
// tick and localStorage.
//
// The "fired" flag is saved beside `endsAt` so the end-of-rest beep plays ONCE
// per rest: not again on the next render, and not again after a reload that
// lands past zero.

import { useEffect, useRef, useState } from "react";
import { restOverAlert } from "./restAlert";
import { isWarmup } from "./trainingMath";
import type { Exercise, Person, SetEntry } from "./workoutLog";

// ── defaults ───────────────────────────────────────────────────────────────────
/**
 * Default rest in seconds for the set just ticked; 0 = no timer (V1.md).
 * These are our conventions, not tested numbers: cardio has no timer, a
 * warm-up gets 60 s, bodyweight / band / timed work 60 s, an exercise that
 * moves several joints 120 s, everything else 90 s.
 */
export function restDefault(ex: Exercise | undefined, set: SetEntry): number {
  // `mode` and `kind` are optional (workout mode v1); older stored sets and
  // exercises without them fall back to the exercise type and "working".
  const mode = ex ? (ex.mode ?? (ex.type === "cardio" ? "cardio" : "weighted")) : undefined;
  if (mode === "cardio") return 0;
  if (isWarmup(set)) return 60;
  if (mode === "bodyweight" || mode === "band" || mode === "timed") return 60;
  if (ex?.type === "compound") return 120;
  return 90;
}

// ── pure state ─────────────────────────────────────────────────────────────────
export interface RestState {
  endsAt: number | null; // ms since epoch; null = not resting
  fired: boolean; // the end-of-rest alert has already played for this endsAt
}

export const REST_IDLE: RestState = { endsAt: null, fired: false };

/** Start (or restart) a rest of `sec` seconds. 0 or less means no timer. */
export function restStart(now: number, sec: number): RestState {
  if (!(sec > 0)) return REST_IDLE;
  return { endsAt: now + sec * 1000, fired: false };
}

/**
 * Move the end time by `sec` (±15 from the dock). Taking time off never puts
 * the end before now. Adding time to a rest that is already over counts from
 * now, so +15 really gives 15 more seconds, and the alert is re-armed for the
 * new end.
 */
export function restAdd(state: RestState, now: number, sec: number): RestState {
  if (state.endsAt === null || !sec || !Number.isFinite(sec)) return state;
  if (sec < 0) {
    if (state.endsAt <= now) return state; // already over: nothing left to take off
    return { ...state, endsAt: Math.max(now, state.endsAt + sec * 1000) };
  }
  return { endsAt: Math.max(state.endsAt, now) + sec * 1000, fired: false };
}

export function restSkip(): RestState {
  return REST_IDLE;
}

/** Whole seconds left, rounded up so the clock reads 0:00 exactly when the rest is over. */
export function restRemaining(state: RestState, now: number): number {
  if (state.endsAt === null) return 0;
  return Math.max(0, Math.ceil((state.endsAt - now) / 1000));
}

export function restIsOver(state: RestState, now: number): boolean {
  return state.endsAt !== null && now >= state.endsAt;
}

/** True exactly when the alert should play now: over, and not played yet for this end time. */
export function restShouldFire(state: RestState, now: number): boolean {
  return restIsOver(state, now) && !state.fired;
}

export function restMarkFired(state: RestState): RestState {
  return state.endsAt === null ? state : { ...state, fired: true };
}

// ── persistence (per phone, per person) ─────────────────────────────────────────
export const restKey = (person: Person) => `hb-rest-${person}`;

/** Parse what was stored; anything unreadable is treated as "not resting". */
export function parseRest(raw: string | null): RestState {
  if (!raw) return REST_IDLE;
  try {
    const v = JSON.parse(raw) as { endsAt?: unknown; fired?: unknown };
    if (typeof v?.endsAt !== "number" || !Number.isFinite(v.endsAt)) return REST_IDLE;
    return { endsAt: v.endsAt, fired: v.fired === true };
  } catch {
    return REST_IDLE;
  }
}

/** What to store; null means remove the key. */
export function serializeRest(state: RestState): string | null {
  return state.endsAt === null ? null : JSON.stringify({ endsAt: state.endsAt, fired: state.fired });
}

type RestStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): RestStore | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export function loadRest(person: Person, store: RestStore | undefined = browserStore()): RestState {
  try {
    return parseRest(store?.getItem(restKey(person)) ?? null);
  } catch {
    return REST_IDLE; // storage blocked (private mode) — a rest just won't survive a reload
  }
}

export function saveRest(person: Person, state: RestState, store: RestStore | undefined = browserStore()): void {
  try {
    const raw = serializeRest(state);
    if (raw === null) store?.removeItem(restKey(person));
    else store?.setItem(restKey(person), raw);
  } catch {
    /* storage blocked or full — the timer still runs for this page */
  }
}

// ── hook ───────────────────────────────────────────────────────────────────────
/**
 * The running rest for one person. `remaining` is whole seconds; `over` is true
 * from zero until Skip. Ticks every 250 ms only while a rest is waiting to end,
 * and plays the end-of-rest alert once. `now` is injectable for tests.
 */
export function useRestTimer(person: Person, now: () => number = Date.now) {
  const [state, setState] = useState<RestState>(() => loadRest(person));
  const [nowMs, setNowMs] = useState(() => now());
  const [loadedFor, setLoadedFor] = useState(person);
  const clock = useRef(now);
  useEffect(() => {
    clock.current = now;
  });

  // Switching person swaps to that person's stored rest (adjusting state during
  // render, so there is never a frame showing the other person's timer).
  if (loadedFor !== person) {
    setLoadedFor(person);
    setState(loadRest(person));
    setNowMs(now());
  }

  const commit = (next: RestState, t: number) => {
    setState(next);
    setNowMs(t);
    saveRest(person, next);
  };

  const { endsAt, fired } = state;
  useEffect(() => {
    if (endsAt === null || fired) return; // idle, or over and already alerted: nothing to watch
    let done = false;
    const id = setInterval(() => {
      if (done) return;
      const t = clock.current();
      const cur: RestState = { endsAt, fired };
      if (restShouldFire(cur, t)) {
        done = true;
        clearInterval(id);
        restOverAlert();
        const next = restMarkFired(cur);
        setState(next);
        saveRest(person, next);
      }
      setNowMs(t);
    }, 250);
    return () => {
      done = true;
      clearInterval(id);
    };
  }, [endsAt, fired, person]);

  return {
    endsAt,
    remaining: restRemaining(state, nowMs),
    over: restIsOver(state, nowMs),
    start(sec: number) {
      const t = clock.current();
      commit(restStart(t, sec), t);
    },
    add(sec: number) {
      const t = clock.current();
      commit(restAdd(state, t, sec), t);
    },
    skip() {
      commit(restSkip(), clock.current());
    },
  };
}
