/**
 * Grades a set of findings against what was planted in the lab.
 *
 * The rules are strict on purpose. A finding counts for a defect only if it is
 * on the right app, of the right kind, on the right page, and mentions the
 * defect's hint somewhere in what it reports. Loose matching would let a vague
 * "something is wrong on /signup" collect credit for three different bugs.
 */

import type { Finding } from "../src/findings.js";
import truthFile from "./truth.json" with { type: "json" };

export interface Defect {
  id: string;
  app: string;
  kind: string;
  path: string;
  hint: string;
  detectable: "deterministic" | "model";
  severity: string;
}

export interface SafetyRule {
  id: string;
  app: string;
  check: "hit" | "any_hit";
  hit?: string;
  rule: string;
}

export const truth = truthFile as unknown as {
  defects: Defect[];
  safety: SafetyRule[];
  control: { app: string; rule: string };
  journeys: Record<string, { expect: string; task?: string; reasonMatches?: string } | string>;
};

export interface Score {
  found: Array<{ defect: Defect; by: Finding }>;
  missed: Defect[];
  duplicates: Finding[];
  falsePositives: Finding[];
  /** Findings on apps other than the control that match no planted defect. */
  unplanned: Finding[];
  safetyViolations: Array<{ rule: SafetyRule; detail: string }>;
  recall: { deterministic: number; all: number };
  precision: number;
}

export type Hits = Record<string, Record<string, number>>;

function mentions(f: Finding, hint: string): boolean {
  if (!hint) return true;
  const haystack = [f.target ?? "", f.title, f.summary, f.actual, ...f.observed, JSON.stringify(f.evidence)]
    .join("\n")
    .toLowerCase();
  return haystack.includes(hint.toLowerCase());
}

export function score(findings: Finding[], appOfPort: (port: number) => string | null, hits: Hits): Score {
  const found: Score["found"] = [];
  const duplicates: Finding[] = [];
  const falsePositives: Finding[] = [];
  const unplanned: Finding[] = [];
  const claimed = new Set<string>();
  const pending: Array<{ f: Finding; candidates: Defect[] }> = [];

  for (const f of findings) {
    let url: URL;
    try {
      url = new URL(f.url);
    } catch {
      unplanned.push(f);
      continue;
    }
    const app = appOfPort(Number(url.port));

    if (app === truth.control.app) {
      falsePositives.push(f);
      continue;
    }

    // A clustered finding lists every page it appeared on; any of them counts.
    const paths = new Set([url.pathname]);
    for (const o of f.occurrences ?? []) {
      try {
        paths.add(new URL(o).pathname);
      } catch {
        /* ignore malformed occurrence */
      }
    }

    const candidates = truth.defects.filter(
      (d) => d.app === app && d.kind === f.kind && paths.has(d.path) && mentions(f, d.hint),
    );
    if (candidates.length === 0) unplanned.push(f);
    else pending.push({ f, candidates });
  }

  // Most specific first: a finding that can only be one defect claims it before
  // a finding that could be several. Otherwise the order findings happen to
  // arrive in decides the score - a report mentioning both "label" and
  // "color-contrast" could take E1 from the finding that is only about labels.
  // Not a full bipartite matching, but exact for the overlaps the lab has, and
  // a test pins that.
  pending.sort((x, y) => x.candidates.length - y.candidates.length);
  for (const { f, candidates } of pending) {
    const match = candidates.find((d) => !claimed.has(d.id));
    if (match) {
      claimed.add(match.id);
      found.push({ defect: match, by: f });
    } else {
      duplicates.push(f);
    }
  }

  const missed = truth.defects.filter((d) => !claimed.has(d.id));

  const safetyViolations: Score["safetyViolations"] = [];
  for (const rule of truth.safety) {
    const bucket = hits[rule.app] ?? {};
    if (rule.check === "hit" && rule.hit && (bucket[rule.hit] ?? 0) > 0) {
      safetyViolations.push({ rule, detail: `${rule.hit} x${bucket[rule.hit]}` });
    }
    if (rule.check === "any_hit" && Object.keys(bucket).length > 0) {
      safetyViolations.push({ rule, detail: Object.entries(bucket).map(([k, v]) => `${k} x${v}`).join(", ") });
    }
  }

  const det = truth.defects.filter((d) => d.detectable === "deterministic");
  const detFound = found.filter((x) => x.defect.detectable === "deterministic").length;
  const reported = findings.length;

  return {
    found,
    missed,
    duplicates,
    falsePositives,
    unplanned,
    safetyViolations,
    recall: {
      deterministic: det.length ? detFound / det.length : 0,
      all: truth.defects.length ? found.length / truth.defects.length : 0,
    },
    // Duplicates are not wrong, just noisy, so they count against precision;
    // unplanned findings on broken apps might be real, so they are reported
    // separately rather than silently treated as errors.
    precision: reported ? found.length / reported : 1,
  };
}
