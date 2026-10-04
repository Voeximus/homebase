import { useState } from "react";
import { Check, ChevronRight, Lightbulb, Loader2, X } from "lucide-react";
import { t } from "../../lib/i18n";
import { hasWrite, type ReviewWrites } from "./reviewApply";
import type { Suggestion } from "../../lib/reviewTypes";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Worth a look ──────────────────────────────────────────────────────────────
//
// The screen for the review engine. Built from AnomalySheet, which was already the
// right shape: a centred modal, one card per item, two buttons per card.
//
// WHAT MAKES THIS DIFFERENT FROM THE SELF-CHECK PANEL, ON PURPOSE
// The panel in Profile is red, has no buttons, and tells you the app disagreed
// with itself — certain, exactly zero in a healthy app. This is amber, every card
// has a tap, and every card can be wrong. The header says so in those words,
// because a guess wearing a warning's clothes teaches you to ignore warnings.
// They never appear on the same screen and the wording never overlaps: that panel
// says "did not add up", this one says "worth a look".
//
// WHY A GREEN LINE AND NOT A DISAPPEARANCE
// When a fix lands, the card is replaced in place by one green line. It does not
// vanish: he tapped, and the tap has to have a visible consequence. The line stays
// until the sheet closes, while the list underneath recomputes from the changed
// data — so a fix that resolves two suggestions clears both.

type CardState =
  | { phase: "idle" }
  | { phase: "working" }
  // `amount` is kept so the green line sorts into the slot its card occupied.
  | { phase: "done"; message: string; amount: number }
  | { phase: "refused"; reason: string };

export interface ReviewSheetTaps {
  /** Apply one fix. Resolves with a plain sentence when it was refused. */
  onApply: (s: Suggestion) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** "Looks fine" — remember it and stop showing it. */
  onDismiss: (s: Suggestion) => void;
  /** Open a charge, to look at the evidence. */
  onTxn: (txnId: string) => void;
  /** Open the bills screen, for the suggestions only a person can decide. */
  onBills: () => void;
}

