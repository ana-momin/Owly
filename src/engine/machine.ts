/**
 * A test run as a resumable state machine.
 *
 * On Vercel a single invocation may run for 300 seconds at most, and a real
 * test takes longer. So a run is a list of work items plus everything learned
 * so far, all plain JSON. Each call to `advance` does as many items as fit in
 * its time budget and hands back the state; the next call - usually the next
 * poll from Pond - picks up exactly where it stopped, possibly on a different
 * instance. Nothing lives in memory between slices.
 *
 * That is the lesson of Foxy's first Pond rejection: its scan died after 166
 * seconds because work depended on an instance staying alive. Here no work
 * depends on anything but the state in the database.
 *
 *   discover  crawl as a new desktop user, running the chosen units on each page
 *   personas  revisit what was found as a phone user and a keyboard user
 *   verify    replay every unit that raised a candidate, in a fresh context
 *   done      cluster, redact, write the report
 */

import type { Browser } from "playwright-core";
import { load } from "../config.js";
import type { Evidence, Finding } from "../findings.js";
import { createRedactor } from "../policy/redact.js";
import { checkUrl, sameSite } from "../policy/urlGuard.js";
import { launchBrowser, PERSONAS, Session, type BlockRecord, type Persona, type StorageState } from "../browser/session.js";
import { parseUnit, unitKey, type Activity, type Candidate } from "./candidate.js";
import { cluster, replayKey } from "./cluster.js";
import { a11yUnit, buttonsUnit, formsUnit, keyboardUnit, layoutUnit, loadUnit, persistUnit, type UnitResult } from "./probes.js";
import { boundaryUnit } from "./boundary.js";
import { runJourney, type Journey } from "./journey.js";
import { accessChecks, cookieChecks, headerChecks, signOutCheck } from "./security.js";
import { costOf, understand, type Understanding } from "./understanding.js";
// The pure half: what a run may check and the state it starts from. Kept in
// its own file so the endpoints that only create or read runs never pull a
// browser into their bundle.
import { activitiesFor, emit, newRun, normalise, type NewRunOptions } from "./plan.js";
export { activitiesFor, newRun } from "./plan.js";
export type { NewRunOptions } from "./plan.js";

/**
 * `full` presses buttons and submits forms. `passive` only looks: it loads
 * pages, measures layout, runs the accessibility scan and walks focus with Tab.
 * Only a site whose owner has proven control of it gets `full` (spec §54).
 */
export type Mode = "full" | "passive";

/** What the requester asked to concentrate on. Honoured, not decorative. */
export type Focus = "everything" | "forms" | "mobile" | "accessibility";

export interface RunEvent {
  at: string;
  level: "info" | "warn" | "suspect" | "confirmed" | "dismissed";
  text: string;
}

type WorkItem = (
  | { kind: "journey" }
  | { kind: "discover"; url: string; from: string | null; via: string }
  | { kind: "unit"; persona: Persona["key"]; activity: Activity; url: string }
  | { kind: "replay"; unit: string }
  | { kind: "security" }
) & {
  /** Failed attempts so far. One retry, then the item is skipped and noted. */
  tries?: number;
};

/**
 * The longest one work item may take. A page can hang an evaluation forever
 * (an endless script, a stuck render); without this, one bad page ran a slice
 * past Vercel's function limit and the platform killed it mid-write.
 */
export const ITEM_LIMIT_MS = 35_000;

const ACTIVITY_LABEL: Record<Activity, string> = {
  journey: "the main user journey",
  load: "loading the page",
  links: "checking links",
  a11y: "the accessibility scan",
  layout: "the layout check",
  buttons: "pressing buttons",
  forms: "filling in forms",
  boundary: "trying an unusually long value",
  keyboard: "the keyboard check",
  persist: "checking that changes are saved",
  security: "the security checks",
};

type Outcome<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "error"; error: string; stopSlice: boolean };

/** Resolves within `ms`, whatever `work` does. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // An abandoned promise may still reject later; that must not crash anything.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunReport {
  target: string;
  mode: Mode;
  focus: Focus;
  /** The checks that actually ran - so a scoped run can prove its scope. */
  activities: Activity[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  slices: number;
  findings: Finding[];
  unverified: Finding[];
  pages: Array<{ url: string; status: number | null }>;
  notes: string[];
  events: RunEvent[];
  /** How Owly got in, when it did: the report says so plainly. */
  signedInBy: string | null;
  /** What Owly made of the product it was testing. */
  understanding: Understanding;

  /** The attempt at the site's main task. The report leads with it. */
  journey: Journey | null;
  /**
   * Set when no page of the site could be opened. A run that tested nothing
   * must never be presented as a site with no problems.
   */
  failed: string | null;
}

