/**
 * The security half of using a product properly.
 *
 * Nothing here attacks anything: every check reads what the server already
 * said, or does what any user could do - sign out, or open a page while not
 * signed in. The last one is the point: Owly signed up itself, so it knows
 * which pages are supposed to need an account.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOnce } from "./shared-run.js";
import { appUrl, startLab, type Lab } from "../lab/serve.js";

// Without this the lab is not listening, every run fails to open anything,
// and the assertions below pass or fail for reasons that have nothing to do
// with security. A run that finds nothing because there was nothing there is
// the one result this file must never mistake for a clean bill of health.
let lab: Lab;
beforeAll(async () => {
  lab = await startLab();
}, 60_000);
afterAll(async () => {
  await lab?.close();
});

describe("what the server says about itself", () => {
  it("reports the missing headers on an app that sends none", async () => {
    const report = await runOnce(appUrl("i"), { allowPrivate: true });
    const headers = report.findings.find((f) => f.kind === "security_headers");

    expect(headers, `findings: ${report.findings.map((f) => f.kind).join(", ")}`).toBeDefined();
    expect(headers!.severity).toBe("low");
    expect(headers!.actual).toMatch(/Content-Security-Policy/i);
    expect(headers!.category).toBe("security");
  }, 400_000);

  it("says nothing about an app that sends them", async () => {
    const report = await runOnce(appUrl("g"), { allowPrivate: true });
    // "No security findings" only means something if the run actually ran.
    expect(report.failed, "the run itself failed, so this proves nothing").toBeFalsy();
    expect(report.findings.some((f) => f.category === "security")).toBe(false);
  }, 400_000);
});

describe("signing out", () => {
  it("is reported when the session still works afterwards", async () => {
    const report = await runOnce(appUrl("i"), { allowPrivate: true });
    const out = report.findings.find((f) => f.kind === "signout_ineffective");

    expect(out, `findings: ${report.findings.map((f) => f.kind).join(", ")}`).toBeDefined();
    expect(out!.severity).toBe("high");
    expect(out!.summary).toMatch(/still/i);
  }, 400_000);
});

describe("pages behind the login", () => {
  it("is not reported when they redirect a stranger to sign in", async () => {
    // App I protects its pages properly - the bug there is the sign-out, not
    // the door. A false "your dashboard is public" would be unforgivable.
    const report = await runOnce(appUrl("i"), { allowPrivate: true });
    expect(report.failed, "the run itself failed, so this proves nothing").toBeFalsy();
    expect(report.findings.some((f) => f.kind === "unprotected_page")).toBe(false);
  }, 400_000);
});
