// A description of the door, generated from the tool list so it cannot drift.
//
// Nobody has published what a phone-built connector actually reads, so this is
// not claimed to be the thing that teaches the assistant how to call us — it
// costs a few lines and it might help. The list of tools and their fields comes
// straight out of tools.ts, which means adding a tool updates this document and
// forgetting to update this document is not possible.
//
// AND SO DOES THE COUNT, now. "The seven things an assistant may change" was typed
// here, in tools.ts, in index.ts and in API.md, and two branches adding tools at once
// each corrected some of those and not others. Every number in the text below is
// counted from the catalogue; none is written.

import { CATALOGUE, REMIND_OPEN_MAX, REMIND_PER_DAY, TOOL_NAMES } from "./tools.ts";
import { DUPLICATE_WINDOW_MIN, UNIVERSAL_FIELDS, WRITES_PER_HOUR } from "./handler.ts";
import { numberWord, toolLines } from "../_shared/muse/catalogue.ts";
import { REPEAT_LIMITS } from "../_shared/muse/reminders.ts";
import { GATED } from "./gated.ts";
import { READ_DOOR_NAMES } from "./shapes.ts";
import { EXAMPLE_ID } from "./kit.ts";

/**
 * "calories for kcal, protein_g for p, …" — off the table handler.ts renames with, so
 * the description can never promise a synonym the door does not take, or miss one it
 * does. Grouped by the word they stand for, because `duration_min` and `duration` are
 * two names for one field and reading them as two fields is the mistake to avoid.
 */
function synonymsSaid(): string {
  const by = new Map<string, string[]>();
  for (const [alias, field] of Object.entries(READ_DOOR_NAMES)) by.set(field, [...(by.get(field) ?? []), alias]);
  return [...by].map(([field, aliases]) => `${aliases.join(" or ")} for ${field}`).join(", ");
}

/**
 * @param baseUrl this door's own public address, e.g.
 *   `https://<project>.supabase.co/functions/v1/muse-write`.
 *
 * A STRING BUILT FROM THE PROJECT URL, never the incoming request. This used to take
 * the request's `URL` and build `servers` out of `url.origin` + `url.pathname`, and
 * that is the difference between the door a connector screen accepted and the door it
 * refused. Behind Supabase's proxy the request arrives as `http://` with
 * `/functions/v1` already stripped, so the document advertised
 * `http://<project>.supabase.co/muse-write` — wrong scheme, missing prefix, 404 for
 * anything that followed it. The read door has always been handed an env-derived
 * string here, its screen worked on the first try, and this one failed four times
 * while every hand-made call to the same door with the same key returned 200.
 */
