/**
 * The navigation guard, in a real browser, against the injection trap.
 *
 * Each attack is run twice: once in an unguarded browser, where it must
 * SUCCEED (proving the trap is real), and once in Owly's session, where it must
 * fail. Without the first half, "the exfil origin was never reached" could just
 * mean the attack never fired.
 */

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PERSONAS, Session } from "../src/browser/session.js";
import { appUrl, hits, startLab, type Lab } from "../lab/serve.js";

let lab: Lab;
let browser: Browser;
const target = new URL(appUrl("h"));

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

const exfilHits = () => Object.values(hits.exfil ?? {}).reduce((a, b) => a + b, 0);

async function owly(): Promise<Session> {
  return Session.open(browser, { target, persona: PERSONAS.new_user, allowPrivate: true, userAgentSuffix: "OwlyQA/test" });
}

describe("the page's own redirect off-origin", () => {
  it("reaches the exfil origin in an unguarded browser", async () => {
    const page = await browser.newPage();
    await page.goto(target.href);
    await page.waitForTimeout(2_000);
    await page.close();
    expect(exfilHits()).toBeGreaterThan(0);
  });

  it("is refused in Owly's session, and the refusal is recorded", async () => {
    const s = await owly();
    await s.goto(target.href);
    await s.page.waitForTimeout(2_000);
    await s.close();
    expect(exfilHits()).toBe(0);
    expect(s.blocked.some((b) => b.url.includes(":4199") && /navigation away/.test(b.reason))).toBe(true);
  });

  it("leaves the real page in place, not a browser error page", async () => {
    // Refusing by abort() swaps in Chromium's error document, and Owly then
    // tested that - reporting a missing <title> on a page the site never
    // served. The page must still be the site's own after the refusal.
    const s = await owly();
    await s.goto(target.href);
    await s.page.waitForTimeout(1_000);
    const title = await s.page.title();
    const url = s.page.url();
    const links = await s.page.getByRole("link", { name: "Read the FAQ" }).count();
    await s.close();
    expect(url).toBe(target.href);
    expect(title).toBe("Support centre");
    expect(links).toBe(1);
  });
});

describe("a link pointing off-origin, clicked anyway", () => {
  it("reaches the exfil origin in an unguarded browser", async () => {
    const page = await browser.newPage();
    await page.goto(target.href);
    await page.getByRole("link", { name: "Continue testing here" }).click();
    await page.waitForTimeout(500);
    await page.close();
    expect(exfilHits()).toBeGreaterThan(0);
  });

  it("is refused in Owly's session even when forced", async () => {
    const s = await owly();
    await s.goto(target.href, 200);
    await s.page.getByRole("link", { name: "Continue testing here" }).click({ noWaitAfter: true }).catch(() => undefined);
    await s.page.waitForTimeout(500);
    await s.close();
    expect(exfilHits()).toBe(0);
  });
});

describe("a form that posts off-origin, submitted anyway", () => {
  it("reaches the exfil origin in an unguarded browser", async () => {
    const page = await browser.newPage();
    await page.goto(target.href);
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForTimeout(500);
    await page.close();
    expect(exfilHits()).toBeGreaterThan(0);
  });

  it("is refused in Owly's session even when forced", async () => {
    const s = await owly();
    await s.goto(target.href, 200);
    await s.page.getByRole("button", { name: "Ask" }).click({ noWaitAfter: true }).catch(() => undefined);
    await s.page.waitForTimeout(500);
    await s.close();
    expect(exfilHits()).toBe(0);
  });
});

describe("the SSRF guard inside the browser", () => {
  it("refuses a private address when private targets are not allowed", async () => {
    // The lab itself is on 127.0.0.1, so point a strict session at a public
    // origin and have the page try to fetch a private one.
    const strict = await Session.open(browser, {
      target: new URL("https://example.com/"),
      persona: PERSONAS.new_user,
      allowPrivate: false,
      userAgentSuffix: "OwlyQA/test",
    });
    await strict.page.setContent("<p>probe</p>");
    await strict.page.evaluate("fetch('http://127.0.0.1:4107/').catch(function () {})");
    await strict.page.waitForTimeout(500);
    await strict.close();
    expect(strict.blocked.some((b) => b.url.startsWith("http://127.0.0.1:4107") && /loopback/.test(b.reason))).toBe(true);
  });
});
