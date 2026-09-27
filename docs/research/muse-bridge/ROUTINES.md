# The night-shift routines — what Muse should set up

Everything here comes from two places: `weekly-schedule (2).html` (the sleep protocol,
the meal plan and the hour-by-hour timeline for all four day types) and the door plan
beside this file. Times are Arizona, always. Nothing here is a guess about his day —
where the two source documents disagree, §9 says so instead of quietly picking one.

Two halves, and they are worth separating because one of them works today:

- **Part A — the reminders, alarms and calendar events.** Needs nothing from Homebase.
  Muse can do all of this now, before either door is deployed.
- **Part B — the scheduled checks that call Homebase.** Needs the read door deployed
  and the connector built — `SETUP.md` steps 1–5, then checks 1–6 in its step 6.
  Until then these are written down and switched off.

---

## 1. Five rules that shape every item below

**1. Nothing fires between 8:55 AM and 4:00 PM. Ever.** That is the sleep window,
seven days a week. A push does not override Do Not Disturb, which sounds like safety
until the one day it does get through. The only thing allowed in that window is the
4:00 PM alarm at the end of it.

**2. Four channels, and they are not interchangeable.**

| Channel | Use it for | Why |
|---|---|---|
| **ALARM** on the Pixel | anything that must wake him or must land in the circadian trough | The only one that beats Do Not Disturb. Muse can set these. |
| **EVENT** in Google Calendar | standing blocks — the shift, prep, the park, the retro, rent | Two people can see it, it survives Muse, and he can move it. |
| **CHAT** message from Muse | everything else | Arrives as a message plus a push. Does not override Do Not Disturb, and delivery cannot be confirmed. |
| **HOMEBASE REMINDER** via `schedule.remind` | a one-off nudge he asks for in the moment — "remind me at 11 to check the electric bill" | The write door's `schedule.remind` puts a row in Homebase's own `reminders` table and Homebase's 15-minute job pushes it. It arrives even if Muse is down, and it lands within about 15 minutes of the time, never on the minute. Needs the write door and `SETUP.md` step 4. Do Not Disturb silences it too. |

**Never let something that must happen depend only on a CHAT reminder.** If it matters
more than a nudge, it is an ALARM or an EVENT.

**Nothing in this document uses the HOMEBASE REMINDER channel for a standing item**,
and that is deliberate: it is capped at 10 new reminders a day and 20 waiting at once,
its message has to fit 80 characters, and a repeating one counts as waiting forever. It
is the right channel for something he asks for once, not for the spine below. It is
listed here so nobody reads the three rows above and concludes Homebase cannot remind
him of anything.

**3. Muse's timing is loose by a few minutes, so fire early.** Every deadline-shaped
item is set 5–10 minutes ahead of the real moment: the caffeine curfew at 2:45 AM for a
3:00 AM cutoff, gear-up at 7:05 PM for a 7:15 PM door. A reminder that drifts past its
own deadline is worse than none.

**4. The cycle is seven days long, so weekly repeats work.** Four on plus three off is
exactly a week — so once he knows which four nights he is on, they are the same four
nights every week, and every calendar item can be a plain weekly repeat. No cycle
maths, no conditional jobs.
**If his four nights ever rotate instead:** keep the whole daily spine (§3) exactly as
it is — it does not care which day it is — and put only the work-night items (§4) on
the shift EVENT itself, so moving the shift moves them.

**5. His day is not the calendar day.** His day runs **4:00 PM to 9:00 AM the next
morning**. Homebase, by contrast, files everything by Arizona calendar date. So:

- **Name a shift by the night it starts.** "Monday's shift" is Monday 8:00 PM to
  Tuesday 8:00 AM, one calendar event crossing midnight.
- **On any calendar date, Homebase sees his four meals out of order:** the 1:00 AM
  break meal and the 8:45 AM snack belong to the shift that started *yesterday*, then
  the 4:15 PM bowl and the dinner belong to the shift starting *today*.
- In steady state that still adds up to about 2,500 calories on the date, which is
  right. What it breaks is any mid-day reading of it. J2 in §7 handles that.

---

## 2. His day, laid out

Read off the timeline in the HTML. Same wake, same first two hours, every single day.

