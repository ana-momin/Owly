/**
 * Can a new person actually do the thing this site is for?
 *
 * This is the question a scanner never asks. Broken links and contrast ratios
 * are worth knowing, but they are not what a founder lies awake about: they
 * lie awake about whether the sign-up works. So Owly picks the site's main
 * task, attempts it the way a newcomer would - follow the most prominent
 * call to action, fill in what it asks for, press the button - and ends with
 * a verdict and the frame where it stopped.
 *
 * It is heuristic, and says so. It reports what it did, what it saw, and
 * where it got stuck, and never claims to have understood the product.
 */

import type { Evidence } from "../findings.js";
import { assess } from "../policy/actionGuard.js";
import { sameOrigin } from "../policy/urlGuard.js";
import * as journeyJs from "../browser/journey-inpage.js";
import * as js from "../browser/inpage.js";
import type { NetRecord, Session } from "../browser/session.js";
import { identityMarker, isEmailField, nonce, valueFor, type FieldInfo } from "./synthetic.js";

export type TaskKind = "signup" | "login" | "checkout" | "contact" | "subscribe" | "book" | "generic";

/** What each task is called, and what a control offering it tends to say. */
const TASKS: Array<{ kind: TaskKind; goal: string; pattern: string; needsForm: boolean }> = [
  // "Create a free account", "Start for free": a call to action puts words in
  // the middle, and missing them sent the journey off to the contact form.
  { kind: "signup", goal: "Create an account", pattern: "\\b(sign ?up|create (a |an )?(free |new )?account|get started|start (for )?(free|now)|try (it )?free|join (free|now|us)|register)\\b", needsForm: true },
  { kind: "checkout", goal: "Buy something", pattern: "\\b(add to (cart|bag|basket)|view cart|checkout|buy|order now|shop now)\\b", needsForm: false },
  { kind: "book", goal: "Book a demo or a time", pattern: "\\b(book (a )?(demo|call|time)|schedule|request (a )?demo|talk to sales)\\b", needsForm: true },
  { kind: "contact", goal: "Get in touch", pattern: "\\b(contact( us)?|get in touch|support|help)\\b", needsForm: true },
  { kind: "subscribe", goal: "Subscribe to updates", pattern: "\\b(subscribe|newsletter|join the list|keep me posted)\\b", needsForm: true },
  { kind: "login", goal: "Log in", pattern: "\\b(log ?in|sign ?in)\\b", needsForm: true },
  // The catch-all, used only when nothing above matches. Plenty of products
  // say "Start setup" or "Create a project" rather than anything Owly knows by
  // name, and refusing to try at all is worse than trying and saying what
  // happened.
  {
    kind: "generic",
    goal: "Get started",
    pattern: "^(start|begin|continue|create|launch|set ?up|make|build|add|new|open|apply|request|upload|import|connect)\\b",
    needsForm: false,
  },
];

/** The order tasks are preferred in when a site offers several. */
const PRIORITY: TaskKind[] = ["signup", "checkout", "book", "contact", "subscribe", "login", "generic"];

export interface JourneyStep {
  n: number;
  /** What Owly did, in the words a person would use. */
  action: string;
  url: string;
  /** What happened next. */
  outcome: string;
  ok: boolean;
  ms: number;
  /** A picture of the screen after this step, as a data URL. */
  shot: string | null;
  evidence: Evidence[];
}

export interface Journey {
  task: TaskKind;
  goal: string;
  /** How the journey started: the control a newcomer would press first. */
  entry: string | null;
  steps: JourneyStep[];
  completed: boolean;
  /** Why it stopped, when it did not complete. */
  reason: string | null;
  /** Everything Owly relied on to decide, so the verdict can be argued with. */
  observed: string[];
  durationMs: number;
  /** True when the run was passive, so the journey could only be looked at. */
  lookedOnly: boolean;
  /**
   * True when OWLY stopped, not the site: a guarded control, a form that posts
   * elsewhere, a journey that continues on another website. Owly declining to
   * act is never evidence that the site is broken, so these produce no finding.
   */
  stoppedByOwly: boolean;
  /**
   * True only when the site did something demonstrably wrong: a server error,
   * an error message, valid details rejected, or nothing at all happening. A
   * journey that merely ran out of road - no call to action Owly recognises,
   * no form where it expected one - is NOT a defect: it usually means Owly
   * does not understand this particular product, and saying "your site is
   * broken" on that basis is how a QA tool earns a reputation for noise.
   */
  hardFailure: boolean;
  /**
   * The distinctive things Owly typed to become this account - its email, its
   * name - and never its password. A page that prints one of these back is
   * showing Owly's own account, which is how the security checks tell a
   * genuinely private page from an ordinary one.
   */
  identity?: string[];
}