export interface RunState {
  v: 1;
  target: string;
  mode: Mode;
  focus: Focus;
  allowPrivate: boolean;
  maxPages: number;
  maxRunMs: number;
  phase: "discover" | "personas" | "verify" | "done";
  pending: WorkItem[];
  pages: Array<[string, number | null]>;
  referrers: Array<[string, Array<{ from: string; via: string }>]>;
  candidates: Candidate[];
  reproduced: string[];
  blocked: BlockRecord[];
  notes: string[];
  events: RunEvent[];
  activities: Activity[];
  exploringStopped: boolean;
  /**
   * Cookies and storage from the moment Owly got in, as plain JSON.
   *
   * This is what lets a run test a product rather than a brochure: the browser
   * dies at the end of every slice, so being signed in has to survive as data.
   * Every session opened afterwards - in this slice, or on another instance
   * three polls later - starts already signed in.
   */
  auth: StorageState | null;
  /** How Owly got in, for the report. */
  signedInBy: string | null;
  /** Pages that were only reachable once signed in. The access check uses these. */
  behindLogin: string[];
  /** The words this product uses about itself. What the understanding is built from. */
  labels: string[];
  /** The way out, if the product offers one. Followed last, on purpose. */
  signOutUrl: string | null;
  /**
   * Who Owly said it was when it signed up: the email and name it typed, never
   * the password. A page printing one of these back is proof that the page
   * belongs to Owly's own account, which is the difference between a security
   * finding and a guess. Redacted out of the report like any other value.
   */
  identity: string[];
  journey: Journey | null;
  createdAt: string;
  elapsedMs: number;
  slices: number;
  report: RunReport | null;
}


export interface AdvanceOptions {
  /** Epoch ms after which no new work item starts. */
  deadline: number;
  /** Overrides ITEM_LIMIT_MS, for tests. */
  itemLimitMs?: number;
  onEvent?: (e: RunEvent) => void;
}

/**
 * Do as much of the run as fits before `deadline`, then return. Mutates and
 * returns `state`; the caller persists it.
 */
