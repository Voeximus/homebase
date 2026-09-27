// ONE LIST OF WHAT EXISTS, across both doors.
//
// WHY THIS FILE EXISTS
//
// Each door already had a single registry that its router and its OpenAPI
// description both came off, so neither door could describe a tool it did not have.
// What nothing held was the pair of them together, and every sentence that counted
// them was typed by hand:
//
//   tools.ts        "The read door's catalogue. Eleven tools"
//   muse-write      "The seven things an assistant may change"
//   openapi.ts      "The seven things an assistant may change in Homebase."
//   API.md          "This door lets you ask ... Eleven questions can be asked today"
//   index.ts        "A separate door with its own secret and seven named verbs"
//
// Two branches then added tools at the same time. Both had to correct "eleven" in
// the same comment, one said twelve and the other said fifteen, and both were right
// about their own branch and wrong about main. That is five hand-typed numbers about
// one fact, and a number in a document an assistant reads is not decoration: it is
// what tells it whether it has seen the whole list or should go looking for more.
//
// So the count is no longer typed anywhere. Every sentence that states one is built
// from a registry, through this file, and tests/museCatalogue.test.ts fails if the
// two registries, the two served OpenAPI documents and API.md's headings disagree by
// one name.
//
// WHAT THIS FILE IS NOT. It is not a third list of tools. It holds no tool names —
// nothing below could tell you what `finance.audit` is. It takes each door's own
// registry and normalises it, which is why it cannot fall behind one: there is
// nothing in here to forget to update.
//
// AND WHY IT IS IN _shared RATHER THAN IN A TEST. Two reasons. The doors' own
// descriptions are generated through it, so it ships. And `catalogueOf` VALIDATES:
// a malformed entry throws at module load, which means a bad registry entry takes
// its own door down at deploy time instead of being served as a broken description
// to an assistant that will believe it.
//
// NO CLOCK, NO MONEY. The only arithmetic here is counting names in a list the door
// itself declared, and `numberWord` below spelling that count. Rule 1 is about never
// re-deriving the household's FIGURES; how many tools exist is not one of them.

/** Which door answers this name. */
export type Door = "read" | "write";

/**
 * What happens when the tool is called.
 *
 * `answer` is every read tool. `direct` and `queued` are the write door's own split,
 * carried through because the description has to say which — a queued tool writes the
 * request down and changes nothing, and an assistant that reads "done" into that
 * sends somebody looking at a ledger that did not move.
 */
export type Landing = "answer" | "direct" | "queued";

/** One argument, as the read door declares it. */
export interface CatalogueArg {
  name: string;
  type: "string" | "integer";
  required: boolean;
  description: string;
}

/** One tool, in the one shape both doors can be read in. */
export interface CatalogueEntry {
  name: string;
  door: Door;
  /** One plain sentence. The read door calls it `summary`, the write door `does`. */
  summary: string;
  /** Every field this tool accepts, in declaration order. */
  fields: readonly string[];
  landing: Landing;
  /** Declared types, where the door declares them. The read door does; the write
   *  door's `fields` are names only, and this is empty for those. */
  args: readonly CatalogueArg[];
}

/** The shape of a read-door tool, structurally — not an import, so this file stays
 *  free of both registries and neither door can pull the other in behind it. */
export interface ReadToolShape {
  name: string;
  summary: string;
  args?: readonly CatalogueArg[];
}

/** The shape of a write-door tool. */
export interface WriteToolShape {
  kind: "direct" | "queued";
  does: string;
  fields: readonly string[];
}

/**
 * A name is `area.verb_object`, lower case. Checked rather than assumed, because
 * every one of these ends up in a URL path on the read door, in a JSON enum on the
 * write door, and in a markdown heading in API.md — and the test that compares those
 * three matches on the exact string.
 */
const NAME = /^(finance|health|schedule)\.[a-z][a-z0-9_]*$/;
const FIELD = /^[a-z][a-z0-9_]*$/;

export function readEntries(tools: readonly ReadToolShape[]): CatalogueEntry[] {
  return tools.map((t) => ({
    name: t.name,
    door: "read" as Door,
    summary: t.summary,
    fields: (t.args ?? []).map((a) => a.name),
    landing: "answer" as Landing,
    args: t.args ?? [],
  }));
}

