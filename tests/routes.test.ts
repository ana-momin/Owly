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
  ["GET", "/api/engine", "api/engine.ts"],
  ["GET", "/api/r/:id", "api/r/[id]/index.ts"],
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

  it("rewrites both engine paths to the one function that has an engine", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.rewrites).toContainEqual({ source: "/api/tasks/:id", destination: "/api/engine" });
    expect(config.rewrites).toContainEqual({ source: "/api/r/:id/advance", destination: "/api/engine" });
    // A file for either path would take precedence over the rewrite and bring
    // a second copy of Chromium back with it.
    expect(existsSync("api/tasks/[id].ts")).toBe(false);
    expect(existsSync("api/r/[id]/advance.ts")).toBe(false);
  });
});

/**
 * Bundle weight is a bill, not a detail.
 *
 * Every function that imports the engine ships Chromium with it: ~80MB, per
 * function, per deployment. Seven of them times a day of edits used the free
 * tier's entire 10GB of function storage. Only the two endpoints that drive a
 * browser may import it.
 */
describe("only the endpoints that drive a browser carry one", () => {
  const ENGINE = ["api/engine.ts"];
  const LIGHT = ["api/manifest.ts", "api/health.ts", "api/runs.ts", "api/try.ts", "api/r/[id]/index.ts"];

  it.each(ENGINE)("%s uses the app with the engine", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/production-full\.js/);
  });

  it.each(LIGHT)("%s uses the app without one", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/production\.js/);
    expect(source).not.toMatch(/production-full\.js/);
  });

  it("keeps the browser out of the shared app and the light entry", () => {
    for (const file of ["src/api/app.ts", "src/api/production.ts"]) {
      const source = readFileSync(file, "utf8");
      const runtimeImports = source.split("\n").filter((l) => /^import /.test(l) && !/^import type /.test(l));
      const reaches = runtimeImports.join("\n");
      expect(reaches, `${file} must not import the engine`).not.toMatch(/engine\/machine\.js|full\.js|playwright|chromium/);
    }
  });
});

/**
 * The engine function needs more than the defaults, and it is easy to lose.
 *
 * When the two heavy routes were merged into one top-level api/engine.ts, the
 * config key `api/**` + `/*.ts` stopped matching it - that glob needs at least
 * one directory - so the function quietly ran with default memory, the
 * default time limit and no axe-core. The first real test after that died
 * with "Target page, context or browser has been closed".
 */
describe("the engine function keeps what it needs", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));

  it("is configured under its own exact path", () => {
    expect(Object.keys(config.functions)).toContain("api/engine.ts");
  });

  it("gets the memory, the time and the accessibility engine", () => {
    const f = config.functions["api/engine.ts"];
    expect(f.memory).toBeGreaterThanOrEqual(2048);
    expect(f.maxDuration).toBeGreaterThanOrEqual(120);
    expect(f.includeFiles).toMatch(/axe-core/);
  });

  it("names a file that exists and is the one with the engine", () => {
    for (const path of Object.keys(config.functions)) {
      expect(existsSync(path), `${path} is configured but missing`).toBe(true);
    }
    expect(readFileSync("api/engine.ts", "utf8")).toMatch(/production-full\.js/);
  });
});
