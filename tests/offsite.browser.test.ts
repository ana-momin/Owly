/**
 * A URL that redirects off the site is not a page of the site.
 *
 * Found in production, on Foxy's own site: /slack/install redirects to Slack,
 * Owly's guard refused to follow it, and the browser stayed on about:blank -
 * which Owly then measured and reported as "dead end: no links, buttons or
 * forms". A working redirect, reported as a defect.
 *
 * It only happens when the redirect is the FIRST page a browser opens, which
 * is why a crawl never showed it: mid-crawl the browser is still showing the
 * previous page. A slice boundary starts a fresh browser, so in production it
 * happened on the first try.
 */

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERSONAS, Session } from "../src/browser/session.js";
import { loadUnit } from "../src/engine/probes.js";
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

describe("an off-site redirect, opened first in a fresh browser", () => {
  it("is recorded as leaving the site, and nothing is reported about it", async () => {
    const target = new URL(appUrl("g"));
    const session = await Session.open(browser, {
      target,
      persona: PERSONAS.new_user,
      allowPrivate: true,
      userAgentSuffix: "OwlyQA/test",
    });
    // Nothing else has run in this session: the browser is on about:blank,
    // exactly as at the start of a slice.
    const result = await loadUnit(session, `${target.origin}/partner`);
    await session.close();

    expect(result.leftTheSite).toBeTruthy();
    expect(result.candidates).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/leads off the site/);
  });

  it("treats a JSON endpoint as not a page, rather than judging Chromium's wrapper for it", async () => {
    const target = new URL(appUrl("g"));
    const session = await Session.open(browser, {
      target,
      persona: PERSONAS.new_user,
      allowPrivate: true,
      userAgentSuffix: "OwlyQA/test",
    });
    const result = await loadUnit(session, `${target.origin}/status.json`);
    await session.close();

    expect(result.notHtml).toBe("application/json");
    expect(result.candidates).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/not a web page/);
  });

  it("still analyses an ordinary page opened the same way", async () => {
    const target = new URL(appUrl("g"));
    const session = await Session.open(browser, {
      target,
      persona: PERSONAS.new_user,
      allowPrivate: true,
      userAgentSuffix: "OwlyQA/test",
    });
    const result = await loadUnit(session, `${target.origin}/pricing`);
    await session.close();

    expect(result.leftTheSite).toBeNull();
    expect(result.status).toBe(200);
    expect(result.discovered.length).toBeGreaterThan(0);
  });
});
