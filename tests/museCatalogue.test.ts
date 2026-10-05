// ONE LIST OF TOOLS, OR THE BUILD FAILS.
//
// WHAT WENT WRONG, TWICE IN ONE WEEK
//
// Four things say which tools exist: each door's registry, each door's served OpenAPI
// description, and API.md, which is the document an assistant is actually given. Per
// door, the registry and the description could not disagree — the description is
// generated. Nothing compared the two doors with each other, and nothing compared
// either with API.md.
//
// Then two branches added tools to the same file at the same time. One said the read
// door had twelve tools, the other said fifteen; both were right about themselves and
// wrong about main. The write door's description said "the seven things an assistant
// may change" while nine existed. API.md said "Eleven questions can be asked today"
// with fifteen headings under it.
//
// None of that breaks a call. It is worse than that: a count is how an assistant
// decides whether it has seen the whole list. Told there are eleven when there are
// fifteen, it stops looking, and the four it never asks about are the three money
// questions and the reminder list — the ones he actually wants. A tool that is
// documented and does not exist is the other direction: the assistant calls it,
// gets a 404, and improvises.
//
// SO THIS FILE HOLDS ONE CLAIM: the two registries, the two served documents and
// API.md name the same set of tools, and no number about them is typed by hand
// anywhere. It is the only test that imports BOTH doors.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  catalogueOf,
  headingsIn,
  namesOf,
  numberWord,
  readEntries,
  toolLines,
  writeEntries,
} from "../supabase/functions/_shared/muse/catalogue.ts";
import {
  ABSENT,
  CATALOGUE as READ_CATALOGUE,
  TOOL_BY_NAME as READ_BY_NAME,
  TOOLS as READ_TOOLS,
} from "../supabase/functions/_shared/muse/tools.ts";
import { openApiDocument } from "../supabase/functions/_shared/muse/openapi.ts";
import {
  CATALOGUE as WRITE_CATALOGUE,
  TOOL_BY_NAME as WRITE_BY_NAME,
  TOOL_NAMES as WRITE_NAMES,
} from "../supabase/functions/muse-write/tools.ts";
import { openapi as writeOpenApi } from "../supabase/functions/muse-write/openapi.ts";
import { WRITES_PER_HOUR } from "../supabase/functions/muse-write/handler.ts";
import { REMIND_OPEN_MAX, REMIND_PER_DAY } from "../supabase/functions/muse-write/tools.ts";
import { READS_PER_HOUR } from "../supabase/functions/_shared/muse/handler.ts";

const API_MD = "docs/research/muse-bridge/API.md";
const api = () => readFileSync(API_MD, "utf8");

/** Both halves, through the same validator the doors use at load. */
const BOTH = catalogueOf(readEntries(READ_TOOLS), writeEntries(WRITE_BY_NAME));

/** As much of one served operation as the assertions below read. Spelled once,
 *  because both documents are the same shape at this depth. */
interface PostOp {
  summary?: string;
  requestBody: {
    content: Record<string, {
      schema: {
        properties?: Record<string, { type?: string; enum?: string[] }>;
        required?: string[];
      };
    }>;
  };
}

const readDoc = openApiDocument("https://example.test/functions/v1/muse-read");
const writeDoc = writeOpenApi(new URL("https://example.test/functions/v1/muse-write/openapi.json"));
const writeText = String(
  (writeDoc.info as { description: string }).description,
);

// ── the catalogue against each door's own router ──────────────────────────────

