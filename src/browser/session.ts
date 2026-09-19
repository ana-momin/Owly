/**
 * A browser session Owly can be trusted to drive.
 *
 * Three things happen here that must never be left to the code above:
 *
 *   1. Every request the page makes passes the URL guard. Top-level navigation
 *      away from the target origin is refused outright, which is what makes a
 *      page that says "go here instead" harmless.
 *   2. Everything the browser does is recorded: console messages, uncaught
 *      exceptions, every request with its status and timing. Detectors work
 *      from this record, never from assumptions.
 *   3. Owly's own interventions are recorded too, so a request Owly blocked is
 *      never mistaken for a request the site failed.
 */

import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { checkUrl, pinArgs, sameOrigin } from "../policy/urlGuard.js";
import type { Viewport } from "../findings.js";

export interface Persona {
  key: "new_user" | "mobile_impatient" | "keyboard_only";
  label: string;
  viewport: Viewport;
  isMobile: boolean;
  hasTouch: boolean;
  /** How long this user waits for a page to calm down before judging it. */
  patienceMs: number;
}

export const PERSONAS: Record<Persona["key"], Persona> = {
  new_user: {
    key: "new_user",
    label: "New user (desktop)",
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    patienceMs: 8_000,
  },
  mobile_impatient: {
    key: "mobile_impatient",
    label: "Impatient mobile user",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    patienceMs: 4_000,
  },
  keyboard_only: {
    key: "keyboard_only",
    label: "Keyboard-only user",
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    patienceMs: 6_000,
  },
};

export interface NetRecord {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  startedAt: number;
  /** Request body, truncated. Needed to prove what the server accepted. */
  postData: string | null;
  /** True when Owly's guard refused it - never a site failure. */
  blockedByOwly: boolean;
  isNavigation: boolean;
}

export interface ConsoleRecord {
  level: string;
  text: string;
  at: number;
  location: string;
}

export interface ErrorRecord {
  message: string;
  stack: string;
  at: number;
}

export interface BlockRecord {
  url: string;
  reason: string;
  at: number;
}

export interface SessionOptions {
  target: URL;
  persona: Persona;
  allowPrivate: boolean;
  userAgentSuffix: string;
}

export async function launchBrowser(target: URL, allowPrivate: boolean): Promise<Browser> {
  // Pin the target host to the address that passed the guard, so the browser
  // cannot be handed a different one mid-run. Skipped for the lab, whose apps
  // are already on a literal loopback address.
  const extraArgs: string[] = [];
  if (!allowPrivate) {
    const verdict = await checkUrl(target.href, { allowPrivate });
    if (!verdict.ok) throw new Error(`target refused: ${verdict.reason}`);
    const first = verdict.addresses[0];
    if (first && first !== target.hostname) extraArgs.push(...pinArgs(target, first));
  }

  const serverless = Boolean(process.env.VERCEL) || process.env.OWLY_BROWSER === "serverless";
  if (serverless) {
    const { default: chromium } = await import("@sparticuz/chromium");
    const { chromium: playwright } = await import("playwright-core");
    const browser = await playwright.launch({
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, ...extraArgs],
      headless: true,
    });
    // Serverless Chromium runs as a single process, and closing its last
    // context can take the whole browser down with it - the next session then
    // fails with "browser has been closed". This context is never used and
    // never closed, so every session Owly opens and closes has company.
    await browser.newContext();
    return browser;
  }
  const { chromium: playwright } = await import("playwright");
  return playwright.launch({ headless: true, args: extraArgs });
}

export class Session {
  readonly net: NetRecord[] = [];
  readonly console: ConsoleRecord[] = [];
  readonly errors: ErrorRecord[] = [];
  readonly blocked: BlockRecord[] = [];
  /** Response bodies of same-origin documents and scripts, for source snippets. */
  readonly sources = new Map<string, string>();

