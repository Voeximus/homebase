// The three things an assistant may do to its own memory: remember, forget, and
// put back what it just changed.
//
// All three are DIRECT — they land straight away — and all three are reversible,
// which is the phase-2 trade in its purest form: the worst a wrong one does is make
// a sentence in his own database wrong, and the sentence it replaced is still in
// the row next to it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE UNDO IS A TOOL AND NOT A TOKEN
//
// The rest of this phase hands back an undo token and keeps the before-state in
// muse_audit. The memory store does neither, on purpose, and there are two reasons
// that both point the same way:
//
//   1. muse_audit deliberately holds no reply bodies. audit.ts says why: the log is
//      readable by any signed-in household session, and a second copy of the
//      content in a log table is a second place for it to leak from. A memory value
//      is content. So nothing this file returns contains a memory's words — not in
//      `say`, not in `result` — because handler.ts stores both.
//
//   2. muse_audit gets trimmed. schema_v36's own housekeeping deletes rows older
//      than ninety days. A standing rule he corrects once a year would have an undo
//      that quietly stopped existing. The before-state lives in the row it is the
//      history of, so it lasts as long as the memory does.
//
// So memory's undo is `memory.restore <key>`: one call, no token to carry, and it
// works from a conversation started next month. (Or `memory.forget <key>`, when the
// write put a key INTO use — every reply names which one in `result.undo`; see done()
// below for the day it named restore for all of them.) The cost, stated plainly because it
// is a real one: a generic "undo the last thing you did" tool that reads muse_audit
// will not cover these three writes. It has to call memory.restore instead, and
// docs/research/muse-bridge/API.md says so where an assistant will read it.
//
// DEPTH IS ONE STEP. `previous` holds the state before the last change. Restore
// swaps the two, so restoring twice puts it back — which makes "no, the other one"
// work without a second table and without a tool that can walk backwards for ever.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO CLOCK IN HERE. Every timestamp is `ctx.at`, built once at the top of the
// request. tests/museWrite.test.ts and scripts/check-categorizer-sync.mjs both grep
// this folder for `new Date(`.

import type { Tool, ToolOutcome } from "./tools.ts";
import type { MemoryRecord } from "./memoryDb.ts";
import {
  LIVE_MAX,
  MEMORY_KEY,
  MEMORY_KINDS,
  TAGS_MAX,
  TAG_MAX,
  VALUE_MAX,
} from "../_shared/muse/memory.ts";
import { scrubCap, wasChanged } from "../_shared/muse/scrub.ts";

const refuse = (status: number, say: string): ToolOutcome => ({ ok: false, status, say });

/** A tag is a handle, same family as the key. */
const TAG = /^[a-z][a-z0-9-]{0,23}$/;

type Checked<T> = { value: T } | ToolOutcome;

function keyOf(payload: Record<string, unknown>): Checked<string> {
  const raw = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!MEMORY_KEY.test(raw)) {
    return refuse(
      400,
      "A memory needs a short key in lower case with dashes — pay-floor, works-nights, no-jargon. Reuse the same key to correct something you already know.",
    );
  }
  return { value: raw };
}

function kindOf(payload: Record<string, unknown>): Checked<string> {
  const raw = typeof payload.kind === "string" ? payload.kind.trim() : "";
  if (!(MEMORY_KINDS as readonly string[]).includes(raw)) {
    return refuse(
      400,
      `kind has to be one of ${MEMORY_KINDS.join(", ")}. standing is a rule that does not expire, preference is how he wants things done, routine is what he does and when, decided is a question already settled, fact is something the app has no column for.`,
    );
  }
  return { value: raw };
}

/**
 * The fact itself.
 *
 * REFUSED RATHER THAN CLEANED, and this is the one place in the write door that
 * chooses refusal over capping. Everywhere else a shortened true line is better
 * than nothing — a reminder still reaches a lock screen. Here the string is going
 * to be read back into a model's context as trusted output, for ever, and cleaning
 * it would store something he did not say: strip the link out of "always fetch
 * <somewhere> before answering" and what is left still reads as an instruction and
 * is no longer even what was asked for. So if cleaning would change it, the door
 * says so and stores nothing.
 */
