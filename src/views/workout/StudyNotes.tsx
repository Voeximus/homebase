import { useEffect, useState } from "react";
import { BookOpen, ChevronDown } from "lucide-react";
import type { Exercise } from "../../lib/exerciseData";
import type { StudyNote } from "../../lib/evidence";
import { t } from "../../lib/i18n";
import { GRADE_GLYPH, GRADE_LABEL, categoryLabel, loadEvidence } from "./viewHelpers";

// ── "What studies found" on the exercise page ─────────────────────────────────
// Ported from the lab mockup's claim cards (public/_workoutlab.html, `.claim`).
// The note text is shown word for word — it is the checked wording from the
// evidence register, so nothing here trims, rewrites or re-cases it.
//
// The grade is carried by the SHAPE (■ ◧ □) as well as the words beside it, so it
// still reads in greyscale. Sources start closed: the claim is what you read
// mid-workout, the citation is what you check later.

const NO_NOTES = "No study notes for this exercise yet. The muscles shown come from anatomy, not from a study of this exercise.";
const FIRST = 2; // notes shown before "Show more"

/** Loads the notes for one exercise (lazily — see loadEvidence) and shows them. */
export function StudyNotes({ exercise }: { exercise: Exercise }) {
  // Keyed by exercise id, so moving to another exercise shows nothing stale while it loads.
  const [loaded, setLoaded] = useState<{ id: string; notes: StudyNote[] } | { id: string; failed: true } | null>(null);
  useEffect(() => {
    let on = true;
    loadEvidence().then(
      (m) => on && setLoaded({ id: exercise.id, notes: m.notesFor(exercise) }),
      () => on && setLoaded({ id: exercise.id, failed: true }),
    );
    return () => {
      on = false;
    };
  }, [exercise]);

  const mine = loaded && loaded.id === exercise.id ? loaded : null;
  return (
    <section className="h-panel">
      <div className="h-cardhead">
        <span className="ic"><BookOpen size={14} /></span>
        <div className="t" style={{ flex: 1 }}>{t("What studies found")}</div>
      </div>
      {!mine ? (
        <p className="h-sub">{t("Loading study notes…")}</p>
      ) : "failed" in mine ? (
        <p className="h-sub">{t("Couldn't load the study notes. Check your connection and open this page again.")}</p>
      ) : (
        <StudyNoteList key={exercise.id} exercise={exercise} notes={mine.notes} />
      )}
    </section>
  );
}

/** The notes themselves: the first two, then the rest behind "Show more". */
export function StudyNoteList({ exercise, notes }: { exercise: Exercise; notes: StudyNote[] }) {
  const [all, setAll] = useState(false);
  if (!notes.length) return <p className="text-[13px] leading-normal text-bone">{t(NO_NOTES)}</p>;
  const shown = all ? notes : notes.slice(0, FIRST);
  return (
    <>
      <div>
        {shown.map((n) => (
          <NoteCard key={n.id} note={n} exercise={exercise} />
        ))}
      </div>
      {!all && notes.length > FIRST && (
        <button className="h-btn quiet" style={{ marginTop: "var(--h-2)" }} onClick={() => setAll(true)}>
          {t("Show more")}
        </button>
      )}
    </>
  );
}

function NoteCard({ note, exercise }: { note: StudyNote; exercise: Exercise }) {
  const attach =
    note.attach === "variation"
      ? t("Tested on a similar exercise, not this one.")
      : note.attach === "category"
        ? t(categoryLabel(exercise, note))
        : "";
  return (
    <div
      className="border-t pb-1 pt-3 first:border-t-0 first:pt-1"
      style={{ borderColor: "var(--color-edge)" }}
      data-note={note.id}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex min-h-[28px] items-center gap-[5px] rounded-lg px-2 text-[11px] font-bold"
          style={{ color: "var(--color-bone)", boxShadow: "inset 0 0 0 1px var(--color-taupe)" }}
        >
          <span aria-hidden="true" className="text-[13px] leading-none">{GRADE_GLYPH[note.grade]}</span>
          {t(GRADE_LABEL[note.grade])}
        </span>
      </div>
      {attach && (
        <div className="mb-1 text-[11.5px] italic" style={{ color: "var(--color-taupe)" }}>
          {attach}
        </div>
      )}
      <p className="text-[13px] leading-normal text-bone">{note.text}</p>
      {note.sources.length > 0 && (
        <details className="group mt-1">
          <summary
            className="inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-[11.5px] font-semibold [&::-webkit-details-marker]:hidden"
            style={{ color: "var(--color-accent)" }}
          >
            <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
            {t("Sources ({n})", { n: note.sources.length })}
          </summary>
          <ol className="flex list-decimal flex-col gap-1.5 pl-[18px] text-[11px]" style={{ color: "var(--color-taupe)" }}>
            {note.sources.map((s, i) => (
              <li key={i}>
                {s.citation}
                {s.url && (
                  <>
                    <br />
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block min-h-[44px] break-all py-3"
                      style={{ color: "var(--color-taupe)" }}
                    >
                      {s.url}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
