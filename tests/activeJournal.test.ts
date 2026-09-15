import { describe, it, expect } from "vitest";
import {
  clearJournal,
  confirmJournal,
  journalKey,
  readJournal,
  readJournals,
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
// storage failing never breaks logging, and that a copy whose saves all landed
// never overrides what happened on the server since.

function memoryStorage(opts: { failWritesAfter?: number } = {}): JournalStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let writes = 0;
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (opts.failWritesAfter !== undefined && ++writes > opts.failWritesAfter) throw new Error("quota");
      data.set(k, v);
    },
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
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
  key: () => {
    throw new Error("blocked");
  },
  get length(): number {
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
// an unconfirmed copy: one edit written, no save of it confirmed yet
const journal = (workout: Workout, savedAt = 5000, over: Partial<ActiveJournal> = {}): ActiveJournal => ({
  workout,
  savedAt,
  edits: 1,
  confirmed: 0,
  onServer: false,
  ...over,
});
const setIds = (w: Workout, exId = "e1") => (w.exercises.find((e) => e.id === exId)!.sets as SyncSet[]).map((x) => x.id);

describe("writing and reading the phone copy", () => {
  it("round-trips under hb-active-<person>:<id> with savedAt, what was deleted, and one more edit", () => {
    const st = memoryStorage();
    const w = wk([ex("e1", [ticked("a", 1000)])]);
    writeJournal(w, { now: 4242, storage: st, removedSets: new Set(["b"]), removedExercises: ["e9"] });
    expect(journalKey("gino", "w1")).toBe("hb-active-gino:w1");
    expect([...st.data.keys()]).toEqual(["hb-active-gino:w1"]);
    expect(readJournal("gino", "w1", st)).toEqual({
      workout: w,
      savedAt: 4242,
      removedSets: ["b"],
      removedExercises: ["e9"],
      edits: 1,
      confirmed: 0,
      onServer: false,
    });
    writeJournal(w, { storage: st, onServer: true });
    expect(readJournal("gino", "w1", st)).toMatchObject({ edits: 2, confirmed: 0, onServer: true });
    writeJournal(w, { storage: st }); // once known to be on the server, it stays known
    expect(readJournal("gino", "w1", st)?.onServer).toBe(true);
    expect(readJournal("xinyan", "w1", st)).toBeNull();
    expect(readJournals("xinyan", st)).toEqual([]);
  });

  it("keeps fields another piece stored in the session's slot", () => {
    const st = memoryStorage();
    st.setItem("hb-active-gino:w1", JSON.stringify({ workout: wk([]), savedAt: 1, startedAt: 777, rest: { endsAt: 9 } }));
    writeJournal(wk([ex("e1", [])]), { now: 2, storage: st });
    expect(JSON.parse(st.getItem("hb-active-gino:w1")!)).toMatchObject({ startedAt: 777, rest: { endsAt: 9 }, savedAt: 2 });
  });

  // Scratch test S12: offline at load, the old session can't show, so a new one
  // is started — and writing it used to replace the one slot holding the old
  // session's sets, which had never reached the server.
  it("starting another session keeps the first session's unsaved copy (one slot per session)", () => {
    const st = memoryStorage();
    const first = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000), ticked("c", 3000)])], { id: "w-gym" });
    writeJournal(first, { storage: st });
    writeJournal(wk([], { id: "w-new" }), { storage: st });
    writeJournal(wk([ex("e1", [open("x")])], { id: "w-new" }), { storage: st });
    const all = readJournals("gino", st);
    expect(all.map((j) => j.workout.id).sort()).toEqual(["w-gym", "w-new"]);
    const gym = all.find((j) => j.workout.id === "w-gym")!;
    expect(setIds(gym.workout)).toEqual(["a", "b", "c"]);
    expect(resolveJournal(undefined, gym).action).toBe("restore");
  });

  it("a copy in the first version's one-per-person slot is read, and moved to its own slot", () => {
    const st = memoryStorage();
    const w = wk([ex("e1", [ticked("a", 1000)])]);
    st.setItem("hb-active-gino", JSON.stringify({ workout: w, savedAt: 7, removedSets: ["z"] }));
    const [j] = readJournals("gino", st);
    // no counts in that version: one edit, never confirmed — how it treated every copy
    expect(j).toEqual({ workout: w, savedAt: 7, removedSets: ["z"], removedExercises: undefined, edits: 1, confirmed: 0, onServer: false });
    expect([...st.data.keys()]).toEqual(["hb-active-gino:w1"]);
    expect(readJournals("gino", st)).toHaveLength(1);
  });

  it("anything that doesn't look like a session reads as none", () => {
    const st = memoryStorage();
    const put = (v: string) => st.setItem("hb-active-gino:w1", v);
    for (const bad of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ savedAt: 1 }),
      JSON.stringify({ workout: { id: "w1", date: "2026-09-14", person: "xinyan", exercises: [] } }), // wrong person's slot
      JSON.stringify({ workout: { id: 5, date: "2026-09-14", person: "gino", exercises: [] } }),
      JSON.stringify({ workout: { id: "w2", date: "2026-09-14", person: "gino", exercises: [] } }), // another session's id
      JSON.stringify({ workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [{ id: "e1" }] } }), // no sets array
    ]) {
      put(bad);
      expect(readJournal("gino", "w1", st)).toBeNull();
      expect(readJournals("gino", st)).toEqual([]);
    }
    expect(readJournal("gino", "w1", memoryStorage())).toBeNull();
  });

  it("fills missing plain fields and ignores malformed tombstone lists and counts", () => {
    const st = memoryStorage();
    st.setItem(
      "hb-active-gino:w1",
      JSON.stringify({
        workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [] },
        removedSets: [1, 2],
        edits: 2,
        confirmed: 9, // more confirmed than written can't be: capped
        base: { id: "nope" },
      }),
    );
    expect(readJournal("gino", "w1", st)).toEqual({
      workout: { id: "w1", date: "2026-09-14", person: "gino", exercises: [], name: "", notes: "", done: false },
      savedAt: 0,
      removedExercises: undefined,
      removedSets: undefined,
      edits: 2,
      confirmed: 2,
      onServer: false,
    });
  });

  it("blocked or full storage never throws, and no storage at all is fine", () => {
    const w = wk([]);
    expect(() => writeJournal(w, { storage: throwing })).not.toThrow();
    expect(() => readJournal("gino", "w1", throwing)).not.toThrow();
    expect(readJournal("gino", "w1", throwing)).toBeNull();
    expect(readJournals("gino", throwing)).toEqual([]);
    expect(() => confirmJournal(w, throwing)).not.toThrow();
    expect(() => clearJournal("gino", "w1", throwing)).not.toThrow();
    expect(() => writeJournal(w, { storage: null })).not.toThrow();
    expect(readJournals("gino", null)).toEqual([]);
    // the test runner has no localStorage: the defaults must cope too
    expect(() => writeJournal(w)).not.toThrow();
    expect(readJournals("gino")).toEqual([]);
    expect(() => confirmJournal(w)).not.toThrow();
    expect(() => clearJournal("gino", "w1")).not.toThrow();
  });

  it("clearing removes only that session's slot", () => {
    const st = memoryStorage();
    writeJournal(wk([], { id: "w1" }), { storage: st });
    writeJournal(wk([], { id: "w2" }), { storage: st });
    clearJournal("gino", "w1", st);
    expect(readJournals("gino", st).map((j) => j.workout.id)).toEqual(["w2"]);
    clearJournal("gino", "w2", st);
    expect(st.data.size).toBe(0);
  });
});