  private readonly inflight = new Map<Request, NetRecord>();
  /** Requests Owly's guard refused, so they are never read as site failures. */
  private readonly refused = new WeakSet<Request>();
  private lastNetworkEvent = Date.now();

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly opts: SessionOptions,
  ) {}

  static async open(browser: Browser, opts: SessionOptions): Promise<Session> {
    // Built from the version rather than read from a scratch page: opening
    // and closing a page just to read navigator.userAgent was what killed the
    // single-process serverless browser.
    const platform = opts.persona.isMobile
      ? "Linux; Android 14; Pixel 8"
      : "X11; Linux x86_64";
    const ua = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()}${opts.persona.isMobile ? " Mobile" : ""} Safari/537.36`;

    const context = await browser.newContext({
      viewport: opts.persona.viewport,
      isMobile: opts.persona.isMobile,
      hasTouch: opts.persona.hasTouch,
      userAgent: `${ua} ${opts.userAgentSuffix}`,
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    const session = new Session(context, page, opts);
    await session.install();
    return session;
  }

  private async install(): Promise<void> {
    const { page, context, opts } = this;

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();

      // data: and blob: URLs never leave the browser.
      if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();

      const isTopNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();

      // Refusing a top-level navigation with abort() makes Chromium replace the
      // page with its own error document - which Owly would then go on to test,
      // reporting "no <title>" on a page the site never served, and losing the
      // real page's links. A 204 answer is the spec's way to say "stay where
      // you are": the browser keeps the current document untouched.
      const refuse = async (reason: string) => {
        this.blocked.push({ url, reason, at: Date.now() });
        this.refused.add(request);
        if (isTopNavigation) return route.fulfill({ status: 204, body: "" });
        return route.abort("blockedbyclient");
      };

      if (isTopNavigation && !sameOrigin(url, opts.target)) {
        return refuse("navigation away from the site under test");
      }

      const verdict = await checkUrl(url, { allowPrivate: opts.allowPrivate });
      if (!verdict.ok) return refuse(verdict.reason);
      return route.continue();
    });

    page.on("console", (msg) => {
      const loc = msg.location();
      this.console.push({
        level: msg.type(),
        text: msg.text(),
        at: Date.now(),
        location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : "",
      });
    });

    // alert(), confirm() and prompt() stop the page until someone answers, and
    // a page that is stopped also stops every evaluation Owly runs in it. They
    // are dismissed, which for confirm() means "Cancel" - the safe answer when
    // the question might be "Delete this?".
    page.on("dialog", (dialog) => {
      this.console.push({ level: "dialog", text: `${dialog.type()}: ${dialog.message()}`, at: Date.now(), location: "" });
      dialog.dismiss().catch(() => undefined);
    });

    page.on("pageerror", (err) => {
      this.errors.push({ message: err.message, stack: err.stack ?? "", at: Date.now() });
    });

    page.on("request", (request) => {
      this.lastNetworkEvent = Date.now();
      const record: NetRecord = {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        status: null,
        error: null,
        durationMs: null,
        startedAt: Date.now(),
        postData: (request.postData() ?? "").slice(0, 4000) || null,
        blockedByOwly: false,
        isNavigation: request.isNavigationRequest(),
      };
      this.inflight.set(request, record);
      this.net.push(record);
    });

    page.on("requestfinished", async (request) => {
      this.lastNetworkEvent = Date.now();
      const record = this.inflight.get(request);
      this.inflight.delete(request);
      if (!record) return;
      record.durationMs = Date.now() - record.startedAt;
      record.blockedByOwly = this.refused.has(request);
      const response = await request.response().catch(() => null);
      record.status = response?.status() ?? null;
      const type = request.resourceType();
      if (response && (type === "document" || type === "script") && sameOrigin(request.url(), opts.target)) {
        const body = await response.text().catch(() => "");
        if (body.length < 500_000) this.sources.set(request.url(), body);
      }
    });

    page.on("requestfailed", (request) => {
      this.lastNetworkEvent = Date.now();
      const record = this.inflight.get(request);
      this.inflight.delete(request);
      if (!record) return;
      record.durationMs = Date.now() - record.startedAt;
      record.error = request.failure()?.errorText ?? "failed";
      record.blockedByOwly = this.refused.has(request) || /BLOCKED_BY_CLIENT/i.test(record.error);
    });
  }

  /** A position in the event log, to read "everything since" later. */
  mark(): { net: number; console: number; errors: number; blocked: number; at: number } {
    return {
      net: this.net.length,
      console: this.console.length,
      errors: this.errors.length,
      blocked: this.blocked.length,
      at: Date.now(),
    };
  }

  since(m: ReturnType<Session["mark"]>) {
    return {
      net: this.net.slice(m.net),
      console: this.console.slice(m.console),
      errors: this.errors.slice(m.errors),
      blocked: this.blocked.slice(m.blocked),
    };
  }

  /**
   * Wait until the page stops talking to the network, or the persona runs out
   * of patience. Slow requests are waited for (up to the limit) because a
   * request that never finishes cannot be timed, and timing it is the point.
   */
  async settle(maxMs = this.opts.persona.patienceMs, quietMs = 500): Promise<void> {
    const deadline = Date.now() + maxMs;
    await this.page.waitForLoadState("load", { timeout: maxMs }).catch(() => undefined);
    while (Date.now() < deadline) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetworkEvent >= quietMs) return;
      await this.page.waitForTimeout(100);
    }
  }

  /**
   * Navigate and settle. Returns the main document's HTTP status.
   *
   * `patienceMs` shortens the wait for units that only read the rendered page
   * (layout, accessibility, keyboard). Waiting out a six-second API call before
   * measuring a table's width costs six seconds and tells us nothing; the load
   * unit is the one that waits, because timing that call is its job.
   */
  async goto(url: string, patienceMs = this.opts.persona.patienceMs, timeoutMs = 20_000): Promise<number | null> {
    // A serverless browser can lose its very first navigation: the instance is
    // cold, nothing is warm, and the page comes back with nothing at all. That
    // produced a live run that tested 0 pages and told the owner their site
    // did not answer - when it was up the whole time. One retry tells "the site
    // is down" apart from "the browser was not ready yet".
    let response = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        this.lastNavigationError = null;
      } catch (err) {
        this.lastNavigationError = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0]!.trim();
        response = null;
      }
      if (response) break;
      if (attempt === 0) await this.page.waitForTimeout(700).catch(() => undefined);
    }
    this.lastContentType = response?.headers()["content-type"] ?? null;
    await this.settle(patienceMs);
    return response?.status() ?? null;
  }

  /** Why the last navigation produced nothing, when it produced nothing. */
  lastNavigationError: string | null = null;

  /** Content type of the last document navigation, for deciding if it is a page at all. */
  lastContentType: string | null = null;

  async eval<T>(script: string): Promise<T> {
    return (await this.page.evaluate(script)) as T;
  }

  /**
   * A picture of what the user would be looking at, as a data URL.
   *
   * JPEG at a modest quality, and the viewport only - a full-page shot of a
   * long marketing page is megabytes, and what matters is the screen at the
   * moment something went wrong. Password fields are masked by the browser
   * anyway (dots), and Owly only ever types synthetic data.
   */
  async shot(): Promise<string | null> {
    try {
      const buffer = await this.page.screenshot({ type: "jpeg", quality: 55, timeout: 8_000 });
      if (buffer.byteLength > 400_000) return null;
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
