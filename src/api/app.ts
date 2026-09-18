/**
 * Owly's HTTP surface: the Pond protocol and the report pages.
 *
 *   GET  /api/manifest          public discovery document
 *   POST /api/runs              Pond starts an action (Bearer key + protocol header)
 *   GET  /api/tasks/:id         Pond polls a long action; each poll runs one slice
 *   GET  /api/r/:id             the report page, or live progress while running
 *   POST /api/r/:id/advance     the progress page moving its own run forward
 *   GET  /api/health
 *
 * Built by `createApp` from injected pieces, so tests drive the exact same
 * routes with an in-memory store and a stubbed ownership check.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { advance, newRun, type Focus, type RunState } from "../engine/machine.js";
import type { OwnershipResult } from "../policy/ownership.js";
import { checkUrl } from "../policy/urlGuard.js";
import { failedPage, notFoundPage, progressPage, reportPage, contentSecurityPolicy } from "../report/html.js";
import { pondMarkdown } from "../report/text.js";
import type { Store, StoredRun } from "../store.js";
import { ACTIONS, AGENT_VERSION, manifest, MAX_REQUEST_BYTES, PROTOCOL_VERSION } from "./manifest.js";
import { Invalid, validate } from "./params.js";

export interface AppDeps {
  store: Store;
  /** The Pond Access Key. Unset means Pond is refused, not let through. */
  accessKey: string;
  allowPrivate: boolean;
  checkOwnership: (url: string) => Promise<OwnershipResult>;
  ownershipInstructions: (url: string) => string;
  /** Budget for one slice of a test. */
  sliceMs: number;
  /** How long a slice holds the run. Longer than a slice, shorter than forever. */
  leaseMs: number;
  maxPages: number;
}

type Json = Record<string, unknown>;

function perr(c: Context, code: string, message: string, status: number, runId?: string, details?: Json) {
  const body: Json = { error: { code, message, ...(details ? { details } : {}) } };
  if (runId) body.run_id = runId;
  return c.json(body, status as 400);
}

const usage = (quantity: number) => ({ unit_of_measurement: "result", quantity });

function completed(runId: string, text: string, quantity = 0): Json {
  return { run_id: runId, status: "completed", output: [{ type: "text", text }], usage: usage(quantity) };
}

function newId(): string {
  return `t_${randomBytes(15).toString("base64url")}`;
}

