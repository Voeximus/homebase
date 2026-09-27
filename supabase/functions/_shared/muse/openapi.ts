// The door's own description, served at /muse-read/openapi.json.
//
// Nobody has published that a phone-built Muse connector reads one of these. The
// only Meta page that asks for an OpenAPI spec belongs to a different,
// application-gated product. So this is served because it costs a few lines and
// might help — not because anything here depends on it.
//
// It is BUILT FROM THE CATALOGUE rather than written beside it, so a tool added to
// tools.ts appears here and a tool removed from there disappears. A description
// that disagreed with the door would be worse than none: it would teach an
// assistant to ask for something that does not exist and then improvise when
// refused.
//
// The forbidden list is in the description too, in words. An assistant that has
// read why it cannot search transactions asks a different question; one that only
// gets a 404 tries another spelling.
//
// IS IT VALID 3.1? Yes, checked against the spec itself rather than by reading it:
// the served document validates against the official OpenAPI 3.1 meta-schema
// (spec.openapis.org/oas/3.1/schema/2022-10-07) and Redocly's linter reports it
// valid with one style warning (no `license` in `info`, which is deliberate — this
// is one household's private door).
//
// One trap for whoever repeats that check. ajv 8 cannot bind the meta-schema's
// `$dynamicRef: "#meta"` to its own placeholder at `$defs/schema`; it falls through
// to the document root, which carries `unevaluatedProperties: false`, so EVERY
// Schema Object under a requestBody is reported invalid. That is the validator, not
// the document — a textbook-minimal 3.1 file fails identically. Point that one
// reference at `#/$defs/schema` and both the minimal file and this one pass. The
// checks that live in the repo are in tests/museRead.test.ts: the served paths
// against the tool catalogue both ways, and each argument's declared type.

import { ABSENT, CATALOGUE, type Json } from "./tools.ts";

const DEFAULT_BASE = "https://example.supabase.co/functions/v1/muse-read";

export function openApiDocument(baseUrl: string = DEFAULT_BASE): { [k: string]: Json } {
  const paths: { [k: string]: Json } = {};

  // CATALOGUE, not TOOLS — the same normalised list the write door's description and
  // API.md's headings are checked against, so "the document describes this door" and
  // "both doors describe the same set of tools" are one claim instead of two.
  for (const tool of CATALOGUE) {
    const properties: { [k: string]: Json } = {};
    const required: string[] = [];
    for (const a of tool.args) {
      // The type comes off the argument's own declaration in tools.ts. It used to
      // be guessed from the name here, which was right for the one integer
      // argument that exists and would have been wrong for the next one.
      properties[a.name] = { type: a.type, description: a.description };
      if (a.required) required.push(a.name);
    }
    paths[`/${tool.name}`] = {
      post: {
        operationId: tool.name.replace(/\./g, "_"),
        summary: tool.summary,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: required.length > 0,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties,
                ...(required.length ? { required } : {}),
              },
            },
          },
        },
        responses: {
          "200": { description: "The answer, as computed summaries. Never individual ledger rows." },
          "400": { description: "An argument was missing or not a shape this tool takes." },
          "401": { description: "The key does not open this door." },
          "404": { description: "No such tool. The reply lists what exists and what never will." },
          "413": { description: "The body was bigger than the door will read. Do not send it again." },
          "429": { description: "Too many questions this hour. Wait rather than retrying." },
          "503": { description: "A table could not be read in full, so no number was computed." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Homebase read door",
      version: "1",
      description: [
        "Read-only access to one household's own finance and health figures.",
        "Every number comes from the app's own functions, so an answer here is the",
        "number on the app's screen. Nothing here writes, deletes, or moves money.",
        "",
        "What this door will never have:",
        ...ABSENT.map((a) => `  - ${a.name}: ${a.why}`),
      ].join("\n"),
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        // Both are accepted; which one a phone-built connector actually sends is a
        // measurement nobody has published, so the door takes either.
        bearerAuth: { type: "http", scheme: "bearer" },
        museToken: { type: "apiKey", in: "header", name: "X-Muse-Token" },
      },
    },
    security: [{ bearerAuth: [] }, { museToken: [] }],
    paths,
  };
}
