// The finance side's one NAMED inverse: putting a forgotten merchant rule back.
//
// WHY THE FINANCE SIDE HAS ONE AT ALL. Until 2026-10-09 every finance write was
// undone by DATA — the four step kinds in _shared/muse/undo.ts, over an allowlist of
// tables and columns — and undoRegistry.ts said so with some pride, because data is
// the stricter thing. finance.forget_merchant is the first finance write whose
// inverse does not fit any of them, and it is worth saying exactly why rather than
// reaching for the handler because it was there:
//
//   · Its inverse CREATES A ROW. The data kinds have exactly one way to create a row,
//     restore_money_event, and that is the app's own SQL function for a charge. The
//     other choice was a new data kind, "insert this row into that table", and that is
//     the one undo.ts exists to not have: a step in muse_undo that can create any row
//     in any allowlisted table, with any columns, widens what an undo can write to
//     whatever a step says. The allowlist would still name the table; it would no
//     longer bound what lands in it.
//   · Its guard is about OTHER ROWS. Every data step is a compare-and-set on the row it
//     names — "only if it still holds what I wrote". Here the row is gone, so there is
//     nothing to compare. What has to be true at undo time is that no rule has been
//     taught for the same merchant since, because putting the old one back would then
//     overwrite a newer, deliberate answer (or be refused by the table's unique index
//     on `pattern` halfway through). No data kind can say "only if no OTHER row has
//     this pattern".
//
// So the inverse is code with a narrow reach: it can insert into merchant_rules and
// nowhere else, it writes the five columns a rule is and nothing else (through
// FinanceDb.restoreMerchantRule, which is its own verb for the same reason), and it
// refuses with a sentence when the merchant has a rule again. That is the property the
// data kinds have — what an undo can write is a list you can read — kept by the shape
// of the code rather than by an allowlist.
//
// THE NAME IS A NAME IN A DATABASE ROW. "merchant-rule.insert" is stored in every
// muse_undo row finance.forget_merchant writes, and system.undo looks it up in the
// registry merged by mergeUndo. Renaming it orphans every token already handed out, so
// a rename is a migration, not a refactor — the same rule HEALTH_UNDO lives under. It
// follows that file's spelling, too: `<thing>.insert` is "put a deleted one back".

import type { Json } from "../_shared/muse/args.ts";
import { UUID } from "../_shared/muse/args.ts";
import { NAME_MAX, scrubName, scrubOr } from "../_shared/muse/scrub.ts";
import type { CycleBudgetRow, RuleRow } from "./dbFinance.ts";
import { refuse } from "./kit.ts";
import type { UndoHandler, UndoRegistry } from "./undoContract.ts";
// The six budget lines and the cap on one line's goal, from the shared cycle-goal module
// the app and the read door use — so the undo accepts exactly what the tool could write.
import { BUDGET_LINE_KEYS, GOAL_LINE_MAX } from "../_shared/muse/lib/cycleBudget.ts";
import { LEAN_VARIABLE } from "../_shared/muse/lib/plan.ts";

/** The handler's name, as stored in muse_undo. Exported so the tool that records it
 *  and the registry that runs it cannot spell it two ways. */
export const MERCHANT_RULE_INSERT = "merchant-rule.insert";

/**
 * What a rule makes the app do, as the end of a sentence: "The app will stop …" when
 * it is forgotten, "The app will go back to …" when it is put back. One spelling for
 * both, so the undo describes the same habit the forget said it was ending.
 *
 * Everything in it came out of the database, so everything goes through the cleaner:
 * the pattern can be a bank's wording, and a bill name is whatever was typed in the
 * app. A kind this door does not know — the column has no check on it — gets a plain
 * sentence rather than a guess at what it did.
 */
export function ruleHabit(rule: RuleRow): string {
  const name = scrubOr(rule.pattern, "that merchant", 60);
  if (rule.kind === "variable") {
    const category = rule.categoryId ? scrubName(rule.categoryId, NAME_MAX) : "";
    return category ? `filing ${name} as ${category} on its own` : `filing ${name} as ordinary spending on its own`;
  }
  if (rule.kind === "bill") return `treating ${name} as paying ${scrubOr(rule.billName, "its bill", 40)}`;
  if (rule.kind === "skip") return `dropping ${name} from the ledger`;
  return `applying its saved rule to ${name}`;
}

