import { useMemo, useState } from "react";
import { AlertTriangle, FileJson, Lightbulb, RotateCcw, Trash2 } from "lucide-react";
import { LanguageProvider, LangToggle } from "../components/LanguageProvider";
import { ReviewCard, ReviewSheet } from "../views/redesign/ReviewSheet";
import { applyFix, type ReviewWrites } from "../views/redesign/reviewApply";
import { ENGINE_WIRED, reviewSuggestions, sortSuggestions } from "../lib/reviewEngine";
import { clearDismissed, dismissLocally, loadDismissed } from "../lib/doctorDismissals";
import { DEFAULT_CATEGORIES } from "../lib/seed";
import { t } from "../lib/i18n";
import type { AppData } from "../types";
import type { Suggestion } from "../lib/reviewTypes";
import { EXAMPLE_DATA, EXAMPLE_SUGGESTIONS } from "./doctorExamples";

// ?doctorlab — DEV-only harness for "Worth a look", and the only place its screen
// is checked before it reaches a phone.
//
// It mounts the REAL ReviewCard and ReviewSheet, the real applyFix with all its
// guards, and the real per-phone dismissals. Two sources of suggestions:
//
//   · SNAPSHOT — paste or drop a `npm run snapshot` JSON. It is read in the
//     browser, mapped to AppData, and handed to the engine. Nothing is bundled and
//     nothing is committed: the file never leaves this tab, and there is no
//     fixture of real data anywhere in the repo.
//   · EXAMPLES — one hand-written suggestion per kind and per fix, with invented
//     merchants, so every card shape and every button can be checked even when a
//     snapshot has nothing to say (against real data, most kinds fire zero).
//
// NOTHING HERE CAN REACH SUPABASE. The store is never mounted. The write bag below
// mutates a local copy of AppData, which is also what makes this a real test of the
// surface: applying a fix genuinely changes the data, the list genuinely
// recomputes, and a fix that resolves two suggestions genuinely clears both.

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

/**
 * A snapshot's raw DB rows → AppData.
 *
 * Deliberately mirrors the store's mappers rather than importing them:
 * FinanceStore.tsx is a React module wired to Supabase and cannot be loaded here.
 * Same trade the live self-audit test makes — keep these field lists in step with
 * mapTxn / mapRecurring.
 */
function snapshotToAppData(raw: unknown): { data: AppData; note: string } {
  if (!raw || typeof raw !== "object") throw new Error("not an object");
  const s = raw as Row;
  const data: AppData = {
    categories: DEFAULT_CATEGORIES,
    goals: [],
    paidBills: [],
    foods: [],
    merchantRules: rows(s.merchant_rules).map((r) => ({
      id: String(r.id),
      pattern: String(r.pattern ?? ""),
      kind: r.kind as AppData["merchantRules"][number]["kind"],
      categoryId: str(r.category_id),
      billName: str(r.bill_name),
      createdAt: String(r.created_at ?? ""),
    })),
    accounts: rows(s.accounts).map((a) => ({
      id: String(a.id),
      name: String(a.name ?? ""),
      owner: a.owner as AppData["accounts"][number]["owner"],
      type: String(a.type ?? ""),
      balance: num(a.balance),
      sortOrder: num(a.sort_order),
      createdAt: String(a.created_at ?? ""),
    })),
    debts: rows(s.debts).map((d) => ({
      id: String(d.id),
      name: String(d.name ?? ""),
      balance: num(d.balance),
      originalBalance: num(d.original_balance),
      apr: d.apr == null ? undefined : num(d.apr),
      color: str(d.color) ?? "#000",
      providerAccountId: str(d.provider_account_id),
      trackPattern: str(d.track_pattern),
      createdAt: String(d.created_at ?? ""),
    })),
    recurring: rows(s.recurring).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      amount: num(r.amount),
      direction: r.direction as AppData["recurring"][number]["direction"],
      cadence: r.cadence as AppData["recurring"][number]["cadence"],
      active: !!r.active,
      variable: !!r.variable,
      categoryId: str(r.category_id),
      dueDays: Array.isArray(r.due_days) ? (r.due_days as number[]) : undefined,
      anchorDate: str(r.anchor_date),
      startsOn: str(r.starts_on),
      endsOn: str(r.ends_on),
      knownAmount: r.known_amount == null ? undefined : num(r.known_amount),
      linkedDebtId: str(r.linked_debt_id),
      createdAt: String(r.created_at ?? ""),
    })),
    transactions: rows(s.transactions).map((x) => ({
      id: String(x.id),
      date: String(x.date ?? ""),
      amount: num(x.amount),
      type: x.type as "income" | "expense",
      categoryId: String(x.category_id ?? "other"),
      description: str(x.description) ?? "",
      rawDescription: str(x.raw_description),
      accountId: str(x.account_id),
      appliesTo: (x.applies_to as AppData["transactions"][number]["appliesTo"]) ?? undefined,
      splits:
        Array.isArray(x.splits) && x.splits.length
          ? (x.splits as AppData["transactions"][number]["splits"])
          : undefined,
      pending: x.status === "pending",
      provider: str(x.provider),
      recordOnly: !!x.record_only,
      createdAt: String(x.created_at ?? ""),
    })),
  };
  const note = `${data.transactions.length} charges · ${data.recurring.length} bills · ${data.accounts.length} accounts · taken ${str(s.takenAt) ?? "(unknown)"}`;
  return { data, note };
}

