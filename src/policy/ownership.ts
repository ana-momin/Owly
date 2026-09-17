/**
 * Proving a site belongs to the person asking (spec §54: classify, authorise,
 * test).
 *
 * A checkbox saying "I own this" proves nothing, and a full test fills in
 * forms and presses buttons - on someone else's site that is not QA, it is
 * interference. So Owly asks for what Google Search Console asks for: put a
 * token where only the site's owner could put it.
 *
 * The token is derived from the hostname with a server secret, not stored.
 * Pond tells an agent nothing about who is calling, and this needs no
 * identity: anyone may ask for a site's token, but only whoever controls the
 * site can publish it. Three places count, any one is enough:
 *
 *   https://site/.well-known/owly-verification.txt   containing the token
 *   <meta name="owly-verification" content="TOKEN">  on the home page
 *   DNS TXT record                                    owly-verification=TOKEN
 */

import { createHmac } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { checkUrl } from "./urlGuard.js";

export interface OwnershipResult {
  verified: boolean;
  token: string;
  /** Which method succeeded, or what was checked and not found. */
  method: "file" | "meta" | "dns" | null;
  checked: string[];
}

function secret(): string {
  const s = process.env.OWLY_SECRET ?? "";
  if (s) return s;
  if ((process.env.OWLY_ENV ?? process.env.NODE_ENV) === "production" || process.env.VERCEL) {
    // A default secret would make every site's token public knowledge.
    throw new Error("OWLY_SECRET is not set; refusing to issue verification tokens.");
  }
  return "owly-development-secret";
}

export function tokenFor(hostname: string): string {
  const mac = createHmac("sha256", secret()).update(hostname.toLowerCase().replace(/^www\./, "")).digest("hex");
  return `owly-${mac.slice(0, 24)}`;
}

/** Fetch a small text resource from the site, through the URL guard, no cross-host redirects. */
async function fetchSmall(url: string, allowPrivate: boolean, maxBytes: number): Promise<string | null> {
  const verdict = await checkUrl(url, { allowPrivate });
  if (!verdict.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "OwlyQA-verify/0.1" } });
    if (res.status < 200 || res.status >= 300) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    let text = "";
    const decoder = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface OwnershipOptions {
  allowPrivate?: boolean;
  /** Injectable for tests. */
  txt?: (host: string) => Promise<string[][]>;
}

export async function checkOwnership(siteUrl: string, opts: OwnershipOptions = {}): Promise<OwnershipResult> {
  const url = new URL(siteUrl);
  const token = tokenFor(url.hostname);
  const allowPrivate = opts.allowPrivate ?? false;
  const checked: string[] = [];

  const fileUrl = `${url.origin}/.well-known/owly-verification.txt`;
  checked.push(fileUrl);
  const file = await fetchSmall(fileUrl, allowPrivate, 4_096);
  if (file && file.includes(token)) return { verified: true, token, method: "file", checked };

  checked.push(`${url.origin}/ (meta tag)`);
  const home = await fetchSmall(`${url.origin}/`, allowPrivate, 512_000);
  if (home) {
    const metas = home.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metas) {
      if (/name\s*=\s*["']owly-verification["']/i.test(tag) && tag.includes(token)) {
        return { verified: true, token, method: "meta", checked };
      }
    }
  }

  const host = url.hostname.replace(/^www\./, "");
  checked.push(`DNS TXT ${host}`);
  try {
    const records = await (opts.txt ?? resolveTxt)(host);
    if (records.some((parts) => parts.join("").trim() === `owly-verification=${token}`)) {
      return { verified: true, token, method: "dns", checked };
    }
  } catch {
    /* no TXT records is an ordinary answer */
  }

  return { verified: false, token, method: null, checked };
}

export function instructions(siteUrl: string): string {
  const url = new URL(siteUrl);
  const token = tokenFor(url.hostname);
  return [
    `To let Owly run a full test of ${url.hostname}, put this token on the site. Any one of these works:`,
    "",
    `1. A file at ${url.origin}/.well-known/owly-verification.txt containing:`,
    `   ${token}`,
    `2. A tag in the <head> of your home page:`,
    `   <meta name="owly-verification" content="${token}">`,
    `3. A DNS TXT record on ${url.hostname.replace(/^www\./, "")}:`,
    `   owly-verification=${token}`,
    "",
    "Until then Owly can still run a passive scan: it looks at pages, layout and accessibility, but will not press buttons or submit forms.",
  ].join("\n");
}