/**
 * The before-state, read back out of muse_undo and checked rather than trusted.
 *
 * A door that took whatever a table handed it would have a write surface equal to the
 * table's contents, which is the reason checkStep in undo.ts reads every step again on
 * the way in. A handler's `before` is opaque to checkStep, so the check is here. The
 * kind is checked for shape, not against the three the door teaches: the undo's job is
 * to put back the rule that WAS there, and the column holds whatever the app wrote.
 */
function ruleFrom(before: Json): RuleRow | null {
  if (typeof before !== "object" || before === null || Array.isArray(before)) return null;
  const { id, pattern, kind, category_id, bill_name } = before;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof pattern !== "string" || !pattern || pattern.length > 200) return null;
  if (typeof kind !== "string" || !/^[a-z]{1,20}$/.test(kind)) return null;
  if (category_id !== null && (typeof category_id !== "string" || category_id.length > 64)) return null;
  if (bill_name !== null && (typeof bill_name !== "string" || bill_name.length > 200)) return null;
  return { id, pattern, kind, categoryId: category_id, billName: bill_name };
}

const undoMerchantRuleInsert: UndoHandler = {
  does: "Put a forgotten merchant rule back under its own id, unless that merchant has been given a rule again since.",
  async apply(before, ctx) {
    const rule = ruleFrom(before);
    if (!rule) {
      return refuse(
        409,
        "I wrote that rule down in a shape I cannot read back, so I changed nothing. Teach it again with finance.learn_merchant if you want it.",
      );
    }
    const name = scrubOr(rule.pattern, "that merchant", 60);

    // REFUSE, NEVER OVERWRITE. A rule on this pattern now is one somebody taught after
    // the forget — on the phone, or through learn_merchant — and it is the newer,
    // deliberate answer. The same reason every data step is a compare-and-set.
    const now = await ctx.db.readMerchantRule(rule.pattern);
    if (now) {
      return refuse(
        409,
        now.id === rule.id
          ? `The rule for ${name} is already back.`
          : `${name} has been given a rule again since I forgot the old one, so I left the new one as it is rather than overwrite it. If the old answer was the right one, teach it with finance.learn_merchant.`,
      );
    }
    // The read above is for the sentence. What actually decides is the table's unique
    // index, inside the insert — so a rule taught in the instant between the two is
    // refused here rather than overwritten.
    if ((await ctx.db.restoreMerchantRule(rule)) === "taken") {
      return refuse(
        409,
        `${name} was given a rule again while I was putting the old one back, so I left the new one as it is.`,
      );
    }
    return {
      ok: true,
      result: { id: rule.id, merchant: name },
      rowIds: [rule.id],
      say: `Put the rule for ${name} back. The app will go back to ${ruleHabit(rule)}.`,
    };
  },
};

// ── putting a cleared cycle goal back ────────────────────────────────────────
//
// ADDED 2026-10-10 for finance.set_cycle_budget's `clear: true`, which deletes a pay
// cycle's goal rows so the cycle goes back to the standard budget. Its undo has exactly
// the shape forget_merchant's does, for exactly the reasons the header gives: it
// RE-CREATES a deleted row, and its guard is about OTHER rows — it must refuse if a goal
// has been set for that line in that cycle since (on either phone, through either
// assistant), because putting the old one back would then overwrite a newer, deliberate
// answer. No data step can say either half.
//
// So it is one handler with a narrow reach: it can put one goal row into cycle_budgets
// under the id it had, and nothing else (FinanceDb.insertCycleBudget, its own verb). A
// clear of several lines records one step per line, and applyUndo runs them newest first
// and STOPS at the first line that has been set again since — the lines it already put
// back stay back, the newer goal stays, and the lines after it wait. That is applyUndo's
// rule for every change that is one answer rather than a batch of separate ones, and a
// cycle's goal is one answer: set_cycle_budget's own write keeps nothing of a call that
// half landed, for the same reason.
//
// ASKING AGAIN HAS TO FINISH THE JOB, so "already back" is SUCCESS. FOUND 2026-10-10 in
// review: this handler used to refuse when the row it was about to put back was already
// there under its own id. Because applyUndo stops at the first refusal and a retry starts
// again from the newest step, the first line a previous attempt had put back refused
// every retry, and the lines behind it could never come back with that token — the same
// trap finance.confirm_charges fell into the same day. A goal row can only come back
// under its old id through this very step (the door picks a fresh id for every new goal,
// and nothing else writes this table with a chosen id), so finding that id there means
// this step already ran, and the honest answer is "done". Its amount is deliberately NOT
// compared: a different amount on that id is a newer goal set after it came back, which
// this undo must not touch either way, and refusing over it would only stop the lines
// behind it for good.
//
// THE NAME IS A NAME IN A DATABASE ROW, like MERCHANT_RULE_INSERT: renaming it orphans
// every token already handed out. `<thing>.insert` is "put a deleted one back".