describe("the catalogue is each door's own registry, not a copy of it", () => {
  it("the read door routes exactly the names in its catalogue", () => {
    expect(namesOf(READ_CATALOGUE).sort()).toEqual([...READ_BY_NAME.keys()].sort());
  });

  it("the write door routes exactly the names in its catalogue", () => {
    expect(namesOf(WRITE_CATALOGUE).sort()).toEqual([...WRITE_BY_NAME.keys()].sort());
    expect([...WRITE_NAMES].sort()).toEqual([...WRITE_BY_NAME.keys()].sort());
  });

  it("no name is on both doors", () => {
    // catalogueOf throws on this, so the assertion is that building it does not. The
    // case is real and one rename away: `schedule.list_reminders` reads and
    // `schedule.remind` writes, and a read tool that took the write door's name would
    // tell an assistant holding the READ key that it can change something.
    expect(() => catalogueOf(readEntries(READ_TOOLS), writeEntries(WRITE_BY_NAME))).not.toThrow();
    expect(BOTH.length).toBe(READ_CATALOGUE.length + WRITE_CATALOGUE.length);
  });

  it("every entry carries a sentence and a field list the handler can enforce", () => {
    for (const e of BOTH) {
      expect(e.summary.trim(), e.name).toMatch(/[.?]$/);
      // The handler refuses "any key not on this list" by exact string, so a field
      // spelled with a capital or a space is a field that can never be sent.
      for (const f of e.fields) expect(f, `${e.name}.${f}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("a malformed entry takes its door down rather than being described wrongly", () => {
    const bad = [{ name: "finance.audit", summary: "Fine.", args: [] }];
    // Same name twice — the shape of a bad merge that kept both sides of a registry.
    expect(() => catalogueOf(readEntries([...bad, ...bad]))).toThrow(/finance\.audit/);
    expect(() => catalogueOf(readEntries([{ name: "Finance.Audit", summary: "x.", args: [] }]))).toThrow();
    expect(() => catalogueOf(readEntries([{ name: "finance.audit", summary: "no full stop", args: [] }]))).toThrow();
  });
});

// ── the served documents against the catalogue ────────────────────────────────

describe("the served OpenAPI documents describe exactly what exists", () => {
  it("the read door serves one path per read tool, and no others", () => {
    const paths = Object.keys(readDoc.paths as Record<string, unknown>).sort();
    expect(paths).toEqual(namesOf(READ_CATALOGUE).map((n) => `/${n}`).sort());
  });

  it("each read path declares that tool's own arguments, with the declared types", () => {
    const paths = readDoc.paths as Record<string, { post: PostOp }>;
    for (const e of READ_CATALOGUE) {
      const post = paths[`/${e.name}`].post;
      expect(post.summary, e.name).toBe(e.summary);
      const schema = post.requestBody.content["application/json"].schema;
      expect(Object.keys(schema.properties ?? {}).sort(), e.name).toEqual([...e.fields].sort());
      for (const a of e.args) expect(schema.properties?.[a.name].type, `${e.name}.${a.name}`).toBe(a.type);
      expect((schema.required ?? []).sort(), e.name).toEqual(
        e.args.filter((a) => a.required).map((a) => a.name).sort(),
      );
    }
  });

  it("the write door's enum is exactly its own names", () => {
    const root = (writeDoc.paths as Record<string, { post: PostOp }>)["/"];
    const listed = root.post.requestBody.content["application/json"].schema.properties?.tool.enum ?? [];
    expect([...listed].sort()).toEqual(namesOf(WRITE_CATALOGUE).sort());
  });

  it("the write door's description names every write tool, with its fields", () => {
    for (const line of toolLines(WRITE_CATALOGUE)) expect(writeText).toContain(line);
    for (const e of WRITE_CATALOGUE) {
      for (const f of e.fields) expect(writeText, `${e.name}.${f}`).toContain(f);
    }
  });

  it("the write door's count is counted, not typed", () => {
    // The sentence that was wrong for a week. It has to hold for the number that
    // exists NOW, which is the only way a merge that adds a tool cannot leave it stale.
    expect(writeText).toContain(`The ${numberWord(WRITE_CATALOGUE.length)} things an assistant may change`);
    // And no OTHER count word is sitting in the same sentence position, which is how
    // the old one survived: "seven" stayed while "nine" was added elsewhere.
    const others = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
      .filter((w) => w !== numberWord(WRITE_CATALOGUE.length));
    for (const w of others) {
      expect(writeText, `stale count: ${w}`).not.toContain(`The ${w} things an assistant may change`);
    }
  });

  it("the read door's description tells an assistant what will never exist", () => {
    const text = String((readDoc.info as { description: string }).description);
    for (const a of ABSENT) expect(text).toContain(a.name);
  });
});

// ── API.md, the document the assistant is actually handed ─────────────────────

describe("API.md and the doors cannot name different tools", () => {
  it("every read tool has a heading, and every ### heading is a read tool", () => {
    const md = api();
    const headed = headingsIn(md);
    const readHeadings = md
      .split(/\r?\n/)
      .filter((l) => /^###\s+`/.test(l.trim()))
      .map((l) => /`([a-z.\w]+)`/.exec(l)![1]);
    expect(readHeadings.sort()).toEqual(namesOf(READ_CATALOGUE).sort());
    // And nothing anywhere in the document gives a heading to a tool that does not
    // exist on either door — the direction that makes an assistant call a 404.
    const live = new Set(namesOf(BOTH));
    for (const h of headed) expect(live.has(h), `${h} has a heading in ${API_MD} and exists nowhere`).toBe(true);
  });

  it("a write tool with a heading is a real write tool", () => {
    const md = api();
    const written = md
      .split(/\r?\n/)
      .filter((l) => /^####\s+`/.test(l.trim()))
      .map((l) => /`([a-z.\w]+)`/.exec(l)![1]);
    // API.md is the READ door's guide, so it does not document every write tool — the
    // write door's own served description does that, and the test above checks it.
    // What must hold is that the ones it DOES document exist.
    const writeNames = new Set(namesOf(WRITE_CATALOGUE));
    for (const w of written) expect(writeNames.has(w), `${w} is documented as a write tool`).toBe(true);
    expect(written.length).toBeGreaterThan(0);
  });

  it("no count of tools is written in the prose", () => {
    // Every one of these was in this file and wrong. The list now has no number in
    // front of it anywhere: the headings are the list.
    //
    // It counts TOOLS, not anything countable. "Three things worth a look, and two
    // more that need the app to see" is an example of a sentence the assistant should
    // say about a suggestion list, and it has to stay — so the words this looks for
    // are the ones that mean a tool: questions, tools, reads, writes.
    const md = api();
    const counts = /\b(three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(questions|tools|reads|writes)\b/gi;
    const found = [...md.matchAll(counts)].map((m) => m[0]);
    expect(found, `a typed count in ${API_MD} — say "the headings below" instead`).toEqual([]);
  });

  it("a name is either a tool or forbidden, never both", () => {
    // ABSENT is what the door says it will never have. A name on both lists would
    // mean the door refuses in words something it actually answers — and ABSENT is
    // served in the description and returned with every 404, so the contradiction
    // would be the thing the assistant reads.
    const live = new Set(namesOf(BOTH));
    for (const a of ABSENT) expect(live.has(a.name), `${a.name} is both absent and real`).toBe(false);
  });

  it("every forbidden name is explained, so a 404 can be checked against an intention", () => {
    for (const a of ABSENT) {
      expect(a.name.trim().length, a.name).toBeGreaterThan(0);
      expect(a.why.trim().length, a.name).toBeGreaterThan(20);
    }
  });
});

// ── MUSE-SKILL.md, the document that is actually pasted into the assistant ────
//
// API.md has been guarded here since the week two branches disagreed about how many
// tools existed. MUSE-SKILL.md was not, and it is the one that gets pasted — so it
// went on saying "the read door, eleven questions" while the door served 41, and
// "the write door, seven things" against 54, and it carried a block headed "Planned
// but not built" listing six tools that all work.
//
// That is the direction nothing self-corrects. A count that is too HIGH gets a 404
// and the assistant learns. A count that is too LOW is invisible: the assistant sees
// a complete-looking list, stops looking, and the tools it never asks about are the
// money questions. It survived a month and two assistants. What found it was
// Xinyan's Muse on its first day, reading the door's own description beside the page
// and asking which to believe — which is the behaviour the page asks for, and it
// should not have to be the safety net.
describe("MUSE-SKILL.md cannot state a number the code disagrees with", () => {
  const SKILL_MD = "docs/research/muse-bridge/MUSE-SKILL.md";
  const skill = () => readFileSync(SKILL_MD, "utf8");

  // Read off the code, never typed here either — this test would otherwise be one
  // more hand-written copy of the same numbers.
  // READS_PER_HOUR is deliberately NOT in here. It is null — there is no read cap
  // since 2026-10-04 — and a null has no digits for a document to agree with. The
  // separate test below is what holds that line: it fails if the docs start quoting a
  // reads-an-hour number again, which is the only way this can go wrong now.
  const CAPS: [RegExp, number, string][] = [
    [/(\d+) writes an hour/g, WRITES_PER_HOUR, "WRITES_PER_HOUR"],
    [/(\d+) new reminders a day/g, REMIND_PER_DAY, "REMIND_PER_DAY"],
    [/(\d+) reminders already waiting/g, REMIND_OPEN_MAX, "REMIND_OPEN_MAX"],
  ];

  it("states every cap at the value the door enforces", () => {
    const md = skill();
    for (const [re, actual, name] of CAPS) {
      const found = [...md.matchAll(re)].map((m) => Number(m[1]));
      expect(found.length, `MUSE-SKILL.md never mentions ${name} — did the wording change?`)
        .toBeGreaterThan(0);
      for (const n of found) expect(n, `MUSE-SKILL.md says ${n} where ${name} is ${actual}`).toBe(actual);
    }
  });

  it("never quotes a reads-an-hour number, because there is no read cap", () => {
    // THE OTHER HALF of leaving READS_PER_HOUR out of CAPS above. That list checks a
    // stated number against the code; a null has no digits to check, so without this
    // the reads line could drift back to "60 reads an hour" and nothing would notice —
    // which is the exact failure API.md had, telling an assistant for weeks that a cap
    // was off while it was on, and then that it was on after it came off.
    //
    // Both documents are read, not just the one CAPS reads. API.md is the page an
    // assistant is actually pointed at, and it is the one that drifted.
    for (const file of [SKILL_MD, "docs/research/muse-bridge/API.md"]) {
      const md = readFileSync(file, "utf8");
      const quoted = [...md.matchAll(/(\d+)\s+reads an hour/g)].map((m) => m[0]);
      expect(
        quoted,
        `${file} quotes a read cap, and READS_PER_HOUR is ${READS_PER_HOUR} — there is no cap to quote`,
      ).toEqual([]);
    }
    // And the code agrees, so this test cannot pass by the docs and the door both
    // being wrong in the same direction.
    expect(READS_PER_HOUR).toBeNull();
  });

  it("names no tool that does not exist", () => {
    // Catches the other direction: a tool renamed or removed while the page still
    // teaches the assistant to call it, which produces a 404 and then improvisation.
    const known = new Set([...namesOf(READ_CATALOGUE), ...namesOf(WRITE_CATALOGUE)]);
    const mentioned = new Set(
      [...skill().matchAll(/`((?:finance|health|schedule|memory|system)\.[a-z_]+)`/g)].map((m) => m[1]),
    );
    const ghosts = [...mentioned].filter((n) => !known.has(n));
    expect(ghosts, "MUSE-SKILL.md names tools that no door has").toEqual([]);
  });

  it("names no field a tool does not take", () => {
    // The same failure one level down, and quieter: a field the door does not know
    // is REFUSED, not ignored, so a stale field list turns a working call into a 400
    // the assistant then tries to talk its way around. This page carried
    // `learn_merchant` on categorize_charge, which no version of that tool has had.
    const md = skill();
    // Only the lines that are explicitly "tool — field, field", which is the shape
    // this page uses to teach a call. Prose that happens to mention a tool is left
    // alone; it makes no claim about fields.
    const rows = [...md.matchAll(/^- `((?:finance|health|schedule|memory|system)\.[a-z_]+)` — (.+)$/gm)];
    expect(rows.length, "the page no longer lists any tool with its fields").toBeGreaterThan(0);
    for (const [, tool, rest] of rows) {
      // BOTH, the normalised catalogue, because the two registries spell their
      // arguments differently — the read door declares `args` with types, the write
      // door a bare `fields` list. catalogue.ts exists to end exactly that split,
      // and its `fields` is the one list both doors agree on.
      const def = BOTH.find((e) => e.name === tool);
      expect(def, `${tool} is listed with fields but no door has it`).toBeTruthy();
      const takes = new Set(def!.fields);
      // Backticked words on the line, minus the tool name itself.
      const claimed = [...rest.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      for (const field of claimed) {
        expect(takes.has(field), `${tool} is listed with a \`${field}\` field it does not take`).toBe(true);
      }
    }
  });

  it("does not warn the assistant off tools that exist", () => {
    // The literal heading that caused it. Kept as a string because the failure was
    // never a wrong number — it was a whole block that stopped being true and that
    // nobody reads top-to-bottom often enough to notice.
    const md = skill();
    expect(md, 'the "Planned but not built" block listed six tools that all work').not.toContain(
      "Planned but not built",
    );
    // The three it specifically told two assistants not to attempt.
    for (const tool of ["finance.forecast", "finance.next_bills", "finance.firepower"]) {
      expect(namesOf(READ_CATALOGUE), `${tool} is what that block called unbuilt`).toContain(tool);
    }
  });

  it("points at the door as the authority rather than freezing a count", () => {
    // The structural fix, not the symptom. A page that names its own count will go
    // stale again; a page that says "read the door's list" cannot.
    const md = skill();
    expect(md).toMatch(/THE DOOR'S OWN LIST IS THE AUTHORITY/);
    expect(md).toMatch(/if the door lists something this message does not mention/i);
    expect(md, "the heading must not re-freeze a count").not.toMatch(/the read door, \w+ questions/i);
  });
});
