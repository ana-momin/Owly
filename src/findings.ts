/**
 * What a finding is.
 *
 * The shape enforces the spec's two trust rules instead of hoping each detector
 * follows them:
 *
 *   - Evidence over opinion (§2B). `observed` holds facts the browser recorded.
 *     `inference` holds anything reasoned from them, labelled as such. A report
 *     renders them separately, so a reader can always tell which is which (§33).
 *   - Verification before reporting (§3C, §31). `reproductions` records what
 *     actually happened on replay, and confidence is derived from it in
 *     `confidenceFrom` rather than asserted by the detector that raised it.
 */

export type Category = "functional" | "usability" | "visual" | "accessibility" | "reliability" | "security";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "confirmed" | "likely" | "possible" | "inconclusive";

export type FindingKind =
  /** The site's main task could not be completed. The headline finding. */
  | "task_blocked"
  | "js_exception"
  | "console_error"
  | "http_error"
  | "broken_link"
  | "broken_image"
  | "form_server_error"
  | "form_no_feedback"
  /** Accepted a change and then lost it: the old value is back after a reload. */
  | "lost_write"
  /** Pressing submit twice quickly sent the form twice, and both were accepted. */
  | "duplicate_on_double_submit"
  /** Headers a browser needs to protect people, absent everywhere. */
  | "security_headers"
  /** The cookie that keeps you signed in is readable by scripts, or unencrypted. */
  | "weak_session_cookie"
  /** A page that needs an account answered a browser that has none. */
  | "unprotected_page"
  /** Signing out left the session working. */
  | "signout_ineffective"
  | "form_accepts_invalid"
  | "action_obscured"
  | "dead_end"
  | "mobile_overflow"
  | "clipped_text"
  | "overlapping_controls"
  | "a11y_violation"
  | "focus_invisible"
  | "keyboard_trap"
  | "flaky_request"
  | "slow_response";

export const CATEGORY_OF: Record<FindingKind, Category> = {
  task_blocked: "functional",
  js_exception: "functional",
  console_error: "functional",
  http_error: "functional",
  broken_link: "functional",
  broken_image: "visual",
  form_server_error: "functional",
  form_no_feedback: "usability",
  lost_write: "functional",
  duplicate_on_double_submit: "functional",
  security_headers: "security",
  weak_session_cookie: "security",
  unprotected_page: "security",
  signout_ineffective: "security",
  form_accepts_invalid: "functional",
  action_obscured: "usability",
  dead_end: "usability",
  mobile_overflow: "visual",
  clipped_text: "visual",
  overlapping_controls: "visual",
  a11y_violation: "accessibility",
  focus_invisible: "accessibility",
  keyboard_trap: "accessibility",
  flaky_request: "reliability",
  slow_response: "reliability",
};

export interface Viewport {
  width: number;
  height: number;
}

export type Evidence =
  | { type: "screenshot"; ref: string; caption: string }
  | { type: "console"; level: string; text: string; at: string }
  | { type: "network"; method: string; url: string; status: number | null; error?: string; durationMs?: number }
  | { type: "dom"; selector: string; snippet: string }
  | { type: "a11y"; rule: string; impact: string; help: string; nodes: string[] }
  | { type: "measurement"; name: string; value: number; unit: string; threshold?: number };

export interface Reproduction {
  attempts: number;
  reproduced: number;
}

export interface Finding {
  kind: FindingKind;
  category: Category;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** The first page it was seen on. */
  url: string;
  /**
   * Every page the same underlying problem appeared on, after clustering. A
   * broken footer link is one finding, not one per page it appears on (§11).
   */
  occurrences?: string[];
  /** Accessible name or selector of the element involved, when there is one. */
  target?: string;
  persona?: string;
  viewport?: Viewport;
  summary: string;
  expected: string;
  actual: string;
  /** Exact steps, in the order they were performed. */
  steps: string[];
  evidence: Evidence[];
  /** Facts the browser recorded. */
  observed: string[];
  /** Reasoning from those facts. Never presented as fact. */
  inference: string[];
  reproductions: Reproduction;
  /** Stable identity of the underlying problem, used to cluster duplicates. */
  fingerprint: string;
}

/**
 * Confidence from what replay showed, not from how sure a detector felt.
 *
 * `deterministic` is true when the signal itself is unambiguous (an HTTP 500 is
 * a 500). Heuristic signals - "nothing visibly happened after submit" - cap at
 * `likely` even when they reproduce every time, because the heuristic could be
 * wrong about what "nothing" means on that page.
 */
export function confidenceFrom(r: Reproduction, deterministic: boolean): Confidence {
  if (r.attempts === 0) return "inconclusive";
  if (r.reproduced === 0) return "inconclusive";
  const rate = r.reproduced / r.attempts;
  if (rate === 1) return deterministic ? "confirmed" : "likely";
  if (rate >= 0.5) return "likely";
  return "possible";
}