function normaliseSite(raw: string): string {
  const trimmed = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One slice of a run, if nobody else is running one. Returns the run afterwards. */
export async function advanceRun(deps: AppDeps, id: string): Promise<StoredRun | null> {
  const claimed = await deps.store.claim(id, deps.leaseMs);
  if (!claimed) return deps.store.getRun(id);
  try {
    const state = await advance(claimed.state as RunState, { deadline: Date.now() + deps.sliceMs });
    await deps.store.saveRun(id, { status: state.phase === "done" ? "completed" : "running", state, attempts: 0 });
  } catch (err) {
    // The slice is discarded and the run resumes from its last saved state on
    // the next poll. Three failures in a row and it stops, rather than
    // billing a poll loop that can never finish.
    const attempts = claimed.attempts + 1;
    console.error(`run ${id} slice failed (attempt ${attempts})`, err);
    await deps.store.saveRun(id, {
      status: attempts >= 3 ? "failed" : "running",
      state: claimed.state,
      error: attempts >= 3 ? "The test could not be completed. Nothing was billed." : String(err).slice(0, 300),
      attempts,
    });
  }
  return deps.store.getRun(id);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono().basePath("/api");

  const origin = (c: Context) => new URL(c.req.url).origin;
  const reportUrl = (c: Context, id: string) => `${origin(c)}/r/${id}`;

  // Pond's runtime endpoints: version first, then the key. /manifest needs neither.
  const guard = (c: Context) => {
    const version = (c.req.header("x-agent-protocol-version") ?? "").trim();
    if (!version) return perr(c, "invalid_request", "The X-Agent-Protocol-Version header is required.", 400);
    if (!/^\d+\.\d+$/.test(version)) return perr(c, "invalid_request", `Malformed protocol version '${version}'.`, 400);
    if (version !== PROTOCOL_VERSION) return perr(c, "unsupported_protocol_version", `This agent supports Pond Protocol ${PROTOCOL_VERSION}.`, 400);
    if (!deps.accessKey) return perr(c, "temporarily_unavailable", "This agent has not been configured for Pond yet.", 503);
    const auth = (c.req.header("authorization") ?? "").trim();
    if (!safeEqual(auth, `Bearer ${deps.accessKey}`)) return perr(c, "unauthorized", "A valid Access Key is required.", 401);
    return null;
  };

  app.on(["GET", "HEAD"], "/manifest", (c) => c.json(manifest()));

  app.get("/health", (c) => c.json({ status: "ok", agent: "owly", agent_version: AGENT_VERSION }));

  app.post("/runs", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
      return perr(c, "invalid_request", `The request body is larger than the ${MAX_REQUEST_BYTES} byte limit.`, 413);
    }
    let body: Json;
    try {
      body = JSON.parse(raw) as Json;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return perr(c, "invalid_request", "The request body must be a JSON object.", 400);
    }

    const runId = typeof body.run_id === "string" && body.run_id ? body.run_id : randomUUID();
    const actionId = body.action_id;

    // Pond documents no caller identity. Log anything it sends that Owly does
    // not read, so if that changes it shows up in the logs on its own.
    const extra = Object.keys(body).filter((k) => !["run_id", "action_id", "parameters"].includes(k));
    if (extra.length) console.log(`pond sent unread fields: ${extra.join(", ")}`);

    // A repeated key gets the first answer back, status code and all, instead
    // of starting a second test.
    const key = c.req.header("idempotency-key") ?? runId;
    const replay = await deps.store.recall(key);
    if (replay) return c.json(replay.payload as Json, replay.statusCode as 200);

    const spec = ACTIONS.find((a) => a.id === actionId);
    if (!spec) {
      return perr(c, "unsupported_operation", `Unknown action '${String(actionId)}'. Supported: ${ACTIONS.map((a) => a.id).join(", ")}.`, 400, runId);
    }

    let params: Json;
    try {
      params = validate(body.parameters, spec.input_schema);
    } catch (err) {
      if (err instanceof Invalid) return perr(c, "invalid_input", err.message, 422, runId, { field: err.field });
      throw err;
    }

    const answer = async (payload: Json, status = 200) => {
      await deps.store.remember(key, { statusCode: status, payload });
      return c.json(payload, status as 200);
    };

    try {
      if (spec.id === "start_test") {
        const site = normaliseSite(String(params.url));
        const verdict = await checkUrl(site, { allowPrivate: deps.allowPrivate });
        if (!verdict.ok) {
          return perr(c, "invalid_input", `Owly cannot test ${site}: ${verdict.reason}.`, 422, runId, { field: "parameters.url" });
        }
        const ownership = await deps.checkOwnership(site).catch(() => null);
        const mode = ownership?.verified ? "full" : "passive";
        const state = await newRun(site, {
          mode,
          focus: (params.focus as Focus | undefined) ?? "everything",
          allowPrivate: deps.allowPrivate,
          maxPages: deps.maxPages,
        });
        const id = newId();
        await deps.store.createRun({ id, pondRunId: runId, state });
        console.log(`start_test ${id} ${new URL(site).host} mode=${mode} focus=${state.focus}`);
        return answer({ run_id: runId, task_id: id, status: "queued", poll_after_ms: 1000 }, 202);
      }

      if (spec.id === "get_report") {
        const run = await deps.store.getRun(String(params.test_id));
        if (!run) return answer(completed(runId, `No Owly test has the id \`${String(params.test_id)}\`. Reports are kept for 30 days.`));
        if (run.status === "completed" && run.state.report) {
          return answer(completed(runId, `${pondMarkdown(run.state.report, reportUrl(c, run.id))}\n\nTest id: \`${run.id}\``));
        }
        if (run.status === "failed") return answer(completed(runId, `That test did not finish: ${run.error ?? "unknown error"}. Nothing was billed.`));
        const latest = run.state.events.at(-1)?.text ?? "Queued";
        return answer(completed(runId, `That test is still running. Latest: ${latest}\n\nWatch it live: ${reportUrl(c, run.id)}`));
      }

      if (spec.id === "verify_site") {
        const site = normaliseSite(String(params.url));
        const verdict = await checkUrl(site, { allowPrivate: deps.allowPrivate });
        if (!verdict.ok) {
          return perr(c, "invalid_input", `Owly cannot check ${site}: ${verdict.reason}.`, 422, runId, { field: "parameters.url" });
        }
        const result = await deps.checkOwnership(site);
        const host = new URL(site).host;
        const text = result.verified
          ? `**${host} is verified** (found the token in the ${result.method === "file" ? "verification file" : result.method === "meta" ? "home page meta tag" : "DNS TXT record"}). Owly will run full tests on it, filling in forms and pressing buttons.`
          : `**${host} is not verified yet.**\n\n${deps.ownershipInstructions(site)}\n\nAfter adding it, ask Owly to check again.`;
        return answer(completed(runId, text));
      }

      // health_check
      return answer(completed(runId, `Owly is up (version ${AGENT_VERSION}).`));
    } catch (err) {
      console.error(`run ${runId} failed`, err);
      return c.json({
        run_id: runId,
        status: "failed",
        error: { code: "internal_error", message: "Owly could not complete this request." },
        usage: usage(0),
      });
    }
  });

  app.on(["GET", "HEAD"], "/tasks/:id", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const id = c.req.param("id");

    let run = await deps.store.getRun(id);
    if (!run) return perr(c, "task_not_found", "That task does not exist.", 404);

    // The poll is the worker: one bounded slice, then report whatever is true.
    if (run.status === "queued" || run.status === "running") run = (await advanceRun(deps, id)) ?? run;

    const runId = run.pondRunId ?? id;
    if (run.status === "queued" || run.status === "running") {
      return c.json({ run_id: runId, task_id: id, status: "running", poll_after_ms: 1000 });
    }
    if (run.status === "failed") {
      return c.json({
        run_id: runId,
        task_id: id,
        status: "failed",
        error: { code: "internal_error", message: run.error ?? "The test did not complete." },
        usage: usage(0),
      });
    }
    const report = run.state.report!;
    return c.json({
      run_id: runId,
      task_id: id,
      status: "completed",
      output: [{ type: "text", text: `${pondMarkdown(report, reportUrl(c, id))}\n\nTest id: \`${id}\`` }],
      // One finished test is one result, whatever it found - but a test that
      // could not open the site is not a result and is not charged for.
      usage: usage(report.failed ? 0 : 1),
    });
  });

  const reportPageRoute = async (c: Context) => {
    const nonce = randomBytes(16).toString("base64");
    c.header("content-security-policy", contentSecurityPolicy(nonce));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    const run = await deps.store.getRun(c.req.param("id") ?? "");
    if (!run) return c.html(notFoundPage(nonce), 404);
    if (run.status === "completed" && run.state.report) return c.html(reportPage(run.state.report, nonce));
    if (run.status === "failed") return c.html(failedPage(run.state.target, run.error ?? "The test did not complete.", nonce));
    return c.html(progressPage(run.id, run.state, nonce));
  };
  app.get("/r/:id", reportPageRoute);

  app.post("/r/:id/advance", async (c) => {
    const id = c.req.param("id");
    let run = await deps.store.getRun(id);
    if (!run) return c.json({ error: "not found" }, 404);
    if (run.status === "queued" || run.status === "running") run = (await advanceRun(deps, id)) ?? run;
    const events = run.state.report?.events ?? run.state.events;
    return c.json({ status: run.status, events });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));

  // The short link people are given is /r/:id. Vercel rewrites it to the
  // /api/r/:id function but hands the app the ORIGINAL path - so the app has
  // to answer /r/:id itself, or every shared report link is a 404.
  const root = new Hono();
  root.get("/r/:id", reportPageRoute);
  root.route("/", app);
  root.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));
  return root;
}
