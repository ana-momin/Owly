import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/engine/candidate.js";
import { cluster, replayKey } from "../src/engine/cluster.js";

function candidate(extra: Partial<Candidate> = {}): Candidate {
  return {
    kind: "http_error",
    title: "GET /api/x failed",
    severity: "high",
    url: "https://app.example/page",
    persona: "new_user",
    summary: "s",
    expected: "e",
    actual: "a",
    steps: ["Open page"],
    evidence: [],
    observed: ["GET /api/x -> 500"],
    inference: [],
    deterministic: true,
    fingerprint: "http_error|GET|/api/x|500",
    unit: "new_user|load|https://app.example/page",
    ...extra,
  };
}

describe("verification: only what reproduced is reported", () => {
  it("reports a deterministic problem that reproduced as confirmed", () => {
    const c = candidate();
    const { findings, unverified } = cluster([c], new Set([replayKey(c)]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe("confirmed");
    expect(findings[0]!.reproductions).toEqual({ attempts: 2, reproduced: 2 });
    expect(unverified).toHaveLength(0);
  });

  it("holds back a problem that did NOT reproduce, however certain it looked", () => {
    const c = candidate();
    const { findings, unverified } = cluster([c], new Set());
    expect(findings).toHaveLength(0);
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.confidence).toBe("inconclusive");
  });

  it("does not count a replay of a different unit as reproduction", () => {
    const c = candidate();
    const elsewhere = replayKey({ unit: "new_user|load|https://app.example/other", fingerprint: c.fingerprint });
    expect(cluster([c], new Set([elsewhere])).findings).toHaveLength(0);
  });

  it("caps a heuristic problem at likely even when it always reproduces", () => {
    const c = candidate({ kind: "form_no_feedback", deterministic: false, fingerprint: "form_no_feedback|/p|Save" });
    expect(cluster([c], new Set([replayKey(c)])).findings[0]!.confidence).toBe("likely");
  });

  it("reports an intermittent failure seen again on replay as likely, never confirmed", () => {
    const c = candidate({
      kind: "flaky_request",
      deterministic: false,
      fingerprint: "flaky_request|/|Save note",
      priorAttempts: { attempts: 3, reproduced: 1 },
    });
    const { findings } = cluster([c], new Set([replayKey(c)]));
    expect(findings[0]!.confidence).toBe("likely");
    expect(findings[0]!.reproductions).toEqual({ attempts: 4, reproduced: 2 });
  });

  it("holds back an intermittent failure that did not recur on replay", () => {
    const c = candidate({ kind: "flaky_request", deterministic: false, fingerprint: "f", priorAttempts: { attempts: 3, reproduced: 1 } });
    expect(cluster([c], new Set()).findings).toHaveLength(0);
  });
});

describe("clustering: one underlying problem, one finding", () => {
  it("folds the same problem on several pages into one finding with every page listed", () => {
    const a = candidate({ url: "https://app.example/a", unit: "new_user|load|https://app.example/a" });
    const b = candidate({ url: "https://app.example/b", unit: "new_user|load|https://app.example/b" });
    const { findings } = cluster([a, b], new Set([replayKey(a), replayKey(b)]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.occurrences).toEqual(["https://app.example/a", "https://app.example/b"]);
    expect(findings[0]!.summary).toContain("Seen on 2 pages");
  });

  it("keeps different problems apart", () => {
    const a = candidate();
    const b = candidate({ fingerprint: "http_error|GET|/api/y|500" });
    expect(cluster([a, b], new Set([replayKey(a), replayKey(b)])).findings).toHaveLength(2);
  });

  it("puts the most severe first", () => {
    const low = candidate({ severity: "low", fingerprint: "low" });
    const high = candidate({ severity: "high", fingerprint: "high" });
    const { findings } = cluster([low, high], new Set([replayKey(low), replayKey(high)]));
    expect(findings.map((f) => f.severity)).toEqual(["high", "low"]);
  });
});
