/**
 * Where runs and idempotency records live between requests.
 *
 * Postgres in production, memory in tests - behind one interface, so the API
 * tests exercise the same lease and replay logic the deployment uses. Foxy's
 * third Pond rejection point was task and idempotency state kept in module
 * dictionaries, invisible to the next instance; nothing here is held in
 * process memory in production.
 */

import type { RunState } from "./engine/machine.js";

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface StoredRun {
  id: string;
  pondRunId: string | null;
  status: RunStatus;
  state: RunState;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Replay {
  statusCode: number;
  payload: unknown;
}

export interface Store {
  createRun(run: { id: string; pondRunId: string | null; state: RunState }): Promise<void>;
  getRun(id: string): Promise<StoredRun | null>;
  /**
   * Take the run for one slice. Null if another request holds it, or it has
   * already finished. The lease expires on its own, so a slice that dies
   * mid-way (timeout, crash) never locks the run forever.
   */
  claim(id: string, leaseMs: number): Promise<StoredRun | null>;
  /** Save after a slice and release the lease. */
  saveRun(id: string, patch: { status: RunStatus; state: RunState; error?: string | null; attempts?: number }): Promise<void>;
  recall(key: string): Promise<Replay | null>;
  remember(key: string, replay: Replay): Promise<void>;
  /**
   * Add one to a named counter and return the new value. The replay cache
   * cannot do this - it is write-once by design - and the free try-it limits
   * need a count that actually goes up, atomically, across instances.
   */
  bump(key: string): Promise<number>;
}

// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private runs = new Map<string, StoredRun & { leaseUntil: number }>();
  private replays = new Map<string, Replay>();
  private counters = new Map<string, number>();

  async createRun(run: { id: string; pondRunId: string | null; state: RunState }): Promise<void> {
    const now = new Date().toISOString();
    this.runs.set(run.id, {
      id: run.id,
      pondRunId: run.pondRunId,
      status: "queued",
      // Stored as JSON, as Postgres would, so nothing shares references.
      state: JSON.parse(JSON.stringify(run.state)),
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
    });
  }

  async getRun(id: string): Promise<StoredRun | null> {
    const r = this.runs.get(id);
    return r ? this.copy(r) : null;
  }

  async claim(id: string, leaseMs: number): Promise<StoredRun | null> {
    const r = this.runs.get(id);
    if (!r || r.status === "completed" || r.status === "failed") return null;
    if (r.leaseUntil > Date.now()) return null;
    r.leaseUntil = Date.now() + leaseMs;
    if (r.status === "queued") r.status = "running";
    return this.copy(r);
  }

  async saveRun(id: string, patch: { status: RunStatus; state: RunState; error?: string | null; attempts?: number }): Promise<void> {
    const r = this.runs.get(id);
    if (!r) return;
    r.status = patch.status;
    r.state = JSON.parse(JSON.stringify(patch.state));
    if (patch.error !== undefined) r.error = patch.error;
    if (patch.attempts !== undefined) r.attempts = patch.attempts;
    r.leaseUntil = 0;
    r.updatedAt = new Date().toISOString();
  }

  async recall(key: string): Promise<Replay | null> {
    return this.replays.get(key) ?? null;
  }

  async remember(key: string, replay: Replay): Promise<void> {
    if (!this.replays.has(key)) this.replays.set(key, JSON.parse(JSON.stringify(replay)));
  }

  async bump(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  private copy(r: StoredRun): StoredRun {
    const { leaseUntil: _ignored, ...rest } = r as StoredRun & { leaseUntil: number };
    return JSON.parse(JSON.stringify(rest));
  }
}

// ---------------------------------------------------------------------------

/**
 * Neon over HTTP. Each query is one fetch, so there is no connection pool to
 * go stale while a serverless instance is frozen between requests - the
 * failure that took down Foxy's first Pond scan.
 */
export async function neonStore(databaseUrl: string): Promise<Store> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(databaseUrl);

  let ready: Promise<void> | null = null;
  const ensure = () =>
    (ready ??= (async () => {
      await sql`CREATE TABLE IF NOT EXISTS owly_runs (
        id text PRIMARY KEY,
        pond_run_id text,
        status text NOT NULL,
        state jsonb NOT NULL,
        error text,
        attempts integer NOT NULL DEFAULT 0,
        lease_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS owly_idempotency (
        key text PRIMARY KEY,
        status_code integer NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS owly_counters (
        key text PRIMARY KEY,
        n integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((err) => {
      ready = null;
      throw err;
    }));

  type Row = {
    id: string;
    pond_run_id: string | null;
    status: RunStatus;
    state: RunState | string;
    error: string | null;
    attempts: number;
    created_at: string | Date;
    updated_at: string | Date;
  };
  const toRun = (row: Row): StoredRun => ({
    id: row.id,
    pondRunId: row.pond_run_id,
    status: row.status,
    state: typeof row.state === "string" ? (JSON.parse(row.state) as RunState) : row.state,
    error: row.error,
    attempts: row.attempts,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

  return {
    async createRun(run) {
      await ensure();
      // Retention (spec §30): runs older than 30 days, replays older than 7,
      // are removed as new work arrives. No scheduler needed.
      await sql`DELETE FROM owly_runs WHERE created_at < now() - interval '30 days'`;
      await sql`DELETE FROM owly_idempotency WHERE created_at < now() - interval '7 days'`;
      await sql`INSERT INTO owly_runs (id, pond_run_id, status, state)
                VALUES (${run.id}, ${run.pondRunId}, 'queued', ${JSON.stringify(run.state)}::jsonb)`;
    },

    async getRun(id) {
      await ensure();
      const rows = (await sql`SELECT * FROM owly_runs WHERE id = ${id}`) as Row[];
      return rows[0] ? toRun(rows[0]) : null;
    },

    async claim(id, leaseMs) {
      await ensure();
      // One statement: check and take the lease atomically, so two polls
      // arriving together cannot both run the same slice.
      const rows = (await sql`
        UPDATE owly_runs
           SET lease_until = now() + (${leaseMs} * interval '1 millisecond'),
               status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
               updated_at = now()
         WHERE id = ${id}
           AND status IN ('queued', 'running')
           AND (lease_until IS NULL OR lease_until < now())
     RETURNING *`) as Row[];
      return rows[0] ? toRun(rows[0]) : null;
    },

    async saveRun(id, patch) {
      await ensure();
      await sql`
        UPDATE owly_runs
           SET status = ${patch.status},
               state = ${JSON.stringify(patch.state)}::jsonb,
               error = COALESCE(${patch.error ?? null}, error),
               attempts = COALESCE(${patch.attempts ?? null}, attempts),
               lease_until = NULL,
               updated_at = now()
         WHERE id = ${id}`;
    },

    async recall(key) {
      await ensure();
      const rows = (await sql`SELECT status_code, payload FROM owly_idempotency WHERE key = ${key}`) as Array<{ status_code: number; payload: unknown }>;
      const row = rows[0];
      if (!row) return null;
      return { statusCode: row.status_code, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload };
    },

    async remember(key, replay) {
      await ensure();
      await sql`INSERT INTO owly_idempotency (key, status_code, payload)
                VALUES (${key}, ${replay.statusCode}, ${JSON.stringify(replay.payload)}::jsonb)
                ON CONFLICT (key) DO NOTHING`;
    },

    async bump(key) {
      await ensure();
      // One statement, so two visitors arriving at once cannot both read the
      // same number and both be let through.
      const rows = (await sql`INSERT INTO owly_counters (key, n) VALUES (${key}, 1)
                ON CONFLICT (key) DO UPDATE SET n = owly_counters.n + 1, updated_at = now()
                RETURNING n`) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 1);
    },
  };
}