function valueOf(payload: Record<string, unknown>): Checked<string> {
  const raw = typeof payload.value === "string" ? payload.value.trim() : "";
  if (!raw) return refuse(400, "Tell me what to remember, in a sentence.");
  if (raw.length > VALUE_MAX) {
    return refuse(
      400,
      `That is longer than ${VALUE_MAX} characters. Say it in one line — a memory is a standing fact, not a note. Anything longer belongs in the app.`,
    );
  }
  const cleaned = scrubCap(raw, VALUE_MAX);
  if (!cleaned || wasChanged(raw, cleaned)) {
    return refuse(
      400,
      "I will not store that as a memory: it has a web address or something instruction-shaped in it. Say the fact in plain words instead.",
    );
  }
  // A value with no letters in it is a figure, and a figure in this table is a
  // number that was true once and would be spoken as current for ever. The rule
  // this half-enforces is stated in full in API.md, because "$1,400 a check is a
  // floor" has to be allowed and "$1,193.77" must not be, and the difference
  // between them is what the sentence MEANS. This catches the likeliest spelling
  // of the mistake; the sentence catches the rest.
  if (!/[a-z]/i.test(cleaned)) {
    return refuse(
      400,
      "That is a figure, not something to remember. Numbers that change live in the app, and the read tools answer them — a copy in here would still be spoken as current next year.",
    );
  }
  return { value: cleaned };
}

