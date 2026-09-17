/**
 * One test run, start to finish:
 *
 *   discover  crawl the site as a new desktop user, running every unit on each page
 *   personas  revisit what was found as an impatient phone user and a keyboard user
 *   verify    replay every unit that raised a candidate, in a fresh browser context
 *   cluster   fold candidates with the same fingerprint into one finding
 *   redact    scrub the report before anything leaves the engine
 *
 * The run records what it did as events, in plain words, as it goes. Those are
 * the lines a person watches on the progress page, and they are generated from
 * what actually happened - never a scripted animation (spec §49).
 */

import { load } from "../config.js";
import type { Finding } from "../findings.js";
import { createRedactor } from "../policy/redact.js";
import { checkUrl, sameOrigin } from "../policy/urlGuard.js";
import { launchBrowser, PERSONAS, Session, type BlockRecord, type Persona } from "../browser/session.js";
import { parseUnit, unitKey, type Candidate } from "./candidate.js";
import { cluster, replayKey } from "./cluster.js";
import { a11yUnit, buttonsUnit, formsUnit, keyboardUnit, layoutUnit, loadUnit, type UnitResult } from "./probes.js";

export interface RunEvent {
  at: string;
  level: "info" | "warn" | "suspect" | "confirmed" | "dismissed";
  text: string;
}

export interface RunOptions {
  allowPrivate?: boolean;
  maxPages?: number;
  onEvent?: (event: RunEvent) => void;
}

export interface RunReport {
  target: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Confirmed and likely. What the report leads with. */
  findings: Finding[];
  /** Raised but not reproduced. Shown separately, never counted as bugs. */
  unverified: Finding[];
  pages: Array<{ url: string; status: number | null }>;
  notes: string[];
  events: RunEvent[];
}

