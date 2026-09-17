/**
 * Where the browser is allowed to go.
 *
 * The site under test is untrusted (spec §25). It can link, redirect, or run
 * script that points the browser anywhere - including at the network Owly
 * itself runs on. So every request is checked here, not just the ones Owly
 * chose to make, and the check is on the resolved address, not the hostname:
 * `internal.example.com` can resolve to 10.0.0.5 as easily as a literal IP can.
 *
 * What this does NOT fully close, stated rather than hidden: Chromium resolves
 * DNS itself, so a subresource host could resolve differently between our check
 * and its fetch (DNS rebinding). The target origin is pinned with
 * `--host-resolver-rules` to the address we validated (see `pinArgs`), which
 * closes it for the site being tested. Third-party subresources keep a narrow
 * window; on Vercel the function has no VPC access and no metadata endpoint,
 * which is what bounds the impact.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Verdict =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

export interface GuardOptions {
  /** Lab and tests only. Refused in production by config. */
  allowPrivate: boolean;
  /** Injectable for tests; defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
}

async function systemResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** IPv4 ranges a tested site must never be able to reach. */
const BLOCKED_V4: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private network"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private network"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation range"],
  ["192.168.0.0", 16, "private network"],
  ["198.18.0.0", 15, "benchmark network"],
  ["198.51.100.0", 24, "documentation range"],
  ["203.0.113.0", 24, "documentation range"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Why an address is off limits, or null if it is a public address. */
export function blockedReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    for (const [base, bits, why] of BLOCKED_V4) {
      if (inV4Range(address, base, bits)) return why;
    }
    return null;
  }
  if (family === 6) {
    const a = address.toLowerCase();
    // An IPv4 address wearing IPv6 clothes is judged as the IPv4 it is.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return blockedReason(mapped[1]);
    if (a === "::" ) return "unspecified";
    if (a === "::1") return "loopback";
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return "unique local (private network)";
    if (/^fe[89ab][0-9a-f]:/.test(a)) return "link-local";
    if (/^ff[0-9a-f]{2}:/.test(a)) return "multicast";
    return null;
  }
  return "not an IP address";
}

/**
 * Decide whether a URL may be loaded at all.
 *
 * `new URL` does useful normalisation here: `http://2130706433/`,
 * `http://0x7f.1/` and `http://127.1/` all come back with hostname
 * `127.0.0.1`, so the numeric tricks are caught by the same address check.
 */
export async function checkUrl(raw: string, opts: GuardOptions): Promise<Verdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed` };
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs, reports and screenshots.
    return { ok: false, reason: "URLs carrying credentials are not accepted" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "no host" };

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolve)(host);
    } catch {
      return { ok: false, reason: `could not resolve ${host}` };
    }
    if (addresses.length === 0) return { ok: false, reason: `${host} has no addresses` };
  }

  if (!opts.allowPrivate) {
    // Every address, not the first: a host that resolves to one public and one
    // private address is how rebinding hides.
    for (const address of addresses) {
      const why = blockedReason(address);
      if (why) return { ok: false, reason: `${host} resolves to ${address} (${why})` };
    }
  }

  return { ok: true, url, addresses };
}

/** Same origin, compared the way browsers compare it. */
export function sameOrigin(a: URL | string, b: URL | string): boolean {
  const x = typeof a === "string" ? new URL(a) : a;
  const y = typeof b === "string" ? new URL(b) : b;
  return x.origin === y.origin;
}

/**
 * Chromium flags that pin the target host to the address we validated, so the
 * browser cannot be handed a different one later for the site under test.
 */
export function pinArgs(url: URL, address: string): string[] {
  const target = isIP(address) === 6 ? `[${address}]` : address;
  return [`--host-resolver-rules=MAP ${url.hostname} ${target}`];
}
