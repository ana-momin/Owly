/**
 * The try-it endpoint: the one door into Owly that has no key on it.
 *
 * Anything public and free is something a stranger can point at anything, or
 * run all day. So the rules it has to keep are: a stranger's test never types
 * into a site they have not proved is theirs, private addresses stay
 * unreachable, and the free budget runs out politely rather than silently.
 */

import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/api/app.js";
import { MemoryStore } from "../src/store.js";
import { appUrl } from "../lab/serve.js";

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    store: new MemoryStore(),
    accessKey: "key",
    allowPrivate: true,
    checkOwnership: async () => ({ verified: false, token: "owly-x", method: null, checked: [] }),
    ownershipInstructions: () => "put the token somewhere",
    sliceMs: 10_000,
    leaseMs: 60_000,
    maxPages: 10,
    ...overrides,
  };
}

function tryIt(app: ReturnType<typeof createApp>, url: string, ip = "203.0.113.7") {
  return app.request("/api/try", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ url }),
  });
}

describe("starting a test from the site", () => {
  it("needs no key, and says what it is about to do", async () => {
    const app = createApp(deps());
    const res = await tryIt(app, appUrl("a"));
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, any>;
    expect(body.id).toMatch(/^t_/);
    expect(body.mode).toBe("passive");
    expect(body.report_url).toContain(body.id);
    expect(body.left).toBe(2);
  });

  it("only presses buttons on a site whose owner proved it is theirs", async () => {
    const app = createApp(deps({ checkOwnership: async () => ({ verified: true, token: "owly-x", method: "file", checked: [] }) }));
    const res = await tryIt(app, appUrl("a"));
    expect(((await res.json()) as Record<string, any>).mode).toBe("full");
  });

  it("refuses an address that is not a website anyone can reach", async () => {
    const app = createApp(deps({ allowPrivate: false }));
    const res = await tryIt(app, "http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, any>).error.code).toBe("invalid_input");
  });

  it("asks for a site rather than failing on an empty box", async () => {
    const app = createApp(deps());
    const res = await tryIt(app, "   ");
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, any>).error.message).toMatch(/which site/i);
  });

  it("stops one visitor after three tests, and says why", async () => {
    const app = createApp(deps());
    for (let i = 0; i < 3; i++) expect((await tryIt(app, appUrl("a"))).status).toBe(202);

    const res = await tryIt(app, appUrl("a"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toMatch(/Pond/);

    // Someone else is not punished for it.
    expect((await tryIt(app, appUrl("a"), "198.51.100.4")).status).toBe(202);
  });
});
