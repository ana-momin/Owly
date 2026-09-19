/**
 * The only function that bundles a browser.
 *
 * Two paths need one - Pond's poll and the report page advancing its own run -
 * and each function file that imports the engine ships ~76MB of Chromium per
 * deployment. So both paths are rewritten here in vercel.json instead of
 * having a file each, and the app routes on the ORIGINAL path exactly as it
 * does for /r/:id. One heavy bundle per deploy instead of two, seven before.
 */
import { handler } from "../src/api/production-full.js";

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
