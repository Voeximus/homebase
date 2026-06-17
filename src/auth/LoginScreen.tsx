import { useState, type FormEvent } from "react";
import { Eye, EyeOff, Wallet } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { Button, inputClass, labelClass } from "../components/ui";

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
    if (error) {
      setError(error);
    } else if (mode === "up") {
      setNotice("Account created — you can sign in now.");
      setMode("in");
    }
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#06070b] px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-600/30">
            <Wallet size={28} />
          </div>
          <h1 className="text-2xl font-bold text-white">Homebase</h1>
          <p className="mt-1 text-sm text-slate-400">
            {mode === "in"
              ? "Sign in to your shared finances"
              : "Create your account"}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 shadow-sm backdrop-blur"
        >
          <div>
            <label className={labelClass}>Email</label>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className={labelClass}>Password</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputClass} pr-11`}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 transition hover:text-white"
              >
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              {notice}
            </p>
          )}

          <Button type="submit" disabled={busy} className="w-full">
            {busy
              ? "Working…"
              : mode === "in"
                ? "Sign in"
                : "Create account"}
          </Button>
        </form>

        <button
          onClick={() => {
            setMode((m) => (m === "in" ? "up" : "in"));
            setError(null);
            setNotice(null);
          }}
          className="mt-4 w-full text-center text-sm text-slate-400 transition hover:text-slate-200"
        >
          {mode === "in" ? (
            <>
              Need an account?{" "}
              <span className="font-semibold text-violet-400">Sign up</span>
            </>
          ) : (
            <>
              Already have one?{" "}
              <span className="font-semibold text-violet-400">Sign in</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