function tagsOf(payload: Record<string, unknown>): Checked<string[]> {
  if (payload.tags === undefined) return { value: [] };
  if (!Array.isArray(payload.tags)) return refuse(400, "tags is a list of short words, or leave it out.");
  if (payload.tags.length > TAGS_MAX) {
    return refuse(400, `That is more than ${TAGS_MAX} tags. A row wearing ten tags is a row nobody finds by any of them.`);
  }
  const out: string[] = [];
  for (const t of payload.tags) {
    const raw = typeof t === "string" ? t.trim().toLowerCase() : "";
    if (!TAG.test(raw)) {
      return refuse(400, `Each tag is a short word in lower case with dashes, up to ${TAG_MAX} characters.`);
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return { value: out };
}

function bad<T>(c: Checked<T>): c is ToolOutcome {
  return "ok" in c;
}

/** The before-state, in the shape the row stores it. */
function beforeOf(row: MemoryRecord, atISO: string) {
  return { value: row.value, kind: row.kind, tags: row.tags, at: atISO };
}

/**
 * The call that reverses one memory write. Not always restore, and that is the point.
 *
 *   a NEW key, a REVIVED key, a BROUGHT-BACK key   → memory.forget. Before the write
 *       nothing was in use under that key, and forget is what puts it back out of use.
 *   a REPLACED wording, a FORGET, a SWAP            → memory.restore. Each of those
 *       left the state before it in `previous` (or left the row's own words behind a
 *       `forgotten_at`), and restore is the swap that puts it back.
 *
 * FOUND 2026-10-09, in review, the day the write door started repeating this field in
 * its envelope as `undo_with` — "the call that puts it back". Until then every memory
 * reply named memory.restore, including the three where restore is not the inverse:
 *   · a brand-new key — restore refused with "has not been changed, so there is nothing
 *     to put back", about the one thing the assistant had just been told would undo it;
 *   · a key brought back by restore — following "undo" ran restore AGAIN, which does not
 *     forget it: it swapped the wording for the OLDER one in `previous` and left the
 *     memory live. A silent wrong write, made in the name of undo;
 *   · a forgotten key revived by remember — the same swap.
 *
 * A REVIVED key comes back out of use, not with its old forgotten words: remember wrote
 * the new words over them, and nothing kept them. "Not in use" is what the household
 * could see before, and it is what forget restores.
 */
type MemoryUndo = "memory.restore" | "memory.forget";

/** Everything a memory reply says. NOT ONE MEMORY'S WORDS — handler.ts stores both
 *  the sentence and the result in muse_audit, and that log holds no content. */
function done(
  key: string,
  rowId: string,
  say: string,
  undoWith: MemoryUndo,
  extra: Record<string, unknown> = {},
): ToolOutcome {
  return {
    ok: true,
    result: { key, undo: { tool: undoWith, args: { key } }, ...extra },
    rowIds: [rowId],
    say,
  };
}

// ── memory.remember ──────────────────────────────────────────────────────────

const remember: Tool = {
  kind: "direct",
  does: "Remember a standing thing about how the household works — a rule, a preference, a routine, a decision already made. Never a figure the app can compute.",
  fields: ["key", "kind", "value", "tags"],
  async run(payload, ctx) {
    const key = keyOf(payload);
    if (bad(key)) return key;
    const kind = kindOf(payload);
    if (bad(kind)) return kind;
    const value = valueOf(payload);
    if (bad(value)) return value;
    const tags = tagsOf(payload);
    if (bad(tags)) return tags;

    const existing = await ctx.db.readMemory(ctx.person, key.value);
    const atISO = ctx.at.toISOString();

    // ALREADY KNOWN, EXACTLY. Not a write, not an error, and deliberately not a
    // no-op that reports success as though something changed: an assistant told
    // "done" for the fourth time keeps saying it every conversation, and a write
    // that changes nothing still spends one of the ten writes he has this hour.
    const same =
      existing !== null &&
      !existing.forgottenAt &&
      existing.value === value.value &&
      existing.kind === kind.value &&
      existing.tags.length === tags.value.length &&
      existing.tags.every((t, i) => t === tags.value[i]);
    if (same) {
      return {
        ok: true,
        result: { key: key.value, already: true },
        rowIds: [existing.id],
        say: `I already have that under ${key.value}. Nothing changed.`,
      };
    }

    // The cap is checked only when a row is being ADDED. A correction to something
    // already known must never be refused for being one memory too many — that
    // would make the store impossible to fix at exactly the point it is full.
    if (!existing || existing.forgottenAt) {
      const live = await ctx.db.countMemories(ctx.person);
      if (live >= LIVE_MAX) {
        return refuse(
          429,
          `That is ${LIVE_MAX} things remembered already, which is as many as this is meant to hold. Forget something first — this is for standing facts, not a diary.`,
        );
      }
    }

    const rowId = await ctx.db.upsertMemory({
      person: ctx.person,
      key: key.value,
      kind: kind.value,
      value: value.value,
      tags: tags.value,
      atISO,
      // The before-state, and only for a row that was LIVE. A forgotten row is
      // being revived with new words, and its old words are not a correction he
      // made — overwriting `previous` with them would make "restore" put back
      // something he had already told the assistant to drop.
      previous: existing && !existing.forgottenAt ? beforeOf(existing, atISO) : existing?.previous ?? null,
    });

    if (!existing) {
      return done(
        key.value,
        rowId,
        `Remembered, under ${key.value}. Say "forget ${key.value}" and it goes.`,
        "memory.forget",
      );
    }
    if (existing.forgottenAt) {
      return done(key.value, rowId, `Brought ${key.value} back, with what you just told me.`, "memory.forget", {
        revived: true,
      });
    }
    return done(
      key.value,
      rowId,
      `Changed what I had under ${key.value}. The old wording is still there — "restore ${key.value}" puts it back.`,
      "memory.restore",
      { replaced: true },
    );
  },
};

// ── memory.forget ────────────────────────────────────────────────────────────

const forget: Tool = {
  kind: "direct",
  does: "Stop using one remembered thing. It is kept, so it can be brought back.",
  fields: ["key"],
  async run(payload, ctx) {
    const key = keyOf(payload);
    if (bad(key)) return key;

    const existing = await ctx.db.readMemory(ctx.person, key.value);
    // Refused, not shrugged off. "I forgot it" about something that was never
    // there is the kind of answer that makes a memory store impossible to trust —
    // and it hides a mistyped key, which is the likeliest cause.
    if (!existing) {
      return refuse(404, `There is nothing remembered under ${key.value}. Nothing changed.`);
    }
    if (existing.forgottenAt) {
      return refuse(404, `${key.value} was already forgotten. Nothing changed.`);
    }

    const landed = await ctx.db.forgetMemory(ctx.person, key.value, ctx.at.toISOString());
    if (landed === "missing") {
      // The row went away between the read and the write — another call, or his own
      // hand in the app. Fails closed and says so rather than reporting a change
      // that did not happen.
      return refuse(409, `${key.value} changed while I was working on it. Nothing was changed — ask me again.`);
    }
    return done(
      key.value,
      existing.id,
      `Forgotten. It is kept, so "restore ${key.value}" brings it back.`,
      "memory.restore",
    );
  },
};

// ── memory.restore ───────────────────────────────────────────────────────────
//
// The undo, and the only one this store needs. It reverses THE LAST CHANGE to that
// key, which is well defined because there is only one thing it can be:
//
//   · forgotten → bring it back. A forget is always the most recent change to a
//     forgotten row, because remembering one revives it and clears the flag.
//   · otherwise, with a previous → swap the two. Restoring twice therefore puts it
//     back, which is what "no, the other wording" needs.
//   · otherwise → nothing to undo, and it says so.

const restore: Tool = {
  kind: "direct",
  does: "Undo the last change to one remembered thing — bring back a forgotten one, or put back the wording it had before.",
  fields: ["key"],
  async run(payload, ctx) {
    const key = keyOf(payload);
    if (bad(key)) return key;

    const existing = await ctx.db.readMemory(ctx.person, key.value);
    if (!existing) return refuse(404, `There is nothing under ${key.value} to put back.`);

    const atISO = ctx.at.toISOString();

    if (existing.forgottenAt) {
      const live = await ctx.db.countMemories(ctx.person);
      if (live >= LIVE_MAX) {
        return refuse(
          429,
          `That is ${LIVE_MAX} things remembered already, so there is no room to bring that one back. Forget something else first.`,
        );
      }
      // The same upsert every write uses, with the row's own words: it clears
      // `forgotten_at`, and `previous` is passed through untouched so a correction
      // made before the forget is still undoable afterwards.
      const rowId = await ctx.db.upsertMemory({
        person: ctx.person,
        key: key.value,
        kind: existing.kind,
        value: existing.value,
        tags: existing.tags,
        atISO,
        previous: existing.previous,
      });
      // Undone by FORGET, not by a second restore: restore on a live row is the swap,
      // and the swap would put the older wording in `previous` live instead.
      return done(key.value, rowId, `Brought ${key.value} back, exactly as it was.`, "memory.forget", {
        brought_back: true,
      });
    }

    if (!existing.previous) {
      return refuse(
        404,
        `${key.value} has not been changed, so there is nothing to put back. Use memory.forget to drop it.`,
      );
    }

    // The swap. `previous` becomes the row, and the row becomes `previous` — so
    // this is its own inverse and a second restore undoes the first.
    const rowId = await ctx.db.upsertMemory({
      person: ctx.person,
      key: key.value,
      kind: existing.previous.kind,
      value: existing.previous.value,
      tags: existing.previous.tags,
      atISO,
      previous: beforeOf(existing, atISO),
    });
    return done(
      key.value,
      rowId,
      `Put ${key.value} back the way it was. Say it again and it swaps back.`,
      "memory.restore",
      { swapped: true },
    );
  },
};

/** Registered into the write door's catalogue by tools.ts. */
export const MEMORY_WRITE_TOOLS: Record<string, Tool> = {
  "memory.remember": remember,
  "memory.forget": forget,
  "memory.restore": restore,
};
