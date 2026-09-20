/**
 * The security half of using a product properly.
 *
 * Owly is not a penetration tester and must never behave like one: nothing
 * here sends a payload, guesses a password, or asks a server for anything a
 * browser would not ask for on its own. Every check is either reading what the
 * server already said, or doing something any ordinary user could do - signing
 * out, or opening a page while not signed in.
 *
 * That last one is the valuable one. Owly signs up as its own synthetic user,
 * so it knows exactly which pages are supposed to need an account. Asking for
 * those pages again in a browser with no session is the check a real tester
 * makes and a scanner cannot: it needs to know what "signed in" means here.
 */

import type { Evidence } from "../findings.js";
import type { NetRecord, Session } from "../browser/session.js";
import { unitKey, type Candidate } from "./candidate.js";

export interface SecurityResult {
  candidates: Candidate[];
  notes: string[];
}

export interface AccessResult extends SecurityResult {
  /**
   * The pages that answered a session-less browser correctly, by refusing or
   * sending it to sign in. These are the pages now *known* to be private, as
   * opposed to merely seen while signed in - so they are the right thing to
   * re-open after signing out.
   */
  confirmed: string[];
}

function path(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * What the server said about itself, read from the headers of the pages Owly
 * already loaded. Reported once for the site, not once per page.
 */
export function headerChecks(pages: NetRecord[], target: string, persona: Session["opts"]["persona"]["key"]): SecurityResult {
  const out: SecurityResult = { candidates: [], notes: [] };
  const documents = pages.filter((r) => r.headers && r.status !== null && r.status < 400);
  if (documents.length === 0) return out;

  const https = new URL(target).protocol === "https:";
  const unit = unitKey(persona, "security", target);
  const has = (name: string) => documents.filter((r) => r.headers?.[name.toLowerCase()]).length;

  const missing: string[] = [];
  if (!has("content-security-policy")) missing.push("Content-Security-Policy");
  if (!has("x-content-type-options")) missing.push("X-Content-Type-Options");
  if (https && !has("strict-transport-security")) missing.push("Strict-Transport-Security");
  // X-Frame-Options or a CSP frame-ancestors both answer the clickjacking
  // question; only complain when neither is anywhere.
  const framed = documents.some(
    (r) => r.headers?.["x-frame-options"] || /frame-ancestors/i.test(r.headers?.["content-security-policy"] ?? ""),
  );
  if (!framed) missing.push("X-Frame-Options (or CSP frame-ancestors)");

  if (missing.length) {
    out.candidates.push({
      kind: "security_headers",
      title: `The site does not send ${missing.length} security header${missing.length === 1 ? "" : "s"}`,
      severity: "low",
      url: target,
      persona,
      summary: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} absent from every page Owly opened.`,
      expected: "Pages carry the headers that tell a browser how to protect the people using them.",
      actual: `Missing: ${missing.join(", ")}.`,
      steps: [`Open ${target}`, "Read the response headers"],
      evidence: documents.slice(0, 2).map(
        (r): Evidence => ({ type: "network", method: r.method, url: r.url, status: r.status }),
      ),
      observed: [
        `${documents.length} page${documents.length === 1 ? "" : "s"} checked`,
        ...missing.map((m) => `no ${m}`),
      ],
      inference: [
        "These do not mean the site is under attack; they are the cheap protections a browser can apply if asked, and nothing is asking.",
      ],
      deterministic: true,
      fingerprint: `security_headers|${missing.join(",")}`,
      unit,
    });
  }
  return out;
}

/** Session cookies that any script can read, or that travel unencrypted. */
export async function cookieChecks(s: Session, target: string): Promise<SecurityResult> {
  const out: SecurityResult = { candidates: [], notes: [] };
  const state = await s.session();
  if (!state) return out;
  const https = new URL(target).protocol === "https:";
  const unit = unitKey(s.opts.persona.key, "security", target);

  // A cookie set after signing in, holding something opaque and long, is the
  // session. Short preference cookies are not worth a finding.
  const sessionish = state.cookies.filter((c) => c.value.length >= 12 && !/^(locale|lang|theme|tz|consent)/i.test(c.name));
  const bad = sessionish.filter((c) => !c.httpOnly || (https && !c.secure));
  if (!bad.length) return out;

  const faults = bad.map(
    (c) => `${c.name}: ${[!c.httpOnly ? "readable by scripts (no HttpOnly)" : "", https && !c.secure ? "sent over plain HTTP (no Secure)" : ""].filter(Boolean).join(", ")}`,
  );
  out.candidates.push({
    kind: "weak_session_cookie",
    title: `The session cookie is not protected`,
    severity: "high",
    url: target,
    persona: s.opts.persona.key,
    summary: `After signing in, ${faults.join("; ")}.`,
    expected: "A cookie that keeps someone signed in is HttpOnly, and Secure on an https site.",
    actual: faults.join("; "),
    steps: [`Open ${target}`, "Sign in", "Look at the cookies the site set"],
    evidence: [{ type: "dom", selector: "document.cookie", snippet: bad.map((c) => `${c.name} (HttpOnly: ${c.httpOnly}, Secure: ${c.secure})`).join("\n") }],
    observed: faults,
    inference: ["A script on the page - yours or someone else's - can take a cookie that is not HttpOnly and be that user."],
    deterministic: true,
    fingerprint: `weak_session_cookie|${bad.map((c) => c.name).sort().join(",")}`,
    unit,
  });
  return out;
}

/**
 * The pages Owly could only reach after signing up, asked for again with no
 * session at all. Anything that answers with the same private page is not
 * behind a login at all.
 */
export async function accessChecks(
  signedOut: Session,
  target: string,
  privatePages: string[],
  identity: string[],
): Promise<AccessResult> {
  const out: AccessResult = { candidates: [], notes: [], confirmed: [] };
  const unit = unitKey(signedOut.opts.persona.key, "security", target);
  const exposed: Array<{ url: string; status: number; sample: string; marker: string }> = [];

  for (const url of privatePages.slice(0, 6)) {
    const status = await signedOut.goto(url);
    if (status === null) continue;
    // Anything that refuses - 401, 403, even 404 - is refusing correctly.
    if (status >= 400) {
      out.confirmed.push(url);
      continue;
    }
    const landed = signedOut.page.url();
    // A redirect to a sign-in page is the correct answer.
    if (!landed.startsWith(new URL(url).origin) || /log ?in|sign ?in|auth/i.test(new URL(landed).pathname)) {
      out.confirmed.push(url);
      continue;
    }
    const text = await signedOut.eval<string>(`document.body ? document.body.innerText.slice(0, 2000) : ""`).catch(() => "");
    if (/you (are|have been) signed out|please (sign|log) ?in|not authori[sz]ed|forbidden/i.test(text)) {
      out.confirmed.push(url);
      continue;
    }
    // The page loaded. That on its own proves nothing: the crawl's idea of
    // "behind the login" is just "seen while signed in", and a home page seen
    // while signed in is still a home page. It is only an exposure if the page
    // is showing THIS account - Owly's own email or name, printed to a browser
    // that has never signed in.
    const marker = identity.find((value) => text.includes(value));
    if (!marker) continue;
    exposed.push({ url, status, marker, sample: text.replace(/\s+/g, " ").slice(0, 160) });
  }

  if (exposed.length) {
    out.candidates.push({
      kind: "unprotected_page",
      title: `${exposed.length} page${exposed.length === 1 ? "" : "s"} behind the login open without one`,
      severity: "critical",
      url: exposed[0]!.url,
      persona: signedOut.opts.persona.key,
      summary: `Owly reached ${exposed.map((e) => path(e.url)).join(", ")} in a browser that had never signed in, and the page came back showing the account's own details.`,
      expected: "A page that needs an account sends anyone else to sign in.",
      actual: exposed.map((e) => `${path(e.url)} answered ${e.status} and showed "${e.marker}"`).join("; "),
      steps: [
        "Sign up and note a page only an account can reach",
        "Open the same address in a browser with no session",
      ],
      evidence: exposed.slice(0, 3).map((e): Evidence => ({ type: "dom", selector: path(e.url), snippet: e.sample })),
      observed: exposed.map((e) => `${path(e.url)} -> ${e.status} without any session, showing "${e.marker}"`),
      inference: [
        "Anyone with the address can read what is on these pages.",
        `The proof is the account's own detail ("${exposed[0]!.marker}") appearing in a browser that never signed in.`,
      ],
      deterministic: true,
      fingerprint: `unprotected_page|${exposed.map((e) => new URL(e.url).pathname).sort().join(",")}`,
      unit,
    });
  }
  return out;
}

