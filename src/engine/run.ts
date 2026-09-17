/**
 * Runs a whole test in one process, for the benchmark and local use.
 *
 * It does NOT have its own engine. It drives the same state machine the
 * deployed service uses, slice by slice, and round-trips the state through
 * JSON between slices exactly as the database does. So when the benchmark
 * passes, it has passed through the production path - including every
 * serialisation boundary - rather than through a convenient shortcut that
 * only exists locally.
 */

import { advance, newRun, type Focus, type Mode, type RunEvent, type RunReport, type RunState } from "./machine.js";

export type { Focus, Mode, RunEvent, RunReport } from "./machine.js";

export interface RunOptions {
  mode?: Mode;
  focus?: Focus;
  allowPrivate?: boolean;
  maxPages?: number;
  /** Budget per slice. Deliberately small by default so slicing is exercised. */
  sliceMs?: number;
  onEvent?: (event: RunEvent) => void;
}

export async function runTest(targetUrl: string, opts: RunOptions = {}): Promise<RunReport> {
  let state: RunState = await newRun(targetUrl, {
    mode: opts.mode ?? "full",
    ...(opts.focus ? { focus: opts.focus } : {}),
    ...(opts.allowPrivate !== undefined ? { allowPrivate: opts.allowPrivate } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
  const sliceMs = opts.sliceMs ?? 20_000;

  for (let i = 0; i < 500 && state.phase !== "done"; i++) {
    state = await advance(state, { deadline: Date.now() + sliceMs, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
    // Exactly what storing in Postgres and reading back does to it.
    state = JSON.parse(JSON.stringify(state)) as RunState;
  }
  if (!state.report) throw new Error("run did not finish");
  return state.report;
}