/** The handler's name, as stored in muse_undo. */
export const CYCLE_BUDGET_INSERT = "cycle-budget.insert";

/** A cleared goal row, read back out of muse_undo and checked rather than trusted — the
 *  same reason ruleFrom exists. The line must be one the plan has and the amount a
 *  dollar figure the goal tool itself would have written, or nothing is put back. */
function goalFrom(before: Json): CycleBudgetRow | null {
  if (typeof before !== "object" || before === null || Array.isArray(before)) return null;
  const { id, cycle_start, line, amount, set_by } = before;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof cycle_start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cycle_start)) return null;
  if (typeof line !== "string" || !BUDGET_LINE_KEYS.includes(line)) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > GOAL_LINE_MAX) return null;
  if (set_by !== null && set_by !== "gino" && set_by !== "xinyan") return null;
  return { id, cycleStart: cycle_start, line, amount, setBy: set_by };
}

/** "Groceries", for a line key — the plan's own label, never typed here. */
export const lineLabel = (key: string): string => LEAN_VARIABLE.find((l) => l.key === key)?.label ?? key;

const undoCycleBudgetInsert: UndoHandler = {
  does: "Put a cleared budget goal for one line of one pay cycle back under its own id, unless a goal has been set for that line in that cycle since.",
  async apply(before, ctx) {
    const goal = goalFrom(before);
    if (!goal) {
      return refuse(
        409,
        "I wrote that goal down in a shape I cannot read back, so I changed nothing. Set it again with finance.set_cycle_budget if you want it.",
      );
    }
    const label = lineLabel(goal.line);
    /** The row on this line now, if any — read fresh each time it is asked. */
    const onLine = async () => (await ctx.db.readCycleBudgets(goal.cycleStart)).find((r) => r.line === goal.line);
    // Put back already — by an earlier try of this same undo. Done, not refused; the
    // header says why, and why the amount is not compared.
    const alreadyBack = () => ({
      ok: true as const,
      result: { id: goal.id, cycle_start: goal.cycleStart, line: goal.line, already_back: true },
      rowIds: [goal.id],
      say: `The ${label} goal for the cycle starting ${goal.cycleStart} was already back.`,
    });
    // The sentence for a line given a newer goal since. It says how to finish, because the
    // undo stops here and a person needs to know what unblocks it: once the newer change
    // is undone (by whoever made it), asking again puts this line and the rest back.
    const newerSays = (when: string) =>
      `A ${label} goal has been set again for the cycle starting ${goal.cycleStart} ${when}, so I left the new one as it is. ` +
      "To bring the old goal back, undo that newer change first, then ask me to undo this one again.";

    // REFUSE, NEVER OVERWRITE — a goal for this line under ANOTHER id is one set after the
    // clear, and it is the newer answer. The read is for the sentence; the table's unique
    // index on (cycle_start, line), inside the insert below, is what actually decides.
    const there = await onLine();
    if (there?.id === goal.id) return alreadyBack();
    if (there) return refuse(409, newerSays("since I cleared the old one"));
    if ((await ctx.db.insertCycleBudget(goal)) === "taken") {
      // The table refused it. Usually the other phone set this line in the instant since
      // the read; but two tries of this same undo landing together also end here, and
      // then the row in the way IS this goal — which is done, not a conflict.
      if ((await onLine())?.id === goal.id) return alreadyBack();
      return refuse(409, newerSays("while I was putting the old one back"));
    }
    return {
      ok: true,
      result: { id: goal.id, cycle_start: goal.cycleStart, line: goal.line, amount: goal.amount },
      rowIds: [goal.id],
      say: `Put the ${label} goal of $${goal.amount.toFixed(2)} back for the cycle starting ${goal.cycleStart}.`,
    };
  },
};

/**
 * Every named inverse the finance side has. Two, and the header says why each is one and
 * not a data step; every other finance undo is a data step.
 */
export const FINANCE_UNDO: UndoRegistry = {
  [MERCHANT_RULE_INSERT]: undoMerchantRuleInsert,
  [CYCLE_BUDGET_INSERT]: undoCycleBudgetInsert,
};
