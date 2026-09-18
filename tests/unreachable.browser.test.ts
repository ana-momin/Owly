/**
 * The worst thing Owly could say.
 *
 * A run that never opened the site used to end as an ordinary report with no
 * findings - "no issues", four words that a founder would read as "my site is
 * fine". It happened in production: the first navigation returned nothing, the
 * browser stayed on about:blank, whose origin is the string "null", and the
 * off-site check announced that the home page "leads off the site (to null)".
 *
 * Reporting nothing is only allowed after something was actually tested.
 */

import { describe, expect, it } from "vitest";
import { runTest } from "../src/engine/run.js";
import { reportPage } from "../src/report/html.js";
import { pondMarkdown } from "../src/report/text.js";

// The discard port: a connection to it is refused at once, so this is a dead
// address rather than a slow one.
const DEAD = "http://127.0.0.1:9/";

describe("a site that does not answer", () => {
  it("fails the run instead of passing the site", async () => {
    const report = await runTest(DEAD, { allowPrivate: true });

    expect(report.failed).toMatch(/could not open/i);
    expect(report.findings).toHaveLength(0);
    expect(report.pages.every((p) => p.status === null)).toBe(true);

    const md = pondMarkdown(report, null);
    expect(md).toMatch(/could not open/i);
    expect(md).toMatch(/not a clean bill of health/i);
    expect(md).not.toMatch(/No problems reproduced/i);

    const html = reportPage(report, "nonce");
    expect(html).toMatch(/could not open/i);
    expect(html).not.toMatch(/No issues reproduced/i);
  }, 180_000);

  it("never says the page led off the site", async () => {
    const report = await runTest(DEAD, { allowPrivate: true });
    expect(report.notes.join(" ")).not.toMatch(/leads off the site/i);
    expect(report.notes.join(" ")).toMatch(/did not respond/i);
  }, 180_000);
});
