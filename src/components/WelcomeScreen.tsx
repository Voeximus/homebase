import { useMemo, useState } from "react";
import { Activity, Wallet } from "lucide-react";
import { Logo } from "./Logo";
import { t, getLang } from "../lib/i18n";
import { LangToggle } from "./LanguageProvider";
import type { AppMode } from "./ModeToggle";
import { useStore } from "../store/FinanceStore";
import { useAuth } from "../auth/AuthProvider";
import { buildFinanceVMs } from "../views/redesign/buildVMs";
import { getLens } from "../lib/lens";
import { OWNER_COLOR, OWNER_NAME, saveOwner, type Owner } from "../lib/owner";
import { inkOn } from "../lib/catColor";

// ── The front door ───────────────────────────────────────────────────────────
// Opens on every cold launch. First-ever launch asks whose phone this is and
// binds the device to one spouse; after that it greets that person and offers
// the two doors.
//
// It is composed as an ALTARPIECE — see the long note over the .hb-door block
// in index.css. The short version: a centred panel (the mark and the name), two
// flanking arches (the two doors), and a predella — the band of small panels
// underneath, which on an altarpiece carries the narrative and here carries
// where you actually stand.
//
// That predella is the reason this screen exists at all. It used to be a
// greeting and a two-position switch: a whole screen, on every single launch,
// that told you nothing you did not already know. It now answers the question
// the app is for — what have I got, what is coming, how much is left — BEFORE
// you have chosen a door, and it reads those numbers from the same view-model
// the Home tab renders, so the two can never disagree.
//
// The doors take the mark's own two pigments in the mark's own order:
// ultramarine on the left for Finance, gold on the right for Health. On a first
// launch that is the only explanation of the logo anyone gets, and it is enough.

const ENTER_MS = 460;

/** The three facts the predella carries. Nothing else on this screen is data. */
export interface DoorVM {
  cash: number;
  processing: number;
  leftToSpend: number;
  cycleLabel: string;
  nextBillName: string;
  nextBillDate: string;
}

const LAPIS = "#7f9ff7";
const GOLD = "#dab249";

const money0 = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up,";
  if (h < 12) return "Good morning,";
  if (h < 18) return "Good afternoon,";
  return "Good evening,";
}

export function WelcomeScreen({
  owner,
  onOwner,
  onEnter,
  vmOverride,
}: {
  owner: Owner | null;
  onOwner: (o: Owner) => void;
  onEnter: (m: AppMode) => void;
  /** Dev harness only (?door). Production always reads the live store. */
  vmOverride?: DoorVM;
}) {
  const [pending, setPending] = useState<Owner | null>(null);
  const [thrown, setThrown] = useState<AppMode | null>(null);
  const entering = thrown !== null;

  function throwTo(m: AppMode) {
    if (entering) return;
    setThrown(m);
    window.setTimeout(() => onEnter(m), ENTER_MS);
  }

  return (
    <div className="hb-door">
      {/* One light, two sources: a warm key from the upper left and a cool
          lapis bounce from the lower right. Everything else on this screen is
          lit and shadowed to agree with them. */}
      <div className="hb-aurora" aria-hidden>
        <span className="a1" />
        <span className="a2" />
      </div>

      <div className="safe-top absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-end px-4">
        <LangToggle />
      </div>

      <main
        className="hb-door-inner transition-opacity duration-300"
        style={{ opacity: entering ? 0.45 : 1 }}
      >
        {!owner ? (
          <FirstLaunch pending={pending} setPending={setPending} onOwner={onOwner} />
        ) : vmOverride ? (
          <Returning owner={owner} thrown={thrown} onThrow={throwTo} vm={vmOverride} />
        ) : (
          <LiveReturning owner={owner} thrown={thrown} onThrow={throwTo} />
        )}
      </main>
    </div>
  );
}

// ── First-ever launch: whose phone is this ───────────────────────────────────
function FirstLaunch({
  pending,
  setPending,
  onOwner,
}: {
  pending: Owner | null;
  setPending: (o: Owner | null) => void;
  onOwner: (o: Owner) => void;
}) {
  return (
    <>
      <header className="hb-crest">
        <div className="hb-mark" style={{ animationDelay: "60ms" }}>
          <Logo size={84} title="Homebase" />
        </div>
        <h1 className="hb-title" style={{ animationDelay: "150ms" }}>
          Homebase
        </h1>
        <hr className="hb-gilt" style={{ animationDelay: "260ms" }} />
        <p className="hb-sub" style={{ animationDelay: "330ms" }}>
          {pending
            ? t("This phone will stay yours. You can change it later in Settings.")
            : t("Pick yourself once — this phone will remember.")}
        </p>
      </header>

      {!pending ? (
        <div className="hb-who" style={{ animationDelay: "420ms" }}>
          {(["gino", "xinyan"] as Owner[]).map((o) => (
            <button key={o} onClick={() => setPending(o)}>
              <span
                className="hb-medal"
                style={{ background: OWNER_COLOR[o], color: inkOn(OWNER_COLOR[o]) }}
              >
                {OWNER_NAME[o][0]}
              </span>
              {t(OWNER_NAME[o])}
            </button>
          ))}
        </div>
      ) : (
        <div className="hb-who" style={{ animationDelay: "60ms" }}>
          <button
            onClick={() => {
              saveOwner(pending);
              onOwner(pending);
              setPending(null);
            }}
            style={{ borderColor: LAPIS }}
          >
            <span
              className="hb-medal"
              style={{ background: OWNER_COLOR[pending], color: inkOn(OWNER_COLOR[pending]) }}
            >
              {OWNER_NAME[pending][0]}
            </span>
            {t("Yes, I'm {name}", { name: t(OWNER_NAME[pending]) })}
          </button>
          <button
            onClick={() => setPending(null)}
            style={{
              minHeight: 48,
              fontFamily: "var(--font-sans)",
              fontSize: 13.5,
              fontWeight: 600,
              justifyContent: "center",
              color: "var(--color-taupe)",
              background: "transparent",
              borderColor: "transparent",
              boxShadow: "none",
            }}
          >
            {t("Not me")}
          </button>
        </div>
      )}
    </>
  );
}