export async function advance(state: RunState, opts: AdvanceOptions): Promise<RunState> {
  if (state.phase === "done") return state;
  const config = load();
  const target = new URL(state.target);
  const sliceStart = Date.now();
  const eventsBefore = state.events.length;
  state.slices += 1;

  const itemLimit = opts.itemLimitMs ?? ITEM_LIMIT_MS;
  let browser: Browser | null = null;
  let closing = false;
  const sessions = new Map<Persona["key"], Session>();
  const getBrowser = async () => {
    // An attempt abandoned after a timeout may still be running; it must not
    // launch a fresh browser after this slice has shut down.
    if (closing) throw new Error("slice is closing");
    return (browser ??= await launchBrowser(target, state.allowPrivate));
  };
  const sessionOpts = (persona: Persona) => ({
    target,
    persona,
    allowPrivate: state.allowPrivate,
    userAgentSuffix: config.userAgentSuffix,
    signedInAs: state.auth,
  });
  const shared = async (key: Persona["key"]) => {
    let s = sessions.get(key);
    if (!s) {
      s = await Session.open(await getBrowser(), sessionOpts(PERSONAS[key]));
      sessions.set(key, s);
    }
    return s;
  };

  const pages = new Map(state.pages);
  const referrers = new Map(state.referrers);
  const allowed = new Set(state.activities);

  const take = (r: UnitResult) => {
    for (const c of r.candidates) {
      state.candidates.push(c);
      emit(state, "suspect", `Possible issue: ${c.title}`);
    }
    state.notes.push(...r.notes);
    for (const d of r.discovered) state.pending.push({ kind: "discover", url: d.url, from: d.from, via: d.via });
  };

  const overBudget = () => state.elapsedMs + (Date.now() - sliceStart) > state.maxRunMs;

  const attempt = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
    const started = Date.now();
    try {
      const result = await within(fn(), itemLimit);
      if (result === "timeout") {
        if (process.env.VERCEL) console.log(`[owly] item timed out after ${itemLimit}ms`);
        return { ok: false, reason: "timeout", error: `took longer than ${Math.round(itemLimit / 1000)}s`, stopSlice: true };
      }
      if (process.env.VERCEL) console.log(`[owly] item done in ${Date.now() - started}ms`);
      return { ok: true, value: result };
    } catch (err) {
      // If the browser itself died, nothing else in this slice can run; end it
      // and let the next slice start a new one.
      const dead = browser !== null && !(browser as Browser).isConnected();
      return { ok: false, reason: "error", error: String(err).split("\n")[0]!.slice(0, 200), stopSlice: dead };
    }
  };

  /** Requeue a failed item once; after that, skip it and say so. True if skipped. */
  const retryOrSkip = (item: WorkItem, label: string, o: { reason: string; error: string }) => {
    const tries = (item.tries ?? 0) + 1;
    console.log(`[owly] ${label} failed (${o.reason}, attempt ${tries}): ${o.error}`);
    if (tries < 2) {
      state.pending.unshift({ ...item, tries });
      return false;
    }
    state.notes.push(`Skipped ${label}: ${o.reason === "timeout" ? o.error : `it failed twice (${o.error})`}.`);
    emit(state, "warn", `Skipped ${label}`);
    return true;
  };

  try {
    while (Date.now() < opts.deadline) {
      const item = state.pending.shift();

      if (!item) {
        // --- phase transitions -------------------------------------------
        if (state.phase === "discover") {
          addBrokenLinks(state, pages, referrers);
          const ok = [...pages].filter(([, s]) => s !== null && s < 400).map(([u]) => u);
          if (allowed.has("layout")) {
            emit(state, "info", `Trying ${ok.length} page${ok.length === 1 ? "" : "s"} as an impatient phone user`);
            for (const url of ok) state.pending.push({ kind: "unit", persona: "mobile_impatient", activity: "layout", url });
          }
          if (allowed.has("keyboard")) {
            emit(state, "info", `Trying ${ok.length} page${ok.length === 1 ? "" : "s"} with only a keyboard`);
            for (const url of ok) state.pending.push({ kind: "unit", persona: "keyboard_only", activity: "keyboard", url });
          }
          if (allowed.has("security")) state.pending.push({ kind: "security" });
          state.phase = "personas";
          continue;
        }
        if (state.phase === "personas") {
          const units = [...new Set(state.candidates.map((c) => c.unit))];
          if (units.length) {
            emit(state, "info", `Reproducing ${state.candidates.length} possible issue${state.candidates.length === 1 ? "" : "s"} in a fresh browser`);
          }
          for (const unit of units) state.pending.push({ kind: "replay", unit });
          state.phase = "verify";
          continue;
        }
        if (state.phase === "verify") {
          finish(state, pages, sliceStart);
          break;
        }
        break;
      }

      // --- work items -----------------------------------------------------
      // Everything a unit does runs inside `attempt`, which gives up after
      // ITEM_LIMIT_MS. Units only RETURN what they found; state is changed
      // here, after the attempt, and never by an attempt that was abandoned.
      // A hung page cannot take the slice past the function's time limit, and
      // a late finisher cannot write into a run that has already been saved.

      if (item.kind === "journey") {
        emit(state, "info", "Trying the site the way a new visitor would");
        const outcome = await attempt(async () => runJourney(await shared("new_user"), state.target, state.mode === "full"));
        if (!outcome.ok) {
          retryOrSkip(item, "the main user journey", outcome);
          if (outcome.stopSlice) break;
          continue;
        }
        if (outcome.value) {
          state.journey = outcome.value;
          applyJourney(state, outcome.value);
          await keepTheSession(state, await shared("new_user"), outcome.value);
        }
        continue;
      }

      if (item.kind === "security") {
        emit(state, "info", "Checking the things that should not be possible");
        const outcome = await attempt(async () => {
          // Twice, in two fresh browsers, because a security claim carries the
          // same burden of proof as every other finding here.
          const once = async () =>
            runSecurity(await getBrowser(), sessionOpts(PERSONAS.new_user), state);
          const first = await once();
          const second = await once();
          const confirmed = first.candidates.filter((c) =>
            second.candidates.some((other) => other.fingerprint === c.fingerprint),
          );
          return { confirmed, notes: [...first.notes, ...second.notes] };
        });
        if (!outcome.ok) {
          retryOrSkip(item, "the security checks", outcome);
          if (outcome.stopSlice) break;
          continue;
        }
        for (const c of outcome.value.confirmed) {
          state.candidates.push(c);
          // Seen in both browsers: recorded as reproduced rather than replayed
          // again later, because signing out cannot be undone.
          state.reproduced.push(replayKey(c));
          emit(state, "suspect", `Possible issue: ${c.title}`);
        }
        state.notes.push(...new Set(outcome.value.notes));
        continue;
      }

      if (item.kind === "discover") {
        let url: string;
        try {
          url = normalise(item.url);
        } catch {
          continue;
        }
        if (!sameSite(url, target)) continue;
        if (item.from && !item.tries) referrers.set(url, [...(referrers.get(url) ?? []), { from: item.from, via: item.via }]);
        if (pages.has(url) || state.exploringStopped) continue;

        const okCount = [...pages.values()].filter((s) => s !== null && s < 400).length;
        if (okCount >= state.maxPages || overBudget()) {
          state.exploringStopped = true;
          state.notes.push(
            okCount >= state.maxPages
              ? `Explored the first ${state.maxPages} pages and stopped there.`
              : "Stopped exploring new pages to stay within the time budget.",
          );
          continue;
        }

        emit(state, "info", `Opening ${new URL(url).pathname}`);
        const outcome = await attempt(async () => loadUnit(await shared("new_user"), url));
        if (!outcome.ok) {
          if (retryOrSkip(item, `open ${new URL(url).pathname}`, outcome)) pages.set(url, null);
          if (outcome.stopSlice) break;
          continue;
        }
        const loaded = outcome.value;
        // A page that redirects off the site is not a page of this site. It is
        // recorded as visited so it is not tried again, and nothing is checked
        // on it - the browser is not showing it.
        if (loaded.unreachable) {
          pages.set(url, null);
          state.notes.push(...loaded.notes);
          emit(state, "warn", `${new URL(url).pathname} did not respond`);
          continue;
        }
        if (loaded.leftTheSite || loaded.notHtml) {
          pages.set(url, null);
          state.notes.push(...loaded.notes);
          emit(
            state,
            "info",
            loaded.notHtml
              ? `${new URL(url).pathname} is ${loaded.notHtml}, not a page; not tested`
              : `${new URL(url).pathname} leads off the site; not tested`,
          );
          continue;
        }
        pages.set(url, loaded.status);
        if (loaded.status !== null && loaded.status >= 400) {
          emit(state, "warn", `${new URL(url).pathname} answered HTTP ${loaded.status}`);
          continue;
        }
        if (state.auth && !state.behindLogin.includes(url)) state.behindLogin.push(url);
        for (const label of loaded.labels) {
          if (state.labels.length < 200 && !state.labels.includes(label)) state.labels.push(label);
        }
        for (const found of [...loaded.discovered, ...loaded.refusedLinks]) {
          if (!state.signOutUrl && /\b(sign|log)\s?out\b/i.test(found.via) && sameSite(found.url, target)) {
            state.signOutUrl = found.url;
          }
        }
        take(loaded);
        // Finish this page before moving to the next one.
        const units: WorkItem[] = [];
        // "Did it save?" only applies to a product Owly is signed into, where
        // the thing being edited belongs to the account it created itself.
        for (const activity of ["a11y", "layout", "buttons", "forms", "boundary", ...(state.auth ? (["persist"] as const) : [])] as const) {
          if (allowed.has(activity) && !(activity === "layout" && state.focus === "mobile")) {
            units.push({ kind: "unit", persona: "new_user", activity, url });
          }
        }
        state.pending.unshift(...units);
        continue;
      }

      if (item.kind === "unit") {
        if (overBudget() && state.phase !== "verify") {
          state.notes.push("Some checks were skipped to stay within the time budget.");
          continue;
        }
        const path = new URL(item.url).pathname;
        if (item.activity === "buttons" && !item.tries) emit(state, "info", `Pressing buttons on ${path}`);
        if (item.activity === "forms" && !item.tries) emit(state, "info", `Filling in forms on ${path}`);
        const outcome = await attempt(async () => runUnit(await shared(item.persona), item.activity, item.url, state.mode));
        if (!outcome.ok) {
          retryOrSkip(item, `${ACTIVITY_LABEL[item.activity]} on ${path}`, outcome);
          if (outcome.stopSlice) break;
          continue;
        }
        take(outcome.value);
        continue;
      }

      // replay, in a fresh context that no earlier work has touched
      const { persona, activity, url } = parseUnit(item.unit);
      const outcome = await attempt(async () => {
        const fresh = await Session.open(await getBrowser(), sessionOpts(PERSONAS[persona]));
        try {
          if (activity === "journey") {
            const again = await runJourney(fresh, state.target, state.mode === "full");
            return {
              keys: again?.hardFailure && !again.completed ? [replayKey({ unit: item.unit, fingerprint: `task_blocked|${again.task}` })] : [],
              blocked: fresh.blocked,
            };
          }
          if (activity === "links") {
            const status = await fresh.goto(url);
            return {
              keys: status !== null && status >= 400 ? [replayKey({ unit: item.unit, fingerprint: `broken_link|${new URL(url).pathname}` })] : [],
              blocked: fresh.blocked,
            };
          }
          const replay = await runUnit(fresh, activity, url, state.mode);
          return { keys: replay.candidates.map((c) => replayKey({ unit: item.unit, fingerprint: c.fingerprint })), blocked: fresh.blocked };
        } finally {
          await fresh.close();
        }
      });
      if (!outcome.ok) {
        // A replay that could not run did not reproduce anything, so whatever
        // it was checking stays unverified - the honest outcome.
        retryOrSkip(item, `reproducing ${ACTIVITY_LABEL[activity]} on ${new URL(url).pathname}`, outcome);
        if (outcome.stopSlice) break;
        continue;
      }
      state.reproduced.push(...outcome.value.keys);
      state.blocked.push(...outcome.value.blocked);
    }
  } finally {
    closing = true;
    // Closing can hang on the very page that timed out, so closing is time
    // limited too. Whatever is left dies with the function instance.
    for (const s of sessions.values()) {
      state.blocked.push(...s.blocked);
      await within(s.close(), 5_000);
    }
    if (browser) await within((browser as Browser).close().catch(() => undefined), 5_000);
    state.pages = [...pages];
    state.referrers = [...referrers];
    // `finish` may have moved the phase to done inside the loop; the compiler
    // cannot see that through the call, so the phase is read afresh here.
    if ((state.phase as RunState["phase"]) !== "done") state.elapsedMs += Date.now() - sliceStart;
    for (const e of state.events.slice(eventsBefore)) opts.onEvent?.(e);
  }
  return state;
}

