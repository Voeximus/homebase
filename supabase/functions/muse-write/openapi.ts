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

export function openapi(url: URL): Record<string, unknown> {
  const names = TOOL_NAMES;
  // Both the lines and the count come out of catalogue.ts, off the same normalised
  // list the read door's document and API.md's headings are checked against. The
  // queued sentence in particular lives there rather than here: it says what is TRUE
  // TODAY — it used to promise a tap in an app screen that does not exist — and one
  // copy of it is the only way the two doors cannot end up describing the same split
  // two different ways.
  const lines = toolLines(CATALOGUE);

  return {
    openapi: "3.1.0",
    info: {
      title: "Homebase write door",
      version: "1.0.0",
      description: [
        // Counted, never typed. This sentence said "seven" while there were nine, in
        // two branches at once, because the number lived in five hand-written places.
        `The ${numberWord(CATALOGUE.length)} things an assistant may change in Homebase.`,
        "",
        ...lines,
        "",
        "Every call needs the household secret, in Authorization: Bearer or in X-Muse-Token — the door takes either, because nobody has published which one a phone-built connector sends. It also needs an Idempotency-Key header. Send the same key if you retry — a repeat returns the first answer and writes nothing.",
        `At most ${WRITES_PER_HOUR} writes an hour, ${REMIND_PER_DAY} new reminders a day, and ${REMIND_OPEN_MAX} reminders waiting at once.`,
        "",
        `Two people share this house and each has their own key. If the same write, with the same numbers, already came through either key in the last ${DUPLICATE_WINDOW_MIN} minutes, this door refuses it and says who did it — because neither of them knows what the other just asked for. Say that sentence as it stands. If they really do want it twice, send the same call again with ${UNIVERSAL_FIELDS[0]}: true, which every tool here accepts.`,
        "",
        "Reminders: schedule.list_reminders on the READ door is where the ids come from. What a repeat can be:",
        ...REPEAT_LIMITS.map((l) => `  - ${l}`),
        "There is no tool for moving money, deleting anything, settling a bill, or changing a debt balance. Those are not switched off; they do not exist here.",
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
