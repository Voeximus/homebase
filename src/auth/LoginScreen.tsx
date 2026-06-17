import { useState, type FormEvent } from "react";
import { Wallet } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { Button, inputClass, labelClass } from "../components/ui";

export function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600 text-white shadow-lg shadow-teal-600/30">
            <Wallet size={28} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Homebase</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === "in"
              ? "Sign in to your shared finances"
              : "Create your account"}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5"
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
            <input
              type="password"
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
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
          className="mt-4 w-full text-center text-sm text-slate-500"
        >
          {mode === "in" ? (
            <>
              Need an account?{" "}
              <span className="font-semibold text-teal-600">Sign up</span>
            </>
          ) : (
            <>
              Already have one?{" "}
              <span className="font-semibold text-teal-600">Sign in</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
