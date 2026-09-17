/**
 * Every setting Owly reads, in one place (spec §48.14).
 *
 * Read from the environment once. Anything that loosens a safety rule is
 * refused in production rather than trusted: a misconfigured flag should fail
 * loudly at startup, not quietly let the browser reach a private network.
 */

export type Env = "production" | "development" | "test";

export interface Config {
  env: Env;
  /**
   * Lets the browser reach localhost and private ranges. Exists for the lab,
   * whose deliberately broken apps run on 127.0.0.1. Never allowed in
   * production - see `load`.
   */
  allowPrivateTargets: boolean;
  /** Sent on every request, so a site owner can see who is testing them. */
  userAgentSuffix: string;
  budgets: {
    /** Pages a single run may visit. */
    maxPages: number;
    /** Wall time one serverless invocation may spend before yielding. */
    sliceMs: number;
    /** Wall time a whole run may take across all its slices. */
    maxRunMs: number;
    navigationTimeoutMs: number;
    /** How long to wait for a page to settle after an action. */
    settleMs: number;
  };
}

function readEnv(): Env {
  const raw = (process.env.OWLY_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

function flag(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").toLowerCase());
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function load(): Config {
  const env = readEnv();
  const allowPrivateTargets = flag("OWLY_ALLOW_PRIVATE_TARGETS");

  if (env === "production" && allowPrivateTargets) {
    throw new Error(
      "OWLY_ALLOW_PRIVATE_TARGETS is set in production. Refusing to start: " +
        "it would let a tested site steer the browser into a private network.",
    );
  }

  return {
    env,
    allowPrivateTargets,
    userAgentSuffix: "OwlyQA/0.1 (+automated QA test run by the site owner)",
    budgets: {
      maxPages: int("OWLY_MAX_PAGES", 25),
      sliceMs: int("OWLY_SLICE_MS", 45_000),
      maxRunMs: int("OWLY_MAX_RUN_MS", 8 * 60_000),
      navigationTimeoutMs: int("OWLY_NAV_TIMEOUT_MS", 20_000),
      settleMs: int("OWLY_SETTLE_MS", 1_500),
    },
  };
}
