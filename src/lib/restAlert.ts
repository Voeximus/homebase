// ── End-of-rest alert ───────────────────────────────────────────────────────
// A short two-tone beep made with Web Audio (no sound file to cache or load)
// plus a vibration where the phone allows it (SPEC §7.1).
//
// Browsers only let a page make sound after a tap, so `unlockAudio` must be
// called from one — the set tick that starts the rest. The AudioContext it
// creates is kept and reused for every later beep. iPhone web pages cannot
// vibrate at all; there the beep and the dock change are the whole alert.
// Every call is wrapped: an alert that can't play must never break logging.

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

/** Create or wake the shared AudioContext. Call from a user tap. */
export function unlockAudio(): void {
  try {
    if (typeof window === "undefined") return;
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    ctx = null; // audio unavailable — the dock still says "Rest over"
  }
}

// One tone: a quick fade in and out so it doesn't click.
function tone(ac: AudioContext, freq: number, at: number, len: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

/** Beep twice (low then high) and vibrate [200, 100, 200] where supported. */
export function restOverAlert(): void {
  try {
    unlockAudio(); // no-op if already unlocked; on Android a page that was tapped may still be allowed
    if (ctx) {
      const t0 = ctx.currentTime + 0.01;
      tone(ctx, 660, t0, 0.16);
      tone(ctx, 880, t0 + 0.22, 0.2);
    }
  } catch {
    /* audio blocked */
  }
  try {
    if (typeof navigator !== "undefined") navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* vibration not supported */
  }
}
