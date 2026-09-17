/**
 * Which controls Owly will not press.
 *
 * Spec §8: never take irreversible real-world actions by default. The guard
 * runs before every click and submit, and it is deliberately conservative: a
 * button Owly wrongly declines to press costs one untested path, while a
 * "Pay now" it wrongly presses costs someone real money.
 *
 * This is a list of words, and that is right *here*. The spec's warning against
 * keyword filters is about judging what a whole product is for, where context
 * matters. Deciding whether one button might move money or delete data is a
 * narrower question, and false refusals are cheap.
 */

export type Risk = "safe" | "destructive";

export interface ControlDescription {
  /** Visible text or accessible name. */
  name: string;
  /** "button", "link", "submit", "menuitem"... */
  role: string;
  /** For links: the destination. For forms: the action URL. */
  target?: string;
  /** For forms: GET or POST. */
  method?: string;
}

export interface GuardDecision {
  risk: Risk;
  reason: string;
}

// Money moves, data is destroyed, or someone outside the test is contacted.
// These are refused whatever kind of control carries them.
const ALWAYS = [
  /\b(pay|payment)\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bplace\s+(your\s+)?order\b/i,
  /\bconfirm\s+(order|payment|purchase)\b/i,
  /\bcomplete\s+(order|purchase|payment|checkout)\b/i,
  /\b(subscribe|upgrade)\s+(now|today)\b/i,
  /\bstart\s+(my\s+)?subscription\b/i,
  /\btransfer\b/i,
  /\bwithdraw\b/i,
  /\bdonate\b/i,
  /\bdelete\b/i,
  /\bremove\s+(account|user|member|project|workspace|all)\b/i,
  /\b(deactivate|close|cancel|terminate)\s+(my\s+)?(account|subscription|plan)\b/i,
  /\berase\b/i,
  /\bwipe\b/i,
  /\bdestroy\b/i,
  /\bsend\s+(invite|invitation|message|email|money|payment)s?\b/i,
  /\binvite\b/i,
  /\bpublish\b/i,
  /\bunsubscribe\b/i,
];

// Sensitive only when the control actually submits something. A link reading
// "Checkout" usually just opens the checkout page, which is worth testing.
const WHEN_SUBMITTING = [/\bcheckout\b/i, /\bconfirm\b/i, /\bsend\b/i, /\bpost\b/i, /\bremove\b/i, /\bsubmit\s+order\b/i];

// URL paths that do something when merely visited, in apps that misuse GET.
const DANGEROUS_PATHS = /\/(delete|destroy|remove|logout|signout|sign-out|log-out|unsubscribe|cancel|pay|checkout\/(confirm|complete))(\b|\/|\?|$)/i;

export function assess(control: ControlDescription): GuardDecision {
  const name = control.name.replace(/\s+/g, " ").trim();

  for (const pattern of ALWAYS) {
    if (pattern.test(name)) {
      return { risk: "destructive", reason: `"${name}" matches ${pattern.source}` };
    }
  }

  const submits =
    control.role === "submit" ||
    (control.role === "button" && (control.method ?? "").toUpperCase() !== "GET");
  if (submits) {
    for (const pattern of WHEN_SUBMITTING) {
      if (pattern.test(name)) {
        return { risk: "destructive", reason: `submitting "${name}" matches ${pattern.source}` };
      }
    }
  }

  if (control.target) {
    let path = control.target;
    try {
      path = new URL(control.target, "http://owly.invalid").pathname + new URL(control.target, "http://owly.invalid").search;
    } catch {
      /* keep the raw target */
    }
    if (DANGEROUS_PATHS.test(path)) {
      // Logging out is not destructive to anyone's data, but it ends the
      // session the rest of the run depends on, which is the same outcome for
      // the test.
      return { risk: "destructive", reason: `destination ${path} acts on visit` };
    }
  }

  return { risk: "safe", reason: "no destructive intent detected" };
}
