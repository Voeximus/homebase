import { defineConfig } from "vitest/config";

// Deliberately SEPARATE from vite.config.ts. That config carries the PWA plugin,
// which generates a service worker and precache manifest — none of which should
// run to execute a pure-function test. This file exists so `npm test` is fast and
// has nothing to do with a build.
//
// TZ is pinned to America/Phoenix, the household's actual timezone, and that is
// load-bearing rather than cosmetic: the app's worst money bug was a date stamped
// in UTC while every budget window was read in local time. In a UTC test runner
// that bug is INVISIBLE, because the two spellings agree. Phoenix (UTC-7, no DST)
// makes them disagree for seven hours a day, which is exactly when the app is
// used. Setting it here rather than in a shell command keeps it true no matter how
// the tests are invoked.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TZ: "America/Phoenix" },
    setupFiles: ["tests/setup.ts"],
  },
});
