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
    version: "2026.07.01",
    date: "July 2026",
    notes: [
      "Bills now show when you actually paid them — pay early and it still lands on the right bill, on its due date.",
      "Bills sheet: a Paid and an Unpaid list you expand, plus a flippable month calendar.",
      "Activity: flip back through previous months, not just this one.",
      "Meal builder decluttered — saved meals and each meal's ingredients tuck into dropdowns.",
      "Set your own daily calorie + macro targets.",
      "Together: split each ingredient of a shared meal individually instead of a flat 50/50, and see what each of you ate today.",
    ],
  },
];

export const APP_VERSION = CHANGELOG[0].version;