export function ReviewSheet({
  open,
  onClose,
  suggestions,
  writes,
  taps,
}: {
  open: boolean;
  onClose: () => void;
  suggestions: Suggestion[];
  /** Which fixes can actually be performed right now. */
  writes: ReviewWrites;
  taps: ReviewSheetTaps;
}) {
  // Keyed by suggestion key, so a recompute cannot move a green line onto a
  // different card. Cleared when the sheet closes.
  const [state, setState] = useState<Record<string, CardState>>({});

  if (!open) return null;

  const close = () => {
    setState({});
    onClose();
  };

  // A fix replaces its card IN PLACE with a green line rather than removing it.
  // Applying changes the data, the list recomputes, and that suggestion is gone —
  // so without this the thing he just tapped would vanish from where he was
  // looking and a confirmation would appear somewhere else. The tap has to have a
  // visible consequence WHERE HE TAPPED.
  //
  // Everything is ordered by the money it is about, biggest first, so the card
  // that matters most is the one already on screen — and a green line keeps its
  // card's amount, which puts it in exactly the slot the card occupied.
  const items: (
    | { kind: "card"; key: string; amount: number; s: Suggestion }
    | { kind: "done"; key: string; amount: number; message: string }
  )[] = [
    ...suggestions
      .filter((s) => state[s.key]?.phase !== "done")
      .map((s) => ({ kind: "card" as const, key: s.key, amount: s.amount, s })),
    ...Object.entries(state)
      .filter((e): e is [string, Extract<CardState, { phase: "done" }>] => e[1].phase === "done")
      .map(([key, c]) => ({ kind: "done" as const, key, amount: c.amount, message: c.message })),
  ].sort((a, b) => b.amount - a.amount);

  const apply = async (s: Suggestion) => {
    if (state[s.key]?.phase === "working") return;
    setState((m) => ({ ...m, [s.key]: { phase: "working" } }));
    const res = await taps.onApply(s);
    setState((m) => ({
      ...m,
      [s.key]: res.ok
        ? {
            phase: "done",
            message: s.fix?.done ?? t("Done — the app has been updated."),
            amount: s.amount,
          }
        : { phase: "refused", reason: res.reason },
    }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={close}
    >
      <div
        className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto"
        style={{
          background: "#0f141c",
          border: "1px solid #232d3a",
          borderTop: "2px solid #e3b341",
          borderRadius: "22px",
          padding: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#2a2416", color: "#e3b341" }}
          >
            <Lightbulb size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-bone">{t("Worth a look")}</div>
            {/* "Not mistakes" was not true of everything in here. One card — the
                charge attached to a deleted bill — is the exact self-check's own
                finding, and Profile calls that a real mistake in red. Two screens
                describing the same money differently is the defect selfAudit exists
                to catch, so the subtitle says MOST rather than all. */}
            <div className="text-[12px]" style={{ color: "#8b97a6" }}>
              {t(
                "Things the app noticed about your bills and charges. Most are guesses you can wave off — fix or dismiss.",
              )}
            </div>
          </div>
          <button
            onClick={close}
            aria-label={t("Close")}
            className="h-hit -m-1 p-1"
            style={{ color: "#7a8595" }}
          >
            <X size={20} />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="py-8 text-center">
            <Check size={26} style={{ color: "#46d18a" }} className="mx-auto" />
            <p className="mt-2 text-[13.5px] text-bone">
              {t("Nothing to look at — the bills and the charges agree.")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((it) =>
              it.kind === "done" ? (
                <DoneLine key={it.key} message={it.message} />
              ) : (
                <SuggestionCard
                  key={it.key}
                  s={it.s}
                  state={state[it.key] ?? { phase: "idle" }}
                  writes={writes}
                  onApply={() => void apply(it.s)}
                  onDismiss={() => taps.onDismiss(it.s)}
                  onTxn={taps.onTxn}
                  onBills={taps.onBills}
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DoneLine({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl p-3"
      style={{ background: "#13211a", border: "1px solid #1e3b2a" }}
    >
      <Check size={16} className="mt-[1px] shrink-0" style={{ color: "#46d18a" }} />
      <span className="text-[12.5px] font-medium" style={{ color: "#46d18a" }}>
        {message}
      </span>
    </div>
  );
}

function SuggestionCard({
  s,
  state,
  writes,
  onApply,
  onDismiss,
  onTxn,
  onBills,
}: {
  s: Suggestion;
  state: CardState;
  writes: ReviewWrites;
  onApply: () => void;
  onDismiss: () => void;
  onTxn: (id: string) => void;
  onBills: () => void;
}) {
  // A fix whose store action is not connected yet is treated as no fix at all:
  // the card becomes the "open the evidence" version rather than a dead button.
  // Information the user can act on himself beats a control that does nothing.
  // A BLOCKED fix is different — it is a real offer with a stated reason — so it
  // keeps its own button, greyed, with the reason above it.
  const fix = s.fix && hasWrite(s.fix, writes) ? s.fix : null;
  const blocked = fix?.blocked;
  // ...but the card SAYS SO, rather than quietly becoming a different card. The
  // app already had the honest sentence for this and nothing could ever reach it,
  // because the button it would have been shown on was the one being suppressed.
  const notReady =
    s.fix && !fix ? t("That fix is not ready yet. You can still change it yourself.") : null;
  const txnIds = s.txnIds ?? [];
  const working = state.phase === "working";
  // The dangling-charge card is the ONE certain finding in this sheet — the exact
  // self-check found it and will keep reporting it — so it is not something to wave
  // off, and dismissing it would hide the only route to the fix.
  const canDismiss = s.kind !== "dangling";

  // The fallback left button, for the suggestions only a person can decide (W4),
  // for a duplicate where both rows came from the bank (§D.5 — no fix, ever), and
  // for a fix whose write has not shipped. It goes where the card's subject is: a
  // card about a BILL opens the Bills screen, because the charge sheet has no
  // control for a bill's amount, its window or whether it is on.
  const openLabel = s.recurringId
    ? t("Show me the bill")
    : txnIds.length >= 2
      ? t("Show me the charges")
      : t("Show me the charge");
  const openTap = () => {
    if (s.recurringId) onBills();
    else if (txnIds.length) onTxn(txnIds[0]);
    else onBills();
  };

  return (
    <div className="rounded-xl p-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold" style={{ color: "#e6edf3" }}>
            {s.title}
          </span>
          <span className="mt-0.5 block text-[11.5px] leading-snug" style={{ color: "#8b97a6" }}>
            {s.detail}
          </span>
        </span>
        <span className="num shrink-0 text-[14px] font-bold" style={{ color: "#e6edf3" }}>
          {money2(s.amount)}
        </span>
      </div>

      {/* Why this one cannot be tapped yet — the app says it rather than showing a
          button that does nothing. §D.4's ungraded-category case lands here, and so
          does a fix whose store action has not shipped. */}
      {(blocked || notReady) && (
        <p className="mt-2 text-[11.5px]" style={{ color: "#e3b341" }}>
          {blocked ?? notReady}
        </p>
      )}
      {!canDismiss && (
        <p className="mt-2 text-[11.5px]" style={{ color: "#8b97a6" }}>
          {t("The self-check found this one, so it will keep reporting it until it is fixed.")}
        </p>
      )}
      {state.phase === "refused" && (
        <p className="mt-2 text-[11.5px]" style={{ color: "#e8a09a" }}>
          {state.reason}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        {fix ? (
          <button
            onClick={onApply}
            disabled={working || !!blocked}
            aria-disabled={!!blocked}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] font-semibold transition active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100"
            style={
              blocked
                ? { background: "#232d3a", color: "#8b97a6" }
                : { background: "#0e2230", color: "#34c5e8" }
            }
          >
            {working && <Loader2 size={14} className="animate-spin" />}
            {fix.label}
          </button>
        ) : (
          <button
            onClick={openTap}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold transition active:scale-[0.98]"
            style={{ background: "#232d3a", color: "#8b97a6" }}
          >
            {openLabel}
            <ChevronRight size={14} />
          </button>
        )}
        {canDismiss && (
          <button
            onClick={onDismiss}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg px-2 text-[12.5px] font-semibold transition active:scale-[0.98]"
            style={{ background: "#13211a", color: "#46d18a" }}
          >
            {t("Looks fine — dismiss")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── The card that opens it ────────────────────────────────────────────────────
// Same geometry as the "Unusual purchases" card on Home, amber instead of pink.
// It is NOT rendered at zero — there is no green "all clear" version, because the
// self-check panel earns its always-there line by being exact and a guesser that
// says "nothing to report" is only taking up space.
export function ReviewCard({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      onClick={onOpen}
      className="flex min-h-[44px] items-center gap-3 rounded-[13px] p-3 text-left transition active:scale-[0.98]"
      style={{ background: "#241f12", border: "1px solid #4a3f1c" }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "#2a2416", color: "#e3b341" }}
      >
        <Lightbulb size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold" style={{ color: "#e3b341" }}>
          {t("Worth a look")}
        </div>
        <div className="mt-0.5 text-[11px]" style={{ color: "#9aa6b2" }}>
          {count === 1
            ? t("1 thing the app noticed")
            : t("{n} things the app noticed", { n: count })}
        </div>
      </div>
      <ChevronRight size={18} style={{ color: "#7a8595" }} />
    </button>
  );
}
