/**
 * Everything needed to START a run, with no browser anywhere in reach.
 *
 * This file exists for a bill. Every serverless function that imported
 * `machine.js` pulled Chromium in with it - 80MB of it, per function, per
 * deployment - and the free tier's 10GB of function storage went in a day of
 * UI edits. Only the two endpoints that actually drive a browser need that
 * weight; creating a run, listing a manifest and rendering a report do not.
 *
 * So the pure half lives here: what a run is allowed to check, and the state
 * it starts from. `machine.ts` imports these and adds the browser.
 */

import { load } from "../config.js";
import { checkUrl } from "../policy/urlGuard.js";
import type { Activity } from "./candidate.js";
import type { Focus, Mode, RunEvent, RunState } from "./machine.js";

/** Which checks a mode and focus allow. The single place scope is decided. */
export function activitiesFor(mode: Mode, focus: Focus): Activity[] {
  const interactive: Activity[] = mode === "full" ? ["buttons", "forms", "persist", "boundary"] : [];
  switch (focus) {
    case "forms":
      return ["journey", "load", "links", ...interactive];
    case "mobile":
      return ["load", "links", "layout"];
    case "accessibility":
      return ["load", "links", "a11y", "keyboard"];
    default:
      return ["journey", "load", "links", "a11y", "layout", ...interactive, "keyboard", "security"];
  }
}

export function normalise(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

export function emit(state: RunState, level: RunEvent["level"], text: string): void {
  state.events.push({ at: new Date().toISOString(), level, text });
  // A progress feed, not an audit log: the oldest lines go first.
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
}

export interface NewRunOptions {
  mode: Mode;
  focus?: Focus;
  allowPrivate?: boolean;
  maxPages?: number;
  maxRunMs?: number;
}

/** Validates the target before anything is stored. Throws with a reason. */
export async function newRun(targetUrl: string, opts: NewRunOptions): Promise<RunState> {
  const config = load();
  const allowPrivate = opts.allowPrivate ?? config.allowPrivateTargets;
  const verdict = await checkUrl(targetUrl, { allowPrivate });
  if (!verdict.ok) throw new Error(verdict.reason);
  const target = normalise(verdict.url.href);
  const focus = opts.focus ?? "everything";

  const state: RunState = {
    v: 1,
    target,
    mode: opts.mode,
    focus,
    allowPrivate,
    maxPages: opts.maxPages ?? config.budgets.maxPages,
    maxRunMs: opts.maxRunMs ?? config.budgets.maxRunMs,
    phase: "discover",
    pending: activitiesFor(opts.mode, focus).includes("journey")
      ? [{ kind: "journey" }, { kind: "discover", url: target, from: null, via: "start" }]
      : [{ kind: "discover", url: target, from: null, via: "start" }],
    pages: [],
    referrers: [],
    candidates: [],
    reproduced: [],
    blocked: [],
    notes: [],
    events: [],
    activities: activitiesFor(opts.mode, focus),
    exploringStopped: false,
    behindLogin: [],
    labels: [],
    signOutUrl: null,
    identity: [],
    auth: null,
    signedInBy: null,
    journey: null,
    createdAt: new Date().toISOString(),
    elapsedMs: 0,
    slices: 0,
    report: null,
  };
  if (opts.mode === "passive") {
    state.notes.push(
      "Passive scan: Owly looked but did not press buttons or submit forms, because ownership of this site has not been verified.",
    );
  }
  emit(state, "info", `Test queued for ${new URL(target).origin} (${opts.mode === "full" ? "full test" : "passive scan"}, focus: ${focus})`);
  return state;
}
