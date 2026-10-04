import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { Exercise } from "../../lib/exerciseData";
import { t, tc } from "../../lib/i18n";
import { AREAS, filterLibrary, groupByArea, libraryLine, loadEvidence, ownNoteCount, type Area } from "./viewHelpers";

// ── The Exercises tab ─────────────────────────────────────────────────────────
// Ported from the lab mockup's "Library" screen, cut to v1: a search box, one row
// of body-area chips, and the list. Tapping a row opens the exercise page.
//
// With nothing typed and "All" picked, the list is grouped by body area so it
// can be browsed; any search or chip turns it into one alphabetical list.
//
// The "N study notes" hint needs the evidence module, which is lazy. The rows
// render without it and the counts appear when it lands; if it never does, the
// rows are still complete, just without the hint.

export function ExercisesTab({ library, onOpen }: { library: Exercise[]; onOpen(name: string): void }) {
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<Area>("All");

  const [notesOf, setNotesOf] = useState<((ex: Exercise) => number) | null>(null);
  useEffect(() => {
    let on = true;
    loadEvidence().then(
      (m) => on && setNotesOf(() => (ex: Exercise) => ownNoteCount(m.notesFor(ex))),
      () => {}, // no counts — the list works without them
    );
    return () => {
      on = false;
    };
  }, []);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    if (notesOf) for (const ex of library) out.set(ex.id, notesOf(ex));
    return out;
  }, [notesOf, library]);

  const list = useMemo(() => filterLibrary(library, query, area), [library, query, area]);
  const browsing = !query.trim() && area === "All";

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-2 rounded-xl pl-3 pr-1"
        style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
      >
        <Search size={16} style={{ color: "var(--color-faint)", flex: "none" }} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search exercises")}
          aria-label={t("Search exercises")}
          className="min-h-[44px] w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="grid h-11 w-11 flex-none place-items-center rounded-[10px]"
            style={{ color: "var(--color-faint)" }}
            aria-label={t("Clear search")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div
        className="-my-1 flex gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label={t("Body area")}
      >
        {AREAS.map((a) => (
          <button
            key={a}
            onClick={() => setArea(a)}
            aria-pressed={area === a}
            className="inline-flex min-h-[36px] flex-none items-center whitespace-nowrap rounded-full px-3 text-[12.5px] font-semibold"
            style={
              area === a
                ? { background: "var(--color-accent)", color: "var(--h-on-accent)" }
                : { background: "var(--color-raised)", color: "var(--color-taupe)", boxShadow: "inset 0 0 0 1px var(--color-edge)" }
            }
          >
            {tc(a, "body area")}
          </button>
        ))}
      </div>

      {library.length === 0 ? (
        <p className="h-sub py-6 text-center">{t("Loading exercises…")}</p>
      ) : list.length === 0 ? (
        <div
          className="rounded-[var(--h-radius)] px-3 py-6 text-center text-[13px]"
          style={{ border: "1px dashed var(--color-edge)", color: "var(--color-taupe)" }}
        >
          {t("No exercise matches that.")}
        </div>
      ) : browsing ? (
        groupByArea(list).map((g) => (
          <Group key={g.label} title={tc(g.label, "body area")} items={g.items} counts={counts} onOpen={onOpen} />
        ))
      ) : (
        <Group title={query.trim() ? t("Results") : tc(area, "body area")} items={list} counts={counts} onOpen={onOpen} />
      )}
    </div>
  );
}

function Group({
  title,
  items,
  counts,
  onOpen,
}: {
  title: string;
  items: Exercise[];
  counts: Map<string, number>;
  onOpen(name: string): void;
}) {
  return (
    <section className="h-panel" style={{ paddingTop: 10, paddingBottom: 4 }}>
      <p className="h-eyebrow" style={{ marginBottom: 2 }}>
        {title} · {items.length}
      </p>
      {items.map((ex) => {
        const n = counts.get(ex.id) ?? 0;
        return (
          <button
            key={ex.id}
            onClick={() => onOpen(ex.name)}
            className="flex min-h-[52px] w-full items-center gap-3 border-b px-1.5 py-2 text-left last:border-b-0 active:bg-[var(--color-raised)]"
            style={{ borderColor: "var(--color-edge)" }}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-bone">{ex.name}</span>
              <span className="block truncate text-[10.5px]" style={{ color: "var(--color-faint)" }}>
                {libraryLine(ex)}
              </span>
            </span>
            {n > 0 && (
              <span className="flex-none text-[10.5px]" style={{ color: "var(--color-faint)" }}>
                {t(n === 1 ? "{n} study note" : "{n} study notes", { n })}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}
