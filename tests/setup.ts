// Pin the timezone before any module reads a Date.
//
// vitest.config.ts sets `env.TZ`, but Node caches its timezone on first use, so a
// value that arrives late has no effect. Setting it here — in a setup file, which
// runs before the test modules are imported — plus the config entry covers both
// orders. The guard below then FAILS LOUDLY rather than letting the date tests
// pass vacuously: in UTC, a local stamp and a UTC stamp agree, so the exact bug
// these tests exist to catch would slip through green.
process.env.TZ = "America/Phoenix";

const offsetMinutes = new Date("2026-08-31T12:00:00Z").getTimezoneOffset();

if (offsetMinutes !== 420) {
  throw new Error(
    `Tests must run in America/Phoenix (UTC-7, offset 420). Got offset ${offsetMinutes}. ` +
      `The date tests are meaningless in UTC — a local stamp and a UTC stamp agree there, ` +
      `which is precisely how the evening-entry bug survived. Run via "npm test" so ` +
      `vitest.config.ts applies, or export TZ=America/Phoenix.`,
  );
}
