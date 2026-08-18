# ⛔ SUPERSEDED — do not use

**This file was last accurate on 2026-06-16.** It has been replaced by
[`ACCOUNTANT_BRIEF.md`](ACCOUNTANT_BRIEF.md).

It is stubbed out rather than deleted because an AI assistant reading a stale
status doc is exactly how wrong numbers get into real decisions — and this one had
drifted badly. Its full original text is in git history if you need it:

```bash
git log --oneline -- docs/STATUS.md
git show <commit>:docs/STATUS.md
```

## What it got wrong by August 2026

Concretely, so nobody quotes it by accident:

- **Rent** — said $1,715. Actual $1,732.16.
- **Mom's support** — said $600/mo ongoing. Actually $300/check, paused, restarting 2026-11-01.
- **No car existed.** There is now a Civic: $232.67/mo from 2026-09-30, plus restructured insurance.
- **Debts** — the whole $5,836.65 picture listed there has since been paid down and restructured.
- **Budget** — said $1,250/mo. Re-based to $1,600 in July 2026, then moved to
  **per-pay-cycle** grading in August. The monthly framing itself is obsolete.
- **Xinyan's paycheck** — modeled on the 15th and 29th. She is paid **biweekly**;
  the real dates come from an anchor date, and ~2 months a year carry a third check.
- **Roadmap** — every item in its §6 is either shipped or abandoned.
- **Open security TODOs** in its §2 (test user, disabling signups) — verify these
  independently rather than trusting the state described there.

## Where to go instead

| For | Read |
|---|---|
| Access, current numbers, the accounting rules, the trap catalog | [`ACCOUNTANT_BRIEF.md`](ACCOUNTANT_BRIEF.md) |
| What changed when, and why | [`HANDOFF.md`](HANDOFF.md) |
| The live data | `SUPABASE_PAT=<token> npm run snapshot` |