const SUCCESS_WORDS = /\b(welcome|thank you|thanks|success|confirmed|you're in|check your (inbox|email)|verify your email|account created|we'll be in touch|received)\b/i;
const FAILURE_WORDS = /\b(error|failed|failure|something went wrong|try again|invalid|unable to|couldn't|could not|sorry)\b/i;
const SUCCESS_PATH = /\/(welcome|dashboard|app|home|thanks|thank-you|success|onboarding|verify|confirm)(\/|$|\?)/i;

const isMutation = (r: NetRecord) => r.method !== "GET" && r.method !== "HEAD";

interface Outcome {
  url: string;
  title: string;
  heading: string;
  live: string[];
  invalid: string[];
  textLength: number;
  text: string;
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

/**
 * Attempt the site's main task.
 *
 * `interactive` is false for a passive scan: the journey is then mapped as far
 * as looking allows (which task the site leads with, and whether the form a
 * newcomer must fill is even reachable) and honestly marked as not attempted.
 */
export async function runJourney(s: Session, startUrl: string, interactive: boolean): Promise<Journey | null> {
  const started = Date.now();
  const steps: JourneyStep[] = [];
  const observed: string[] = [];
  let n = 0;

  const step = async (action: string, outcome: string, ok: boolean, at: number, evidence: Evidence[] = []): Promise<void> => {
    steps.push({
      n: ++n,
      action,
      url: s.page.url(),
      outcome,
      ok,
      ms: Date.now() - at,
      shot: await s.shot(),
      evidence,
    });
  };

  // --- 1. the front door --------------------------------------------------
  let at = Date.now();
  const status = await s.goto(startUrl);
  if (status === null || status >= 400) {
    // Returning null here meant the report simply had no verdict on it: a run
    // that opened four pages and said nothing about the main task, with no
    // note explaining why. Say what happened instead. A page that answers 4xx
    // or 5xx is the site failing; a navigation that answers nothing at all may
    // be Owly's own cold browser, so that one is not held against the site.
    observed.push(
      status === null
        ? `The home page did not respond${s.lastNavigationError ? ` (${s.lastNavigationError})` : ""}.`
        : `The home page answered HTTP ${status}.`,
    );
    return {
      task: "signup",
      goal: "Start using the site",
      entry: null,
      steps,
      completed: false,
      reason:
        status === null
          ? "Owly could not open the home page, so it never got to try the main task."
          : `The home page answered HTTP ${status}, so there was nothing to start from.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: !interactive,
      stoppedByOwly: false,
      hardFailure: status !== null,
    };
  }
  await step(`Open ${startUrl}`, `The page loaded${status === 200 ? "" : ` (HTTP ${status})`}`, true, at);

  // --- 2. what is this site asking a newcomer to do? ----------------------
  const patterns = TASKS.map((t) => [t.kind, t.pattern]);
  const entries = await s.eval<Array<{ id: string; name: string; task: TaskKind; href: string | null; describe: string; prominence: number }>>(
    journeyJs.RANK_ENTRY_POINTS.replace("TASK_PATTERNS", JSON.stringify(patterns)),
  );
  if (entries.length === 0) {
    observed.push("No sign-up, checkout, contact or similar call to action was found on the home page.");
    return {
      task: "signup",
      goal: "Start using the site",
      entry: null,
      steps,
      completed: false,
      reason: "Owly could not find a way in: nothing on the home page offers to sign up, buy, book or get in touch.",
      observed,
      durationMs: Date.now() - started,
      lookedOnly: !interactive,
      stoppedByOwly: false,
      hardFailure: false,
    };
  }

  // The most prominent control, of the highest-priority task offered.
  const offered = new Set(entries.map((e) => e.task));
  const chosenTask = PRIORITY.find((t) => offered.has(t)) ?? entries[0]!.task;
  const entry = entries.filter((e) => e.task === chosenTask).sort((a, b) => b.prominence - a.prominence)[0]!;
  const task = TASKS.find((t) => t.kind === chosenTask)!;
  observed.push(
    `The most prominent way in is "${entry.name}" (${entry.describe}), which offers to ${task.goal.toLowerCase()}.`,
    `Other ways in seen: ${entries.filter((e) => e.id !== entry.id).slice(0, 4).map((e) => `"${e.name}"`).join(", ") || "none"}.`,
  );

  const guard = assess({ name: entry.name, role: entry.href ? "link" : "button", ...(entry.href ? { target: entry.href } : {}) });
  if (guard.risk === "destructive" || !interactive) {
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: !interactive
        ? `This was a passive scan, so Owly did not press "${entry.name}". Verify the site to have the whole journey attempted.`
        : `Owly does not press "${entry.name}" automatically: ${guard.reason}.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: !interactive,
      stoppedByOwly: true,
      hardFailure: false,
    };
  }

  // --- 3. press it --------------------------------------------------------
  at = Date.now();
  const before = await s.eval<Outcome>(journeyJs.READ_OUTCOME).catch(() => null);
  let mark = s.mark();
  const pressed = await s.page
    .locator(`[data-owly-entry="${entry.id}"]`)
    .click({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await s.settle(6_000);

  if (!pressed) {
    await step(`Press "${entry.name}"`, "The button could not be pressed: something was in the way, or it never became clickable.", false, at);
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: `A new user cannot get started: "${entry.name}" could not be pressed.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: false,
      hardFailure: false,
    };
  }

  const afterClick = await s.eval<Outcome>(journeyJs.READ_OUTCOME);
  const leftSite = s.since(mark).blocked.some((b) => !sameOrigin(b.url, s.opts.target));
  if (leftSite) {
    await step(`Press "${entry.name}"`, "It leads to another website, so Owly stopped there.", true, at);
    observed.push(`"${entry.name}" leaves the site, so the rest of the journey is not Owly's to test.`);
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: `The journey continues on another website, which Owly does not follow.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: true,
      hardFailure: false,
    };
  }
  await step(`Press "${entry.name}"`, `Arrived at ${new URL(afterClick.url).pathname}${afterClick.heading ? ` - "${afterClick.heading}"` : ""}`, true, at);

  // --- 4. fill in what it asks for ---------------------------------------
  const form = await s.eval<{ index: number; count: number } | null>(journeyJs.DESCRIBE_MAIN_FORM);
  if (!form) {
    // Never "completed" without having actually done something. Reaching a
    // cart is not buying, and claiming a purchase journey works when Owly
    // deliberately refuses to buy would be the worst kind of false comfort.
    // "Nothing happened" has to be evidenced. A dialog opening, or the page
    // text changing, is something happening even when the URL does not move -
    // Owly called a newsletter dialog "led nowhere" because its fields were
    // not inside a <form>, and reported a working button as a blocked journey.
    const dialogs = await s.eval<Array<{ describe: string; label: string }>>(js.OPEN_DIALOGS).catch(() => []);
    const textChanged = Boolean(before && before.text !== afterClick.text);
    const progressed =
      afterClick.url !== startUrl || dialogs.length > 0 || textChanged || SUCCESS_WORDS.test(afterClick.text.slice(0, 600));
    const nowhere = !progressed;
    if (dialogs.length > 0) {
      observed.push(`Pressing it opened "${dialogs[0]!.label || dialogs[0]!.describe}", which has no form Owly could fill in.`);
    }
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: nowhere
        ? `Pressing "${entry.name}" led nowhere: the page did not change and there is nothing to fill in.`
        : chosenTask === "checkout"
          ? `Owly got as far as ${new URL(afterClick.url).pathname}. It does not complete purchases, so the rest of this journey is untested.`
          : `Owly got as far as ${new URL(afterClick.url).pathname} and found nothing to fill in, so it could not finish ${task.goal.toLowerCase()}.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      // Reaching a cart and stopping is Owly's own limit, not a defect.
      stoppedByOwly: chosenTask === "checkout" && progressed,
      // "Pressing the main call to action does nothing" is a real, evidenced
      // failure; running out of forms to fill is not.
      hardFailure: nowhere,
    };
  }

  const formUrl = s.page.url();
  const fields = await s.eval<Array<FieldInfo & { key: string }>>(js.LIST_FORMS).then((forms) => {
    const all = forms as unknown as Array<{ index: number; fields: Array<FieldInfo & { key: string }>; submit: { name: string } | null }>;
    return all.find((f) => f.index === form.index)?.fields ?? [];
  });
  const formInfo = (await s.eval<Array<{ index: number; submit: { name: string } | null; action: string; method: string }>>(js.LIST_FORMS)).find(
    (f) => f.index === form.index,
  );
  const submitName = formInfo?.submit?.name ?? "Submit";

  if (!formInfo?.submit) {
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: `The form on ${new URL(formUrl).pathname} has no submit button Owly could find.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: false,
      hardFailure: false,
    };
  }
  if (formInfo.action && !sameOrigin(formInfo.action, s.opts.target)) {
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: `The form sends its data to another site (${new URL(formInfo.action).origin}), which Owly does not do.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: true,
      hardFailure: false,
    };
  }
  const submitGuard = assess({ name: submitName, role: "submit", target: formInfo.action, method: formInfo.method });
  if (submitGuard.risk === "destructive") {
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed: false,
      reason: `Owly stopped before pressing "${submitName}": ${submitGuard.reason}. A person would carry on from here.`,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: true,
      hardFailure: false,
    };
  }

  at = Date.now();
  const filled: string[] = [];
  const couldNotFill: string[] = [];
  const identity: string[] = [];
  const seed = nonce();
  for (const field of fields) {
    const value = valueFor(field, seed);
    if (!value) continue;
    const loc = s.page.locator(`[data-owly-field="${field.key}"]`);
    try {
      if (value.kind === "select") await loc.selectOption(value.value, { timeout: 10_000 });
      else if (value.kind === "check") await loc.check({ timeout: 10_000 });
      else await loc.fill(value.value, { timeout: 10_000 });
      // Remember who Owly just claimed to be. Later checks use this to tell a
      // page that belongs to this account from a page that belongs to nobody.
      const marker = value.kind === "text" ? identityMarker(field, value.value) : null;
      if (marker && marker.length >= 4 && !identity.includes(marker)) identity.push(marker);
      filled.push(`${field.label || field.name || field.type}: ${field.type === "password" ? "(a password)" : value.value}`);
    } catch (err) {
      couldNotFill.push(`${field.label || field.name || field.type} (${String(err).split("\n")[0]!.slice(0, 80)})`);
    }
  }
  observed.push(`Filled in: ${filled.join("; ") || "nothing"}.`);
  if (couldNotFill.length) observed.push(`Could not fill: ${couldNotFill.join("; ")}.`);
  await step(
    `Fill in the ${TASKS.find((t) => t.kind === chosenTask)!.goal.toLowerCase()} form`,
    `Entered test details in ${filled.length} field${filled.length === 1 ? "" : "s"}${couldNotFill.length ? `; ${couldNotFill.length} could not be filled` : ""}`,
    couldNotFill.length === 0,
    at,
  );

  // --- 5. press the button and judge what happened ------------------------
  at = Date.now();
  mark = s.mark();
  const submitted = await s.page
    .locator(`[data-owly-submit="${form.index}"]`)
    .click({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await s.settle(10_000);
  const after = await s.eval<Outcome>(journeyJs.READ_OUTCOME).catch(() => null);
  const events = s.since(mark);
  const requests = events.net.filter((r) => !r.blockedByOwly && sameOrigin(r.url, s.opts.target) && ["fetch", "xhr", "document"].includes(r.resourceType));
  const mutations = requests.filter(isMutation);
  const failed = mutations.filter((r) => r.status === null || r.status >= 500);
  const rejected = mutations.filter((r) => r.status !== null && r.status >= 400 && r.status < 500);
  const succeeded = mutations.filter((r) => r.status !== null && r.status >= 200 && r.status < 300);
  const evidence = mutations.slice(0, 4).map(netEvidence);

  if (!submitted) {
    await step(`Press "${submitName}"`, "The button could not be pressed.", false, at, evidence);
    return verdict(false, `A new user cannot ${task.goal.toLowerCase()}: "${submitName}" could not be pressed.`, true);
  }

  const urlChanged = after && after.url !== formUrl;
  const saysSuccess = Boolean(after && (after.live.some((l) => SUCCESS_WORDS.test(l)) || SUCCESS_WORDS.test(after.heading) || SUCCESS_WORDS.test(after.text.slice(0, 400))));
  const saysFailure = Boolean(after && (after.live.some((l) => FAILURE_WORDS.test(l)) || FAILURE_WORDS.test(after.heading)));
  const wentSomewhereGood = Boolean(after && urlChanged && SUCCESS_PATH.test(new URL(after.url).pathname));
  const message = after?.live.find((l) => l.trim()) ?? "";

  if (failed.length > 0) {
    const r = failed[0]!;
    observed.push(`${r.method} ${new URL(r.url).pathname} answered ${r.status ?? r.error}.`);
    if (message) observed.push(`The page said: "${message}".`);
    await step(`Press "${submitName}"`, `The server failed: ${r.method} ${new URL(r.url).pathname} returned ${r.status ?? r.error}`, false, at, evidence);
    return verdict(false, `A new user cannot ${task.goal.toLowerCase()}: submitting valid details returns ${r.status ?? "a network error"}.`, true);
  }

  if (after && after.invalid.length > 0 && !saysSuccess) {
    observed.push(`The form rejected details Owly considers valid: ${after.invalid.join("; ")}.`);
    await step(`Press "${submitName}"`, `The form rejected the details: ${after.invalid[0]}`, false, at, evidence);
    return verdict(false, `A new user cannot ${task.goal.toLowerCase()}: the form rejected plausible details (${after.invalid[0]}).`, true);
  }

  if (rejected.length > 0 && !saysSuccess) {
    const r = rejected[0]!;
    observed.push(`${r.method} ${new URL(r.url).pathname} answered ${r.status}${message ? `, and the page said "${message}"` : ""}.`);
    await step(`Press "${submitName}"`, `The request was refused: ${r.status}${message ? ` - "${message}"` : ""}`, false, at, evidence);
    return verdict(false, `A new user cannot ${task.goal.toLowerCase()}: the site refused the submission (HTTP ${r.status}).`, true);
  }

  if (saysFailure && !saysSuccess) {
    observed.push(`The page reported a problem: "${message}".`);
    await step(`Press "${submitName}"`, `The page showed an error: "${message}"`, false, at, evidence);
    return verdict(false, `A new user cannot ${task.goal.toLowerCase()}: the site answered "${message}".`, true);
  }

  if (succeeded.length > 0 || saysSuccess || wentSomewhereGood) {
    const how = saysSuccess
      ? `the page said "${message || after?.heading}"`
      : wentSomewhereGood
        ? `it moved on to ${new URL(after!.url).pathname}`
        : `the site accepted it (HTTP ${succeeded[0]?.status})`;
    observed.push(`Accepted: ${how}.`);
    await step(`Press "${submitName}"`, `Accepted - ${how}`, true, at, evidence);
    return verdict(true, null);
  }

  // Nothing observable happened at all.
  observed.push("After pressing the button, no request was sent, the page did not change, and no message appeared.");
  await step(`Press "${submitName}"`, "Nothing happened: no request, no new page, no message", false, at, evidence);
  return verdict(false, `A new user cannot tell whether it worked: pressing "${submitName}" produced no response at all.`, true);

  function verdict(completed: boolean, reason: string | null, hardFailure = false): Journey {
    return {
      task: chosenTask,
      goal: task.goal,
      entry: entry.name,
      steps,
      completed,
      reason,
      observed,
      durationMs: Date.now() - started,
      lookedOnly: false,
      stoppedByOwly: false,
      hardFailure,
      identity,
    };
  }
}