// ── Returning: the greeting, the two doors, and where you stand ──────────────
// The live wrapper exists so the hook below is never called conditionally: the
// harness renders `Returning` straight, the app renders this.
function LiveReturning(props: {
  owner: Owner;
  thrown: AppMode | null;
  onThrow: (m: AppMode) => void;
}) {
  return <Returning {...props} vm={useLiveDoorVM(props.owner)} />;
}

function Returning({
  owner,
  thrown,
  onThrow,
  vm,
}: {
  owner: Owner;
  thrown: AppMode | null;
  onThrow: (m: AppMode) => void;
  vm: DoorVM | null;
}) {

  return (
    <>
      <header className="hb-crest">
        <div className="hb-mark" style={{ animationDelay: "50ms" }}>
          <Logo size={84} title="Homebase" />
        </div>
        <h1 className="hb-greet" style={{ animationDelay: "140ms" }}>
          {t(greeting())} <em>{t(OWNER_NAME[owner])}</em>
        </h1>
        <hr className="hb-gilt" style={{ animationDelay: "240ms" }} />
        <p className="hb-motto" style={{ animationDelay: "300ms" }}>
          {t("measure, don't infer")}
        </p>
      </header>

      <div
        className={`hb-doors${thrown ? " thrown" : ""}`}
        style={{ animationDelay: "380ms" }}
      >
        <Arch
          pigment={LAPIS}
          Icon={Wallet}
          name={t("Finance")}
          fact={
            vm
              ? t("{n} left to spend this cycle", { n: money0(vm.leftToSpend) })
              : t("bank, bills and budget")
          }
          chosen={thrown === "finance"}
          onClick={() => onThrow("finance")}
        />
        <Arch
          pigment={GOLD}
          Icon={Activity}
          name={t("Health")}
          fact={t("meals, lifts and weight")}
          chosen={thrown === "health"}
          onClick={() => onThrow("health")}
        />
      </div>

      {/* The predella. Reserved height whether or not the numbers have arrived,
          so the composition never jumps when the store resolves. */}
      <div className="hb-predella" style={{ animationDelay: "470ms" }}>
        <Panel
          gilt
          k={t("available")}
          v={vm ? money0(vm.cash) : "—"}
          s={
            vm && vm.processing > 0
              ? t("{n} still settling", { n: money0(vm.processing) })
              : t("across your accounts")
          }
        />
        <Panel
          k={t("next bill")}
          v={vm ? vm.nextBillName : "—"}
          s={vm && vm.nextBillDate ? vm.nextBillDate : t("nothing scheduled")}
        />
        <Panel
          k={t("left to spend")}
          v={vm ? money0(vm.leftToSpend) : "—"}
          s={vm ? vm.cycleLabel : t("this pay cycle")}
        />
      </div>
    </>
  );
}

/**
 * The three predella figures, read from the SAME view-model the Home tab
 * renders. Recomputing them here with their own arithmetic is exactly how two
 * screens end up quoting different numbers for the same money.
 */
function useLiveDoorVM(owner: Owner): DoorVM | null {
  const { data, loading } = useStore();
  const { session } = useAuth();
  return useMemo(() => {
    if (loading) return null;
    const h = buildFinanceVMs(data, owner, getLens(), {
      email: session?.user.email ?? "",
      lang: getLang(),
    }).home;
    return {
      cash: h.cash,
      processing: h.processing,
      leftToSpend: Math.max(0, h.budgetTarget - h.budgetSpent),
      cycleLabel: h.budgetCycleLabel,
      nextBillName: h.bills.nextName,
      nextBillDate: h.bills.nextDate,
    };
  }, [data, loading, owner, session]);
}

function Arch({
  pigment,
  Icon,
  name,
  fact,
  chosen,
  onClick,
}: {
  pigment: string;
  Icon: typeof Wallet;
  name: string;
  fact: string;
  chosen: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`hb-arch${chosen ? " chosen" : ""}`}
      style={{ ["--hb-pig" as string]: pigment }}
      onClick={onClick}
      aria-label={name}
    >
      <span className="em">
        <Icon size={27} />
      </span>
      <span className="nm">{name}</span>
      <span className="fact">{fact}</span>
    </button>
  );
}

function Panel({
  k,
  v,
  s,
  gilt,
}: {
  k: string;
  v: string;
  s: string;
  gilt?: boolean;
}) {
  return (
    <div className={`hb-pred${gilt ? " gilt" : ""}`}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="s">{s}</span>
    </div>
  );
}
