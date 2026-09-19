/**
 * The app as deployed, WITHOUT the engine: real database, real ownership
 * checks, no browser. Everything but Pond’s poll and the advance endpoint
 * is served from here, so those bundles stay small.
 *
 * Every file under api/ exports this same app. They exist as separate files
 * only because Vercel's file routing decides which paths reach a function at
 * all: a `[...route]` catch-all turned out to match a single path segment, so
 * /api/runs worked and /api/tasks/:id - the endpoint Pond polls - was a
 * platform 404 that never reached Owly. `tests/routes.test.ts` holds every
 * Pond path to a file.
 */

import { handle } from "hono/vercel";
import { createApp, type AppDeps } from "./app.js";
import { load } from "../config.js";
import { checkOwnership, instructions } from "../policy/ownership.js";
import { neonStore } from "../store.js";

const config = load();
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

export const deps: AppDeps = {
  store: await neonStore(databaseUrl),
  accessKey: process.env.POND_ACCESS_KEY ?? "",
  allowPrivate: config.allowPrivateTargets,
  checkOwnership: (url) => checkOwnership(url, { allowPrivate: config.allowPrivateTargets }),
  ownershipInstructions: instructions,
  // Well inside the 120s a function may run: a slice, then closing the browser
  // and saving state, with room to spare. The lease outlasts it, so a slice
  // killed by the platform frees the run for the next poll.
  sliceMs: 40_000,
  leaseMs: 100_000,
  maxPages: 15,
};

const app = createApp(deps);

export const handler = handle(app);
