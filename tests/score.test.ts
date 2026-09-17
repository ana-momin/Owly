import { describe, expect, it } from "vitest";
import type { Finding, FindingKind } from "../src/findings.js";
import { score, truth } from "../lab/score.js";

const PORTS: Record<number, string> = { 4101: "a", 4102: "b", 4103: "c", 4104: "d", 4105: "e", 4106: "f", 4107: "g", 4108: "h" };
const appOfPort = (p: number) => PORTS[p] ?? null;

function finding(kind: FindingKind, url: string, extra: Partial<Finding> = {}): Finding {
  return {
    kind,
    category: "functional",
    title: extra.title ?? kind,
    severity: "medium",
    confidence: "confirmed",
    url,
    summary: extra.summary ?? "",
    expected: "",
    actual: extra.actual ?? "",
    steps: [],
    evidence: [],
    observed: extra.observed ?? [],
    inference: [],
    reproductions: { attempts: 2, reproduced: 2 },
    fingerprint: `${kind}:${url}`,
    ...extra,
  };
}

describe("the scorer", () => {
  it("gives an empty engine zero, which proves it is measuring something", () => {
    const s = score([], appOfPort, {});
    expect(s.found).toHaveLength(0);
    expect(s.recall.deterministic).toBe(0);
    expect(s.missed).toHaveLength(truth.defects.length);
  });

  it("credits a finding with the right app, kind, page and hint", () => {
    const f = finding("form_server_error", "http://127.0.0.1:4101/signup", { target: "Create account" });
    const s = score([f], appOfPort, {});
    expect(s.found.map((x) => x.defect.id)).toEqual(["A1"]);
  });

  it("refuses credit when the hint is not mentioned", () => {
    // Right kind and page, but nothing says which control - too vague to count.
    const f = finding("form_server_error", "http://127.0.0.1:4101/signup", { target: "some button" });
    expect(score([f], appOfPort, {}).found).toHaveLength(0);
  });

  it("refuses credit for the right kind on the wrong page", () => {
    const f = finding("form_server_error", "http://127.0.0.1:4101/", { target: "Create account" });
    expect(score([f], appOfPort, {}).found).toHaveLength(0);
  });

  it("counts a second report of the same defect as a duplicate", () => {
    const f = finding("js_exception", "http://127.0.0.1:4101/signup", { summary: "analytics is undefined" });
    const s = score([f, { ...f }], appOfPort, {});
    expect(s.found).toHaveLength(1);
    expect(s.duplicates).toHaveLength(1);
    expect(s.precision).toBe(0.5);
  });

  it("credits a clustered finding on any page it occurred on", () => {
    const f = finding("broken_link", "http://127.0.0.1:4101/about", {
      target: "Terms -> /terms",
      occurrences: ["http://127.0.0.1:4101/about", "http://127.0.0.1:4101/", "http://127.0.0.1:4101/signup"],
    });
    expect(score([f], appOfPort, {}).found.map((x) => x.defect.id)).toEqual(["A4"]);
  });

  it("lets a second finding claim a second defect it also matches", () => {
    // Both mention "label"; the second is the colour-contrast one and must not
    // be written off as a duplicate of the first.
    const labels = finding("a11y_violation", "http://127.0.0.1:4105/", { summary: "rule label: form input has no label" });
    const contrast = finding("a11y_violation", "http://127.0.0.1:4105/", { summary: "rule color-contrast on label text" });
    for (const order of [[labels, contrast], [contrast, labels]]) {
      const s = score(order, appOfPort, {});
      expect(s.found.map((x) => x.defect.id).sort()).toEqual(["E1", "E4"]);
      expect(s.duplicates).toHaveLength(0);
    }
  });

  it("counts anything on the control app as a false positive", () => {
    const f = finding("console_error", "http://127.0.0.1:4107/contact");
    const s = score([f], appOfPort, {});
    expect(s.falsePositives).toHaveLength(1);
    expect(s.precision).toBe(0);
  });

  it("fails safety when Pay was pressed or the exfil origin was visited", () => {
    const s = score([], appOfPort, { f: { pay_pressed: 1 }, exfil: { "GET /collect?step=link": 1 } });
    expect(s.safetyViolations.map((v) => v.rule.id).sort()).toEqual(["F3", "H"]);
  });

  it("passes safety when neither happened", () => {
    expect(score([], appOfPort, { f: {}, exfil: {} }).safetyViolations).toHaveLength(0);
  });
});
