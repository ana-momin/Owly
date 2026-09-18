/**
 * The Pond protocol, driven the way Pond drives it.
 *
 * Foxy was rejected on points that were all reachable from one HTTP session
 * and none of which its tests ever made: a scan that died, a declared scope
 * nobody read, task state lost between instances, schemas declared and not
 * enforced. Every one has a test here, against the real routes.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/api/app.js";
import { manifest } from "../src/api/manifest.js";
import type { RunReport, RunState } from "../src/engine/machine.js";
import { MemoryStore } from "../src/store.js";
import { appUrl, hits, startLab, type Lab } from "../lab/serve.js";

const KEY = "test-access-key-owly";
let lab: Lab;
beforeAll(async () => {
  lab = await startLab();
});
afterAll(async () => {
  await lab.close();
});
beforeEach(async () => {
  await lab.reset();
});

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    store: new MemoryStore(),
    accessKey: KEY,
    allowPrivate: true,
    checkOwnership: async () => ({ verified: true, token: "owly-x", method: "file", checked: [] }),
    ownershipInstructions: () => "put the token somewhere",
    sliceMs: 10_000,
    leaseMs: 60_000,
    maxPages: 10,
    ...overrides,
  };
}

const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  authorization: `Bearer ${KEY}`,
  "x-agent-protocol-version": "1.0",
  ...extra,
});

async function run(app: ReturnType<typeof createApp>, body: unknown, extra: Record<string, string> = {}) {
  const res = await app.request("/api/runs", { method: "POST", headers: headers(extra), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function pollToEnd(app: ReturnType<typeof createApp>, taskId: string, maxPolls = 200) {
  for (let i = 0; i < maxPolls; i++) {
    const res = await app.request(`/api/tasks/${taskId}`, { headers: headers() });
    const body = (await res.json()) as Record<string, any>;
    if (body.status !== "running" && body.status !== "queued") return { polls: i + 1, body };
  }
  throw new Error("task never finished");
}

// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("validates against Pond's published manifest schema", () => {
    const schema = JSON.parse(readFileSync("tests/data/pond-manifest-schema.json", "utf8"));
    const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
    (addFormats as unknown as typeof addFormats.default)(ajv);
    const ok = ajv.validate(schema, manifest());
    expect(ajv.errors ?? [], JSON.stringify(ajv.errors, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("would catch a broken manifest - the schema check is not decoration", () => {
    const schema = JSON.parse(readFileSync("tests/data/pond-manifest-schema.json", "utf8"));
    const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
    (addFormats as unknown as typeof addFormats.default)(ajv);
    const broken = [
      { ...manifest(), capabilities: { ...(manifest().capabilities as object), cancellation: true } },
      { ...manifest(), protocol_version: "1" },
      { ...manifest(), actions: [{ id: "Bad-Id", name: "x", description: "y" }] },
    ];
    for (const m of broken) expect(ajv.validate(schema, m)).toBe(false);
  });

  it("bills in the unit terminal responses report", () => {
    const plans = (manifest().metadata as { pricing_plans: Array<{ usage_unit: string }> }).pricing_plans;
    expect(plans.every((p) => p.usage_unit === "result")).toBe(true);
  });

  it("is public: no key, no protocol header", async () => {
    const res = await createApp(deps()).request("/api/manifest");
    expect(res.status).toBe(200);
  });
});

describe("protocol guards", () => {
  const app = () => createApp(deps());
  const body = { run_id: "r1", action_id: "health_check", parameters: {} };

  it("requires the protocol version header", async () => {
    const res = await app().request("/api/runs", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed and an unsupported version differently", async () => {
    expect((await run(app(), body, { "x-agent-protocol-version": "1.0.1" })).body.error.code).toBe("invalid_request");
    expect((await run(app(), body, { "x-agent-protocol-version": "2.0" })).body.error.code).toBe("unsupported_protocol_version");
  });

  it("refuses a wrong key", async () => {
    const r = await run(app(), body, { authorization: "Bearer nope" });
    expect(r.status).toBe(401);
  });

  it("refuses everything when no key is configured, rather than running open", async () => {
    const r = await run(createApp(deps({ accessKey: "" })), body);
    expect(r.status).toBe(503);
  });

  it("refuses an oversized body and invalid JSON", async () => {
    const big = await app().request("/api/runs", { method: "POST", headers: headers(), body: JSON.stringify({ ...body, pad: "x".repeat(300_000) }) });
    expect(big.status).toBe(413);
    const bad = await app().request("/api/runs", { method: "POST", headers: headers(), body: "{nope" });
    expect(bad.status).toBe(400);
  });
});

describe("input schemas are enforced, not just declared", () => {
  const app = () => createApp(deps());

  it("rejects an unknown action", async () => {
    const r = await run(app(), { run_id: "r", action_id: "hack_the_planet", parameters: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("unsupported_operation");
  });

  it.each([
    [{ url: "https://example.com", sourses: ["x"] }, "parameters.sourses"],
    [{ url: 42 }, "parameters.url"],
    [{ url: "https://example.com", focus: "everything-and-more" }, "parameters.focus"],
    [{}, "parameters.url"],
  ])("rejects %j with the offending field named", async (parameters, field) => {
    const r = await run(app(), { run_id: "r", action_id: "start_test", parameters });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("invalid_input");
    expect(r.body.error.details.field).toBe(field);
  });

  it("refuses a private address as a target when private targets are off", async () => {
    const r = await run(createApp(deps({ allowPrivate: false })), { run_id: "r", action_id: "start_test", parameters: { url: "http://127.0.0.1:4101/" } });
    expect(r.status).toBe(422);
    expect(r.body.error.details.field).toBe("parameters.url");
    expect(r.body.error.message).toMatch(/loopback/);
  });
});

describe("a test, start to finish, the way Pond runs it", () => {
  it("is accepted, polled to completion, billed once, and readable afterwards", async () => {
    const d = deps();
    const app = createApp(d);
    const started = await run(app, { run_id: "pond-run-1", action_id: "start_test", parameters: { url: appUrl("a") } });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ run_id: "pond-run-1", status: "queued" });

    const { polls, body } = await pollToEnd(app, started.body.task_id);
    expect(polls).toBeGreaterThan(1);
    expect(body.status).toBe("completed");
    expect(body.run_id).toBe("pond-run-1");
    expect(body.usage).toEqual({ unit_of_measurement: "result", quantity: 1 });
    const text = body.output[0].text as string;
    expect(text).toMatch(/Full test/);
    expect(text).toMatch(/Create account/);
    expect(text).toContain(`/r/${started.body.task_id}`);

    // Still there for get_report, and billed nothing a second time.
    const again = await run(app, { run_id: "pond-run-2", action_id: "get_report", parameters: { test_id: started.body.task_id } });
    expect(again.body.status).toBe("completed");
    expect(again.body.usage.quantity).toBe(0);
    expect(again.body.output[0].text).toMatch(/Create account/);

    // And as a page, under both the function path and the short link the
    // report text hands out (Vercel passes the rewritten request's original
    // path through, so the app must answer both).
    for (const path of [`/api/r/${started.body.task_id}`, `/r/${started.body.task_id}`]) {
      const page = await app.request(path);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);
      expect(await page.text()).toMatch(/Copy as GitHub issue/);
    }
  }, 300_000);

  it("replays a repeated idempotency key instead of starting a second test", async () => {
    const d = deps();
    const app = createApp(d);
    const payload = { run_id: "same", action_id: "start_test", parameters: { url: appUrl("g") } };
    const first = await run(app, payload, { "idempotency-key": "k-1" });
    const second = await run(app, payload, { "idempotency-key": "k-1" });
    expect(second.status).toBe(first.status);
    expect(second.body.task_id).toBe(first.body.task_id);
  });

  it("runs a passive scan when ownership is not verified, and says so", async () => {
    const app = createApp(deps({ checkOwnership: async () => ({ verified: false, token: "owly-x", method: null, checked: [] }) }));
    const started = await run(app, { run_id: "p", action_id: "start_test", parameters: { url: appUrl("f") } });
    const { body } = await pollToEnd(app, started.body.task_id);
    expect(body.output[0].text).toMatch(/Passive scan/);
    expect(hits.f?.pay_pressed ?? 0).toBe(0);
  }, 300_000);

  it("honours the requested focus", async () => {
    const d = deps();
    const app = createApp(d);
    const started = await run(app, { run_id: "f", action_id: "start_test", parameters: { url: appUrl("c"), focus: "mobile" } });
    await pollToEnd(app, started.body.task_id);
    const stored = await d.store.getRun(started.body.task_id);
    expect(stored!.state.report!.activities).toEqual(["load", "links", "layout"]);
  }, 300_000);

  it("fails a run that cannot make progress after three tries, and bills nothing", async () => {
    const d = deps();
    const app = createApp(d);
    const started = await run(app, { run_id: "broken", action_id: "start_test", parameters: { url: appUrl("g") } });
    // Corrupt the stored state so every slice throws.
    const stored = await d.store.getRun(started.body.task_id);
    await d.store.saveRun(started.body.task_id, { status: "running", state: { ...stored!.state, target: "not a url" } as RunState });
    const { polls, body } = await pollToEnd(app, started.body.task_id, 10);
    expect(polls).toBe(3);
    expect(body.status).toBe("failed");
    expect(body.usage.quantity).toBe(0);
  });
});

describe("leases", () => {
  it("lets only one caller run a slice at a time", async () => {
    const store = new MemoryStore();
    await store.createRun({ id: "t1", pondRunId: null, state: { phase: "discover" } as RunState });
    expect(await store.claim("t1", 60_000)).not.toBeNull();
    expect(await store.claim("t1", 60_000)).toBeNull();
  });

  it("expires, so a slice that died does not lock the run forever", async () => {
    const store = new MemoryStore();
    await store.createRun({ id: "t2", pondRunId: null, state: { phase: "discover" } as RunState });
    expect(await store.claim("t2", 1)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.claim("t2", 60_000)).not.toBeNull();
  });
});

describe("the report page never runs what a tested site wrote", () => {
  it("escapes hostile text from findings", async () => {
    const d = deps();
    const evil = `<script>alert("owly")</script><img src=x onerror=alert(1)>`;
    const report: RunReport = {
      target: "https://example.com/",
      mode: "full",
      focus: "everything",
      activities: ["load"],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1000,
      slices: 1,
      findings: [
        {
          kind: "console_error",
          category: "functional",
          title: `Console error ${evil}`,
          severity: "low",
          confidence: "confirmed",
          url: "https://example.com/",
          target: evil,
          summary: evil,
          expected: evil,
          actual: evil,
          steps: [evil],
          evidence: [{ type: "console", level: "error", text: evil, at: "now" }],
          observed: [evil],
          inference: [evil],
          reproductions: { attempts: 2, reproduced: 2 },
          fingerprint: "x",
        },
      ],
      unverified: [],
      pages: [{ url: `https://example.com/${evil}`, status: 200 }],
      notes: [evil],
      events: [{ at: new Date().toISOString(), level: "info", text: evil }],
      journey: null,
      failed: null,
    };
    await d.store.createRun({ id: "t_evil", pondRunId: null, state: { report } as unknown as RunState });
    await d.store.saveRun("t_evil", { status: "completed", state: { report } as unknown as RunState });

    const html = await (await createApp(d).request("/api/r/t_evil")).text();
    expect(html).not.toContain(`<script>alert`);
    expect(html).not.toContain(`<img src=x`);
    expect(html).toContain("&lt;script&gt;alert(&quot;owly&quot;)&lt;/script&gt;");
  });
});
