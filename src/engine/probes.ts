/**
 * The units of work. Each opens a page fresh, does one kind of thing a user
 * would do, and reports candidates from what the browser recorded.
 *
 * A unit is deliberately self-contained - fresh navigation in, candidates out -
 * because verification works by running the same unit again in a new browser
 * context and checking the same fingerprints come back. Anything a unit relied
 * on from a previous unit would make that replay dishonest.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Evidence, Severity } from "../findings.js";
import { assess } from "../policy/actionGuard.js";
import { sameSite } from "../policy/urlGuard.js";
import * as js from "../browser/inpage.js";
import type { NetRecord, Session } from "../browser/session.js";
import { unitKey, type Candidate } from "./candidate.js";
import { INVALID_EMAIL, isEmailField, nonce, valueFor, type FieldInfo, type FillValue } from "./synthetic.js";

/** A page Owly learned about while running a unit. */
export interface Discovery {
  url: string;
  from: string;
  via: string;
}

export interface UnitResult {
  candidates: Candidate[];
  discovered: Discovery[];
  notes: string[];
  /** Same-origin links the guard refused to follow, with the words on them. */
  refusedLinks: Array<{ url: string; via: string }>;
}

const SLOW_MS = 5_000;

// How long units that only read the rendered page wait for the network to calm
// down. The load unit waits longer, because timing slow requests is its job.
const READ_PATIENCE_MS = 1_500;

export function path(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Collapses ids in paths so /api/notes/41 and /api/notes/42 are one problem. */
function pathPattern(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id");
  } catch {
    return url;
  }
}

function netEvidence(r: NetRecord): Evidence {
  return {
    type: "network",
    method: r.method,
    url: r.url,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
  };
}

/** The line of source an exception points at, when Owly has that source. */
function sourceLine(s: Session, stack: string): string | null {
  const m = stack.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
  if (!m || !m[1] || !m[2]) return null;
  const body = s.sources.get(m[1]);
  if (!body) return null;
  const line = body.split("\n")[Number(m[2]) - 1];
  return line ? line.trim().slice(0, 200) : null;
}

/**
 * Problems visible without touching anything: exceptions, console errors,
 * failing and slow requests. Shared by `load` and by `buttons`, which run it
 * over the window after a click.
 */
