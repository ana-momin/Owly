/**
 * The resumable engine, in a real browser against the lab.
 *
 * Three promises the deployed service depends on:
 *   - a run gives the same answer however it is sliced, because on Vercel the
 *     slices are decided by timeouts, not by us;
 *   - a requested focus is honoured, not just recorded (Foxy's second Pond
 *     rejection point was a declared scope that nothing read);
 *   - a passive scan never presses or submits anything.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advance, newRun, type RunState } from "../src/engine/machine.js";
import { runTest } from "../src/engine/run.js";
import { appUrl, hits, startLab, type Lab } from "../lab/serve.js";

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

const kinds = (r: { findings: Array<{ kind: string; fingerprint: string }> }) => r.findings.map((f) => f.fingerprint).sort();

describe("slicing", () => {
  it("gives the same findings one work item per slice as in large slices", async () => {
    const whole = await runTest(appUrl("c"), { allowPrivate: true, sliceMs: 600_000 });

    // A deadline already in the past: each call starts exactly one item.
    let state: RunState = await newRun(appUrl("c"), { mode: "full", allowPrivate: true });
    for (let i = 0; i < 300 && state.phase !== "done"; i++) {
      state = await advance(state, { deadline: Date.now() + 1 });
      state = JSON.parse(JSON.stringify(state)) as RunState;
    }
    expect(state.phase).toBe("done");
    expect(state.report!.slices).toBeGreaterThan(10);
    expect(kinds(state.report!)).toEqual(kinds(whole));
    expect(whole.findings.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("focus is honoured", () => {
  it("an accessibility-focused run does not touch forms or layout", async () => {
    const r = await runTest(appUrl("a"), { allowPrivate: true, focus: "accessibility" });
    expect(r.activities).toEqual(["load", "links", "a11y", "keyboard"]);
    const found = new Set(r.findings.map((f) => f.kind));
    expect(found.has("form_server_error")).toBe(false);
    expect(found.has("form_accepts_invalid")).toBe(false);
    // Nothing was submitted at all, not just not reported.
    const events = r.events.map((e) => e.text).join("\n");
    expect(events).not.toMatch(/Filling in forms|Pressing buttons/);
  }, 180_000);

  it("a mobile-focused run checks phone layout and nothing interactive", async () => {
    const r = await runTest(appUrl("c"), { allowPrivate: true, focus: "mobile" });
    expect(r.activities).toEqual(["load", "links", "layout"]);
    const found = new Set(r.findings.map((f) => f.kind));
    expect(found.has("mobile_overflow")).toBe(true);
    expect(found.has("a11y_violation")).toBe(false);
  }, 180_000);

  it("a forms-focused run finds the broken signup and skips accessibility", async () => {
    const r = await runTest(appUrl("a"), { allowPrivate: true, focus: "forms" });
    const found = new Set(r.findings.map((f) => f.kind));
    expect(found.has("form_server_error")).toBe(true);
    expect(found.has("a11y_violation")).toBe(false);
  }, 180_000);
});

describe("a passive scan only looks", () => {
  it("never submits a form, even a broken one", async () => {
    const r = await runTest(appUrl("a"), { allowPrivate: true, mode: "passive" });
    expect(r.mode).toBe("passive");
    expect(r.activities).not.toContain("forms");
    expect(r.activities).not.toContain("buttons");
    const found = new Set(r.findings.map((f) => f.kind));
    expect(found.has("form_server_error")).toBe(false);
    // Still useful: the page error and the broken link need no interaction.
    expect(found.has("js_exception")).toBe(true);
    expect(found.has("broken_link")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Passive scan/);
  }, 180_000);

  it("never presses a button - the Pay counter stays at zero and no coupon request is made", async () => {
    const r = await runTest(appUrl("f"), { allowPrivate: true, mode: "passive" });
    expect(hits.f?.pay_pressed ?? 0).toBe(0);
    expect(r.findings.some((f) => f.kind === "console_error")).toBe(false);
  }, 180_000);
});