async function runUnit(s: Session, activity: Activity, url: string, mode: Mode): Promise<UnitResult> {
  switch (activity) {
    case "load":
      return loadUnit(s, url);
    case "a11y":
      return a11yUnit(s, url);
    case "layout":
      return layoutUnit(s, url);
    case "buttons":
      return buttonsUnit(s, url);
    case "forms":
      return formsUnit(s, url);
    case "keyboard":
      return keyboardUnit(s, url, { pressButtons: mode === "full" });
    case "persist":
      return persistUnit(s, url);
    case "boundary":
      return boundaryUnit(s, url);
    default:
      return { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  }
}

/**
 * A journey that did not complete is the most important thing a report can
 * say, so it becomes a finding like any other - verified by replay before it
 * is reported, with the screen at the moment it stopped as evidence.
 *
 * A journey Owly merely looked at (a passive scan) produces no finding: not
 * having tried is not the same as having failed.
 */
function applyJourney(state: RunState, journey: Journey): void {
  const where = journey.steps.filter((s) => !s.ok)[0] ?? journey.steps.at(-1);
  emit(
    state,
    journey.completed ? "confirmed" : journey.lookedOnly ? "info" : "suspect",
    journey.completed
      ? `A new visitor could ${journey.goal.toLowerCase()} in ${journey.steps.length} steps`
      : journey.lookedOnly
        ? `Found the way in ("${journey.entry ?? "none"}"), but a passive scan does not press it`
        : `A new visitor could not ${journey.goal.toLowerCase()}: ${journey.reason ?? "unknown"}`,
  );
  // Reported only when the site did something demonstrably wrong. Owly
  // stopping (a guarded button, a passive scan) is its own decision, and Owly
  // running out of road usually means it did not understand this product -
  // neither is evidence of a defect.
  if (!journey.hardFailure || journey.completed || journey.lookedOnly || journey.stoppedByOwly || !journey.reason) return;

  const shots = journey.steps
    .filter((s) => s.shot)
    .slice(-2)
    .map((s): Evidence => ({ type: "screenshot", ref: s.shot!, caption: `Step ${s.n}: ${s.action} - ${s.outcome}` }));

  // Choosing the journey is a heuristic, so the finding is "likely" by
  // default. But when the step that stopped it failed with a status the
  // browser recorded, the stop itself is a fact, not a guess - and it would
  // read oddly for the headline to be less certain than the form finding
  // that corroborates it.
  const hardEvidence = (where?.evidence ?? []).some((e) => e.type === "network" && typeof e.status === "number" && e.status >= 400);

  state.candidates.push({
    kind: "task_blocked",
    title: `A new visitor cannot ${journey.goal.toLowerCase()}`,
    severity: "critical",
    url: where?.url ?? state.target,
    ...(journey.entry ? { target: journey.entry } : {}),
    persona: "new_user",
    summary: journey.reason,
    expected: `Someone arriving at the site can ${journey.goal.toLowerCase()} by following the most prominent call to action.`,
    actual: where ? `${where.action} - ${where.outcome}` : journey.reason,
    steps: journey.steps.map((s) => `${s.action} - ${s.outcome}`),
    evidence: [...(where?.evidence ?? []), ...shots],
    observed: journey.observed,
    inference: [
      "Owly picked this task from the most prominent call to action on the home page; it does not know the product, so the task it chose may not be the one that matters most to you.",
    ],
    deterministic: hardEvidence,
    fingerprint: `task_blocked|${journey.task}`,
    unit: unitKey("new_user", "journey", state.target),
  });
}

/**
 * If the journey got Owly through a door, hold it open.
 *
 * A product is not its landing page. Until now a run tested whatever a
 * stranger could see and stopped at the login, which is the half without any
 * of the product in it. When the journey finishes - signed up, signed in -
 * the browser is holding a session, and this is where it is taken out of the
 * browser and put into the run state, where it survives the slice.
 *
 * Nothing is stored unless the site actually gave Owly something (a cookie or
 * stored token) AND the journey finished, so an abandoned attempt leaves no
 * credentials lying around in the database.
 */
async function keepTheSession(state: RunState, s: Session, journey: Journey): Promise<void> {
  if (!journey.completed || state.auth) return;
  const held = await s.session();
  const cookies = held?.cookies?.length ?? 0;
  const stored = held?.origins?.length ?? 0;
  if (!held || (cookies === 0 && stored === 0)) return;

  state.auth = held;
  state.identity = (journey.identity ?? []).filter((v) => v.length >= 4);
  state.signedInBy = journey.entry ? `following "${journey.entry}"` : "the main journey";
  emit(state, "info", `Signed in ${state.signedInBy} - testing what is behind it`);

  // Whatever the journey landed on is the way into the product. Explore from
  // there as well as from the front page.
  const landed = journey.steps.at(-1)?.url;
  if (landed && sameSite(landed, state.target)) {
    state.pending.push({ kind: "discover", url: landed, from: state.target, via: "signed in" });
  }
}

function addBrokenLinks(
  state: RunState,
  pages: Map<string, number | null>,
  referrers: Map<string, Array<{ from: string; via: string }>>,
): void {
  for (const [url, status] of pages) {
    if (status === null || status < 400) continue;
    const path = new URL(url).pathname;
    for (const ref of referrers.get(url) ?? []) {
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
      state.candidates.push(c);
      emit(state, "suspect", `Possible issue: ${c.title}`);
    }
  }
}

function finish(state: RunState, pages: Map<string, number | null>, sliceStart: number): void {
  const { findings, unverified } = cluster(state.candidates, new Set(state.reproduced));
  for (const f of findings) emit(state, "confirmed", `${f.confidence === "confirmed" ? "Confirmed" : "Likely"}: ${f.title}`);
  for (const f of unverified) emit(state, "dismissed", `Could not reproduce, so not reported: ${f.title}`);
  for (const b of state.blocked) state.notes.push(`Refused to go to ${b.url}: ${b.reason}.`);

  const okCount = [...pages.values()].filter((s) => s !== null && s < 400).length;
  // "No issues" is only meaningful if something was actually tested. A run
  // where nothing opened once reported a clean bill of health for a site it
  // never reached, which is the worst thing this tool could say.
  const failed =
    okCount > 0
      ? null
      : [...pages.values()].every((s) => s === null)
        ? `Owly could not open ${new URL(state.target).host}: nothing answered.`
        : `Owly could not test ${new URL(state.target).host}: no page of it could be opened.`;
  state.elapsedMs += Date.now() - sliceStart;
  emit(state, "info", `Done: ${findings.length} issue${findings.length === 1 ? "" : "s"} found on ${okCount} page${okCount === 1 ? "" : "s"}`);

  // What Owly made of the product, said out loud so a wrong reading is
  // visible rather than buried in the findings underneath it.
  const understanding = understand({
    target: state.target,
    labels: state.labels,
    journey: state.journey,
    signedInBy: state.signedInBy,
    behindLogin: state.behindLogin,
  });
  // Ranked by what a failure costs this product, not by which checker found it.
  findings.sort((a, b) => costOf(a, understanding) - costOf(b, understanding));

  const redact = createRedactor();
  state.report = redact.value<RunReport>({
    target: state.target,
    mode: state.mode,
    focus: state.focus,
    activities: state.activities,
    startedAt: state.createdAt,
    finishedAt: new Date().toISOString(),
    durationMs: state.elapsedMs,
    slices: state.slices,
    findings,
    unverified,
    pages: [...pages].map(([url, status]) => ({ url, status })),
    notes: [...new Set(state.notes)],
    events: state.events,
    journey: state.journey,
    signedInBy: state.signedInBy,
    understanding,
    failed,
  });
  state.phase = "done";
  // The report carries everything a reader needs; the working set does not
  // need to be stored twice.
  state.candidates = [];
  state.pending = [];
}

/**
 * One security pass, in browsers of its own.
 *
 * Fresh contexts every time: the access check needs a browser that has never
 * signed in, and the sign-out check needs one that can be thrown away
 * afterwards, because signing out is not something you can undo and take back.
 */
async function runSecurity(
  browser: Browser,
  opts: ReturnType<typeof sessionOptsShape>,
  state: RunState,
): Promise<{ candidates: Candidate[]; notes: string[] }> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  let confirmedPrivate: string[] = [];

  // 1. What the server says about itself, read from a page load of its own.
  const plain = await Session.open(browser, { ...opts, signedInAs: null });
  try {
    await plain.goto(state.target);
    const headers = headerChecks(plain.net, state.target, plain.opts.persona.key);
    candidates.push(...headers.candidates);
    notes.push(...headers.notes);

    // 2. Pages that needed an account, asked for without one. This also tells
    //    us which of them are private for real, rather than merely pages the
    //    crawl happened to see after signing in.
    if (state.behindLogin.length) {
      const access = await accessChecks(plain, state.target, state.behindLogin, state.identity);
      candidates.push(...access.candidates);
      notes.push(...access.notes);
      confirmedPrivate = access.confirmed;
    }
  } finally {
    await within(plain.close(), 5_000);
  }

  if (!state.auth) return { candidates, notes };

  // 3. The cookie that keeps the session, and 4. whether signing out ends it.
  const signedIn = await Session.open(browser, { ...opts, signedInAs: state.auth });
  try {
    const cookies = await cookieChecks(signedIn, state.target);
    candidates.push(...cookies.candidates);
    notes.push(...cookies.notes);

    // Re-open a page that a session-less browser was actually refused. Using
    // just "the first page seen while signed in" picked the home page, which
    // looks fine to everyone and so proved nothing either way.
    const privatePage = confirmedPrivate[0];
    if (state.signOutUrl && privatePage && state.identity.length) {
      const out = await signOutCheck(signedIn, state.target, state.signOutUrl, privatePage, state.identity);
      candidates.push(...out.candidates);
      notes.push(...out.notes);
    } else if (privatePage && !state.signOutUrl) {
      notes.push("No sign-out link was found, so whether signing out works was not tested.");
    } else if (state.signOutUrl && !privatePage) {
      notes.push("No page turned out to need an account, so whether signing out works could not be tested.");
    }
  } finally {
    await within(signedIn.close(), 5_000);
  }

  return { candidates, notes };
}

/** Only for the type of the options object the machine builds per persona. */
declare function sessionOptsShape(persona: Persona): {
  target: URL;
  persona: Persona;
  allowPrivate: boolean;
  userAgentSuffix: string;
  signedInAs: StorageState | null;
};
