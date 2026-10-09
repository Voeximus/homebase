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
import type { RuleRow } from "./dbFinance.ts";
import { refuse } from "./kit.ts";
import type { UndoHandler, UndoRegistry } from "./undoContract.ts";

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

/**
 * Every named inverse the finance side has. One, and the header says why it is one and
 * not zero; every other finance undo is a data step.
 */
export const FINANCE_UNDO: UndoRegistry = {
  [MERCHANT_RULE_INSERT]: undoMerchantRuleInsert,
};
