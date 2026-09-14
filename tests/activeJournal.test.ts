import { describe, it, expect } from "vitest";
import {
  clearJournal,
  journalKey,
  readJournal,
  resolveJournal,
  writeJournal,
  type ActiveJournal,
  type JournalStorage,
} from "../src/lib/activeJournal";
import type { SyncSet } from "../src/lib/syncMerge";
import type { ExerciseEntry, Workout } from "../src/lib/workoutLog";

// The phone copy exists for one moment: the app died between a tick and the save
// reaching the server. So the tests are about that moment — what the next load
// does with a phone copy and a server copy that disagree — plus the promise that
// storage failing never breaks logging.

function memoryStorage(): JournalStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const throwing: JournalStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

const s = (id: string | undefined, weight = 100, reps = 5, extra: Partial<SyncSet> = {}): SyncSet => ({
  ...(id === undefined ? {} : { id }),
  weight,
  reps,
  ...extra,
});
const ticked = (id: string, doneAt: number, weight = 100, reps = 5) => s(id, weight, reps, { done: true, doneAt });
const open = (id: string, weight = 0, reps = 0) => s(id, weight, reps, { done: false });
const ex = (id: string, sets: SyncSet[]): ExerciseEntry => ({ id, exerciseId: "", name: `Exercise ${id}`, muscle: "chest", sets });
const wk = (exercises: ExerciseEntry[], over: Partial<Workout> = {}): Workout => ({
  id: "w1",
  date: "2026-09-14",
  person: "gino",
  name: "Workout",
  notes: "",
  exercises,
  done: false,
  ...over,
});
const journal = (workout: Workout, savedAt = 5000, over: Partial<ActiveJournal> = {}): ActiveJournal => ({ workout, savedAt, ...over });
const setIds = (w: Workout, exId = "e1") => (w.exercises.find((e) => e.id === exId)!.sets as SyncSet[]).map((x) => x.id);

describe("writing and reading the phone copy", () => {
  it("round-trips under hb-active-<person> with savedAt and what was deleted", () => {
    const st = memoryStorage();
    const w = wk([ex("e1", [ticked("a", 1000)])]);
    writeJournal(w, { now: 4242, storage: st, removedSets: new Set(["b"]), removedExercises: ["e9"] });
    expect(journalKey("gino")).toBe("hb-active-gino");
    expect([...st.data.keys()]).toEqual(["hb-active-gino"]);
    expect(readJournal("gino", st)).toEqual({ workout: w, savedAt: 4242, removedSets: ["b"], removedExercises: ["e9"] });
    expect(readJournal("xinyan", st)).toBeNull();
  });

  it("keeps fields another piece stored for the SAME session, drops them for a different one", () => {
    const st = memoryStorage();
    st.setItem("hb-active-gino", JSON.stringify({ workout: wk([]), savedAt: 1, startedAt: 777, rest: { endsAt: 9 } }));
    writeJournal(wk([ex("e1", [])]), { now: 2, storage: st });
    expect(JSON.parse(st.getItem("hb-active-gino")!)).toMatchObject({ startedAt: 777, rest: { endsAt: 9 }, savedAt: 2 });
    writeJournal(wk([], { id: "w2" }), { now: 3, storage: st });
    const raw = JSON.parse(st.getItem("hb-active-gino")!);
    expect(raw.startedAt).toBeUndefined();
    expect(raw.workout.id).toBe("w2");
  });

  it("anything that doesn't look like a session reads as none", () => {
    const st = memoryStorage();
    const put = (v: string) => st.setItem("hb-active-gino", v);
    for (const bad of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ savedAt: 1 }),
      JSON.stringify({ workout: { id: "w1", date: "2026-09-14", person: "xinyan", exercises: [] } }), // wrong person's slot
      JSON.stringify({ workout: { id: 5, date: "2026-09-14", person: "gino", exercises: [] } }),
      JSON.stringify({ workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [{ id: "e1" }] } }), // no sets array
    ]) {
      put(bad);
      expect(readJournal("gino", st)).toBeNull();
    }
    expect(readJournal("gino", memoryStorage())).toBeNull();
  });

  it("fills missing plain fields and ignores malformed tombstone lists", () => {
    const st = memoryStorage();
    st.setItem(
      "hb-active-gino",
      JSON.stringify({ workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [] }, removedSets: [1, 2] }),
    );
    expect(readJournal("gino", st)).toEqual({
      workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [], name: "", notes: "", done: false },
      savedAt: 0,
      removedExercises: undefined,
      removedSets: undefined,
    });
  });

  it("blocked or full storage never throws, and no storage at all is fine", () => {
    const w = wk([]);
    expect(() => writeJournal(w, { storage: throwing })).not.toThrow();
    expect(() => readJournal("gino", throwing)).not.toThrow();
    expect(readJournal("gino", throwing)).toBeNull();
    expect(() => clearJournal("gino", "w1", throwing)).not.toThrow();
    expect(() => writeJournal(w, { storage: null })).not.toThrow();
    expect(readJournal("gino", null)).toBeNull();
    // the test runner has no localStorage: the defaults must cope too
    expect(() => writeJournal(w)).not.toThrow();
    expect(readJournal("gino")).toBeNull();
    expect(() => clearJournal("gino", "w1")).not.toThrow();
  });

  it("clearing removes the slot only if it still holds that session", () => {
    const st = memoryStorage();
    writeJournal(wk([], { id: "w2" }), { storage: st });
    clearJournal("gino", "w1", st);
    expect(readJournal("gino", st)?.workout.id).toBe("w2");
    clearJournal("gino", "w2", st);
    expect(st.data.size).toBe(0);
  });
});

