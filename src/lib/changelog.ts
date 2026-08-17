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
    version: "2026.08.16b",
    date: "August 16, 2026",
    notes: [
      "The Update button actually updates now. It could quietly fail two different ways — the new version never took over, or it took over and the page still loaded the old one from cache — and both looked the same from your side: a flicker and nothing changed. It now clears the cache and re-registers as a guaranteed fallback, so tapping it always lands you on the new version.",
      "It also tells you it's working. The button spins and says \"Updating…\" instead of sitting there looking ignored for three seconds.",
      "Electric reads $100 instead of $83 — it was averaging old bills because August's $132 hadn't synced from the bank yet.",
    ],
  },
  {
    version: "2026.08.16a",
    date: "August 16, 2026",
    notes: [
      "The Civic is in the app. The car payment ($232.67, first one Sept 30) and the rewritten insurance are both bills now, each with its own start date — so they stay out of August and show up on their own when they begin.",
      "Forecast is down to the two dials you actually decide each cycle: what you spend, and what goes at the card. The car payment came off the dials because it's a real bill now, not a what-if.",
      "Insurance is modelled the way it's actually billed — three installments finishing the current term, nothing in December and January, then the new rate from February. The empty months are real, not a mistake.",
      "Verizon reads $93 instead of $130. The app was averaging in a catch-up payment that covered two months, so you can now tell it what a bill actually is.",
    ],
  },
  {
    version: "2026.08.15b",
    date: "August 15, 2026",
    notes: [
      "New Forecast tab. It runs your bills forward twelve months instead of showing one, so you can see that support payments restart in November, the dental plan ends in January, and two months a year carry a third paycheck. Tap any month to see the bills behind it.",
      "Three dials on it: how much goes at the card, a car payment you don't have yet, and your spending per cycle. Drag them and every month re-runs. It also pays the card down as it walks forward, so the month the balance hits zero is the month its payment disappears and your surplus jumps. Nothing you drag is saved — they're what-ifs.",
      "Bills can now have a start and end date. That's how a payment paused until November turns itself back on with nobody remembering, and how a dental plan with six payments left knows to stop. It replaces switching a bill off and leaving a note.",
      "You can tell the app what a variable bill actually is. Verizon was projecting $130 because it was averaging in a $209 catch-up payment that covered two months. Now a bill you've actually read beats the estimate.",
    ],
  },
  {
    version: "2026.08.15a",
    date: "August 15, 2026",
    notes: [
      "Xinyan's paycheck now lands on the days it actually lands. The app had her on the 15th and 29th; she's really paid every 14 days — Aug 7, Aug 21, Sep 4 — so every forecast was off by up to six days. It also now shows the months that carry a THIRD paycheck (October has one). Your budget still plans on two checks a month on purpose, so the extra one shows up as upside instead of getting spent in advance.",
      "Two charges that never happened are off your books. The car insurance and one Cherry payment were each counted twice — once as the real bank charge, once as a manual \"already paid\" note on top of it. That was $791.14 of spending that never left your account. The real bank charge now marks the bill paid on its own, so it can't happen again.",
      "Rent reads $1,732.16 instead of $1,715 — the actual amount for the last two months.",
      "Verizon moved to the 24th, Claude Max is switched off, payments to your mom are paused through October, and the ALEKS math subscription is tracked at $21.57.",
    ],
  },
  {
    version: "2026.08.08b",
    date: "August 8, 2026",
    notes: [
      "Tapping a budget category now shows the same period the bar is measuring. Dining read \"$80\" on the summary but \"$44.13 of $250\" when you opened it — the bar was grading your pay cycle while the list underneath was still on the calendar month, and showing the monthly target instead of the per-cycle one.",
    ],
  },
  {
    version: "2026.08.08a",
    date: "August 8, 2026",
    notes: [
      "Activity now opens on THIS CYCLE, not the calendar month. A purchase on the 31st counts toward the current cycle’s budget but used to file under last month — so the dining total included charges you couldn’t find in the list. Now the list matches the number.",
      "Insights shows the pay cycle it’s grading: the dates, the days left, and which day of the cycle you’re on. It used to just say \"June\".",
      "Bills shows the cycle dates, days left, and how much is still due before your next check lands. The bill list itself stays monthly — rent really is due on the 1st.",
    ],
  },
  {
    version: "2026.08.06a",
    date: "August 6, 2026",
    notes: [
      "Notifications are fixed. Both phones had quietly fallen off the notification list — the switch still read On, but nothing could actually be delivered. The app now re-registers your phone every time you open it, so it can't silently drop off again.",
      "Bill reminders stop nagging about bills that aren't due. The car insurance was going to remind you every month instead of every six, and the paid-off card was still asking for its $35 minimum.",
      "A store that sells both gas and groceries now always asks which one it was, even if you've answered for that store before — one answer can't be right for both the pump and the aisles.",
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