describe("a copy whose saves all landed never overrides the server", () => {
  // Scratch test S1: phone A logged x, y, z and exercise e2, and every save
  // landed. Phone B then fixed x to 105 lb, un-ticked y, deleted z and e2. On
  // A's next load the lingering copy used to write all of that back.
  const logged = () => wk([ex("e1", [ticked("x", 1000, 100), ticked("y", 1100), ticked("z", 1200)]), ex("e2", [ticked("q", 1300)])]);
  const afterB = () => wk([ex("e1", [ticked("x", 1000, 105), open("y", 100, 5)])]);

  it("confirmed copy → cleared, and B's edits stand", () => {
    const st = memoryStorage();
    writeJournal(logged(), { storage: st });
    confirmJournal(logged(), st);
    const j = readJournal("gino", "w1", st)!;
    expect(j).toMatchObject({ edits: 1, confirmed: 1, onServer: true });
    expect(resolveJournal(afterB(), j)).toEqual({ action: "clear" });
  });

  it("an unconfirmed edit after the confirmed save keeps only that edit; B's changes to untouched sets stand", () => {
    const st = memoryStorage();
    writeJournal(logged(), { storage: st });
    confirmJournal(logged(), st);
    // A ticks one more set; the app dies before that save lands
    const more = logged();
    more.exercises[0].sets.push(ticked("w", 9000));
    writeJournal(more, { storage: st });
    const r = resolveJournal(afterB(), readJournal("gino", "w1", st)!);
    expect(r.action).toBe("restore");
    if (r.action !== "restore") return;
    expect(r.workout.exercises.map((e) => e.id)).toEqual(["e1"]); // e2 stays deleted
    const sets = r.workout.exercises[0].sets as SyncSet[];
    expect(sets.map((x) => x.id)).toEqual(["x", "y", "w"]); // z stays deleted, w is kept
    expect(sets[0].weight).toBe(105); // B's fix
    expect(sets[1].done).toBe(false); // B's un-tick
  });

  it("a set this phone changed after the confirmed save still wins over the server", () => {
    const st = memoryStorage();
    writeJournal(logged(), { storage: st });
    confirmJournal(logged(), st);
    const edited = logged();
    edited.exercises[0].sets[2] = ticked("z", 1200, 110);
    writeJournal(edited, { storage: st, removedExercises: [] });
    const server = wk([ex("e1", [ticked("x", 1000), ticked("y", 1100), ticked("z", 1200)]), ex("e2", [ticked("q", 1300)])]);
    const r = resolveJournal(server, readJournal("gino", "w1", st)!);
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect((r.workout.exercises[0].sets[2] as SyncSet).weight).toBe(110);
  });

  it("untouched name and notes take the server's; edited ones stay", () => {
    const base = wk([ex("e1", [ticked("a", 1000)])], { name: "Legs", notes: "" });
    const mine = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000)])], { name: "Legs", notes: "knee ok" });
    const server = wk([ex("e1", [ticked("a", 1000)])], { name: "Lower A", notes: "from B" });
    const r = resolveJournal(server, journal(mine, 2000, { edits: 2, confirmed: 1, onServer: true, base }));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect([r.workout.name, r.workout.notes]).toEqual(["Lower A", "knee ok"]);
  });

  it("a copy left stale by a failed copy write is confirmed by the next save that lands", () => {
    const st = memoryStorage({ failWritesAfter: 1 });
    writeJournal(wk([ex("e1", [ticked("a", 1000)])]), { storage: st });
    // storage is full now: this edit never reaches the copy
    writeJournal(wk([ex("e1", [ticked("a", 1000, 120)])]), { storage: st });
    // …but its save lands; the stamp can't be written either, so the copy goes
    confirmJournal(wk([ex("e1", [ticked("a", 1000, 120)])]), st);
    expect(readJournals("gino", st)).toEqual([]);
  });

  // Scratch test S2: finished and deleted from history on phone B; phone A's copy
  // used to bring the deleted session back.
  it("a session once on the server and gone now was deleted on purpose → cleared", () => {
    const copy = wk([ex("e1", [ticked("a", 1000)])]);
    expect(resolveJournal(undefined, journal(copy, 5000, { onServer: true }))).toEqual({ action: "clear" });
    expect(resolveJournal(undefined, journal(copy, 5000, { edits: 3, confirmed: 3 }))).toEqual({ action: "clear" });
    // never on the server and logged → still restored
    expect(resolveJournal(undefined, journal(copy)).action).toBe("restore");
  });
});

