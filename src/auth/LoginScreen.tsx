import { useState, type FormEvent } from "react";
import { Eye, EyeOff, ArrowRight, Loader2 } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { Logo } from "../components/Logo";
import { t } from "../lib/i18n";

/**
 * The front door.
 *
 * The old one showed a lucide Wallet in a cyan rounded square — a different mark
 * from the app's own favicon — over a flat card, and told you it was for "your
 * shared finances", which stopped being true when Health shipped.
 *
 * What it is now: the real mark, at size, over a slow aurora; the two things the
 * app actually holds named underneath it; and a form that arrives after the
 * identity rather than beside it. Everything that moves is CSS and every bit of
 * it is off under prefers-reduced-motion.
 */
export function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const run = mode === "in" ? signIn : signUp;
    const { error } = await run(email.trim(), password);
    if (error) setError(error);
    else if (mode === "up") {
      setNotice(t("Account created — you can sign in now."));
      setMode("in");
    }
    setBusy(false);
  }

  return (
    <div className="hb-login">
      {/* Two slow, offset colour fields. They are the only thing on the screen
          that moves on its own, they sit behind everything, and at this blur
          radius they read as light rather than as shapes. */}
      <div className="hb-aurora" aria-hidden>
        <span className="a1" />
        <span className="a2" />
      </div>

      <main className="hb-login-inner">
        <header className="hb-login-head">
          <div className="hb-mark" style={{ animationDelay: "60ms" }}>
            <Logo size={84} animated title="Homebase" />
          </div>
          <h1 className="hb-title" style={{ animationDelay: "160ms" }}>
            Homebase
          </h1>
          {/* Gold leaf goes on the frame, never on the figure — so the one
              gilded thing on this screen is a rule, not a fill. */}
          <hr className="hb-gilt" style={{ animationDelay: "250ms" }} />
          {/* The app is money AND body. The old line said "shared finances". */}
          <p className="hb-sub aldine" style={{ animationDelay: "320ms", fontSize: 17 }}>
            {t("Money and health, calibrated in one place.")}
          </p>
        </header>

        <form onSubmit={submit} className="hb-card" style={{ animationDelay: "400ms" }}>
          <label className="hb-field">
            <span>{t("Email")}</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label className="hb-field">
            <span>{t("Password")}</span>
            <div className="hb-pw">
              <input
                type={showPw ? "text" : "password"}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? t("Hide password") : t("Show password")}
              >
                {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>

          {error && <p className="hb-msg bad">{error}</p>}
          {notice && <p className="hb-msg good">{notice}</p>}

          <button type="submit" className="hb-go" disabled={busy}>
            {busy ? (
              <>
                <Loader2 size={17} className="hb-spin" /> {t("Working…")}
              </>
            ) : (
              <>
                {mode === "in" ? t("Sign in") : t("Create account")} <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>

        <button
          className="hb-swap"
          style={{ animationDelay: "470ms" }}
          onClick={() => {
            setMode((m) => (m === "in" ? "up" : "in"));
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "in" ? t("Need an account?") : t("Already have one?")}{" "}
          <span>{mode === "in" ? t("Sign up") : t("Sign in")}</span>
        </button>
      </main>
    </div>
  );
}
