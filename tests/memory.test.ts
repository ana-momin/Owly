/**
 * What Owly remembers, and what it works out from it.
 *
 * The comparison is the part worth pinning hard: "did I fix it?" is the
 * question people actually come back with, and an answer that quietly counts
 * wrong is worse than no answer at all.
 */

import { describe, expect, it } from "vitest";
import { brief, changeLine, changeSince, clean, hostOf, runsFor, type RememberedRun } from "../src/api/memory.js";

const run = (site: string, at: string, titles: Array<[string, string]>): RememberedRun => ({
  site,
  at,
  mode: "full",
  headline: "a headline",
  findings: titles.map(([severity, title]) => ({ severity, title })),
});

describe("tidying whatever the browser sent", () => {
  it("survives rubbish without throwing", () => {
    for (const junk of [null, undefined, 42, "nonsense", [], { runs: "no" }, { mine: [1, 2] }]) {
      const m = clean(junk);
      expect(Array.isArray(m.mine)).toBe(true);
      expect(Array.isArray(m.runs)).toBe(true);
      expect(Array.isArray(m.facts)).toBe(true);
    }
  });

  it("normalises hosts so one site is one site", () => {
    expect(hostOf("https://WWW.Acme.dev/pricing?x=1")).toBe("acme.dev");
    expect(hostOf("acme.dev:8080")).toBe("acme.dev");
    const m = clean({ mine: ["https://www.Acme.dev/"], runs: [{ site: "WWW.ACME.DEV", at: "2026-01-01", findings: [] }] });
    expect(m.mine).toEqual(["acme.dev"]);
    expect(runsFor(m, "https://acme.dev/anything")).toHaveLength(1);
  });

  it("caps how much it will hold", () => {
    const many = Array.from({ length: 200 }, (_, i) => run(`s${i}.dev`, "2026-01-01", []));
    expect(clean({ runs: many }).runs.length).toBeLessThanOrEqual(40);
  });
});

describe("what changed since last time", () => {
  const before = run("acme.dev", "2026-09-19T10:00:00Z", [
    ["critical", "A new visitor cannot create an account"],
    ["high", "Submitting fails on /signup"],
    ["low", "The site does not send 3 security headers"],
  ]);

  it("counts fixed, still there, and new", () => {
    const change = changeSince(before, [
      { severity: "high", title: "Submitting fails on /signup" },
      { severity: "medium", title: "Nothing happens after pressing Sign in" },
    ]);
    expect(change.fixed.map((f) => f.severity)).toEqual(["critical", "low"]);
    expect(change.still.map((f) => f.severity)).toEqual(["high"]);
    expect(change.fresh.map((f) => f.severity)).toEqual(["medium"]);
    expect(changeLine(change)).toBe("Since the last run: 2 fixed, 1 still there, 1 new.");
  });

  it("calls everything fixed when a run comes back clean", () => {
    const change = changeSince(before, []);
    expect(change.fixed).toHaveLength(3);
    expect(change.still).toHaveLength(0);
    expect(change.fresh).toHaveLength(0);
  });

  it("does not call a change of severity the same finding", () => {
    // The same words at a different severity is a different line in the
    // report, and pretending otherwise would hide a bug getting worse.
    const change = changeSince(before, [{ severity: "critical", title: "Submitting fails on /signup" }]);
    expect(change.still).toHaveLength(0);
    expect(change.fresh).toHaveLength(1);
  });

  it("says so plainly when both runs found nothing", () => {
    expect(changeLine(changeSince(run("a.dev", "2026-09-01", []), []))).toMatch(/nothing found/i);
  });
});

describe("the briefing the model reads", () => {
  it("says what it does not know, rather than nothing", () => {
    const text = brief(clean(null));
    expect(text).toMatch(/not yet said which sites are theirs/i);
    expect(text).toMatch(/No test has been run/i);
  });

  it("names the sites, when they are known", () => {
    const text = brief(
      clean({
        mine: ["acme.dev"],
        runs: [run("acme.dev", "2026-09-19T10:00:00Z", [["critical", "signup"]])],
        facts: ["they are building a booking tool"],
      }),
    );
    expect(text).toMatch(/acme\.dev/);
    expect(text).toMatch(/2026-09-19/);
    expect(text).toMatch(/booking tool/);
  });
});
