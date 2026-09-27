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

export function openapi(url: URL): Record<string, unknown> {
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
        "EVERY CHANGE CAN BE PUT BACK. A tool that changes something records what it replaced and returns an `undo` token in its result, and the sentence it says carries the token too. Call system.undo with that token — or with no token at all, for the last change — and it goes back the way it was. system.changes on the READ door lists what has been changed, with each one's token and whether it can still be undone.",
        "",
        "An undo REFUSES rather than overwriting. If anything has changed the same row since — he edited it in the app, or the bank feed did — the undo stops and says so, and nothing is written. Say that plainly rather than trying again.",
        "",
        "Before you write a category anywhere, ask the read door for finance.categories. A category id that is not on the app's own list is refused, because a made-up one files the charge under no budget line at all.",
        "",
        "Every call needs the household secret, in Authorization: Bearer or in X-Muse-Token — the door takes either, because nobody has published which one a phone-built connector sends. It also needs an Idempotency-Key header. Send the same key if you retry — a repeat returns the first answer and writes nothing.",
        `At most ${WRITES_PER_HOUR} writes an hour, ${REMIND_PER_DAY} new reminders a day, and ${REMIND_OPEN_MAX} reminders waiting at once.`,
        "",
        "EVERY CHANGE CAN BE PUT BACK. A successful reply carries an `undo` object with a token and a sentence saying what undoing would do. Read that sentence out; if he says undo, send the token back. Some undos say `only_until`, which names the thing that could overwrite the restore — say that too rather than promising it holds for ever. A reply whose `undo` is null could not capture a before-state, and says so.",
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
    servers: [{ url: `${url.origin}${url.pathname.replace(/\/openapi\.json$/, "")}` }],
    paths: {
      "/": {
        post: {
          operationId: "museWrite",
          summary: "Run one write tool.",
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
                      description: `The fields that tool takes, and no others — plus ${UNIVERSAL_FIELDS[0]}, which every tool accepts and which only turns off the duplicate check.`,
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
                    },
                  },
                },
              },
            },
            "400": { description: "Something about the request was wrong. The message says what." },
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