type Source = "examples" | "snapshot";

export function DoctorLab() {
  const [source, setSource] = useState<Source>("examples");
  // ONE ledger, whichever source filled it. A fix mutates this, so the recompute
  // afterwards is the real thing rather than a mock of it.
  const [data, setData] = useState<AppData>(EXAMPLE_DATA);
  const [loadNote, setLoadNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [paste, setPaste] = useState("");
  const [nowText, setNowText] = useState(() => new Date().toISOString().slice(0, 10));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => loadDismissed());
  const [pretendPiece3Missing, setPretendPiece3Missing] = useState(false);
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((l) => [line, ...l].slice(0, 12));

  // The hand-written battery. A successful fix takes its card off this list, the
  // way a recompute takes it off the real one.
  const [examples, setExamples] = useState<Suggestion[]>(EXAMPLE_SUGGESTIONS);

  const now = useMemo(() => {
    const d = new Date(`${nowText}T12:00:00`);
    return isNaN(d.getTime()) ? new Date() : d;
  }, [nowText]);

  // Bumped when the language flips, and a dependency of the list below. The
  // suggestions are built by t() at ENGINE time, and this component sits ABOVE the
  // LanguageProvider it renders — so the provider's remount never reaches this
  // memo and the cards stayed in English while the chrome around them turned
  // Chinese. In the real app FinanceTabs is BELOW the provider and remounts with
  // it, so this is a harness-shaped problem with a harness-shaped fix; checking
  // that the Chinese reads well is half of what this screen is for.
  const [langTick, setLangTick] = useState(0);

  const suggestions = useMemo(() => {
    // Read so the dependency is a real one: the strings below come out of t(),
    // which reads a module-level language this memo cannot otherwise see.
    void langTick;
    const list =
      source === "snapshot"
        ? reviewSuggestions(data, now, dismissed)
        : examples.filter((s) => !dismissed.has(s.key));
    return sortSuggestions(list);
  }, [source, data, now, dismissed, examples, langTick]);

  // Fake writes. They change the local AppData exactly the way the real actions
  // change the row in Supabase, so the recompute afterwards is honest. For the
  // EXAMPLES source there is no AppData behind the card, so the fix is recorded and
  // the card is dropped — enough to check the green line and the count.
  const fakeWrites: ReviewWrites = {
    unlinkFromBill: async (id) => {
      setData((d) => ({
        ...d,
        transactions: d.transactions.map((x) => (x.id === id ? { ...x, appliesTo: undefined } : x)),
      }));
      say(`unlinkFromBill(${id.slice(0, 8)}…)`);
    },
    deleteTransaction: async (id) => {
      setData((d) => ({ ...d, transactions: d.transactions.filter((x) => x.id !== id) }));
      say(`deleteTransaction(${id.slice(0, 8)}…)`);
    },
    ...(pretendPiece3Missing
      ? {}
      : {
          setRecurringAmount: async (id, patch) => {
            setData((d) => ({
              ...d,
              recurring: d.recurring.map((r) =>
                r.id === id
                  ? {
                      ...r,
                      amount: patch.amount ?? r.amount,
                      // null means "hand the estimate back", which the model spells
                      // as absent.
                      knownAmount: patch.knownAmount ?? undefined,
                    }
                  : r,
              ),
            }));
            say(`setRecurringAmount(${id.slice(0, 8)}…, ${JSON.stringify(patch)})`);
          },
          setRecurringActive: async (id, active) => {
            setData((d) => ({
              ...d,
              recurring: d.recurring.map((r) => (r.id === id ? { ...r, active } : r)),
            }));
            say(`setRecurringActive(${id.slice(0, 8)}…, ${active})`);
          },
          setRecurringWindow: async (id, patch) => {
            setData((d) => ({
              ...d,
              recurring: d.recurring.map((r) =>
                r.id === id ? { ...r, endsOn: patch.endsOn ?? undefined } : r,
              ),
            }));
            say(`setRecurringWindow(${id.slice(0, 8)}…, ${JSON.stringify(patch)})`);
          },
          addRecurringFromCharges: async (bill) => {
            setData((d) => ({
              ...d,
              recurring: [
                ...d.recurring,
                {
                  id: `lab-${Math.random().toString(36).slice(2, 10)}`,
                  name: bill.name,
                  amount: bill.amount,
                  direction: "out" as const,
                  cadence: bill.cadence,
                  categoryId: bill.categoryId,
                  active: true,
                  dueDays: [bill.dueDay],
                  createdAt: new Date().toISOString(),
                },
              ],
            }));
            say(`addRecurringFromCharges(${bill.name} $${bill.amount} day ${bill.dueDay})`);
          },
          linkTransactionToBill: async (txnId, recurringId) => {
            setData((d) => ({
              ...d,
              transactions: d.transactions.map((x) =>
                x.id === txnId
                  ? { ...x, appliesTo: { kind: "bill" as const, recurringId, monthKey: x.date.slice(0, 7), day: Number(x.date.slice(8, 10)) } }
                  : x,
              ),
            }));
            say(`linkTransactionToBill(${txnId.slice(0, 8)}…, ${recurringId.slice(0, 8)}…)`);
          },
        }),
  };

  const loadJson = (text: string) => {
    setLoadError("");
    try {
      const { data: next, note } = snapshotToAppData(JSON.parse(text));
      setData(next);
      setLoadNote(note);
      setSource("snapshot");
      say(`loaded a snapshot — ${note}`);
    } catch (e) {
      setLoadNote("");
      setLoadError(e instanceof Error ? e.message : "could not read that file");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    f.text()
      .then(loadJson)
      .catch(() => setLoadError("could not read that file"));
  };

  const seg = (on: boolean) =>
    `min-h-[44px] flex-1 rounded-lg px-3 text-[13px] font-semibold transition ${on ? "bg-bone text-bg" : "bg-tile text-taupe"}`;

  return (
    <LanguageProvider>
      <div className="min-h-screen" style={{ background: "#0b0f17" }}>
        <main className="mx-auto max-w-[460px] px-4 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb size={18} style={{ color: "#e3b341" }} />
            <h1 className="flex-1 text-[16px] font-bold text-bone">Worth a look — lab</h1>
            {/* The click bubbles here AFTER LangToggle has already flipped the
                language, so the recompute below reads the new one. See langTick. */}
            <div onClick={() => setLangTick((n) => n + 1)}>
              <LangToggle />
            </div>
          </div>

          {!ENGINE_WIRED && (
            <div
              className="mb-3 flex items-start gap-2 rounded-xl p-3"
              style={{ background: "#2a1618", border: "1px solid #4a2326" }}
            >
              <AlertTriangle size={16} className="mt-[1px] shrink-0" style={{ color: "#e8746a" }} />
              <p className="text-[12px] leading-snug" style={{ color: "#e8a09a" }}>
                <b>The engine is not connected.</b> <code>src/lib/ledgerReview.ts</code> (spec piece
                2) is not wired into <code>src/lib/reviewEngine.ts</code>, so the SNAPSHOT source
                returns nothing. Wire it there — two lines — and this banner goes away. Everything
                below the source switch is the real screen either way.
              </p>
            </div>
          )}

          {/* ── source ── */}
          <div className="mb-3 flex gap-2">
            <button
              className={seg(source === "examples")}
              onClick={() => {
                setSource("examples");
                setData(EXAMPLE_DATA);
              }}
            >
              Examples
            </button>
            <button className={seg(source === "snapshot")} onClick={() => setSource("snapshot")}>
              Snapshot
            </button>
          </div>

          {source === "snapshot" && (
            <div
              className="mb-3 rounded-xl p-3"
              style={{ background: "#141a24", border: "1px dashed #2f3b4a" }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              <div className="mb-2 flex items-center gap-2 text-[12px]" style={{ color: "#8b97a6" }}>
                <FileJson size={14} /> Drop a <code>docs/snapshots/*.json</code> here, or paste it
                below. It stays in this tab.
              </div>
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="paste the snapshot JSON"
                spellCheck={false}
                className="h-20 w-full rounded-lg p-2 text-[11px] text-bone"
                style={{ background: "#0b0f17", border: "1px solid #232d3a" }}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => loadJson(paste)}
                  disabled={!paste.trim()}
                  className="min-h-[44px] rounded-lg px-3 text-[12.5px] font-semibold disabled:opacity-40"
                  style={{ background: "#0e2230", color: "#34c5e8" }}
                >
                  Load pasted JSON
                </button>
                <label className="text-[12px]" style={{ color: "#8b97a6" }}>
                  today is{" "}
                  <input
                    value={nowText}
                    onChange={(e) => setNowText(e.target.value)}
                    className="num w-[104px] rounded-md px-2 py-1 text-bone"
                    style={{ background: "#0b0f17", border: "1px solid #232d3a" }}
                  />
                </label>
              </div>
              {loadNote && (
                <p className="mt-2 text-[11.5px]" style={{ color: "#46d18a" }}>
                  {loadNote}
                </p>
              )}
              {loadError && (
                <p className="mt-2 text-[11.5px]" style={{ color: "#e8a09a" }}>
                  {loadError}
                </p>
              )}
            </div>
          )}

          {/* ── switches ── */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setPretendPiece3Missing((v) => !v)}
              className="min-h-[44px] rounded-lg px-3 text-[12px] font-semibold"
              style={
                pretendPiece3Missing
                  ? { background: "#2a2416", color: "#e3b341" }
                  : { background: "#1b2129", color: "#8b97a6" }
              }
            >
              {pretendPiece3Missing ? "piece 3 writes: OFF" : "piece 3 writes: on"}
            </button>
            <button
              onClick={() => {
                setDismissed(clearDismissed());
                setExamples(EXAMPLE_SUGGESTIONS);
                if (source === "examples") setData(EXAMPLE_DATA);
                setLog([]);
              }}
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold"
              style={{ background: "#1b2129", color: "#8b97a6" }}
            >
              <RotateCcw size={13} /> reset dismissals
            </button>
            <button
              onClick={() => setOpen(true)}
              className="min-h-[44px] rounded-lg px-3 text-[12px] font-semibold"
              style={{ background: "#0e2230", color: "#34c5e8" }}
            >
              open the sheet
            </button>
          </div>

          {/* ── the real card, in an Activity-tab-width column ── */}
          <p className="mb-1.5 text-[11px] uppercase tracking-wide" style={{ color: "#5d6a78" }}>
            the card, as Activity renders it
          </p>
          <div className="mb-1 flex flex-col">
            <ReviewCard count={suggestions.length} onOpen={() => setOpen(true)} />
          </div>
          {suggestions.length === 0 && (
            <p className="mb-3 text-[11.5px]" style={{ color: "#5d6a78" }}>
              nothing to show — the card renders nothing at zero, by design
            </p>
          )}

          {log.length > 0 && (
            <div className="mt-4 rounded-xl p-3" style={{ background: "#0f141c", border: "1px solid #232d3a" }}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide" style={{ color: "#5d6a78" }}>
                <Trash2 size={12} /> writes this session (local only — never Supabase)
              </div>
              {log.map((l, i) => (
                <p key={i} className="num text-[11px]" style={{ color: "#8b97a6" }}>
                  {l}
                </p>
              ))}
            </div>
          )}
        </main>

        <ReviewSheet
          open={open}
          onClose={() => setOpen(false)}
          suggestions={suggestions}
          writes={fakeWrites}
          taps={{
            onApply: async (s) => {
              if (!s.fix) return { ok: false as const, reason: t("This one is for you to decide.") };
              const res = await applyFix(s.fix, data, fakeWrites);
              // The examples are a fixed list rather than an engine output, so a
              // successful fix is taken off it by hand. The real surface gets that
              // for free from the recompute.
              if (res.ok && source === "examples") {
                setExamples((l) => l.filter((x) => x.key !== s.key));
              }
              return res;
            },
            onDismiss: (s) => {
              setDismissed(dismissLocally(s.key));
              say(`dismissed ${s.key}`);
            },
            onTxn: (id) => say(`would open charge ${id}`),
            onBills: () => say("would open the bills screen"),
          }}
        />
      </div>
    </LanguageProvider>
  );
}