| | Work night (×4) | Off 1 · errands | Off 2 · park | Off 3 · retro |
|---|---|---|---|---|
| 4:00 PM | up, water, 10 min outside | up, laundry in | up, outside | up, outside |
| 4:10 PM | big bowl | big bowl | big bowl | big bowl |
| 4:40 PM | workout 45 min | workout | workout | workout |
| 5:25 PM | shower | shower | shower | shower |
| 5:40 PM | **dinner (reheat)** | grocery run, 70 min | company ops | company ops |
| 6:00 PM | flex · L&O or ops | — | — | — |
| 6:50 PM | — | fold laundry | — | — |
| 6:55 PM | Tank walk with Xinyan | — | — | — |
| 7:05 PM | gear up | — | — | — |
| 7:10 PM | — | dinner + L&O | — | — |
| 7:15 PM | leave for work | — | — | — |
| 7:40 PM | — | — | **park, 2 h** | dinner + L&O |
| 8:00 PM | **on shift** | — | — | — |
| 8:10 PM | — | Tank walk | — | — |
| 8:40 PM | — | — | — | Tank walk |
| 8:55 PM | — | — | — | **money retro, 30 min** |
| 9:40 PM | — | — | dinner + L&O | — |
| 10:25 PM | — | **prep #1, 2 h** | — | — |
| 11:25 PM | — | — | — | **prep #2, 2 h** |
| 1:00 AM | **break meal** | company ops | company ops | company ops |
| 2:45 AM | **walk + water + light** | walk break | walk break | walk break |
| 3:00 AM | caffeine curfew | curfew | curfew | curfew |
| 7:55 AM | job log | — | — | — |
| 8:00 AM | sunglasses, drive home | — | — | — |
| 8:45 AM | home, wind-down | wind-down | wind-down | wind-down |
| 9:00 AM | **sleep** | sleep | sleep | sleep |

The thing that falls out of this table: **he is awake at 2:45 AM and asleep at 9:00 AM
on all seven days.** So the two hardest anchors need no cycle logic at all.

---

## 3. Part A — the daily spine (all seven days, weekly repeat not needed)

| # | Fires | When | Channel | Exact words |
|---|---|---|---|---|
| D1 | Wake | 4:00 PM daily | **ALARM** | `Up. Water, then ten minutes outside.` |
| D2 | Weigh in | 4:05 PM daily | CHAT | `Scale before food. Say the number.` |
| D3 | Big bowl | 4:10 PM daily | CHAT | `Big bowl now. Workout at 4:40.` |
| D4 | Workout | 4:35 PM daily | CHAT | `Workout in five. 45 minutes.` |
| D5 | Tank walk | 6:55 PM daily | EVENT | `Tank walk with Xinyan` · 15 min |
| D6 | Trough reset + caffeine curfew | **2:45 AM daily** | **ALARM** | `Walk, water, bright light. Last coffee is now.` |
| D7 | Wind-down | 8:45 AM daily | CHAT | `Shower warm, then dim. Lights out at nine.` |
| D8 | Lights out | 8:55 AM daily | EVENT | `Sleep 9:00 AM – 4:00 PM` · phone out of the bed, mask on |

**D1 is the load-bearing one.** Everything else hangs off the 4:00 PM anchor, and the
schedule's own rule is: keep the 4:00 PM wake even after a bad night. Ask Muse to set it
as a **repeating daily alarm**. If it can only set one-shot alarms, set the repeat by
hand in the Clock app once — a hand-set alarm costs a minute and never depends on Muse
being right.

**D6 does two jobs on purpose.** The walk and the caffeine cutoff are the same moment,
and one reminder in the trough is worth more than two he dismisses. It is an ALARM
because 2:45 AM is exactly when he is least able to start something himself.

**D2 pairs with the write door** (`health.log_weight`, lands immediately). Until the
write door is up, he says the number to Muse and it goes nowhere — so either keep D2 off
until then, or accept that it is a habit-builder only.

---

## 4. Part A — work nights only (weekly repeat on his four nights)

