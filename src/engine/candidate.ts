/**
 * A suspected problem, before verification.
 *
 * Detectors produce candidates, never findings. A candidate becomes a finding
 * only after the unit of work that raised it has been replayed in a fresh
 * browser and the same fingerprint appeared again (spec §31) - see `verify` in
 * run.ts. That is why every candidate records the `unit` that produced it.
 */

import type { Evidence, FindingKind, Reproduction, Severity, Viewport } from "../findings.js";
import type { Persona } from "../browser/session.js";

export type Activity = "load" | "layout" | "a11y" | "forms" | "buttons" | "keyboard" | "links";

export interface Candidate {
  kind: FindingKind;
  title: string;
  severity: Severity;
  /** Page it was observed on. */
  url: string;
  target?: string;
  persona: Persona["key"];
  viewport?: Viewport;
  summary: string;
  expected: string;
  actual: string;
  steps: string[];
  evidence: Evidence[];
  observed: string[];
  inference: string[];
  /**
   * True when the signal cannot mean anything else (an HTTP 500). False when a
   * heuristic decided it (nothing visibly changed after submit), which caps
   * confidence at "likely" however often it reproduces.
   */
  deterministic: boolean;
  /** Identity of the underlying problem. Equal fingerprints are one finding. */
  fingerprint: string;
  /** The unit of work to replay to verify this: `${persona}|${activity}|${url}`. */
  unit: string;
  /**
   * For problems that are themselves about repetition (flaky requests), the
   * attempts already made while detecting it.
   */
  priorAttempts?: Reproduction;
}

export function unitKey(persona: Persona["key"], activity: Activity, url: string): string {
  return `${persona}|${activity}|${url}`;
}

export function parseUnit(unit: string): { persona: Persona["key"]; activity: Activity; url: string } {
  const [persona, activity, ...rest] = unit.split("|");
  return { persona: persona as Persona["key"], activity: activity as Activity, url: rest.join("|") };
}
