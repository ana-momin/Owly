/**
 * The deployed app with the engine, for the two paths that drive a browser:
 * GET /api/tasks/:id (Pond's poll) and POST /api/r/:id/advance.
 *
 * Everything else uses ./production.ts, which has no browser in its bundle.
 */

import { handle } from "hono/vercel";
import { createFullApp } from "./full.js";
import { deps } from "./production.js";

export const handler = handle(createFullApp(deps));
