/**
 * From candidates and replay results to findings.
 *
 * Pure on purpose: no browser, no clock. This is where "only report what
 * reproduced" is decided (spec §3C), and a rule like that has to be provable by
 * a test that feeds it a candidate which did NOT reproduce and watches it be
 * held back. A version that could only be exercised through a live browser
 * run would pass forever without anyone knowing whether it ever rejects.
 */

import { CATEGORY_OF, confidenceFrom, type Confidence, type Finding, type Reproduction } from "../findings.js";
import { PERSONAS } from "../browser/session.js";
import type { Candidate } from "./candidate.js";

export interface Clustered {
  /** Confirmed and likely, most severe first. */
  findings: Finding[];
  /** Raised but not reproduced. Never presented as bugs. */
  unverified: Finding[];
}

/** The key replay results are recorded under. */
export function replayKey(c: Pick<Candidate, "unit" | "fingerprint">): string {
  return `${c.unit}#${c.fingerprint}`;
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

export function cluster(candidates: Candidate[], reproduced: ReadonlySet<string>): Clustered {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) groups.set(c.fingerprint, [...(groups.get(c.fingerprint) ?? []), c]);

  const findings: Finding[] = [];
  const unverified: Finding[] = [];

  for (const [fingerprint, group] of groups) {
    const first = group[0]!;
    const repro: Reproduction = { attempts: 0, reproduced: 0 };
    for (const c of group) {
      // The detection itself, or the attempts a repetition-based detector made.
      repro.attempts += c.priorAttempts ? c.priorAttempts.attempts : 1;
      repro.reproduced += c.priorAttempts ? c.priorAttempts.reproduced : 1;
      // The replay in a fresh browser.
      repro.attempts += 1;
      if (reproduced.has(replayKey(c))) repro.reproduced += 1;
    }

    const replayed = group.some((c) => reproduced.has(replayKey(c)));
    const deterministic = group.every((c) => c.deterministic);
    let confidence: Confidence = confidenceFrom(repro, deterministic);
    // Seen once and not again on replay: not a bug report, however plausible.
    if (!replayed) confidence = "inconclusive";
    // A repetition-based problem that showed up again on replay is likely even
    // when its raw failure rate is low - intermittent is the finding.
    else if (first.priorAttempts && confidence === "possible") confidence = "likely";

    const occurrences = [...new Set(group.map((c) => c.url))];
    const finding: Finding = {
      kind: first.kind,
      category: CATEGORY_OF[first.kind],
      title: first.title,
      severity: first.severity,
      confidence,
      url: first.url,
      ...(occurrences.length > 1 ? { occurrences } : {}),
      ...(first.target ? { target: first.target } : {}),
      persona: PERSONAS[first.persona].label,
      ...(first.viewport ? { viewport: first.viewport } : {}),
      summary: occurrences.length > 1 ? `${first.summary} Seen on ${occurrences.length} pages.` : first.summary,
      expected: first.expected,
      actual: first.actual,
      steps: first.steps,
      evidence: group.flatMap((c) => c.evidence).slice(0, 12),
      observed: [...new Set(group.flatMap((c) => c.observed))].slice(0, 20),
      inference: [...new Set(group.flatMap((c) => c.inference))],
      reproductions: repro,
      fingerprint,
    };

    (confidence === "confirmed" || confidence === "likely" ? findings : unverified).push(finding);
  }

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { findings, unverified };
}
