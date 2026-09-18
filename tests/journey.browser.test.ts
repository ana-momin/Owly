/**
 * The main-task attempt: the sentence the whole report is built around.
 *
 * Being wrong here is worse than missing a console error. A false "your
 * signup is broken" destroys trust in everything else in the report, and a
 * false "a new visitor could sign up" is worse still, because it is the one
 * thing the reader wanted to be sure of.
 *
 * So: it must be right on a site that works, right on a site that is broken,
 * and silent whenever OWLY is the reason it stopped.
 */

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PERSONAS, Session } from "../src/browser/session.js";
import { runJourney } from "../src/engine/journey.js";
import { runTest } from "../src/engine/run.js";
import { appUrl, hits, startLab, type Lab } from "../lab/serve.js";

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

async function journeyFor(app: string, interactive = true) {
  const target = new URL(appUrl(app));
  const session = await Session.open(browser, { target, persona: PERSONAS.new_user, allowPrivate: true, userAgentSuffix: "OwlyQA/test" });
  try {
    return await runJourney(session, target.href, interactive);
  } finally {
    await session.close();
  }
}

describe("a site whose signup is broken", () => {
  it("is reported as blocked, at the right step, with the reason", async () => {
    const j = await journeyFor("a");
    expect(j).not.toBeNull();
    expect(j!.task).toBe("signup");
    expect(j!.completed).toBe(false);
    expect(j!.hardFailure).toBe(true);
    expect(j!.reason).toMatch(/500/);

    const failing = j!.steps.filter((s) => !s.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.action).toMatch(/Create account/);
    // The evidence a developer needs: the failing request and the screen.
    expect(JSON.stringify(failing[0]!.evidence)).toMatch(/api\/signup/);
    expect(j!.steps.every((s) => s.shot?.startsWith("data:image/jpeg;base64,"))).toBe(true);
  }, 120_000);
});

describe("a site that works", () => {
  it("is reported as completed, with the steps it took", async () => {
    const j = await journeyFor("g");
    expect(j!.completed).toBe(true);
    expect(j!.task).toBe("signup");
    expect(j!.entry).toBe("Create a free account");
    expect(j!.reason).toBeNull();
    expect(j!.steps.length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("produces no finding at all", async () => {
    const report = await runTest(appUrl("g"), { allowPrivate: true });
    expect(report.findings).toHaveLength(0);
    expect(report.journey?.completed).toBe(true);
  }, 300_000);
});

describe("when Owly is the one who stops", () => {
  it("never calls a purchase journey completed, and never calls it broken", async () => {
    const j = await journeyFor("f");
    expect(j!.completed).toBe(false);
    expect(j!.hardFailure).toBe(false);
    expect(j!.reason).toMatch(/does not complete purchases/);
    expect(hits.f?.pay_pressed ?? 0).toBe(0);
  }, 120_000);

  it("says a passive scan did not try, rather than that the site failed", async () => {
    const j = await journeyFor("a", false);
    expect(j!.lookedOnly).toBe(true);
    expect(j!.hardFailure).toBe(false);
    expect(j!.reason).toMatch(/passive scan/i);

    // And no finding comes out of it, even though this site IS broken.
    const report = await runTest(appUrl("a"), { allowPrivate: true, mode: "passive" });
    expect(report.findings.some((f) => f.kind === "task_blocked")).toBe(false);
  }, 300_000);

  it("does not follow the journey onto another website", async () => {
    const j = await journeyFor("h");
    expect(j!.completed).toBe(false);
    expect(j!.stoppedByOwly).toBe(true);
    expect(Object.keys(hits.exfil ?? {})).toHaveLength(0);
  }, 120_000);
});

describe("the blocked journey becomes the report's headline", () => {
  it("is the most severe finding, and carries a screenshot", async () => {
    const report = await runTest(appUrl("a"), { allowPrivate: true });
    const first = report.findings[0]!;
    expect(first.kind).toBe("task_blocked");
    expect(first.severity).toBe("critical");
    expect(first.title).toMatch(/cannot create an account/);
    expect(first.evidence.some((e) => e.type === "screenshot")).toBe(true);
    // Verified like anything else: reported only because it happened twice.
    expect(first.reproductions.reproduced).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
