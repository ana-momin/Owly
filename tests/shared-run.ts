/**
 * One run per target per test file.
 *
 * Several tests in a file ask the same question of the same lab app - "run
 * app I with private pages allowed" - and each was paying for its own full
 * run of a real browser. On the slowest app that is about two and a half
 * minutes, three times over, to assert three different things about one
 * report.
 *
 * The cache is module state, which is safe precisely because Vitest gives
 * each test file its own worker: files never share a run, and a file that
 * wants a genuinely fresh one calls `runTest` directly.
 *
 * It caches the PROMISE, not the report, so tests that start together wait on
 * one run rather than racing to start three.
 */

import { runTest, type RunOptions, type RunReport } from "../src/engine/run.js";

const runs = new Map<string, Promise<RunReport>>();

export function runOnce(target: string, opts: RunOptions = {}): Promise<RunReport> {
  // A callback makes two calls different even when the options look alike,
  // and is not something to share; those get their own run.
  if (Object.values(opts).some((v) => typeof v === "function")) return runTest(target, opts);

  const key = `${target}|${JSON.stringify(opts, Object.keys(opts).sort())}`;
  let already = runs.get(key);
  if (!already) {
    already = runTest(target, opts);
    runs.set(key, already);
  }
  return already;
}