/**
 * Sign out, then go back in. If the session still works, signing out did
 * nothing - which is the bug a shared computer turns into an incident.
 *
 * Runs last in a run, because afterwards the session is meant to be dead.
 */
export async function signOutCheck(
  s: Session,
  target: string,
  signOutUrl: string,
  privatePage: string,
  identity: string[],
): Promise<SecurityResult> {
  const out: SecurityResult = { candidates: [], notes: [] };
  const unit = unitKey(s.opts.persona.key, "security", target);

  const left = await s.goto(signOutUrl);
  if (left === null) {
    out.notes.push(`Could not open ${path(signOutUrl)}, so signing out was not tested.`);
    return out;
  }

  const status = await s.goto(privatePage);
  if (status === null || status >= 400) return out;
  const landed = s.page.url();
  if (/log ?in|sign ?in|auth/i.test(new URL(landed).pathname)) return out;
  const text = await s.eval<string>(`document.body ? document.body.innerText.slice(0, 2000) : ""`).catch(() => "");
  // Same rule as the access check: the page loading is not the finding. The
  // finding is the page still knowing who Owly is after it signed out.
  const marker = identity.find((value) => text.includes(value));
  if (!marker) {
    out.notes.push(
      `After signing out, ${path(privatePage)} still answered ${status}, but showed nothing belonging to the account, so Owly did not treat it as still signed in.`,
    );
    return out;
  }

  out.candidates.push({
    kind: "signout_ineffective",
    title: "Signing out does not sign you out",
    severity: "high",
    url: privatePage,
    persona: s.opts.persona.key,
    summary: `After following "${path(signOutUrl)}", the same browser still opened ${path(privatePage)} as the signed-in user, showing "${marker}".`,
    expected: "Signing out ends the session: the next request has to sign in again.",
    actual: `${path(privatePage)} answered ${status} and still showed the account's own details ("${marker}").`,
    steps: ["Sign in", `Follow ${path(signOutUrl)}`, `Open ${path(privatePage)} again`],
    evidence: [{ type: "dom", selector: path(privatePage), snippet: text.replace(/\s+/g, " ").slice(0, 200) }],
    observed: [`signed out via ${path(signOutUrl)}`, `${path(privatePage)} -> ${status}, still showing "${marker}"`],
    inference: ["On a shared or borrowed computer, the next person is still logged in as them."],
    deterministic: true,
    fingerprint: `signout_ineffective|${new URL(signOutUrl).pathname}`,
    unit,
  });
  return out;
}
