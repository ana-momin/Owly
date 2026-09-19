/**
 * The app WITH an engine: the only place that imports the browser half.
 *
 * Two endpoints do real work - Pond's poll and the report page advancing its
 * own run - and only those two need Chromium in their bundle. Everything else
 * (manifest, health, starting a run, the try-it endpoint, the report page)
 * uses `createApp` on its own and stays a few hundred kilobytes.
 */

import { advance, type RunState } from "../engine/machine.js";
import { createApp, type AppDeps } from "./app.js";
import type { StoredRun } from "../store.js";

export async function advanceRun(deps: AppDeps, id: string): Promise<StoredRun | null> {
  const claimed = await deps.store.claim(id, deps.leaseMs);
  if (!claimed) return deps.store.getRun(id);
  try {
    const state = await advance(claimed.state as RunState, { deadline: Date.now() + deps.sliceMs });
    await deps.store.saveRun(id, { status: state.phase === "done" ? "completed" : "running", state, attempts: 0 });
  } catch (err) {
    // The slice is discarded and the run resumes from its last saved state on
    // the next poll. Three failures in a row and it stops, rather than
    // billing a poll loop that can never finish.
    const attempts = claimed.attempts + 1;
    console.error(`run ${id} slice failed (attempt ${attempts})`, err);
    await deps.store.saveRun(id, {
      status: attempts >= 3 ? "failed" : "running",
      state: claimed.state,
      error: attempts >= 3 ? "The test could not be completed. Nothing was billed." : String(err).slice(0, 300),
      attempts,
    });
  }
  return deps.store.getRun(id);
}

/** The whole app, engine included. Used by the two advancing functions and by tests. */
export function createFullApp(deps: AppDeps) {
  return createApp(deps, advanceRun);
}
