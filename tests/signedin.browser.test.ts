/**
 * Getting in, and staying in.
 *
 * Every version of Owly before this tested the half of a product a stranger
 * can see and stopped at the login. That is the half without the product in
 * it: the dashboard, the thing you create, the settings you save - none of it
 * was ever opened, so none of it was ever tested.
 *
 * What has to be true:
 *   1. the journey signs up and Owly notices it now holds a session
 *   2. that session is plain JSON on the run state, so it survives a slice
 *      ending and the browser dying
 *   3. a later session - a different context, as a later slice would open -
 *      is still signed in
 *   4. pages that only exist behind the login are actually reached and tested
 *   5. nothing is kept when the journey did not get in
 */

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PERSONAS, Session } from "../src/browser/session.js";
import { advance } from "../src/engine/machine.js";
import { newRun } from "../src/engine/plan.js";
import { runTest } from "../src/engine/run.js";
import { appUrl, startLab, type Lab } from "../lab/serve.js";

let lab: Lab;
let browser: Browser;

beforeAll(async () => {
  lab = await startLab();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
  await lab.close();
});
beforeEach(async () => {
  await lab.reset();
});

async function runToEnd(target: string, mode: "full" | "passive" = "full") {
  let state = await newRun(target, { mode, allowPrivate: true, maxPages: 12 });
  for (let i = 0; i < 40 && state.phase !== "done"; i++) {
    state = await advance(state, { deadline: Date.now() + 25_000 });
  }
  return state;
}

describe("a product with a login", () => {
  it("signs up, and keeps the session as data rather than in the browser", async () => {
    const state = await runToEnd(appUrl("i"));

    expect(state.journey?.completed, "the signup journey should finish").toBe(true);
    expect(state.signedInBy).toMatch(/free account|journey|account/i);
    expect(state.auth, "the session should be on the state").not.toBeNull();
    expect(state.auth!.cookies.some((c) => c.name === "tickly")).toBe(true);

    // The proof that it is data and not a live browser: JSON round trip, the
    // way the database stores it between slices.
    const revived = JSON.parse(JSON.stringify(state.auth));
    const later = await Session.open(browser, {
      target: new URL(appUrl("i")),
      persona: PERSONAS.new_user,
      allowPrivate: true,
      userAgentSuffix: "OwlyQA/test",
      signedInAs: revived,
    });
    try {
      const status = await later.goto(`${appUrl("i").replace(/\/$/, "")}/app`);
      expect(status).toBe(200);
      expect(await later.page.title()).toMatch(/Your tickets/i);
    } finally {
      await later.close();
    }
  }, 300_000);

  it("tests the pages that only exist once you are in", async () => {
    const state = await runToEnd(appUrl("i"));
    const opened = state.pages.filter(([, s]) => s !== null && s < 400).map(([u]) => new URL(u).pathname);

    expect(opened, "the dashboard is behind the login").toContain("/app");
    expect(opened.some((p) => p.startsWith("/app/")), "and so is everything under it").toBe(true);
  }, 300_000);

  it("keeps nothing when it never got in", async () => {
    // App A's signup always fails, so there is no session to hold on to.
    const state = await runToEnd(appUrl("a"));
    expect(state.journey?.completed).toBe(false);
    expect(state.auth).toBeNull();
    expect(state.signedInBy).toBeNull();
  }, 300_000);

  it("says so in the report, without putting the cookies in it", async () => {
    const report = await runTest(appUrl("i"), { allowPrivate: true });
    expect(report.signedInBy).toBeTruthy();
    // The report is stored and rendered. Credentials must not be in it.
    expect(JSON.stringify(report)).not.toMatch(/"cookies"/);
    expect(JSON.stringify(report)).not.toMatch(/tickly=/);
  }, 300_000);
});

/**
 * The lost write: accepted, then gone.
 *
 * App I's settings page answers 200, says "Saved." and keeps nothing. Every
 * signal Owly measured before this run said the save worked.
 */
describe("checking that a change actually stuck", () => {
  it("finds a save that says it worked and did not", async () => {
    const report = await runTest(appUrl("i"), { allowPrivate: true });
    const lost = report.findings.find((f) => f.kind === "lost_write");

    expect(lost, `findings were: ${report.findings.map((f) => f.kind).join(", ") || "none"}`).toBeDefined();
    expect(lost!.severity).toBe("high");
    expect(lost!.title).toMatch(/does not save/i);
    expect(lost!.steps.join(" ")).toMatch(/again/i);
    expect(lost!.reproductions.reproduced).toBeGreaterThanOrEqual(2);
  }, 400_000);

  it("says nothing of the kind about a product that saves properly", async () => {
    const report = await runTest(appUrl("g"), { allowPrivate: true });
    expect(report.findings.some((f) => f.kind === "lost_write")).toBe(false);
  }, 400_000);
});
