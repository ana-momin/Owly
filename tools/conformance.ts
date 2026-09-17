/**
 * Drive a live Owly deployment exactly as Pond does, and report what happens.
 *
 *   npx tsx tools/conformance.ts --base https://tryowly.vercel.app --key KEY [--target https://example.com]
 *
 * Foxy was rejected from Pond on points that were all reachable from one HTTP
 * session its author had never made. This makes that session, against the
 * real deployment, before anything is submitted. Exits non-zero on any failure.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = (arg("base") ?? "").replace(/\/$/, "");
const key = arg("key") ?? process.env.POND_ACCESS_KEY ?? "";
const target = arg("target", "https://example.com")!;
if (!base || !key) {
  console.error("usage: tsx tools/conformance.ts --base URL --key KEY [--target URL]");
  process.exit(2);
}

const results: Array<[boolean, string, string]> = [];
const check = (ok: boolean, name: string, detail = "") => {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  -  ${detail}` : ""}`);
  return ok;
};

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const started = Date.now();
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "x-agent-protocol-version": "1.0",
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers, ms: Date.now() - started };
}

const isTerminal = (b: any) =>
  b && typeof b.run_id === "string" && ["completed", "failed"].includes(b.status) && b.usage && typeof b.usage.quantity === "number";

console.log(`\nDriving ${base} as Pond would\n`);

// --- manifest ---------------------------------------------------------------
const m = await fetch(`${base}/api/manifest`);
const manifest = await m.json().catch(() => null);
check(m.status === 200, "manifest is served without auth", `HTTP ${m.status}`);
const schema = JSON.parse(readFileSync("tests/data/pond-manifest-schema.json", "utf8"));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
check(Boolean(ajv.validate(schema, manifest)), "manifest matches Pond's published schema", ajv.errors ? JSON.stringify(ajv.errors).slice(0, 200) : "");
const actionIds = (manifest?.actions ?? []).map((a: any) => a.id);
check(actionIds.includes("start_test"), "manifest declares actions", actionIds.join(", "));

// --- sync actions -------------------------------------------------------------
for (const [action, parameters] of [
  ["health_check", {}],
  ["verify_site", { url: target }],
  ["get_report", { test_id: "t_doesnotexist000" }],
] as const) {
  const r = await call("/api/runs", { body: { run_id: `conf-${action}-${Date.now()}`, action_id: action, parameters } });
  check(r.status === 200 && isTerminal(r.json), `${action} returns a Pond result`, `HTTP ${r.status}, ${(r.ms / 1000).toFixed(1)}s`);
}

// --- guards ---------------------------------------------------------------------
{
  const r = await call("/api/runs", { body: { run_id: "conf-auth", action_id: "health_check", parameters: {} }, headers: { authorization: "Bearer wrong" } });
  check(r.status === 401, "a wrong access key is refused", `HTTP ${r.status}`);
}
{
  const r = await call("/api/runs", { body: { run_id: "conf-ver", action_id: "health_check", parameters: {} }, headers: { "x-agent-protocol-version": "9.0" } });
  check(r.status === 400, "an unsupported protocol version is refused", `HTTP ${r.status}`);
}
for (const [label, parameters, field] of [
  ["unknown parameter", { url: target, sourses: ["x"] }, "parameters.sourses"],
  ["value outside the enum", { url: target, focus: "all-of-it" }, "parameters.focus"],
  ["wrong type", { url: 42 }, "parameters.url"],
  ["private address as target", { url: "http://169.254.169.254/latest/meta-data/" }, "parameters.url"],
] as const) {
  const r = await call("/api/runs", { body: { run_id: `conf-bad-${Date.now()}`, action_id: "start_test", parameters } });
  check(r.status === 422 && r.json?.error?.details?.field === field, `${label} is refused`, `HTTP ${r.status}, field=${r.json?.error?.details?.field}`);
}

// --- a real test, polled to the end ---------------------------------------------
const idem = `conf-idem-${Date.now()}`;
const body = { run_id: idem, action_id: "start_test", parameters: { url: target, focus: "mobile" } };
const first = await call("/api/runs", { body, headers: { "idempotency-key": idem } });
const second = await call("/api/runs", { body, headers: { "idempotency-key": idem } });
check(first.status === 202 && first.json?.task_id, "start_test is accepted as a task", `HTTP ${first.status}`);
check(second.json?.task_id === first.json?.task_id, "a repeated idempotency key replays the same task");

const taskId = first.json?.task_id;
let final: any = null;
const t0 = Date.now();
let polls = 0;
while (taskId && Date.now() - t0 < 9 * 60_000) {
  const r = await call(`/api/tasks/${taskId}`);
  polls++;
  if (r.status !== 200) {
    check(false, "polling works", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    break;
  }
  if (r.json.status !== "running" && r.json.status !== "queued") {
    final = r.json;
    break;
  }
  await new Promise((res) => setTimeout(res, r.json.poll_after_ms ?? 1000));
}
check(final?.status === "completed", "the test completes", `${final?.status ?? "timed out"} after ${polls} polls, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
check(final?.usage?.quantity === 1, "a completed test bills exactly one result", JSON.stringify(final?.usage));

const link = /(https?:\/\/[^\s)]+\/r\/[A-Za-z0-9_-]+)/.exec(final?.output?.[0]?.text ?? "")?.[1];
if (link) {
  const page = await fetch(link);
  const html = await page.text();
  check(page.status === 200, "the report page loads", `HTTP ${page.status}`);
  check(/script-src 'nonce-/.test(page.headers.get("content-security-policy") ?? ""), "the report page sends a strict CSP");
  check(/Checks: <b>load, links, layout<\/b>/.test(html), "the requested focus was honoured", "mobile focus ran only load, links, layout");
} else {
  check(false, "the result links to a report page");
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
