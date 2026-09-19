/**
 * Every path Pond or a browser calls must have a file that Vercel routes to.
 *
 * The app's own tests call routes in-process, where every path works. On
 * Vercel a path only reaches the app if a file under api/ claims it - and the
 * first deploy used a `[...route]` catch-all that claimed one segment, so
 * /api/tasks/:id (what Pond polls) was a platform 404 while every local test
 * passed. Only the live conformance run caught it. This catches it before a
 * deploy.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES: Array<[method: string, path: string, file: string]> = [
  ["GET", "/api/manifest", "api/manifest.ts"],
  ["HEAD", "/api/manifest", "api/manifest.ts"],
  ["GET", "/api/health", "api/health.ts"],
  ["POST", "/api/runs", "api/runs.ts"],
  ["GET", "/api/tasks/:id", "api/tasks/[id].ts"],
  ["GET", "/api/r/:id", "api/r/[id]/index.ts"],
  ["POST", "/api/r/:id/advance", "api/r/[id]/advance.ts"],
  ["POST", "/api/try", "api/try.ts"],
];

describe("each path has a Vercel function file", () => {
  it.each(ROUTES)("%s %s -> %s", (method, _path, file) => {
    expect(existsSync(file), `${file} is missing`).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source, `${file} does not export ${method}`).toMatch(new RegExp(`export const ${method}\\b`));
  });

  it("uses no catch-all file, which Vercel matches to a single segment", () => {
    const files = ["api/[...route].ts", "api/[[...route]].ts"];
    for (const f of files) expect(existsSync(f), `${f} would shadow nested routes`).toBe(false);
  });

  it("rewrites the short report link to the report function", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.rewrites).toContainEqual({ source: "/r/:id", destination: "/api/r/:id" });
  });
});