export function writeEntries(registry: ReadonlyMap<string, WriteToolShape>): CatalogueEntry[] {
  return [...registry].map(([name, t]) => ({
    name,
    door: "write" as Door,
    summary: t.does,
    fields: t.fields,
    landing: t.kind,
    args: [],
  }));
}

/**
 * The catalogue, validated.
 *
 * THE FOUR THINGS IT REFUSES, and each one is a bug that has either happened here or
 * is one rename away:
 *
 *   · a name that is not `area.verb_object` — it would still route, and then fail to
 *     match its own heading in API.md by a character nobody would find;
 *   · the same name on both doors. `schedule.list_reminders` reads and
 *     `schedule.remind` writes; the day somebody adds a read tool called
 *     `schedule.remind` for symmetry, an assistant holding the read key would be
 *     told a write exists on the door that has no write verb;
 *   · a summary that is empty or does not end a sentence. It is read aloud and it is
 *     joined into a bulleted description — a fragment there reads as a truncated
 *     list;
 *   · a duplicated or oddly spelled field name. The handler refuses "any key not on
 *     this list" by exact string, so `learn_Merchant` in a registry is a field that
 *     can never be sent.
 *
 * It THROWS rather than returning errors, and that is the point: both doors call it
 * at module load, so a door with a malformed entry does not start.
 */
export function catalogueOf(...groups: readonly CatalogueEntry[][]): readonly CatalogueEntry[] {
  const all = groups.flat();
  const seen = new Map<string, Door>();
  for (const e of all) {
    if (!NAME.test(e.name)) throw new Error(`muse catalogue: ${e.name} is not a tool name`);
    const already = seen.get(e.name);
    if (already) throw new Error(`muse catalogue: ${e.name} is on the ${already} door and the ${e.door} door`);
    seen.set(e.name, e.door);
    if (!e.summary.trim() || !/[.?]$/.test(e.summary.trim())) {
      throw new Error(`muse catalogue: ${e.name}'s summary is not a sentence`);
    }
    const fields = new Set<string>();
    for (const f of e.fields) {
      if (!FIELD.test(f)) throw new Error(`muse catalogue: ${e.name} declares a field called ${f}`);
      if (fields.has(f)) throw new Error(`muse catalogue: ${e.name} declares ${f} twice`);
      fields.add(f);
    }
  }
  return all;
}

/** Just the names, in declaration order. The routers' "no such tool" reply and the
 *  write door's JSON enum both come off this. */
export const namesOf = (entries: readonly CatalogueEntry[]): string[] => entries.map((e) => e.name);

/**
 * A count, spelled.
 *
 * "The nine things an assistant may change" reads better than "The 9 things", and
 * these descriptions are read by a model that then says them out loud. Past twenty it
 * falls back to digits, because a list that long has a worse problem than its
 * grammar.
 */
const WORDS = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];
export const numberWord = (n: number): string => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));

/**
 * One plain line per tool, for an OpenAPI description.
 *
 * `landing` is spelled out for the write door because it is the difference between a
 * thing that happened and a thing that was written down, and the queued sentence is
 * the one that has already been wrong once — it used to promise a tap in an app
 * screen that does not exist.
 */
export function toolLines(entries: readonly CatalogueEntry[]): string[] {
  return entries.map((e) => {
    const fields = e.fields.length ? ` Fields: ${e.fields.join(", ")}.` : " Takes nothing.";
    const lands = e.landing === "queued"
      ? " This one only writes the request down. The app has no screen for these yet, so it will NOT be applied and it clears itself after 24 hours. Say that plainly, and say the app is where the change actually gets made."
      : e.landing === "direct"
        ? " This one takes effect right away."
        : "";
    return `- ${e.name}: ${e.summary}${fields}${lands}`;
  });
}

/**
 * The tool names API.md gives a heading to.
 *
 * The document's own convention, which is now load-bearing: a tool gets a heading
 * whose text starts with its name in backticks. Read tools are `###` and the write
 * door's are `####`, and this does not care which — what it checks is that the set of
 * names with a heading is exactly the set of names that exist. A heading is the only
 * thing in that file an assistant can use to tell a tool that exists from a sentence
 * about one that does not.
 */
export function headingsIn(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{2,4}\s+`([a-z]+\.[a-z0-9_]+)`/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}
