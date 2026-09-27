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

import { ABSENT, TOOLS, type Json } from "./tools.ts";

const DEFAULT_BASE = "https://example.supabase.co/functions/v1/muse-read";

export function openApiDocument(baseUrl: string = DEFAULT_BASE): { [k: string]: Json } {
  const paths: { [k: string]: Json } = {};

  for (const tool of TOOLS) {
    const properties: { [k: string]: Json } = {};
    const required: string[] = [];
    for (const a of tool.args ?? []) {
      properties[a.name] = { type: a.name === "days" ? "integer" : "string", description: a.description };
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
