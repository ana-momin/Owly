import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Browser tests launch a real Chromium against the lab. Slow is honest;
    // a mocked browser would pass while the real one failed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Files run in parallel. The lab used to sit on fixed ports, so two files
    // could not hold one at once and the whole suite ran end to end - half an
    // hour to learn whether a one-line change was safe, which meant it got run
    // less often than it should have been. The lab now takes whatever ports
    // the OS gives it, so each file gets its own.
    //
    // Capped, because every worker may also be driving a Chromium: past about
    // four they compete for the machine and the wall-clock saving stops.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
