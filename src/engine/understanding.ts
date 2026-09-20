/**
 * What Owly thinks your product is.
 *
 * Everything else in the engine checks a page against a rule. This builds a
 * picture of the product from what the run saw - what kind of thing it is,
 * what it keeps, what it lets you do, whether Owly got inside - and puts that
 * picture in the report.
 *
 * Two reasons it earns its place:
 *
 *   1. Findings can be ranked by what they cost. "Nobody can create a ticket"
 *      matters more than a contrast ratio, and the difference is knowing that
 *      tickets are the thing this product is for.
 *   2. It is checkable. A tester who has misunderstood your product writes a
 *      useless report, and you cannot tell until you read it. Owly says what
 *      it understood, in a sentence, at the top - so a wrong assumption is
 *      visible immediately instead of quietly poisoning everything below.
 *
 * It is inference from words on the page, and the report says so. No model is
 * involved, so it is never a confident guess about something it cannot see.
 */

import type { Finding } from "../findings.js";
import type { Journey } from "./journey.js";

export interface Understanding {
  /** One sentence: what this appears to be. */
  reads_as: string;
  /** The nouns the product is organised around, most prominent first. */
  keeps: string[];
  /** What a person can do here, in the product's own words. */
  can: string[];
  /** Whether Owly got an account, and how. */
  inside: string | null;
  /** The things above, as the evidence they came from. */
  because: string[];
}

const KINDS: Array<{ kind: string; words: RegExp; need?: RegExp }> = [
  { kind: "a help desk", words: /\b(ticket|support|help desk|helpdesk|issue|request)s?\b/i },
  { kind: "a shop", words: /\b(cart|checkout|basket|shipping|add to bag|add to cart)\b/i },
  { kind: "a booking tool", words: /\b(book|booking|reservation|appointment|availability|calendar)s?\b/i },
  { kind: "an invoicing tool", words: /\b(invoice|billing|expense|payment|receipt)s?\b/i },
  { kind: "a project tool", words: /\b(project|task|board|sprint|backlog|milestone)s?\b/i },
  { kind: "a writing tool", words: /\b(document|note|post|draft|page|article)s?\b/i },
  { kind: "an analytics tool", words: /\b(dashboard|report|metric|analytics|chart)s?\b/i },
  { kind: "a mailing tool", words: /\b(subscriber|campaign|newsletter|audience|broadcast)s?\b/i },
];

/** Words that start an action rather than name a thing. */
const VERB =
  /^(create|add|new|start|book|buy|send|save|invite|upload|publish|export|download|edit|update|delete|remove|sign|log|open|close|read|learn|get|try|go|see|view|continue|submit|search|choose|select|pick|connect|make)\b/i;

/** Words that are furniture on every site and say nothing about the product. */
const FURNITURE =
  /^(home|about|pricing|contact|blog|docs|help|terms|privacy|login|log in|sign in|sign up|signup|settings|account|profile|search|menu|dashboard|new|create|back|next|previous|save|cancel|close|open|read more|learn more)$/i;

function tidy(word: string): string {
  return word.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Build the picture. `labels` is everything the run read out of the product:
 * navigation links, headings, list captions, form names, button text.
 */
export function understand(input: {
  target: string;
  labels: string[];
  journey: Journey | null;
  signedInBy: string | null;
  behindLogin: string[];
}): Understanding {
  const words = input.labels.map(tidy).filter(Boolean);
  const text = words.join(" · ");
  const because: string[] = [];

  // 1. What kind of thing is this?
  const matched = KINDS.filter((k) => k.words.test(text));
  const kind = matched[0]?.kind ?? null;
  if (kind) because.push(`the words on the page read like ${kind}`);

  // 2. What does it keep? The nouns - which means throwing away everything
  //    that starts with a verb. "Create account" is something you can do, not
  //    a thing the product is built around, and counting it as one had Owly
  //    announcing that a help desk was organised around "create account".
  const counted = new Map<string, { n: number; shown: string }>();
  for (const word of words) {
    if (word.length < 3 || word.length > 24 || FURNITURE.test(word)) continue;
    if (/[.:/@]/.test(word) || VERB.test(word)) continue;
    const shown = word.replace(/^(your|my|all|the) /, "").trim();
    if (!shown || FURNITURE.test(shown) || VERB.test(shown)) continue;
    // "Tickets" and "ticket" are one thing being counted twice.
    const key = shown.endsWith("ies") ? `${shown.slice(0, -3)}y` : shown.replace(/s$/, "");
    const seen = counted.get(key);
    counted.set(key, { n: (seen?.n ?? 0) + 1, shown: seen?.shown ?? shown });
  }
  const keeps = [...counted.values()]
    .filter((c) => c.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((c) => c.shown);
  if (keeps.length) because.push(`"${keeps[0]}" appears in the navigation and on more than one page`);

  // 3. What can be done, in the product's own words - one per verb, so that
  //    "Create account" and "Create your account" are not two different things.
  const byVerb = new Map<string, string>();
  for (const word of words) {
    const verb = VERB.exec(word)?.[1]?.toLowerCase();
    if (!verb || word.length > 30) continue;
    const kept = byVerb.get(verb);
    if (!kept || word.length < kept.length) byVerb.set(verb, word);
  }
  const can = [...byVerb.values()].slice(0, 5).map((w) => w.replace(/^./, (c) => c.toUpperCase()));

  // 4. Did Owly get in?
  const inside = input.signedInBy ? `signed in ${input.signedInBy}` : null;
  if (inside) {
    because.push(
      input.behindLogin.length
        ? `${input.behindLogin.length} page${input.behindLogin.length === 1 ? "" : "s"} were only reachable after signing in`
        : "an account was created during the run",
    );
  }

  // 5. Say it in one sentence, and never claim more than was seen.
  const host = (() => {
    try {
      return new URL(input.target).host;
    } catch {
      return input.target;
    }
  })();
  const main = input.journey?.goal ? input.journey.goal.toLowerCase() : null;
  let reads_as: string;
  if (kind && keeps.length) {
    reads_as = `${host} reads like ${kind}, organised around ${keeps.slice(0, 2).join(" and ")}`;
  } else if (kind) {
    reads_as = `${host} reads like ${kind}`;
  } else if (keeps.length) {
    reads_as = `${host} is organised around ${keeps.slice(0, 2).join(" and ")}`;
  } else {
    reads_as = `${host} did not say enough about itself for Owly to summarise it`;
  }
  if (main) reads_as += `, and asks a newcomer to ${main}`;
  if (inside) reads_as += `. Owly ${inside}`;

  return { reads_as, keeps, can, inside, because };
}

/**
 * Rank findings by what they cost the product, not by which checker found
 * them. A failure in the thing the product is for outranks everything.
 */
export function costOf(f: Finding, u: Understanding | null): number {
  const base = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[f.severity];
  let cost = base * 10;

  // The main task, whatever it is, is the product.
  if (f.kind === "task_blocked") cost -= 15;
  // Losing what someone typed, or letting a stranger read it, is worse than
  // anything cosmetic however it was classified.
  if (f.kind === "lost_write" || f.kind === "unprotected_page") cost -= 8;
  // A finding about the noun this product is built around matters more than
  // the same finding somewhere peripheral.
  if (u && u.keeps.some((noun) => `${f.title} ${f.url}`.toLowerCase().includes(noun))) cost -= 4;
  return cost;
}