export function openapi(baseUrl: string): Record<string, unknown> {
  const names = TOOL_NAMES;
  // Both the lines and the count come out of catalogue.ts, off the same normalised
  // list the read door's document and API.md's headings are checked against. The
  // queued sentence in particular lives there rather than here: it says what is TRUE
  // TODAY — it used to promise a tap in an app screen that does not exist — and one
  // copy of it is the only way the two doors cannot end up describing the same split
  // two different ways.
  //
  // Phase 2's "and can be undone" is in that shared sentence too, for the same
  // reason. This branch had written its own copy of the whole line here; a second
  // spelling of what `direct` means is exactly the drift catalogue.ts exists to stop.
  const lines = toolLines(CATALOGUE);

  return {
    openapi: "3.1.0",
    info: {
      title: "Homebase write door",
      version: "2.0.0",
      description: [
        // COUNTED, never typed. This sentence said "seven" while there were nine, in two
        // branches at once, because the number lived in five hand-written places. And
        // under-claiming is the worse direction of the two: a description that names
        // fewer tools than exist teaches an assistant not to ask for something that
        // works, and nothing in the conversation would ever correct it.
        `The ${numberWord(CATALOGUE.length)} things an assistant may change in Homebase.`,
        "",
        ...lines,
        "",
        // FOUND 2026-10-10: close to half the failed calls in the log were a guessed field
        // name or a guessed list shape. These three paragraphs are the other half of the
        // examples printed on each line above, and every name in them is generated, not
        // typed.
        `EVERY TOOL ABOVE THAT TAKES FIELDS SHOWS AN EXAMPLE of one call that works. Copy its SHAPE — above all what goes inside a list (exercises, items, sets, slices). Every value in an example is made up: ${EXAMPLE_ID} is a placeholder id that matches nothing, so get the real id from the read door, and never send an example as it stands. A call that IS a tool's example, exactly as printed, is refused and nothing is written; if the person really did ask for exactly those values, send it again with ${UNIVERSAL_FIELDS[0]}: true.`,
        `The read door's names work here too: ${synonymsSaid()}; and inside a logged workout's exercises or a routine's, exercise for name. Send one name per field, never both.`,
        // Said precisely since review on 2026-10-10, when every tool got a check: what is
        // free is a refusal decided from the call alone, and what still counts is one the
        // door had to read the ledger to decide.
        "A refusal about the SHAPE of a call — anything that can be told from the call alone: a list item, a field's type or range, a date out of bounds, an id that is not shaped like one — lists every problem at once, each list item by its number and name with the keys it actually had, and carries `problems`, `received` and that tool's `example`. Fix all of them, then send it once. A call refused that way changed nothing and does not count against the hourly cap. A refusal the door had to read the ledger to decide — the row does not exist, the slices do not add up to the charge — does count.",
        "",
        "EVERY CHANGE CAN BE PUT BACK. A tool that changes something records what it replaced and returns an `undo` token in its result, and the sentence it says carries the token too. Call system.undo with that token — or with no token at all, for the last change — and it goes back the way it was. system.changes on the READ door lists what has been changed, with each one's token and whether it can still be undone.",
        "",
        "An undo REFUSES rather than overwriting. If anything has changed the same row since — he edited it in the app, or the bank feed did — the undo stops and says so, and nothing is written. Say that plainly rather than trying again.",
        "",
        "Before you write a category anywhere, ask the read door for finance.categories. A category id that is not on the app's own list is refused, because a made-up one files the charge under no budget line at all.",
        "",
        "Every call needs the household secret, in Authorization: Bearer or in X-Muse-Token — the door takes either, because nobody has published which one a phone-built connector sends. It also needs an Idempotency-Key header. Send the same key if you retry — a repeat returns the first answer and writes nothing.",
        `At most ${WRITES_PER_HOUR} writes an hour, ${REMIND_PER_DAY} new reminders a day, and ${REMIND_OPEN_MAX} reminders waiting at once.`,
        "",
        "EVERY CHANGE CAN BE PUT BACK. A successful reply carries an `undo` object with a token and a sentence saying what undoing would do. Read that sentence out; if he says undo, send the token back. Some undos say `only_until`, which names the thing that could overwrite the restore — say that too rather than promising it holds for ever. A memory change has no token: its reply names the call that puts it back in `undo_with` — memory.forget for something just put into use, memory.restore for a changed wording or a forget — with its key. Make that call, and no other. A reply whose `undo` is null and that names no such call could not capture a before-state, and says so in `cannot_undo`.",
        `Two people share this house and each has their own key. If the same write, with the same numbers, already came through either key in the last ${DUPLICATE_WINDOW_MIN} minutes, this door refuses it and says who did it — because neither of them knows what the other just asked for. Say that sentence as it stands. If they really do want it twice, send the same call again with ${UNIVERSAL_FIELDS[0]}: true, which every tool here accepts.`,
        "",
        "Reminders: schedule.list_reminders on the READ door is where the ids come from. What a repeat can be:",
        ...REPEAT_LIMITS.map((l) => `  - ${l}`),
        // WHAT IT WILL NOT DO IS DATA, not a sentence. The sentence that was here read
        // "there is no tool for moving money, deleting anything, settling a bill, or
        // changing a debt balance" — true in phase 1, and three of its four clauses
        // stopped being true in phase 2. It is the exact failure a generated description
        // exists to prevent, in the direction that is hardest to notice: the door would
        // have been talking an assistant out of asking for things that work. The list
        // lives in gated.ts and a tool that stops being gated is one entry deleted.
        "What this door will not do, whoever asks and however it is phrased:",
        ...GATED.map((g) => `  - ${g.name}: ${g.why}`),
      ].join("\n"),
    },
    servers: [{ url: baseUrl }],
    // WHERE THE KEY GOES, declared. The read door has carried these two schemes from
    // the start; this door carried none at all, which leaves a setup screen reading
    // the document with nowhere to put the secret — and a screen that cannot place
    // the key calls unauthenticated, gets the 401 it earned, and reports "check your
    // API key". The door itself accepts four header spellings (see _shared/muse/
    // auth.ts), but what is advertised here is deliberately the read door's exact
    // pair, in its order: that document is the one known to have been accepted, so
    // this is a copy of a measurement rather than a superset nobody has tried.
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        museToken: { type: "apiKey", in: "header", name: "X-Muse-Token" },
      },
    },
    security: [{ bearerAuth: [] }, { museToken: [] }],
    paths: {
      "/": {
        post: {
          operationId: "museWrite",
          summary: "Run one write tool.",
          security: [{ bearerAuth: [] }, { museToken: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", minLength: 8, maxLength: 200 },
              description: "A fresh key per request. Reuse the same one to retry safely.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["tool"],
                  properties: {
                    tool: { type: "string", enum: names },
                    args: {
                      type: "object",
                      description: `The fields that tool takes, and no others — plus ${UNIVERSAL_FIELDS[0]}, which every tool accepts and which only turns off the duplicate check and the refusal of a call that is exactly a tool's example. Each tool's line in the description above shows an example.`,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Done, or already done under this key.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      tool: { type: "string" },
                      repeated: { type: "boolean", description: "True when this key had already been used." },
                      message: { type: "string", description: "One plain sentence. Say this out loud." },
                      result: { type: "object" },
                      undo: {
                        type: ["object", "null"],
                        description:
                          "How to put this change back, or null when it could not be captured.",
                        properties: {
                          token: { type: "string", description: "Send this back to undo the change." },
                          says: { type: "string", description: "What undoing would do. Say this out loud." },
                          only_until: {
                            type: "string",
                            description: "What could overwrite the restore. Present only when something can.",
                          },
                        },
                      },
                      undo_with: {
                        type: "object",
                        description:
                          "Present when the way back is a call rather than a token — a memory change, put back with memory.forget or memory.restore, whichever this names.",
                        properties: {
                          tool: { type: "string" },
                          args: { type: "object" },
                        },
                      },
                      cannot_undo: {
                        type: "string",
                        description: "Present only when nothing was written down that could put this change back.",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Something about the request was wrong. The message says what — every problem at once when it is the shape of the call, with `problems`, `received` and `example` beside it. Nothing was written.",
            },
            "401": { description: "No usable secret." },
            "404": { description: "No such tool, or the row it named does not exist." },
            "409": {
              description:
                "Either that Idempotency-Key was already used for something else, or the household already made this exact write a few minutes ago, or the row moved while the door was editing it. The message says which. Nothing was changed.",
            },
            "429": { description: "Over one of the caps. The message says which." },
            "503": { description: "The ledger could not be read or written cleanly. Nothing changed." },
          },
        },
      },
    },
  };
}