| # | Fires | When | Channel | Exact words |
|---|---|---|---|---|
| W1 | The shift itself | 8:00 PM – 8:00 AM, his four nights | EVENT | `Night shift` · 8:00 PM to 8:00 AM next day |
| W2 | Dinner | 5:40 PM | CHAT | `Dinner. Reheat the pre-made.` |
| W3 | Gear up | 7:05 PM | CHAT | `Sunglasses and the 1 AM box in the bag. Out at 7:15.` |
| W4 | Leave | 7:15 PM | CHAT | `Leaving now gets you there sharp.` |
| W5 | Break meal | 1:00 AM | CHAT | `Break meal. Yogurt, berries, honey on top.` |
| W6 | Job log | 7:50 AM | CHAT | `Job log. Five minutes, voice note. Then it's closed.` |
| W7 | Sunglasses | 8:00 AM | CHAT | `Sunglasses on before the door. Keep them on till indoors.` |

**W7 is not the same light rule as D1, and confusing them costs him a day of sleep.**
4:00 PM: get outside, no sunglasses, ten minutes of real daylight — that is the anchor
going in. 8:00 AM: sunglasses on at the door and off only behind curtains — that is the
anchor coming out. Two opposite instructions about light, twelve hours apart.

**W3 carries two things in one line** because they fail together: no sunglasses means a
wrecked sleep, no 1 AM box means a vending machine at 1 AM.

---

## 5. Part A — off days (weekly repeat, one per off day)

| # | Fires | When | Channel | Exact words |
|---|---|---|---|---|
| O1 | Laundry in | 4:00 PM off day 1 | CHAT | `Laundry in before the bowl.` |
| O2 | Grocery run | 5:40 PM off day 1 | EVENT | `Grocery run · Sam's list, about $100` · 70 min |
| O3 | Prep #1 | 10:25 PM off day 1 | EVENT | `Prep #1 · rice, beef, nine eggs, chop the veg` · 2 h |
| O4 | Park | 7:40 PM off day 2 | EVENT | `Park with Tank and Xinyan` · 2 h |
| O5 | Money retro | 8:55 PM off day 3 | EVENT | `Money retro with Claude` · 30 min |
| O6 | Prep #2 | 11:25 PM off day 3 | EVENT | `Prep #2 · salmon, beef, rice, nine eggs. Pack the 1 AM boxes.` · 2 h |

O3 and O6 are EVENTS, not chat nudges, because they are two hours each and the week's
food depends on them. O2 is an EVENT so Xinyan can see it.

---

## 6. Part A — monthly and one-off

| # | Fires | When | Channel | Exact words |
|---|---|---|---|---|
| M1 | Rent heads-up | 28th, 6:15 PM | EVENT | `Rent hits the 1st — $1,726.88. Check it's covered.` |
| M2 | Rent due | 1st, 6:15 PM | EVENT | `Rent today, $1,726.88.` |
| M3 | Bonus | 30 September, 6:15 PM | CHAT | `Bonus lands today. Decide where it goes before it's gone.` |

Rent is the only dollar figure written into reminder text anywhere in this document,
because it is the only one that does not move. **Every other number comes from the door
at the moment it is spoken** — a figure baked into a reminder is a figure that goes
stale silently, and a stale number said with confidence is the whole failure this bridge
was built to avoid.

M3 is a judgement call, not an instruction: the card is at 26.49% and the $1,400 floor
per check is deliberate and does not get lowered to make room for anything.

---

## 7. Part B — the scheduled checks that call Homebase

Every one of these is a **scheduled job, pinned to America/Phoenix**. Scheduled jobs
always run and cannot be made conditional, so each one below has an exact sentence for
"nothing to report". Without that, a silent job looks broken and a chatty one gets
muted.

The rules Muse follows on all of them are in `MUSE-SKILL.md`, which is what gets pasted
into Muse, and in `API.md`, which is where those rules come from. The two that
matter most here: never re-derive a number, and never read out a merchant or a single
charge.

### J1 — Evening money check · 6:05 PM, daily

**Tools:** `finance.audit`, then `finance.position`.

Says, in this order: whether the books agree with themselves, then spendable cash.

- **Clean:** `Books agree. $X spendable. Nothing needs you.`
- **A check failed:** the check's own question, that it failed, and that the app is where
  to see which row. Then stop — no diagnosis.
