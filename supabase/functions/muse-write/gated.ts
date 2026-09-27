// What the write door will NOT do, and why — the write side's answer to the read
// door's ABSENT list.
//
// WHY THIS FILE EXISTS AT ALL. openapi.ts used to end its description with a
// hand-written sentence: "There is no tool for moving money, deleting anything,
// settling a bill, or changing a debt balance." Every clause of that was true in
// phase 1 and three of them stopped being true in phase 2, which is the exact
// failure the generated description was built to prevent — a document that
// disagrees with the door teaches an assistant to ask for something that does not
// exist and then improvise when refused, and here it would have done the opposite:
// told it not to bother asking for something that works.
//
// So the list is data, in one place, and openapi.ts prints it. A tool that stops
// being gated is one entry deleted here.
//
// THE PHASE-2 RULE, in one line, because it is what decides whether something
// belongs on this list: Homebase never moves money — it records, categorises and
// computes — so the worst a wrong write does is make data wrong, and wrong data can
// be undone as long as the change was recorded with what it replaced. What stays
// gated is therefore exactly what NO undo could put back.

export const GATED: readonly { name: string; why: string }[] = [
  {
    name: "disconnecting the bank",
    why:
      "It wipes every account on that connection and its whole transaction history (supabase/functions/_shared/callerAuth.ts), and no undo can restore real history — the bank will not re-deliver it. It takes a one-time code he types, not a chat command.",
  },
  {
    name: "moving money",
    why:
      "Nothing in Homebase has ever moved money. It records what happened; the bank is where money moves. There is no verb for it on either door and there never will be.",
  },
  {
    name: "deleting a charge the bank delivered",
    why:
      "A provider row is real history. Deleting one would be undone by the next sync anyway, and history is the one thing this app cannot rebuild.",
  },
  {
    name: "aiming anything at the other person",
    why:
      "Every write lands on whoever's key was used. There is no field for a person, and sending one is a refusal rather than an override — so losing one phone costs one person's data.",
  },
  {
    name: "calling another edge function",
    why:
      "This door talks to Postgres and to nothing else. It holds no URL and no client for anything else, which is why no amount of talking to the assistant can reach one.",
  },
];
