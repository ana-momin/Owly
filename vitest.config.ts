import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Browser tests launch a real Chromium against the lab. Slow is honest;
    // a mocked browser would pass while the real one failed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time. Several files start the lab, and the lab's apps
    // live on fixed ports so each is its own origin; run in parallel, they
    // collided and whole files failed to start.
    fileParallelism: false,
  },
});
