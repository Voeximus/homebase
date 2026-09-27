// A description of the door, generated from the tool list so it cannot drift.
//
// Nobody has published what a phone-built connector actually reads, so this is
// not claimed to be the thing that teaches the assistant how to call us — it
// costs a few lines and it might help. The list of tools and their fields comes
// straight out of tools.ts, which means adding a tool updates this document and
// forgetting to update this document is not possible.

import { REMIND_OPEN_MAX, REMIND_PER_DAY, TOOLS } from "./tools.ts";
import { WRITES_PER_HOUR } from "./handler.ts";

export function openapi(url: URL): Record<string, unknown> {
  const names = Object.keys(TOOLS);
  const lines = names.map((n) => {
    const t = TOOLS[n];
    const lands = t.kind === "direct"
      ? "takes effect right away"
      : "only asks — it waits for a tap in the app and changes nothing until then";
    return `- ${n}: ${t.does} Fields: ${t.fields.join(", ")}. This one ${lands}.`;
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Homebase write door",
      version: "1.0.0",
      description: [
        "The seven things an assistant may change in Homebase.",
        "",
        ...lines,
        "",
        "Every call needs the household secret, in Authorization: Bearer or in X-Muse-Token — the door takes either, because nobody has published which one a phone-built connector sends. It also needs an Idempotency-Key header. Send the same key if you retry — a repeat returns the first answer and writes nothing.",
        `At most ${WRITES_PER_HOUR} writes an hour, ${REMIND_PER_DAY} new reminders a day, and ${REMIND_OPEN_MAX} reminders waiting at once.`,
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
                    args: { type: "object", description: "The fields that tool takes, and no others." },
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
            "409": { description: "That Idempotency-Key was already used." },
            "429": { description: "Over one of the caps. The message says which." },
            "503": { description: "The ledger could not be read or written cleanly. Nothing changed." },
          },
        },
      },
    },
  };
}