describe("merging the phone copy with the server copy on load", () => {
  it("the phone copy's extra ticked set survives", () => {
    const server = wk([ex("e1", [ticked("a", 1000)])]);
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000)])]);
    const r = resolveJournal(server, journal(phone, 2001));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect(setIds(r.workout)).toEqual(["a", "b"]);
  });

  it("a set ticked on the phone that the server still shows open is kept ticked", () => {
    const server = wk([ex("e1", [open("a"), open("b")])]);
    const phone = wk([ex("e1", [ticked("a", 1500, 185, 5), open("b")])]);
    const r = resolveJournal(server, journal(phone, 1600));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect(r.workout.exercises[0].sets[0]).toEqual(ticked("a", 1500, 185, 5));
  });

  it("server has the later tick and the phone adds nothing → the server copy wins", () => {
    const server = wk([ex("e1", [ticked("a", 1000), ticked("b", 9000)])]);
    const phone = wk([ex("e1", [ticked("a", 1000), open("b")])]);
    expect(resolveJournal(server, journal(phone, 5000))).toEqual({ action: "keep" });
  });

  it("both ticked the same set: the later tick wins", () => {
    const server = wk([ex("e1", [ticked("a", 9000, 190, 5)])]);
    const phone = wk([ex("e1", [ticked("a", 3000, 185, 5)])]);
    expect(resolveJournal(server, journal(phone, 3000))).toEqual({ action: "keep" });
    const r = resolveJournal(wk([ex("e1", [ticked("a", 1000, 185, 5)])]), journal(wk([ex("e1", [ticked("a", 3000, 190, 5)])])));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect(r.workout.exercises[0].sets[0].weight).toBe(190);
  });

  it("a phone un-tick AFTER the server's tick is kept (the tick is older than the phone copy)", () => {
    const server = wk([ex("e1", [ticked("a", 1000)])]);
    const phone = wk([ex("e1", [open("a", 100, 5)])]);
    const r = resolveJournal(server, journal(phone, 4000));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect((r.workout.exercises[0].sets[0] as SyncSet).done).toBe(false);
  });

  it("the other phone's sets and exercises are kept alongside the phone copy's", () => {
    const server = wk([ex("e1", [ticked("a", 1000), ticked("x", 1100)]), ex("e2", [ticked("y", 1200)])]);
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000)])]);
    const r = resolveJournal(server, journal(phone, 2000));
    expect(r.action).toBe("restore");
    if (r.action === "restore") {
      expect(setIds(r.workout)).toEqual(["a", "b", "x"]);
      expect(r.workout.exercises.map((e) => e.id)).toEqual(["e1", "e2"]);
    }
  });

  it("a set or exercise deleted on the phone doesn't come back from the server copy", () => {
    const server = wk([ex("e1", [ticked("a", 1000), ticked("b", 1100)]), ex("e2", [ticked("y", 1200)])]);
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("c", 3000)])]);
    const r = resolveJournal(server, journal(phone, 3000, { removedSets: ["b"], removedExercises: ["e2"] }));
    expect(r.action).toBe("restore");
    if (r.action === "restore") {
      expect(setIds(r.workout)).toEqual(["a", "c"]);
      expect(r.workout.exercises.map((e) => e.id)).toEqual(["e1"]);
      expect(r.tombstones).toEqual({ exercises: ["e2"], sets: ["b"] });
    }
  });

  it("a deletion alone, with nothing else new, still restores (the server copy still has the set)", () => {
    const server = wk([ex("e1", [ticked("a", 1000), ticked("b", 1100)])]);
    const phone = wk([ex("e1", [ticked("a", 1000)])]);
    const r = resolveJournal(server, journal(phone, 3000, { removedSets: ["b"] }));
    expect(r.action).toBe("restore");
  });

  it("identical copies → keep, even when the server reordered the object keys", () => {
    const phone = wk([ex("e1", [ticked("a", 1000)])]);
    const server = wk([
      { sets: [{ doneAt: 1000, done: true, reps: 5, weight: 100, id: "a" }], muscle: "chest", name: "Exercise e1", exerciseId: "", id: "e1" },
    ]);
    expect(resolveJournal(server, journal(phone))).toEqual({ action: "keep" });
  });

  it("sets without ids can't be matched: the phone's exercise wins whole", () => {
    const server = wk([ex("e1", [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }])]);
    const phone = wk([ex("e1", [{ reps: 5, weight: 100 }, { reps: 6, weight: 100 }])]);
    const r = resolveJournal(server, journal(phone));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect(r.workout.exercises[0]).toEqual(phone.exercises[0]);
  });

  it("duplicate ids in the phone copy are repaired first (injected maker)", () => {
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("a", 1000)])]);
    const r = resolveJournal(undefined, journal(phone), () => "fresh");
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect(setIds(r.workout)).toEqual(["a", "fresh"]);
  });

  it("never reached the server: restored when something was logged, cleared when not", () => {
    const logged = wk([ex("e1", [ticked("a", 1000)])]);
    expect(resolveJournal(undefined, journal(logged))).toEqual({
      action: "restore",
      workout: logged,
      tombstones: { exercises: [], sets: [] },
    });
    // an old-style set with reps and no `done` counts as logged
    expect(resolveJournal(undefined, journal(wk([ex("e1", [s(undefined, 100, 5)])]))).action).toBe("restore");
    // a timed exercise with minutes counts as logged
    expect(resolveJournal(undefined, journal(wk([{ ...ex("e1", []), duration: 20 }]))).action).toBe("restore");
    expect(resolveJournal(undefined, journal(wk([ex("e1", [open("a", 185, 5)])])))).toEqual({ action: "clear" });
    expect(resolveJournal(undefined, journal(wk([])))).toEqual({ action: "clear" });
  });

  it("a finished session clears the phone copy", () => {
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000)])]);
    expect(resolveJournal(wk([ex("e1", [ticked("a", 1000)])], { done: true }), journal(phone))).toEqual({ action: "clear" });
    expect(resolveJournal(undefined, journal({ ...phone, done: true }))).toEqual({ action: "clear" });
  });

  it("the phone copy's name and notes are its newest edit", () => {
    const sets = [ticked("a", 1000)];
    const r = resolveJournal(wk([ex("e1", sets)]), journal(wk([ex("e1", sets)], { name: "Legs", notes: "knee ok" })));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect([r.workout.name, r.workout.notes]).toEqual(["Legs", "knee ok"]);
  });
});
