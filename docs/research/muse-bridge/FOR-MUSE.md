# FOR-MUSE.md — the questionnaire, already answered. Do not paste this.

> **This is history, not an instruction.** It is the message that was sent to Muse
> on 26 September to find out what Muse could actually do, before either door was
> built. Its six questions have been answered and the answers are what `PLAN.md`
> is built on: skills persist across conversations and devices, a key sits in a
> vault the model cannot read, scheduled jobs can call an API pinned to
> America/Phoenix with timing loose by a few minutes, a reminder arrives as chat
> plus a push that does **not** override Do Not Disturb and cannot be confirmed
> delivered, Muse **can** set a real alarm on a Pixel, Google Calendar is
> connected for create/edit/read, and it reads nutrition labels from photos.
>
> **The thing you paste into Muse is `MUSE-SKILL.md`.** Not this.
>
> **Its "what the door will expose" list below is a wish, and several items were
> not built.** Posted-versus-pending (there is no posted figure at all), bills due
> before the next paycheck, payoff dates, the logging streak, and a barcode lookup
> are all absent — `API.md` has the built list of eleven reads and says which of
> these are planned and which are forbidden. It also narrowed
> `finance.spend_by_category` to whole months. Read `API.md` for what exists;
> read this only to see what was asked.

I want you to become the interface for a system I already run. I'm going to describe it, then ask you six questions about what you can actually do. Answer the questions first, plainly, and say "I don't know" where you don't — I'm making build decisions from your answers.

## What exists today

**Homebase** is a private web app my partner and I use, backed by a Postgres database (Supabase) with server functions. It holds:

**Money** — our bank accounts synced automatically from Bank of America through Plaid, every transaction going back months, categories, merchant rules, recurring bills with due dates, debts with interest rates, a monthly budget, and a set of checks that catch the app disagreeing with itself.

**Health** — meals logged with calories and protein/carbs/fat, daily targets, body weight history, workouts with every set and rep, an exercise library with the muscles each exercise trains, and personal records.

**Schedule** — I'm moving to 12-hour night shifts, 8 PM to 8 AM, four days on and three off, for about three months. Sleep 9 AM to 4 PM every day. A meal plan built around that: pre-workout bowl at 4:15 PM, dinner at 6:15 PM, a light high-protein meal at 1 AM, optional food at 8:45 AM. Roughly 2,500 calories and 130 g protein a day.

## What I want

The app disappears. I stop opening screens. The database and its server functions stay as the source of truth, and **you become how I touch all of it** — ask questions, log things, get told what needs attention, and get reminded at the right times.

I'm building you a door into it: a single HTTPS endpoint with a bearer token, a documented list of named actions, and an OpenAPI description you can read. Reads will be generous. Writes will be few and narrow.

## The six questions

1. **Persistence.** If I describe this API to you and you build an integration for it, does that survive? Can I use it tomorrow, in a brand-new conversation, without re-explaining? Is it the same on my phone and anywhere else I use you?
2. **Secrets.** Can you hold a bearer token securely and send it in an `Authorization` header on every call? Where does that token live, and who at Meta can see it?
3. **Scheduled tasks.** Can a recurring task call my API on a schedule — say, every night at 1 AM — and act on what comes back? What's the smallest interval, and does it respect my time zone (Arizona, no daylight saving)?
4. **Reaching me.** When a scheduled task fires, what actually happens on my phone? A notification that wakes the screen, or a message sitting in our chat until I open it? Be exact, because I work nights and need reminders that arrive without me looking.
5. **Calendar.** Can you create, edit and read events in my Google Calendar? Can you set a reminder that makes my phone go off?
6. **Photos.** If I photograph a nutrition label, can you read the numbers off it and send them to my API as structured data — calories, protein, carbs, fat, serving size?

## What the door will expose

**Read, freely:**
- Cash position across accounts, what's posted vs pending
- Bills due before my next paycheck, paid or not
- How much is free each month to aim at debt
- Budget: spent and left, by line
- Debts, balances and payoff dates
- Spending by category over a window
- Self-checks: does the system disagree with itself
- Macros left today, weight trend, logging streak
- Today's workout, what I lifted last time, weekly training volume per muscle

**Write, three of them land immediately:**
- Log a weigh-in
- Log one of our saved meals by name
- Write a reminder for a given time

**Write, queued for one tap from me:**
- Categorize a charge
- Record what a variable bill actually came to
- Add a cash charge the bank won't see
- Log free-form food

**Never, at any point:**
- Move money, pay anything, or touch the bank connection
- Mark a bill as paid
- Delete anything
- Return the raw transaction list — category totals only, never a feed of individual charges

## Rules I'm holding you to

- **You do the thinking. The database does the arithmetic.** Every number you tell me comes from the API, not from you re-deriving it. If a figure isn't exposed, say so rather than estimating.
- **Say which half is measured and which is your judgement**, every time. I've been burned by confident wrong numbers.
- **Plain language.** No jargon without a one-line meaning.
- **Never repeat a merchant name, bank descriptor or individual charge** into any surface outside our chat.

## What I need back from you

After the six answers: tell me exactly what you need from my side to build this connector — the auth format you prefer, whether you want OpenAPI or something else, request limits, and anything about my design above that won't work with how you actually operate. If a piece of this is impossible for you, say so plainly and tell me the nearest thing that is possible.
