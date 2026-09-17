import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Browser tests launch a real Chromium against the lab. Slow is honest;
    // a mocked browser would pass while the real one failed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
