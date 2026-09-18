/**
 * Overlapping controls, measured per line.
 *
 * An inline link that wraps across two lines has a bounding box that covers
 * both lines and the gap between them. Comparing those boxes made every
 * neighbouring link in a wrapping footer look completely covered: eight
 * confident false positives on the control app, on CI only, because the text
 * happened to wrap on Linux and not on Windows.
 *
 * Both directions are pinned here: wrapped links are not an overlap, and a
 * real overlap is still found.
 */

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIND_OVERLAPS } from "../src/browser/inpage.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function overlapsIn(html: string): Promise<Array<{ first: string; second: string; share: number }>> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${html}</body></html>`);
  const result = (await page.evaluate(FIND_OVERLAPS)) as Array<{ first: string; second: string; share: number }>;
  await page.close();
  return result;
}

describe("wrapping inline links", () => {
  it("are not reported as overlapping, however many lines they run over", async () => {
    const found = await overlapsIn(`
      <footer style="width:200px;font-size:16px">
        <p>Made somewhere.
          <a href="/a">A fairly long partner link that wraps</a> ·
          <a href="/b">Another long link that also wraps onto lines</a> ·
          <a href="/c">Service status page</a>
        </p>
      </footer>`);
    expect(found).toEqual([]);
  });
});

describe("controls genuinely drawn on top of each other", () => {
  it("are still reported", async () => {
    const found = await overlapsIn(`
      <div style="position:relative;height:80px">
        <a href="/x" style="position:absolute;left:10px;top:10px">Features</a>
        <a href="/y" style="position:absolute;left:14px;top:12px">Pricing FAQ</a>
      </div>`);
    expect(found.length).toBeGreaterThan(0);
    expect(`${found[0]!.first} ${found[0]!.second}`).toContain("Features");
  });
});