- **Refused:** the door's own sentence, and no number at all.

**This is the "morning after the shift" check, moved.** It was asked for at clock-out,
and it cannot go there: at 8:00 AM he is driving, at 8:45 AM he is in dim light running
the sleep off-ramp, and his own protocol says mornings are shutdown and no "quick check"
of anything. A bright phone and a money number at 8:50 AM costs him the day's sleep. The
only thing that belongs at clock-out is W6, the voice note — no screens, no figures.
6:05 PM is the replacement: after dinner, before the commute, still early enough to act
on something before the shift starts.

**It also answers the open question in the door plan** about what hour to move
Homebase's existing daily push to. The plan suggests 3:30 PM. **3:30 PM is inside his
sleep window.** Use 6:05 PM for both.

### J2 — Food check · 6:45 PM, daily

**Tool:** `health.macros_today`.

- **Logged:** `Today's log: N calories, N protein, against a target of N and N.`
- **Nothing logged:** `Nothing logged today. That may just mean it isn't logged.`
- Read out the reply's own `note` about the calendar day whenever the count looks low.

**Take the target from the reply, never from this page.** `health.macros_today`
returns `target`, `eaten` and `remaining`, and the target is whatever is stored in the
app. Two different numbers are floating around and they are not the same thing: the
**daily target is ~2,700 calories and ~125 g protein**, and the **four meals as written
add up to ~2,500 and ~130 g** — the schedule itself names that gap and offers one glass
of whole milk with dinner as the lever. So a hardcoded "target 2,500" would be stating
the plan's total as the goal, and it would also go stale the moment he changes the
target on the Meal Builder screen. Read it out of the reply.

**Why 6:45 PM and not later.** By 6:45 PM the Arizona calendar date already holds all
four of his meals — last night's 1 AM break and 8:45 AM snack, then today's bowl and
dinner. So this is a *did today land* check, not a *what's left* check, and 6:45 PM is
the last moment he can act on it: if protein is short he packs a bigger box at 7:05 PM.

**The forward-looking question is not the door's to answer.** What is still to eat this
shift is the 1 AM break meal and the optional 8:45 AM snack — that comes off the meal
plan, not out of Homebase. Standing instruction for Muse: **if he asks "what's left to
eat" between midnight and 4:00 PM, the door's number describes a calendar day holding
only the 1 AM meal. Say so, and answer from the plan instead.**

### J3 — Weekly money review · off day 3, 8:40 PM

Fires fifteen minutes before the retro block (O5) so the numbers are already on the
table when he sits down.

**Tools:** `finance.audit`, `finance.budget_status`, `finance.worth_a_look`,
`finance.spend_by_category` for **the month so far**, `health.weight_trend`,
`health.training_volume`.

- **Clean:** `Clean week. Nothing worth a look. Retro's yours.`
- **Something raised:** say each suggestion's ready-made sentence as it stands, say how
  many were held back because they could not be said without naming a charge, and say
  that the list includes anything already dismissed on the phone.
- Always state the exact window before any number.

**This is a weekly retro and `finance.spend_by_category` cannot answer about a week.**
That tool takes whole months only: `from` is the first of a month, `to` is the last day
of a month or today. A seven-day window is refused, and asking day by day to build one
up is the thing the month rule exists to stop — `API.md` explains why. So J3 asks for
the **month so far** (`from` the 1st, `to` today) and says which month it is talking
about. The weekly half of the retro comes from the tools that are already keyed to his
week: `finance.budget_status` (the pay cycle, no dates needed),
`finance.worth_a_look`, `health.weight_trend` and `health.training_volume` with
`{"days": 7}`. **Never** subtract one month-to-date figure from another to manufacture
a week.

### J4 — Before payday and before the bills · 6:15 PM on the 28th and two days before each payday

