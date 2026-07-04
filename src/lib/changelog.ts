// The release changelog. To roll out an update: add a NEW entry at the TOP with
// a fresh `version` + plain-English bullets. APP_VERSION is derived from the top
// entry, so bumping the changelog IS bumping the version. After a user updates,
// WhatsNew shows the notes for any version they haven't seen yet (compared to the
// `hb-seen-version` they last acknowledged), then records the new one.

export interface Release {
  version: string; // stable id, newest first — also the app version key
  date: string; // human label, e.g. "July 2026"
  notes: string[]; // simple "what's new" bullets shown to the user
}

export const CHANGELOG: Release[] = [
  {
    version: "2026.07.04a",
    date: "July 4, 2026",
    notes: [
      "Saved meals keep their name when you add them to a day — no more \"Meal 1, Meal 2, Meal 3\".",
      "Tap a saved meal to edit it in place — rename it or change its ingredients — without logging it and re-bookmarking.",
      "Meal cards now show calories and each macro (P / C / F) in its own color, so the breakdown reads at a glance.",
      "Plan adherence is now weekly: a fresh \"this week\" that resets every Monday, with a recent-weeks trend below it.",
      "New \"Electronics\" category for one-off tech buys (monitors, etc.) — it sits outside the monthly budget but still counts against debt.",
    ],
  },
  {
    version: "2026.07.01b",
    date: "July 1, 2026",
    notes: [
      "Bills now show when you actually paid them — pay early and it still lands on the right bill, on its due date.",
      "Bills sheet: a Paid and an Unpaid · posting list you expand, plus a flippable month calendar.",
      "Activity: flip back through previous months, not just this one.",
      "Meal builder decluttered — saved meals and each meal's ingredients collapse into dropdowns, the daily macro counter scrolls instead of covering the screen, and the keyboard no longer pops up on its own.",
      "Preview a saved meal before adding it, and save a meal to your library without logging it to today.",
      "Set your own daily calorie + macro targets.",
      "Together: see what each of you ate today, and split each ingredient of a shared meal individually (in 10% steps) instead of a flat 50/50.",
      "Edit or delete a shared meal after logging it — in case a split came out wrong.",
      "Notifications now arrive right away, even with the app closed (no more waiting until you open it).",
      "This 'What's new' card + a clearer, distinct update button, and the Activity + button pinned to the bottom so it stops covering the list.",
    ],
  },
];

export const APP_VERSION = CHANGELOG[0].version;