function normalise(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

export async function runTest(targetUrl: string, opts: RunOptions = {}): Promise<RunReport> {
  const config = load();
  const allowPrivate = opts.allowPrivate ?? config.allowPrivateTargets;
  const maxPages = opts.maxPages ?? config.budgets.maxPages;
  const started = Date.now();
  const events: RunEvent[] = [];
  const notes: string[] = [];

  const emit = (level: RunEvent["level"], text: string) => {
    const e = { at: new Date().toISOString(), level, text };
    events.push(e);
    opts.onEvent?.(e);
  };

  const verdict = await checkUrl(targetUrl, { allowPrivate });
  if (!verdict.ok) throw new Error(`Refusing to test ${targetUrl}: ${verdict.reason}`);
  const target = new URL(normalise(verdict.url.href));

  const browser = await launchBrowser(target, allowPrivate);
  const sessionOpts = (persona: Persona) => ({ target, persona, allowPrivate, userAgentSuffix: config.userAgentSuffix });
  const candidates: Candidate[] = [];
  const blocked: BlockRecord[] = [];
  const pages = new Map<string, number | null>();
  const referrers = new Map<string, Array<{ from: string; via: string }>>();

  const take = (r: UnitResult) => {
    for (const c of r.candidates) {
      candidates.push(c);
      emit("suspect", `Possible issue: ${c.title}`);
    }
    notes.push(...r.notes);
  };

  try {
    // --- discover, as a new desktop user --------------------------------
    emit("info", `Exploring ${target.origin} as a new desktop user`);
    const desktop = await Session.open(browser, sessionOpts(PERSONAS.new_user));
    const queue: Array<{ url: string; from: string | null; via: string }> = [{ url: target.href, from: null, via: "start" }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      let url: string;
      try {
        url = normalise(item.url);
      } catch {
        continue;
      }
      if (!sameOrigin(url, target)) continue;
      if (item.from) referrers.set(url, [...(referrers.get(url) ?? []), { from: item.from, via: item.via }]);
      if (pages.has(url)) continue;
      const okPages = [...pages.values()].filter((s) => s !== null && s < 400).length;
      if (okPages >= maxPages) {
        notes.push(`Stopped exploring after ${maxPages} pages.`);
        break;
      }

      emit("info", `Opening ${new URL(url).pathname}${new URL(url).search}`);
      const loaded = await loadUnit(desktop, url);
      pages.set(url, loaded.status);
      if (loaded.status !== null && loaded.status >= 400) {
        emit("warn", `${new URL(url).pathname} answered HTTP ${loaded.status}`);
        continue;
      }
      take(loaded);
      for (const d of loaded.discovered) queue.push({ url: d.url, from: d.from, via: d.via });

      take(await a11yUnit(desktop, url));
      take(await layoutUnit(desktop, url));

      emit("info", `Pressing buttons on ${new URL(url).pathname}`);
      const pressed = await buttonsUnit(desktop, url);
      take(pressed);
      for (const d of pressed.discovered) queue.push({ url: d.url, from: d.from, via: d.via });

      const submitted = await formsUnit(desktop, url);
      if (submitted.candidates.length || submitted.discovered.length) emit("info", `Submitted forms on ${new URL(url).pathname}`);
      take(submitted);
      for (const d of submitted.discovered) queue.push({ url: d.url, from: d.from, via: d.via });
    }
    blocked.push(...desktop.blocked);
    await desktop.close();

    // Links that led to error pages, reported once per page that links there.
    for (const [url, status] of pages) {
      if (status === null || status < 400) continue;
      const refs = referrers.get(url) ?? [];
      const path = new URL(url).pathname;
      for (const ref of refs) {
        const c: Candidate = {
          kind: "broken_link",
          title: `Broken link: "${ref.via}" leads to a ${status} page`,
          severity: "low",
          url: ref.from,
          target: `${ref.via} -> ${path}`,
          persona: "new_user",
          summary: `The link "${ref.via}" points to ${path}, which answers HTTP ${status}.`,
          expected: "Links lead to a working page.",
          actual: `HTTP ${status}.`,
          steps: [`Open ${ref.from}`, `Follow "${ref.via}"`],
          evidence: [{ type: "network", method: "GET", url, status }],
          observed: [`GET ${url} -> ${status}`, `linked from ${ref.from} as "${ref.via}"`],
          inference: [],
          deterministic: true,
          fingerprint: `broken_link|${path}`,
          unit: unitKey("new_user", "links", url),
        };
        candidates.push(c);
        emit("suspect", `Possible issue: ${c.title}`);
      }
    }

    const okUrls = [...pages].filter(([, s]) => s !== null && s < 400).map(([u]) => u);

    // --- the other personas, over what discovery found -------------------
    emit("info", `Trying ${okUrls.length} page${okUrls.length === 1 ? "" : "s"} as an impatient phone user`);
    const phone = await Session.open(browser, sessionOpts(PERSONAS.mobile_impatient));
    for (const url of okUrls) take(await layoutUnit(phone, url));
    blocked.push(...phone.blocked);
    await phone.close();

    emit("info", `Trying ${okUrls.length} page${okUrls.length === 1 ? "" : "s"} with only a keyboard`);
    const keys = await Session.open(browser, sessionOpts(PERSONAS.keyboard_only));
    for (const url of okUrls) take(await keyboardUnit(keys, url));
    blocked.push(...keys.blocked);
    await keys.close();

    // --- verify: replay each unit in a fresh browser context -------------
    const units = [...new Set(candidates.map((c) => c.unit))];
    emit("info", `Reproducing ${candidates.length} possible issue${candidates.length === 1 ? "" : "s"} across ${units.length} replay${units.length === 1 ? "" : "s"}`);
    const reproduced = new Set<string>();
    for (const unit of units) {
      const { persona, activity, url } = parseUnit(unit);
      const s = await Session.open(browser, sessionOpts(PERSONAS[persona]));
      try {
        let replay: UnitResult | null = null;
        if (activity === "load") replay = await loadUnit(s, url);
        else if (activity === "a11y") replay = await a11yUnit(s, url);
        else if (activity === "layout") replay = await layoutUnit(s, url);
        else if (activity === "buttons") replay = await buttonsUnit(s, url);
        else if (activity === "forms") replay = await formsUnit(s, url);
        else if (activity === "keyboard") replay = await keyboardUnit(s, url);
        else if (activity === "links") {
          const status = await s.goto(url);
          if (status !== null && status >= 400) reproduced.add(replayKey({ unit, fingerprint: `broken_link|${new URL(url).pathname}` }));
        }
        for (const c of replay?.candidates ?? []) reproduced.add(replayKey({ unit, fingerprint: c.fingerprint }));
      } finally {
        blocked.push(...s.blocked);
        await s.close();
      }
    }

    // --- cluster ----------------------------------------------------------
    const { findings, unverified } = cluster(candidates, reproduced);
    for (const f of findings) emit("confirmed", `${f.confidence === "confirmed" ? "Confirmed" : "Likely"}: ${f.title}`);
    for (const f of unverified) emit("dismissed", `Could not reproduce, so not reported: ${f.title}`);

    // Everything the guards refused, so a report can say what Owly would not do.
    for (const b of blocked) notes.push(`Refused to go to ${b.url}: ${b.reason}.`);

    const redact = createRedactor();
    const finished = Date.now();
    emit("info", `Done: ${findings.length} issue${findings.length === 1 ? "" : "s"} found on ${okUrls.length} page${okUrls.length === 1 ? "" : "s"}`);
    return redact.value({
      target: target.href,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      findings,
      unverified,
      pages: [...pages].map(([url, status]) => ({ url, status })),
      notes: [...new Set(notes)],
      events,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