function passiveCandidates(
  s: Session,
  events: ReturnType<Session["since"]>,
  page: string,
  unit: string,
  steps: string[],
  cause?: string,
): Candidate[] {
  const out: Candidate[] = [];
  const persona = s.opts.persona.key;
  const target = s.opts.target;
  const who = cause ? ` after pressing "${cause}"` : " while loading";

  for (const e of events.errors) {
    const line = sourceLine(s, e.stack);
    const evidence: Evidence[] = [{ type: "console", level: "exception", text: `${e.message}\n${e.stack}`.slice(0, 1500), at: new Date(e.at).toISOString() }];
    if (line) evidence.push({ type: "dom", selector: "source", snippet: line });
    out.push({
      kind: "js_exception",
      title: `JavaScript error${who} ${path(page)}`,
      severity: "medium",
      url: page,
      ...(cause ? { target: cause } : {}),
      persona,
      summary: `An uncaught exception was thrown: ${e.message}${line ? ` (at: ${line})` : ""}`,
      expected: "The page runs without uncaught errors.",
      actual: e.message,
      steps,
      evidence,
      observed: [`Uncaught exception: ${e.message}`, ...(line ? [`Source line: ${line}`] : [])],
      inference: ["Code after the failing statement in the same script did not run; any behaviour it was meant to set up may be missing."],
      deterministic: true,
      fingerprint: `js_exception|${e.message}`,
      unit,
    });
  }

  for (const c of events.console) {
    if (c.level !== "error") continue;
    // Chromium logs every failed resource load as a console error. Those are
    // reported from the network record instead, with the status attached.
    if (/^Failed to load resource/i.test(c.text)) continue;
    if (/ERR_BLOCKED_BY_CLIENT/i.test(c.text)) continue;
    out.push({
      kind: "console_error",
      title: `Console error${who} ${path(page)}`,
      severity: "low",
      url: page,
      ...(cause ? { target: cause } : {}),
      persona,
      summary: `The page logged an error: ${c.text.slice(0, 200)}`,
      expected: "No errors are logged during normal use.",
      actual: c.text.slice(0, 300),
      steps,
      evidence: [{ type: "console", level: c.level, text: c.text.slice(0, 1500), at: new Date(c.at).toISOString() }],
      observed: [`console.error: ${c.text.slice(0, 300)}`, ...(c.location ? [`Logged from ${c.location}`] : [])],
      inference: [],
      deterministic: true,
      fingerprint: `console_error|${c.text.slice(0, 200)}`,
      unit,
    });
  }

  for (const r of events.net) {
    if (r.blockedByOwly) continue;
    if (!sameSite(r.url, target)) continue;
    // The page's own document is judged by the crawler as a link, not here.
    if (r.isNavigation && r.resourceType === "document") continue;

    const staticType = ["script", "stylesheet", "font"].includes(r.resourceType);
    const serverError = r.status !== null && r.status >= 500;
    const missingAsset = staticType && r.status !== null && r.status >= 400;
    const networkFailure = r.status === null && r.error !== null;

    if (serverError || missingAsset || networkFailure) {
      // An API answering 4xx is often the app working as designed ("no such
      // user"); the control app relies on exactly that. Only 5xx, broken
      // assets, and requests that never completed are treated as failures.
      const label = r.status !== null ? `HTTP ${r.status}` : r.error ?? "failed";
      out.push({
        kind: "http_error",
        title: `${r.method} ${pathPattern(r.url)} failed (${label})${who} ${path(page)}`,
        severity: serverError || networkFailure ? "high" : "medium",
        url: page,
        target: `${r.method} ${pathPattern(r.url)}`,
        persona,
        summary: `A request the page depends on failed: ${r.method} ${path(r.url)} -> ${label}.`,
        expected: "Requests made by the page succeed.",
        actual: `${r.method} ${path(r.url)} returned ${label}.`,
        steps,
        evidence: [netEvidence(r)],
        observed: [`${r.method} ${r.url} -> ${label}`],
        inference: serverError ? ["The server failed while handling the request; whatever depends on it did not work for this user."] : [],
        deterministic: true,
        fingerprint: `http_error|${r.method}|${pathPattern(r.url)}|${r.status ?? r.error}`,
        unit,
      });
    }

    const interactive = ["fetch", "xhr", "document"].includes(r.resourceType);
    if (interactive && r.durationMs !== null && r.durationMs > SLOW_MS && r.status !== null && r.status < 400) {
      out.push({
        kind: "slow_response",
        title: `${r.method} ${pathPattern(r.url)} took ${(r.durationMs / 1000).toFixed(1)}s on ${path(page)}`,
        severity: "medium",
        url: page,
        target: `${r.method} ${pathPattern(r.url)}`,
        persona,
        summary: `${r.method} ${path(r.url)} took ${(r.durationMs / 1000).toFixed(1)} seconds to respond.`,
        expected: `Responses the page waits on arrive within ${SLOW_MS / 1000} seconds.`,
        actual: `${(r.durationMs / 1000).toFixed(1)} seconds.`,
        steps,
        evidence: [netEvidence(r), { type: "measurement", name: "response time", value: r.durationMs, unit: "ms", threshold: SLOW_MS }],
        observed: [`${r.method} ${r.url} completed in ${r.durationMs}ms`],
        inference: ["Content that waits on this response stays in its loading state for that long."],
        deterministic: true,
        fingerprint: `slow_response|${r.method}|${pathPattern(r.url)}`,
        unit,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export type LoadResult = UnitResult & {
  /** The words the product uses about itself, for the understanding pass. */
  labels: string[];
  status: number | null;
  finalUrl: string;
  leftTheSite: string | null;
  notHtml: string | null;
  /** Nothing answered at all. A run of these must not read like a clean bill of health. */
  unreachable: string | null;
};

/** Load a page, report what it does on its own, and learn its links. */
export async function loadUnit(
  s: Session,
  url: string,
): Promise<LoadResult> {
  const unit = unitKey(s.opts.persona.key, "load", url);
  const mark = s.mark();
  const status = await s.goto(url);
  const finalUrl = s.page.url();
  const steps = [`Open ${url}`, "Wait for the page to finish loading"];
  const result: LoadResult = {
    candidates: [],
    discovered: [],
    notes: [],
    refusedLinks: [],
    labels: [],
    status,
    finalUrl,
    leftTheSite: null,
    notHtml: null,
    unreachable: null,
  };

  // A URL that redirects off the site - /slack/install, /login/google, an
  // affiliate link - is refused by the guard, which leaves the browser on
  // whatever it was showing before. Analysing that would describe a page the
  // site never served: it once produced "dead end: no links, buttons or
  // forms" for a redirect that works perfectly.
  // "Left the site" means the browser ENDED UP somewhere else - not merely that
  // the page tried. A page that redirects itself off-site is refused with a 204
  // and stays put, and that page is still worth testing: treating the attempt
  // as leaving cost the injection-trap app every page but its first.
  // Nothing answered. The browser is still on about:blank, whose origin is the
  // string "null", so the off-site check below would have announced that the
  // page "leads off the site (to null)" and let the run finish looking clean.
  // A test that could not load the site has to say so.
  const blank = !finalUrl || finalUrl === "about:blank" || finalUrl === "chrome-error://chromewebdata/";
  if (status === null && blank) {
    const why = s.lastNavigationError ? ` (${s.lastNavigationError})` : "";
    result.unreachable = `${path(url)} did not respond${why}.`;
    result.notes.push(`${path(url)} did not respond${why}, so there was nothing to test.`);
    return result;
  }

  const refused = s.since(mark).blocked.find((b) => !sameSite(b.url, s.opts.target));
  const landedOnRequest = (() => {
    try {
      return new URL(finalUrl).href.replace(/\/$/, "") === new URL(url).href.replace(/\/$/, "");
    } catch {
      return false;
    }
  })();
  const landedOffSite = !finalUrl || !sameSite(finalUrl, s.opts.target);
  if (landedOffSite || (refused && !landedOnRequest)) {
    result.leftTheSite = (landedOffSite ? finalUrl : refused?.url) || refused?.url || finalUrl;
    result.notes.push(`${path(url)} leads off the site (to ${new URL(result.leftTheSite).origin}), so Owly stopped there.`);
    return result;
  }

  // An API endpoint is not a page. Chromium renders JSON inside a generated
  // HTML document with no <title> and no lang, and judging that document
  // produced three confident findings about a perfectly good /healthz.
  const contentType = s.lastContentType ?? "";
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    result.notHtml = contentType.split(";")[0]!.trim();
    result.notes.push(`${path(url)} is ${result.notHtml}, not a web page, so Owly did not test it.`);
    return result;
  }

  if (status !== null && status >= 400) return result;

  result.labels = await s.eval<string[]>(js.READ_LABELS).catch(() => []);

  result.candidates.push(...passiveCandidates(s, s.since(mark), url, unit, steps));

  const images = await s.eval<Array<{ src: string; alt: string }>>(js.FIND_BROKEN_IMAGES).catch(() => []);
  for (const img of images) {
    result.candidates.push({
      kind: "broken_image",
      title: `Image failed to load on ${path(url)}`,
      severity: "low",
      url,
      target: img.src,
      persona: s.opts.persona.key,
      summary: `The image ${path(img.src)}${img.alt ? ` ("${img.alt}")` : ""} did not load.`,
      expected: "Images on the page load.",
      actual: "The browser shows a broken image.",
      steps,
      evidence: [{ type: "dom", selector: "img", snippet: `src=${img.src} alt=${img.alt}` }],
      observed: [`img ${img.src} finished loading with no image data`],
      inference: [],
      deterministic: true,
      fingerprint: `broken_image|${pathPattern(img.src)}`,
      unit,
    });
  }

  const ways = await s.eval<{ ways: number; heading: string }>(js.COUNT_WAYS_ON).catch(() => ({ ways: 1, heading: "" }));
  if (ways.ways === 0) {
    result.candidates.push({
      kind: "dead_end",
      // The path without its query: the query here is often the test data
      // Owly just submitted, which says nothing to a reader.
      title: `Dead end: ${new URL(url).pathname} offers no way to continue`,
      severity: "medium",
      url,
      target: ways.heading || path(url),
      persona: s.opts.persona.key,
      summary: `"${ways.heading || path(url)}" has no links, buttons or forms. A user who reaches it can only leave with the browser's back button.`,
      expected: "Every page offers a next step or a way back.",
      actual: "No links, buttons or forms are present.",
      steps,
      evidence: [{ type: "measurement", name: "interactive elements", value: 0, unit: "count" }],
      observed: ["0 visible links, buttons or forms on the page"],
      inference: ["Users in the middle of a flow are likely to stop here."],
      deterministic: false,
      fingerprint: `dead_end|${new URL(url).pathname}`,
      unit,
    });
  }

  const links = await s.eval<Array<{ url: string; text: string }>>(js.LIST_LINKS).catch(() => []);
  for (const link of links) {
    let clean: string;
    try {
      const u = new URL(link.url);
      u.hash = "";
      clean = u.href;
    } catch {
      continue;
    }
    if (!sameSite(clean, s.opts.target)) continue;
    if (assess({ name: link.text, role: "link", target: clean }).risk === "destructive") {
      result.notes.push(`Not following "${link.text}" (${path(clean)}): it looks like it acts on visit.`);
      // Refused, but remembered: signing out is the one of these Owly needs to
      // know about, and it is tested deliberately at the end rather than
      // stumbled into in the middle of a crawl.
      result.refusedLinks.push({ url: clean, via: link.text });
      continue;
    }
    result.discovered.push({ url: clean, from: url, via: link.text });
  }
  return result;
}

// ---------------------------------------------------------------------------

let axeSource: string | null = null;
function axe(): string {
  if (axeSource === null) {
    const require = createRequire(import.meta.url);
    axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  }
  return axeSource;
}

const IMPACT: Record<string, Severity> = { critical: "high", serious: "medium", moderate: "low", minor: "info" };

/** An automated accessibility scan. Limited by nature, and labelled so. */
export async function a11yUnit(s: Session, url: string): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "a11y", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url, READ_PATIENCE_MS);
  if (status !== null && status >= 400) return result;

  // Evaluated, not added as a <script> tag. A tag is subject to the page's
  // Content-Security-Policy, so on any site with a real CSP - which is to say
  // most sites worth testing - injecting axe threw and the accessibility scan
  // silently did nothing. Evaluation goes through the debugger protocol, which
  // CSP does not govern, so the scan works on a well-secured site too.
  if (!(await s.eval<boolean>(`typeof axe !== "undefined"`).catch(() => false))) {
    await s.page.evaluate(axe());
  }
  // WCAG A and AA rules only. axe's "best practice" rules are advice, not
  // failures, and reporting them as defects is how accessibility tools earn a
  // reputation for noise.
  const violations = await s.eval<Array<{ id: string; impact: string; help: string; helpUrl: string; nodes: Array<{ target: string[]; failureSummary: string; html: string }> }>>(
    `axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] }).then(function (r) { return r.violations.map(function (v) { return { id: v.id, impact: v.impact || "moderate", help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.slice(0, 5).map(function (n) { return { target: n.target, failureSummary: n.failureSummary || "", html: (n.html || "").slice(0, 200) }; }) }; }); })`,
  );

  for (const v of violations) {
    const nodes = v.nodes.map((n) => n.target.join(" "));
    result.candidates.push({
      kind: "a11y_violation",
      title: `Accessibility: ${v.help}`,
      severity: IMPACT[v.impact] ?? "low",
      url,
      target: v.id,
      persona: s.opts.persona.key,
      summary: `Automated check "${v.id}" failed on ${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}: ${v.help}.`,
      expected: "The page passes this WCAG 2.1 A/AA rule.",
      actual: v.nodes[0]?.failureSummary.split("\n").slice(0, 3).join(" ") ?? v.help,
      steps: [`Open ${url}`, `Run the automated accessibility check (axe-core, rule ${v.id})`],
      evidence: [{ type: "a11y", rule: v.id, impact: v.impact, help: `${v.help} (${v.helpUrl})`, nodes }],
      observed: v.nodes.map((n) => `${n.target.join(" ")}: ${n.html}`),
      inference: [],
      deterministic: true,
      fingerprint: `a11y|${v.id}`,
      unit,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------

/** Layout at this persona's viewport: overflow, clipping, overlaps, covered controls. */
export async function layoutUnit(s: Session, url: string): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "layout", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url, READ_PATIENCE_MS);
  if (status !== null && status >= 400) return result;

  const persona = s.opts.persona;
  const vw = persona.viewport.width;
  const steps = [`Open ${url} at ${vw}x${persona.viewport.height}${persona.isMobile ? " as a phone" : ""}`];
  const where = `${path(url)} at ${vw}px`;

  if (persona.isMobile) {
    const o = await s.eval<{ excess: number; viewportWidth: number; culprits: Array<{ describe: string; right: number; width: number }> }>(js.MEASURE_OVERFLOW);
    if (o.excess > 8) {
      const names = o.culprits.map((c) => c.describe).join(", ");
      result.candidates.push({
        kind: "mobile_overflow",
        title: `Page scrolls sideways on phones: ${where}`,
        severity: "medium",
        url,
        target: names || "page",
        persona: persona.key,
        viewport: persona.viewport,
        summary: `The page is ${o.excess}px wider than a ${vw}px screen, so it scrolls horizontally${names ? `. Widest element: ${o.culprits[0]?.describe} (${o.culprits[0]?.width}px)` : ""}.`,
        expected: `Content fits within ${vw}px.`,
        actual: `Content extends ${o.excess}px past the right edge.`,
        steps,
        evidence: [
          { type: "measurement", name: "horizontal overflow", value: o.excess, unit: "px", threshold: 8 },
          ...o.culprits.map((c): Evidence => ({ type: "dom", selector: c.describe, snippet: `right edge at ${c.right}px, width ${c.width}px` })),
        ],
        observed: [`document scroll width exceeds viewport by ${o.excess}px`, ...o.culprits.map((c) => `${c.describe} reaches x=${c.right}px`)],
        inference: ["Phone users have to scroll sideways, and may not realise content is off-screen."],
        deterministic: true,
        fingerprint: `mobile_overflow|${new URL(url).pathname}`,
        unit,
      });
    }
  }

  const clipped = await s.eval<Array<{ describe: string; text: string; shownPx: number; neededPx: number; axis: string }>>(js.FIND_CLIPPED);
  for (const c of clipped) {
    result.candidates.push({
      kind: "clipped_text",
      title: `Text is cut off on ${where}`,
      severity: "low",
      url,
      target: `${c.describe}: "${c.text.slice(0, 60)}"`,
      persona: persona.key,
      viewport: persona.viewport,
      summary: `${c.describe} shows ${c.shownPx}px of text that needs ${c.neededPx}px; the rest is hidden.`,
      expected: "All of the text is readable.",
      actual: `The ${c.axis} overflow is hidden, cutting off the end of "${c.text.slice(0, 80)}".`,
      steps,
      evidence: [{ type: "dom", selector: c.describe, snippet: c.text }, { type: "measurement", name: "hidden text", value: c.neededPx - c.shownPx, unit: "px" }],
      observed: [`${c.describe}: ${c.axis} content ${c.neededPx}px in a ${c.shownPx}px box with overflow hidden`],
      inference: [],
      deterministic: true,
      fingerprint: `clipped_text|${new URL(url).pathname}|${c.describe}`,
      unit,
    });
  }

  const overlaps = await s.eval<Array<{ first: string; second: string; share: number }>>(js.FIND_OVERLAPS);
  for (const o of overlaps) {
    result.candidates.push({
      kind: "overlapping_controls",
      title: `Controls overlap on ${where}`,
      severity: "medium",
      url,
      target: `${o.first} / ${o.second}`,
      persona: persona.key,
      viewport: persona.viewport,
      summary: `"${o.first}" and "${o.second}" are drawn on top of each other (${o.share}% of the smaller one is covered).`,
      expected: "Controls do not overlap.",
      actual: `${o.share}% overlap.`,
      steps,
      evidence: [{ type: "measurement", name: "overlap", value: o.share, unit: "%", threshold: 25 }],
      observed: [`bounding boxes of "${o.first}" and "${o.second}" intersect by ${o.share}%`],
      inference: ["A tap aimed at one may activate the other."],
      deterministic: true,
      fingerprint: `overlap|${new URL(url).pathname}|${persona.isMobile ? "mobile" : "desktop"}|${o.first}|${o.second}`,
      unit,
    });
  }

  const obscured = await s.eval<Array<{ control: string; coveredBy: string; coverText: string }>>(js.FIND_OBSCURED);
  const byCover = new Map<string, typeof obscured>();
  for (const o of obscured) byCover.set(o.coveredBy, [...(byCover.get(o.coveredBy) ?? []), o]);
  for (const [cover, items] of byCover) {
    const names = items.map((i) => i.control);
    const text = items[0]?.coverText ?? "";
    result.candidates.push({
      kind: "action_obscured",
      title: `${names.length === 1 ? `"${names[0]}" is` : `${names.length} controls are`} covered by another element on ${where}`,
      severity: "high",
      url,
      target: names.join(", "),
      persona: persona.key,
      viewport: persona.viewport,
      summary: `${cover}${text ? ` ("${text.slice(0, 60)}")` : ""} sits on top of ${names.map((n) => `"${n}"`).join(", ")}. A tap at the centre of each lands on ${cover} instead.`,
      expected: "Every visible control can be pressed.",
      actual: `The element hit at the control's centre is ${cover}.`,
      steps: [...steps, `Scroll each control into view`, `Check what a tap at its centre would hit`],
      evidence: [{ type: "dom", selector: cover, snippet: text }, ...names.map((n): Evidence => ({ type: "dom", selector: n, snippet: `covered by ${cover}` }))],
      observed: items.map((i) => `tap at centre of "${i.control}" hits ${i.coveredBy}`),
      inference: ["Users on this screen size cannot press these controls without first dismissing or scrolling past the covering element, if that is possible at all."],
      deterministic: true,
      fingerprint: `action_obscured|${new URL(url).pathname}|${persona.isMobile ? "mobile" : "desktop"}|${cover}`,
      unit,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------

/** Press each standalone button and watch what breaks. */
export async function buttonsUnit(s: Session, url: string, maxButtons = 8): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "buttons", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url, READ_PATIENCE_MS);
  if (status !== null && status >= 400) return result;

  const buttons = (await s.eval<Array<{ key: string; name: string; role: string }>>(js.LIST_LOOSE_BUTTONS)).slice(0, maxButtons);

  for (const b of buttons) {
    if (assess({ name: b.name, role: "button" }).risk === "destructive") {
      result.notes.push(`Not pressing "${b.name}" on ${path(url)}: it looks destructive.`);
      continue;
    }
    // Fresh page for each press, so one button's side effects cannot explain
    // another's failure.
    await s.goto(url, READ_PATIENCE_MS);
    await s.eval(js.LIST_LOOSE_BUTTONS);
    const mark = s.mark();
    const clicked = await s.page
      .locator(`[data-owly-btn="${b.key}"]`)
      .click({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;
    await s.settle(Math.min(s.opts.persona.patienceMs, 6_000));

    const steps = [`Open ${url}`, `Press "${b.name}"`, "Wait for the page to react"];
    result.candidates.push(...passiveCandidates(s, s.since(mark), url, unit, steps, b.name));

    const now = s.page.url();
    if (now !== url && sameSite(now, s.opts.target)) {
      result.discovered.push({ url: now, from: url, via: b.name });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

export interface FormInfo {
  index: number;
  action: string;
  method: string;
  fields: Array<FieldInfo & { key: string }>;
  submit: { name: string; role: string } | null;
}

interface Attempt {
  requests: NetRecord[];
  urlBefore: string;
  urlAfter: string;
  textChanged: boolean;
  live: string;
  invalid: number;
}

/**
 * Long enough for a slow machine. These were 2 and 3 seconds, and on a
 * two-core CI runner the very first fill after a page load exceeded it - the
 * error was swallowed, the form was submitted EMPTY, the server accepted it,
 * and Owly reported nothing at all about a signup that is broken. A silent
 * catch turned a finding into a clean bill of health.
 */
const INTERACT_MS = 10_000;

export interface FillOptions {
  /** Put this in every email field instead of a valid address. */
  emailOverride?: string;
  /**
   * Replace the value for one field. Returning undefined leaves the field to
   * the ordinary synthetic value, so a caller can change exactly one thing
   * about an otherwise normal submission and know that is what it changed.
   */
  override?: (field: FieldInfo & { key: string }) => FillValue | null | undefined;
}

export async function fillAndSubmit(
  s: Session,
  url: string,
  form: FormInfo,
  opts: FillOptions = {},
): Promise<(Attempt & { problems: string[] }) | null> {
  await s.goto(url, READ_PATIENCE_MS);
  await s.eval(js.LIST_FORMS);
  const n = nonce();
  const problems: string[] = [];
  for (const field of form.fields) {
    const chosen = opts.override?.(field);
    const value =
      chosen !== undefined
        ? chosen
        : opts.emailOverride !== undefined && isEmailField(field)
          ? { kind: "text" as const, value: opts.emailOverride }
          : valueFor(field, n);
    if (!value) continue;
    const loc = s.page.locator(`[data-owly-field="${field.key}"]`);
    try {
      if (value.kind === "select") await loc.selectOption(value.value, { timeout: INTERACT_MS });
      else if (value.kind === "check") await loc.check({ timeout: INTERACT_MS });
      else await loc.fill(value.value, { timeout: INTERACT_MS });
    } catch (err) {
      // Never silent: a field Owly could not fill changes what the submission
      // means, and the report has to be able to say so.
      problems.push(`could not fill "${field.label || field.name || field.type}": ${String(err).split("\n")[0]}`);
    }
  }

  const before = await s.eval<{ url: string; text: string; live: string; invalid: number }>(js.READ_STATE);
  const mark = s.mark();
  const clicked = await s.page
    .locator(`[data-owly-submit="${form.index}"]`)
    .click({ timeout: INTERACT_MS })
    .then(() => true)
    .catch((err: unknown) => {
      problems.push(`could not press the submit button: ${String(err).split("\n")[0]}`);
      return false;
    });
  if (!clicked) return null;
  await s.settle(Math.min(s.opts.persona.patienceMs, 8_000));
  const after = await s.eval<{ url: string; text: string; live: string; invalid: number }>(js.READ_STATE).catch(() => ({ url: s.page.url(), text: "", live: "", invalid: 0 }));

  const requests = s
    .since(mark)
    .net.filter((r) => !r.blockedByOwly && sameSite(r.url, s.opts.target) && ["fetch", "xhr", "document"].includes(r.resourceType));

  return {
    requests,
    urlBefore: before.url,
    urlAfter: after.url,
    textChanged: before.text !== after.text || before.live !== after.live,
    live: after.live,
    invalid: after.invalid,
    problems,
  };
}

const isMutation = (r: NetRecord) => r.method !== "GET" && r.method !== "HEAD";

/** Fill and submit each form the way a user would, then the way a careless one would. */
export async function formsUnit(s: Session, url: string, maxForms = 3): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "forms", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url, READ_PATIENCE_MS);
  if (status !== null && status >= 400) return result;

  const forms = (await s.eval<FormInfo[]>(js.LIST_FORMS)).slice(0, maxForms);
  const persona = s.opts.persona.key;

  for (const form of forms) {
    if (!form.submit) continue;
    if (!sameSite(form.action, s.opts.target)) {
      result.notes.push(`Not submitting a form on ${path(url)}: it sends data to another site (${form.action}).`);
      continue;
    }
    const verdict = assess({ name: form.submit.name, role: "submit", target: form.action, method: form.method });
    if (verdict.risk === "destructive") {
      result.notes.push(`Not submitting "${form.submit.name}" on ${path(url)}: ${verdict.reason}.`);
      continue;
    }
    if (form.fields.length === 0) continue;

    const submitName = form.submit.name;
    const baseSteps = [
      `Open ${url}`,
      `Fill ${form.fields.map((f) => f.label || f.name || f.type).join(", ")} with synthetic test data`,
      `Press "${submitName}"`,
    ];

    // --- valid submission, repeated when it changes data -------------------
    const first = await fillAndSubmit(s, url, form);
    if (!first) {
      result.notes.push(`Could not submit "${submitName}" on ${path(url)}, so it was not tested.`);
      continue;
    }
    if (first.problems.length) {
      // Said out loud rather than swallowed: a partly filled form means the
      // result below is about a different submission than the one intended.
      result.notes.push(`On ${path(url)}, ${first.problems.join("; ")}.`);
    }
    const attempts: Attempt[] = [first];
    // Repeat only when the first attempt SUCCEEDED, to see whether the same
    // request sometimes fails. A submission that already failed needs no
    // repeats: verification replays the whole unit anyway, and three slow
    // submissions per form is what pushed this unit past its time limit.
    const firstSucceeded = first.requests.some((r) => isMutation(r) && r.status !== null && r.status >= 200 && r.status < 400);
    if (firstSucceeded) {
      for (let i = 0; i < 2; i++) {
        const again = await fillAndSubmit(s, url, form);
        if (again) attempts.push(again);
      }
    }

    // --- the impatient double press ---------------------------------------
    // A person who is not sure the first click registered clicks again. An app
    // that takes both creates two of whatever it creates, and the second one
    // is a support ticket. Only for forms that make something, only when the
    // first submission worked, and never for signing in, where pressing twice
    // is harmless.
    if (
      firstSucceeded &&
      /\b(create|add|new|book|order|save|post|upload|submit)\b/i.test(submitName) &&
      !/\b(sign|log)\s?in\b/i.test(submitName)
    ) {
      const twice = await submitTwiceQuickly(s, url, form);
      // Two accepted requests are not two records. A signup form that takes a
      // second press has not necessarily made a second account, and saying so
      // would be a guess - it was a false positive on the control app the
      // first time this ran. The claim is only made when the thing Owly typed
      // is visibly there twice afterwards.
      if (twice && twice.accepted.length > 1 && twice.copies > 1) {
        result.candidates.push({
          kind: "duplicate_on_double_submit",
          title: `Pressing "${submitName}" twice on ${path(url)} submits it twice`,
          severity: "medium",
          url,
          target: submitName,
          persona,
          summary: `Two quick presses sent ${twice.accepted.length} identical requests, the server accepted both, and what Owly typed then appeared ${twice.copies} times.`,
          expected:
            "A second press while the first is still going is ignored - the button is disabled, or the server refuses the repeat.",
          actual: twice.accepted.map((r) => `${r.method} ${path(r.url)} -> ${r.status}`).join(", "),
          steps: [...baseSteps.slice(0, 2), `Press "${submitName}" twice, quickly`],
          evidence: twice.accepted.slice(0, 3).map(netEvidence),
          observed: [
            `${twice.accepted.length} identical requests were accepted`,
            ...twice.accepted.slice(0, 3).map((r) => `${r.method} ${r.url} -> ${r.status}`),
            `"${twice.marker}" appears ${twice.copies} times on ${path(twice.landedOn)} afterwards`,
          ],
          inference: ["An impatient user ends up with two of whatever this form makes."],
          deterministic: true,
          fingerprint: `double_submit|${new URL(url).pathname}|${submitName}`,
          unit,
        });
      }
    }

    const outcome = (a: Attempt) => {
      const m = a.requests.filter(isMutation);
      if (m.some((r) => r.status !== null && r.status >= 500)) return "server_error";
      if (m.some((r) => r.status === null && r.error)) return "server_error";
      if (m.length > 0) return "ok";
      return "none";
    };
    const outcomes = attempts.map(outcome);
    const failures = outcomes.filter((o) => o === "server_error").length;
    const mutations = attempts.flatMap((a) => a.requests.filter(isMutation));
    const failing = mutations.filter((r) => r.status === null || r.status >= 500);

    if (failures === attempts.length && failures > 0) {
      const r = failing[0]!;
      result.candidates.push({
        kind: "form_server_error",
        title: `Submitting "${submitName}" fails on ${path(url)}`,
        severity: "high",
        url,
        target: submitName,
        persona,
        summary: `Every submission with valid synthetic data failed: ${r.method} ${path(r.url)} returned ${r.status ?? r.error}.`,
        expected: "A valid submission succeeds.",
        actual: `${r.method} ${path(r.url)} -> ${r.status ?? r.error}${first.live ? `; the page said "${first.live.slice(0, 100)}"` : ""}.`,
        steps: baseSteps,
        evidence: failing.slice(0, 3).map(netEvidence),
        observed: [
          `${attempts.length} of ${attempts.length} valid submissions failed`,
          ...failing.slice(0, 3).map((x) => `${x.method} ${x.url} -> ${x.status ?? x.error}`),
          ...(first.live ? [`Page message: ${first.live.slice(0, 200)}`] : []),
        ],
        inference: ["Users entering valid details cannot complete this form."],
        deterministic: true,
        fingerprint: `form_server_error|${new URL(url).pathname}|${submitName}`,
        unit,
      });
    } else if (failures > 0) {
      const ok = attempts.length - failures;
      result.candidates.push({
        kind: "flaky_request",
        title: `"${submitName}" fails intermittently on ${path(url)}`,
        severity: "high",
        url,
        target: `${submitName} (${[...new Set(failing.map((r) => `${r.method} ${pathPattern(r.url)}`))].join(", ")})`,
        persona,
        summary: `The same valid submission succeeded ${ok} time${ok === 1 ? "" : "s"} and failed ${failures} time${failures === 1 ? "" : "s"} out of ${attempts.length}.`,
        expected: "Identical valid submissions behave the same way.",
        actual: outcomes.map((o, i) => `attempt ${i + 1}: ${o === "ok" ? "succeeded" : "failed"}`).join(", "),
        steps: [...baseSteps, `Repeat ${attempts.length} times`],
        evidence: mutations.slice(0, 6).map(netEvidence),
        observed: mutations.slice(0, 6).map((x) => `${x.method} ${x.url} -> ${x.status ?? x.error}`),
        inference: ["Some users will lose what they submitted, apparently at random. The cause could not be confirmed from the browser."],
        // Intermittent by definition: seeing it again proves it is likely, not
        // that it will happen to any particular user.
        deterministic: false,
        fingerprint: `flaky_request|${new URL(url).pathname}|${submitName}`,
        unit,
        priorAttempts: { attempts: attempts.length, reproduced: failures },
      });
    } else if (
      outcomes.every((o) => o === "none") &&
      !first.textChanged &&
      first.urlAfter === first.urlBefore &&
      first.invalid === 0 &&
      first.requests.length === 0
    ) {
      result.candidates.push({
        kind: "form_no_feedback",
        title: `Nothing happens after pressing "${submitName}" on ${path(url)}`,
        severity: "medium",
        url,
        target: submitName,
        persona,
        summary: "After a valid submission, no request was sent, the page did not change, and no message appeared.",
        expected: "Submitting a form produces a visible result: a message, a new page, or an error.",
        actual: "No visible change and no network activity.",
        steps: baseSteps,
        evidence: [{ type: "measurement", name: "requests after submit", value: 0, unit: "count" }],
        observed: ["0 requests sent", "page text unchanged", "URL unchanged", "no field marked invalid"],
        inference: ["The user cannot tell whether the submission worked."],
        deterministic: false,
        fingerprint: `form_no_feedback|${new URL(url).pathname}|${submitName}`,
        unit,
      });
    }

    if (first.urlAfter !== first.urlBefore && sameSite(first.urlAfter, s.opts.target)) {
      result.discovered.push({ url: first.urlAfter, from: url, via: `submitting "${submitName}"` });
    }

    // --- the careless user: an obviously invalid email ---------------------
    const emailField = form.fields.find(isEmailField);
    if (emailField) {
      const bad = await fillAndSubmit(s, url, form, { emailOverride: INVALID_EMAIL });
      if (bad) {
        // Proof, not suspicion: a request that carried the invalid value, and a
        // server that said yes to it.
        const accepted = bad.requests.find(
          (r) =>
            r.status !== null &&
            r.status >= 200 &&
            r.status < 300 &&
            ((r.postData ?? "").includes(INVALID_EMAIL) || (r.method === "GET" && r.url.includes(INVALID_EMAIL))),
        );
        if (accepted && bad.invalid === 0) {
          result.candidates.push({
            kind: "form_accepts_invalid",
            title: `"${submitName}" accepts an invalid email address on ${path(url)}`,
            severity: "high",
            url,
            target: `${submitName} (${emailField.label || emailField.name || "email"} field)`,
            persona,
            summary: `The ${emailField.label || "email"} field accepted "${INVALID_EMAIL}", and the server responded ${accepted.status}.`,
            expected: "An invalid email address is rejected with a message.",
            actual: `${accepted.method} ${path(accepted.url)} -> ${accepted.status}${bad.live ? `; the page said "${bad.live.slice(0, 100)}"` : ""}.`,
            steps: [`Open ${url}`, `Enter "${INVALID_EMAIL}" in the ${emailField.label || "email"} field, and valid data elsewhere`, `Press "${submitName}"`],
            evidence: [netEvidence(accepted)],
            observed: [
              `request body contained "${INVALID_EMAIL}"`,
              `${accepted.method} ${accepted.url} -> ${accepted.status}`,
              "no field was marked invalid",
              ...(bad.live ? [`Page message: ${bad.live.slice(0, 200)}`] : []),
            ],
            inference: ["Neither the page nor the server validates this field, so records with unusable email addresses can be created."],
            deterministic: true,
            fingerprint: `form_accepts_invalid|${new URL(url).pathname}|${submitName}`,
            unit,
          });
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

interface FocusRead {
  fid: string | null;
  name: string;
  describe: string;
  style: string;
  dialog: string | null;
}

/** Walk the page with Tab, then open each dialog and try to get out of it. */
export async function keyboardUnit(
  s: Session,
  url: string,
  opts: { pressButtons: boolean } = { pressButtons: true },
): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "keyboard", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url, READ_PATIENCE_MS);
  if (status !== null && status >= 400) return result;
  const persona = s.opts.persona.key;

  // --- does focus show? ---------------------------------------------------
  await s.eval(js.INSTALL_STYLE_PROBE);
  const unfocused = await s.eval<Record<string, string>>(js.SNAPSHOT_FOCUSABLES);
  const total = Object.keys(unfocused).length;
  const invisible = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(total + 3, 40); i++) {
    await s.page.keyboard.press("Tab");
    const f = await s.eval<FocusRead | null>(js.READ_FOCUS);
    if (!f || !f.fid) continue;
    if (seen.has(f.fid)) break;
    seen.add(f.fid);
    const base = unfocused[f.fid];
    if (base !== undefined && base === f.style) invisible.set(f.fid, f.name);
  }
  if (invisible.size > 0) {
    const names = [...invisible.values()];
    result.candidates.push({
      kind: "focus_invisible",
      title: `Keyboard focus is invisible on ${names.length} control${names.length === 1 ? "" : "s"} on ${path(url)}`,
      severity: "medium",
      url,
      target: names.join(", "),
      persona,
      summary: `Tabbing to ${names.map((n) => `"${n}"`).join(", ")} changes nothing visible: no outline, shadow, border or colour change.`,
      expected: "The focused control is visibly marked (WCAG 2.4.7).",
      actual: "Focused and unfocused styles are identical.",
      steps: [`Open ${url}`, "Press Tab through the page", "Compare each control's appearance focused and unfocused"],
      evidence: names.map((n): Evidence => ({ type: "dom", selector: n, snippet: "no visual change on keyboard focus" })),
      observed: names.map((n) => `"${n}": computed outline, shadow, border, background and colour identical when focused`),
      inference: ["Keyboard users cannot see where they are on the page."],
      deterministic: false,
      fingerprint: `focus_invisible|${new URL(url).pathname}`,
      unit,
    });
  }

  // --- can you leave a dialog? --------------------------------------------
  // Opening a dialog means pressing a button, which a passive scan must not do
  // on a site whose owner has not verified it.
  if (!opts.pressButtons) return result;
  const buttons = (await s.eval<Array<{ key: string; name: string }>>(js.LIST_LOOSE_BUTTONS)).slice(0, 5);
  for (const b of buttons) {
    if (assess({ name: b.name, role: "button" }).risk === "destructive") continue;
    await s.goto(url, READ_PATIENCE_MS);
    await s.eval(js.LIST_LOOSE_BUTTONS);
    const opener = s.page.locator(`[data-owly-btn="${b.key}"]`);
    if (!(await opener.focus({ timeout: 2_000 }).then(() => true).catch(() => false))) continue;
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(400);
    const dialogs = await s.eval<Array<{ describe: string; label: string }>>(js.OPEN_DIALOGS);
    if (dialogs.length === 0) continue;
    const dialog = dialogs[0]!;

    const visited: FocusRead[] = [];
    let escaped = false;
    for (let i = 0; i < 12; i++) {
      await s.page.keyboard.press("Tab");
      const f = await s.eval<FocusRead | null>(js.READ_FOCUS);
      if (f) visited.push(f);
      if (!f || !f.dialog) {
        escaped = true;
        break;
      }
    }
    if (!escaped) {
      await s.page.keyboard.press("Escape");
      await s.page.waitForTimeout(300);
      const still = await s.eval<Array<{ describe: string }>>(js.OPEN_DIALOGS);
      const focus = await s.eval<FocusRead | null>(js.READ_FOCUS);
      if (still.length === 0 || !focus || !focus.dialog) escaped = true;
    }
    if (!escaped) {
      // Last resort a keyboard user has: a button inside the dialog they can
      // reach. If pressing one closes it, the dialog is not a trap.
      const reachableButtons = [...new Set(visited.filter((v) => v.describe.startsWith("button")).map((v) => v.name))];
      for (const name of reachableButtons) {
        if (assess({ name, role: "button" }).risk === "destructive") continue;
        const loc = s.page.getByRole("button", { name, exact: true }).first();
        if (!(await loc.focus({ timeout: 1_000 }).then(() => true).catch(() => false))) continue;
        await s.page.keyboard.press("Enter");
        await s.page.waitForTimeout(300);
        if ((await s.eval<unknown[]>(js.OPEN_DIALOGS)).length === 0) {
          escaped = true;
          break;
        }
      }
    }

    if (!escaped) {
      const reached = [...new Set(visited.map((v) => v.name))];
      result.candidates.push({
        kind: "keyboard_trap",
        title: `Keyboard users get stuck in "${dialog.label || dialog.describe}" on ${path(url)}`,
        severity: "high",
        url,
        target: `${b.name} -> ${dialog.label || dialog.describe}`,
        persona,
        summary: `After opening "${dialog.label || dialog.describe}" with "${b.name}", Tab never leaves the dialog, Escape does not close it, and no reachable button closes it.`,
        expected: "Keyboard users can close a dialog or move focus out of it (WCAG 2.1.2).",
        actual: `Focus cycled between ${reached.map((r) => `"${r}"`).join(", ") || "the same element"} and could not leave.`,
        steps: [`Open ${url}`, `Focus "${b.name}" with the keyboard and press Enter`, "Press Tab 12 times", "Press Escape", "Press Enter on each reachable button inside the dialog"],
        evidence: [{ type: "dom", selector: dialog.describe, snippet: `focus stayed on: ${reached.join(", ")}` }],
        observed: [`${visited.length} Tab presses kept focus inside ${dialog.describe}`, "Escape left the dialog open", `reachable buttons tried: ${reachableButtons_(visited)}`],
        inference: ["A keyboard-only user who opens this dialog has to reload the page to continue."],
        deterministic: false,
        fingerprint: `keyboard_trap|${new URL(url).pathname}|${dialog.label || dialog.describe}`,
        unit,
      });
    }
  }
  return result;
}

function reachableButtons_(visited: FocusRead[]): string {
  const names = [...new Set(visited.filter((v) => v.describe.startsWith("button")).map((v) => v.name))];
  return names.length ? names.join(", ") : "none";
}


/**
 * Fill the form and press submit twice, as fast as a person does when nothing
 * seems to have happened. Returns the identical mutating requests the server
 * accepted.
 */
async function submitTwiceQuickly(
  s: Session,
  url: string,
  form: FormInfo,
): Promise<{ accepted: NetRecord[]; copies: number; marker: string; landedOn: string } | null> {
  await s.goto(url, READ_PATIENCE_MS);
  const forms = await s.eval<FormInfo[]>(js.LIST_FORMS);
  const again = forms[form.index];
  if (!again || !again.submit) return null;

  const n = nonce();
  // The first text Owly types is the marker it looks for afterwards: if the
  // form made two of something, this is what is sitting there twice.
  let marker = "";
  for (const field of again.fields) {
    const value = valueFor(field, n);
    if (!value) continue;
    if (!marker && value.kind === "text" && value.value.length > 6 && !isEmailField(field)) marker = value.value;
    const loc = s.page.locator(`[data-owly-field="${field.key}"]`);
    try {
      if (value.kind === "select") await loc.selectOption(value.value, { timeout: INTERACT_MS });
      else if (value.kind === "check") await loc.check({ timeout: INTERACT_MS });
      else await loc.fill(value.value, { timeout: INTERACT_MS });
    } catch {
      return null; // a form Owly could not fill says nothing about double presses
    }
  }

  const mark = s.mark();
  // Both presses in the same tick, which is what a double-click is. Clicking
  // twice through the driver does not reproduce it: the first press starts a
  // navigation and the button is gone before the second arrives, so a classic
  // form always looked safe while a real double-click still made two.
  //
  // The call itself usually throws - the first press destroys the context the
  // evaluation was running in - and that is not a failure: both clicks have
  // already happened by then. What the server did with them is in the network
  // record either way.
  await s
    .eval(`(() => { var b = document.querySelector('[data-owly-submit="${form.index}"]'); if (b) { b.click(); b.click(); } })()`)
    .catch(() => undefined);
  await s.settle(READ_PATIENCE_MS);

  const accepted = s
    .since(mark)
    .net.filter(isMutation)
    .filter((r) => r.status !== null && r.status >= 200 && r.status < 400);
  const landedOn = s.page.url();
  const first = accepted[0];
  if (!first) return { accepted: [], copies: 0, marker, landedOn };

  // How many times the typed value is on the page Owly ended up on. Two is the
  // evidence that two records exist; anything else and no claim is made.
  let copies = 0;
  if (marker) {
    copies = await s
      .eval<number>(`(() => { var t = document.body ? document.body.innerText : ""; var n = 0, i = 0;` +
        ` var m = ${JSON.stringify(marker)}; while ((i = t.indexOf(m, i)) !== -1) { n++; i += m.length; } return n; })()`)
      .catch(() => 0);
  }

  // Only identical requests count: a second press that sent something else was
  // a different action, not a duplicate.
  return {
    accepted: accepted.filter((r) => r.method === first.method && r.url === first.url && r.postData === first.postData),
    copies,
    marker,
    landedOn,
  };
}

// ---------------------------------------------------------------------------

/**
 * "It said Saved. Is it saved?"
 *
 * The check a human tester makes without thinking and no scanner makes at all:
 * change something, submit it, then come back with a fresh page load and see
 * whether the change is still there. A lost write is invisible to everything
 * Owly measured before this - the request is a clean 200, the page says Saved,
 * the console is silent - and it is one of the worst bugs a product can have.
 *
 * Only forms that edit something that already exists are touched (a Save
 * button, and a field that already holds a value), and only while Owly is
 * signed in as the account it created itself, so the thing being edited is
 * always Owly's own. The original value is put back afterwards.
 */
export async function persistUnit(s: Session, url: string, maxForms = 2): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "persist", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };

  await s.goto(url, READ_PATIENCE_MS);
  const forms = await s.eval<FormInfo[]>(js.LIST_FORMS);

  let checked = 0;
  for (const form of forms) {
    if (checked >= maxForms) break;
    const submitName = form.submit?.name ?? "";
    if (!/\b(save|update|change|apply|rename)\b/i.test(submitName)) continue;

    const guard = assess({ name: submitName, role: "button" });
    if (guard.risk !== "safe") {
      result.notes.push(`Not testing whether "${submitName}" on ${path(url)} saves: ${guard.reason}.`);
      continue;
    }

    // A field that already holds something is a field that edits something.
    const editable = form.fields.filter((f) => (f.tag === "input" || f.tag === "textarea") && ["text", "textarea", "search"].includes(f.type));
    let field: (typeof editable)[number] | null = null;
    let before = "";
    for (const candidate of editable) {
      const value = await s.page.locator(`[data-owly-field="${candidate.key}"]`).inputValue().catch(() => "");
      if (value.trim()) {
        field = candidate;
        before = value;
        break;
      }
    }
    if (!field) continue;
    checked++;

    const marker = `Owly check ${nonce()}`;
    const mark = s.mark();
    try {
      await s.page.locator(`[data-owly-field="${field.key}"]`).fill(marker, { timeout: INTERACT_MS });
      await s.page.locator(`[data-owly-submit="${form.index}"]`).click({ timeout: INTERACT_MS });
    } catch (err) {
      result.notes.push(`Could not test whether "${submitName}" on ${path(url)} saves: ${String(err).slice(0, 120)}.`);
      continue;
    }
    await s.settle(READ_PATIENCE_MS);

    // If the server said no, that is the forms probe's business, not this one.
    const answers = s.since(mark).net.filter((r) => r.isNavigation || r.resourceType === "xhr" || r.resourceType === "fetch");
    const refused = answers.find((r) => r.status !== null && r.status >= 400);
    if (refused) continue;

    // Come back as a new visit would, not with the back button.
    await s.goto(url, READ_PATIENCE_MS);
    const again = await s.eval<FormInfo[]>(js.LIST_FORMS);
    const sameField = (again[form.index]?.fields ?? []).find(
      (f) => (field.name && f.name === field.name) || (field.id && f.id === field.id) || f.key === field.key,
    );
    const now = sameField ? await s.page.locator(`[data-owly-field="${sameField.key}"]`).inputValue().catch(() => null) : null;
    if (now === null) {
      result.notes.push(`Could not read ${field.label || field.name} on ${path(url)} again, so whether it saved is unknown.`);
      continue;
    }
    if (now === marker) {
      // It stuck. Put it back the way it was found.
      if (sameField) await restore(s, form.index, sameField.key, before);
      continue;
    }

    result.candidates.push({
      kind: "lost_write",
      title: `"${submitName}" on ${path(url)} does not save`,
      severity: "high",
      url,
      target: submitName,
      persona: s.opts.persona.key,
      summary: `Changing ${field.label || field.name} and pressing "${submitName}" was accepted, but the old value is back after reloading the page.`,
      expected: "A change that is accepted is still there when the page is opened again.",
      actual: `The field reads "${now}" again, not the value that was saved.`,
      steps: [
        `Open ${url}`,
        `Change ${field.label || field.name} to something new`,
        `Press "${submitName}"`,
        `Open ${url} again`,
      ],
      evidence: [
        { type: "dom", selector: `[name="${field.name}"]`, snippet: `value after reload: ${now.slice(0, 120)}` },
        ...answers.slice(0, 2).map((r): Evidence => ({ type: "network", method: r.method, url: r.url, status: r.status })),
      ],
      observed: [
        `submitted "${marker}"`,
        ...answers.slice(0, 2).map((r) => `${r.method} ${r.url} -> ${r.status ?? r.error}`),
        `after reloading, the field reads "${now.slice(0, 80)}"`,
      ],
      inference: ["The write is accepted and then lost: users will think the change was kept."],
      deterministic: true,
      fingerprint: `lost_write|${new URL(url).pathname}|${field.name || field.label}`,
      unit,
    });
  }

  return result;
}

/** Best effort: leave the account the way it was found. */
async function restore(s: Session, formIndex: number, fieldKey: string, value: string): Promise<void> {
  if (!value) return;
  try {
    await s.page.locator(`[data-owly-field="${fieldKey}"]`).fill(value, { timeout: INTERACT_MS });
    await s.page.locator(`[data-owly-submit="${formIndex}"]`).click({ timeout: INTERACT_MS });
    await s.settle(1_000);
  } catch {
    // Nothing to do: the value belongs to the account Owly created itself.
  }
}
