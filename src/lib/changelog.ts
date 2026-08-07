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
    version: "2026.08.06a",
    date: "August 6, 2026",
    notes: [
      "Notifications are fixed. Both phones had quietly fallen off the notification list — the switch still read On, but nothing could actually be delivered. The app now re-registers your phone every time you open it, so it can't silently drop off again.",
      "Bill reminders stop nagging about bills that aren't due. The car insurance was going to remind you every month instead of every six, and the paid-off card was still asking for its $35 minimum.",
      "A store that sells both gas and groceries now always asks which one it was, even if you've answered for that store before — one answer can't be right for both the pump and the aisles.",
      "Insights now shows the pay cycle it's grading: the dates, how many days are left, and which day of the cycle you're on. It used to just say \"June\".",
      "Bills now shows the cycle dates, days left, and how much is still due before your next check lands. The bill list itself stays monthly — rent really is due on the 1st.",
    ],
  },
  {
    version: "2026.08.05b",
    date: "August 5, 2026",
    notes: [
      "The budget now runs on your PAY CYCLE instead of the calendar month. It resets on payday — the 15th and the last day — because that's when money actually arrives, and rent hits the 1st.",
      "Home shows which cycle you're in and how far through it, so you can see you're at 51% spent with 8 days left instead of finding out at month end.",
      "Each line is now a per-cycle allowance: $800 total, groceries $300, household $175, dining $125, gas $100, misc $63, pets $38.",
      "Bills stay monthly — rent really is due on the 1st.",
    ],
  },
  {
    version: "2026.08.05a",
    date: "August 5, 2026",
    notes: [
      "Gas at Sam's Club now lands in the gas line and groceries at Sam's Club land in groceries. Your bank labels which pump-vs-store a charge was, and the app was throwing that label away — it had put $143 of July groceries into gas, making gas read $402 instead of $259.",
      "When a store sells both fuel and food and the bank doesn't say which, the app now asks you instead of quietly guessing.",
      "Tap any transaction to see exactly what the bank wrote — handy when a category looks wrong.",
      "Your dental plan and the two new Affirm plans are tracked now, and the card minimum is corrected to $134.",
    ],
  },
  {
    version: "2026.07.28a",
    date: "July 28, 2026",
    notes: [
      "Monthly budget re-based from $1,250 to $1,600 — the old number was never once hit in five months, so every month read as a failure. Each line is now set from what you actually spend: groceries $600, household $350, dining $250, gas $200, misc $125, pets $75.",
      "Dining now covers coffee and boba explicitly, and Misc covers business costs — the Knotted Studios filings were landing there anyway.",
      "Your dental plan is tracked: Cherry, $1,062 at 0%, $151.72 on the 24th through January.",
      "Claude Max now settles as a bill instead of eating $108 of your variable budget every month.",
    ],
  },
  {
    version: "2026.07.15d",
    date: "July 15, 2026",
    notes: [
      "Pay off a card and its monthly payment disappears from your bills on its own — no cleanup. Charge the card again and it comes back.",
    ],
  },
  {
    version: "2026.07.15c",
    date: "July 15, 2026",
    notes: [
      "Electronics no longer counts against your $1,250 — it sits outside the budget the way you set it up, and still comes off what's available for debt.",
      "New \"Misc / uncategorized\" line ($50) catches purchases from merchants the app has never seen, so your budget lines finally add up to your budget total. Gas moves $250 → $200 to make room (you're running ~$95/mo since the Sam's Club card).",
      "Fixing a merchant's category now also fixes the older purchases it got wrong — anything you set by hand is left alone.",
    ],
  },
  {
    version: "2026.07.15b",
    date: "July 15, 2026",
    notes: [
      "New \"Interest + Fees\" category — card interest and late fees have their own line now instead of hiding in Other. You've paid $465 to carry debt since March.",
      "It stays out of your $1,250 budget on purpose: it isn't spending you chose, and it's already counted inside the card balance your debt total reads from.",
    ],
  },
  {
    version: "2026.07.15a",
    date: "July 15, 2026",
    notes: [
      "Yearly and 6-month bills now land only in the month they're actually due — your Sam's Club membership no longer shows up as a bill every single month.",
      "Xinyan's car insurance is tracked now: $639.42 every 6 months, due Aug 1 and again Feb 1.",
      "Fixed a hole where some purchases didn't count toward your budget at all — anything you buy now lands on a budget line, so a mislabel can shift a category but can never make money disappear.",
      "Retired the Subscriptions budget line — every live subscription is already a bill, so its $50 moved to Household + Hygiene (now $250). Your monthly total is still $1,250.",
      "Xinyan's card now shows its real 27.49% interest rate instead of looking free.",
    ],
  },
  {
    version: "2026.07.04c",
    date: "July 4, 2026",
    notes: [
      "Health has a whole new look — a cleaner layout led by a calories-left hero with a colored protein / carbs / fat counter, plus glanceable This-week and Weight tiles you tap to expand.",
      "Pick your Health style — tap the palette icon up top for Original, Instrument, or Bold. It's saved per device, so you and Xinyan can each choose your own.",
      "The new look is consistent everywhere — meals, workouts, Together, and every pop-up.",
      "Tidier header — the Meal/Workout and Just-me/Together switches are compact icons now, and saved meals collapse to one line so long names don't crowd the screen.",
    ],
  },
  {
    version: "2026.07.04b",
    date: "July 4, 2026",
    notes: [
      "Health has a fresh look — a cleaner layout led by a calories-left hero with a colored protein / carbs / fat counter, and consistent styling on every screen (meals, workouts, and all the pop-ups).",
      "Choose your Health style — tap the palette icon up top to pick Original, Instrument, or Bold. It's saved per device, so you and Xinyan can each pick your own.",
      "Fixed weekly adherence — a week with only a day or two logged no longer reads as nearly 100%; days you didn't log now count against that week.",
    ],
  },
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