describe("a finish is kept on the phone until the server has it", () => {
  it("a finished copy against an unfinished server copy restores the finish", () => {
    const server = wk([ex("e1", [ticked("a", 1000), open("b")])]);
    const finished = wk([ex("e1", [ticked("a", 1000)])], { done: true });
    const r = resolveJournal(server, journal(finished, 3000, { onServer: true, removedSets: ["b"] }));
    expect(r.action).toBe("restore");
    if (r.action !== "restore") return;
    expect(r.workout.done).toBe(true);
    expect(setIds(r.workout)).toEqual(["a"]);
  });

  it("a finished copy that never reached the server is restored finished (a quick log)", () => {
    const quick = wk([{ ...ex("e1", []), duration: 30 }], { done: true });
    const r = resolveJournal(undefined, journal(quick));
    expect(r).toMatchObject({ action: "restore", workout: { done: true } });
  });

  it("already finished on the server with the same sets → keep", () => {
    const w = wk([ex("e1", [ticked("a", 1000)])], { done: true });
    expect(resolveJournal(w, journal(w))).toEqual({ action: "keep" });
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

  it("a session finished on another phone clears this phone's unfinished copy", () => {
    const phone = wk([ex("e1", [ticked("a", 1000), ticked("b", 2000)])]);
    expect(resolveJournal(wk([ex("e1", [ticked("a", 1000)])], { done: true }), journal(phone))).toEqual({ action: "clear" });
  });

  it("the phone copy's name and notes are its newest edit", () => {
    const sets = [ticked("a", 1000)];
    const r = resolveJournal(wk([ex("e1", sets)]), journal(wk([ex("e1", sets)], { name: "Legs", notes: "knee ok" })));
    expect(r.action).toBe("restore");
    if (r.action === "restore") expect([r.workout.name, r.workout.notes]).toEqual(["Legs", "knee ok"]);
  });
});