**Tools:** `finance.budget_status` (it carries the pay cycle's start, end and label),
`finance.position`, `finance.debts`.

- **Normal:** `Cycle ends <date>. $X spendable, $Y left in the envelope.`
- **Nothing tight:** `Nothing due that the cash doesn't cover.`

**One honest gap:** the tool that lists what is due before the next paycheck
(`finance.next_bills`) **is not built yet**, and neither is the low-point forecast. So
J4 cannot actually name the bills. Until those ship, Muse says plainly: `I can't see
the bill list from here yet — that tool isn't built. Here's the cash and the cycle.`
Homebase's own daily push still carries the bills-due heads-up in the meantime.

### J5 — Workout read · 4:35 PM, daily, bundled into D4

**Tool:** `health.next_workout`.

- Reads the routines and what he lifted last time on each exercise.
- **Standing rule from the door's own guide:** nothing in the data picks a workout. Muse
  must not say "today is push day" — it hands him the routines and he chooses.
- **An exercise with nothing on file:** say so. That is usually the useful part.

### What no job does

No job runs between 8:55 AM and 4:00 PM. No job writes anything to Homebase. Nothing in
Part B touches money, marks a bill paid, or names a merchant — those doors do not exist,
by design.

---

## 8. What deliberately gets no reminder

Restraint is part of the design, not an omission.

- **The 8:45 AM optional snack.** It lands in the middle of the wind-down, in dim light,
  with the phone deliberately away. A push there costs more than the 250 calories are
  worth. It is optional; leave it optional.
- **Bedtime itself.** D7 at 8:45 AM and the 9:00 AM event are enough. A 9:00 AM
  notification would be a lit screen at lights-out.
- **The five non-negotiables.** They belong in the description of the 9:00 AM calendar
  event where he can read them if a night goes wrong, not as a daily lecture:
  sunglasses from the door, dark and 67°F, same off-ramp in the same order, no caffeine
  after 3 AM and nothing heavy after 5 AM, phone out of the bed.
- **Anything on the shift floor between 3:00 AM and 7:50 AM.** Routine tasks only by
  design; a nudge there is noise.

---

## 9. Two conflicts in the source documents — he settles these, not Muse

**1. Dinner is 6:15 PM in the meal plan and 5:40 PM in the work-day timeline.** The
timeline wins on work nights — the 7:15 PM door is fixed and 6:15 PM does not fit in
front of it. W2 is written for 5:40 PM. On off days the timeline puts dinner at 7:10,
7:40 or 9:40 PM depending on the day, so the meal plan's 6:15 PM matches no day at all.
Worth one decision: either move the meal plan to 5:40 PM, or move the work-night dinner.

The pre-workout bowl has the same small disagreement — 4:15 PM in the meal plan, 4:10 PM
in the timeline — and five minutes is not worth a decision. D3 uses 4:10 PM.

**Until he decides, `MUSE-SKILL.md` PASTE 2 carries the work-night times** (4:10 PM bowl,
5:40 PM dinner), because those are the ones the reminders in §3 and §4 actually fire at,
and telling Muse one time while his phone buzzes at another is the worst of the three
options. The meal plan's own headings still say 4:15 and 6:15; the recipes are the same
food either way.

**2. The door plan's suggested 3:30 PM hour for the daily push is inside his sleep
window.** Covered in J1. Use 6:05 PM.

---

## 10. Set these up first

Five items, about twenty minutes, and they carry most of the value. Nothing here needs
the door, so it can all be done tonight.

| Order | Item | Why this one |
|---|---|---|
| 1 | **D1 — 4:00 PM repeating alarm** | Every other time in this document is measured from it, and it is the one thing a push cannot do. |
| 2 | **Do Not Disturb 8:45 AM – 4:00 PM, alarms allowed** | Makes rule 1 real instead of a promise. One setting on the phone, no Muse involved. |
| 3 | **D6 — 2:45 AM alarm: walk, water, light, last coffee** | Two anchors in one, in the trough, on every one of the seven days. |
| 4 | **W3 — 7:05 PM gear up** | The one reminder that protects both ends of the shift: sunglasses for the sleep, the box for the 1 AM meal. |
| 5 | **W1 + D8 + O5 as calendar events** — the shift, the sleep block, the retro | Three events, one weekly repeat each, and Xinyan can see all three. |

Then, once the read door is deployed and the connector is built: **J1 at 6:05 PM**. It
is the only scheduled check worth switching on alone, and if it survives a week the rest
of Part B is the same shape.

Everything else on this page is a nice-to-have. Thirty reminders set in one sitting is
thirty reminders muted by Thursday.
