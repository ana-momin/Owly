/**
 * Keeping secrets out of everything Owly writes down.
 *
 * Reports, traces, logs and event streams all end up in places a secret must
 * never reach: a shared report link, a Pond chat, the admin console. Redaction
 * is applied at the boundary where text leaves the engine, rather than trusted
 * to each call site remembering, because the one call site that forgets is the
 * one that leaks.
 *
 * Two kinds of secret are caught:
 *   - values Owly was told are secret (a test password it typed) - matched
 *     exactly, and in the encoded forms they take inside URLs and form bodies;
 *   - things that look like credentials whether or not anyone said so -
 *     bearer tokens, common API key shapes, `password=` parameters, JWTs.
 */

export const MASK = "[redacted]";

export interface Redactor {
  text(input: string): string;
  /** Deep-copies and redacts every string inside a JSON-like value. */
  value<T>(input: T): T;
  /** Registers another exact secret. */
  add(secret: string): void;
}

// Shapes that are credentials regardless of context. Each keeps the label and
// replaces the value, so a report still says *what* was hidden.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer|basic|token)?\s*[^\s,;"']+/gi, `$1$2$3 ${MASK}`],
  [/\b(bearer)\s+[a-z0-9._~+/-]{8,}=*/gi, `$1 ${MASK}`],
  [/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?id)(["']?\s*[:=]\s*["']?)[^\s&"',;}]+/gi, `$1$2${MASK}`],
  // JSON Web Tokens: three base64url segments, the first decoding to a header.
  [/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi, MASK],
  // Provider key shapes that are unambiguous on sight.
  [/\bsk-[a-z0-9_-]{16,}\b/gi, MASK],
  [/\bxox[abpr]-[a-z0-9-]{10,}\b/gi, MASK],
  [/\bgh[pousr]_[a-z0-9]{20,}\b/gi, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  // user:pass@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The forms a secret takes once it has been through a URL or a form post. */
function variants(secret: string): string[] {
  const forms = new Set<string>([secret]);
  forms.add(encodeURIComponent(secret));
  forms.add(encodeURIComponent(secret).replace(/%20/g, "+"));
  try {
    forms.add(Buffer.from(secret, "utf8").toString("base64"));
  } catch {
    /* not representable; the plain form is still covered */
  }
  return [...forms].filter((f) => f.length > 0);
}

export function createRedactor(secrets: Iterable<string> = []): Redactor {
  const exact: string[] = [];

  const add = (secret: string) => {
    // Very short values would redact ordinary words ("a", "no"). A secret that
    // short is not protecting anything, and masking every "no" in a report
    // would make it unreadable.
    if (secret.length < 4) return;
    for (const form of variants(secret)) {
      if (!exact.includes(form)) exact.push(form);
    }
    // Longest first, so a secret that contains another is masked whole.
    exact.sort((a, b) => b.length - a.length);
  };

  for (const s of secrets) add(s);

  const text = (input: string): string => {
    if (!input) return input;
    let out = input;
    for (const secret of exact) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), MASK);
    }
    for (const [pattern, replacement] of PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };

  const value = <T>(input: T): T => {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return text(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(input) as T;
  };

  return { text, value, add };
}
