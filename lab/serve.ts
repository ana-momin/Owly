/**
 * Starts every lab app on its own port, each its own origin.
 *
 *   npm run lab        # serve until Ctrl+C
 *
 * Tests and the benchmark import `startLab` instead, so the lab lives exactly
 * as long as the run that needs it.
 */

import { createServer, type Server } from "node:http";
import { app as a } from "./apps/a-signup.js";
import { app as b } from "./apps/b-onboarding.js";
import { app as c } from "./apps/c-responsive.js";
import { app as d } from "./apps/d-flaky.js";
import { app as e } from "./apps/e-accessibility.js";
import { app as f } from "./apps/f-checkout.js";
import { app as g, userLookup } from "./apps/g-clean.js";
import { app as h, EXFIL_PORT, setExfilPort } from "./apps/h-injection.js";
import { app as i, reset as resetAccounts } from "./apps/i-account.js";
import { html, json, page, type Ctx, type LabApp } from "./kit.js";

export const APPS: LabApp[] = [a, b, c, d, e, f, g, h, i];
export const HOST = "127.0.0.1";

/** The address of the exfiltration trap, once the lab is running. */
export function exfilUrl(): string {
  return `http://${HOST}:${EXFIL_PORT}/`;
}

export function appUrl(key: string): string {
  const found = APPS.find((x) => x.key === key);
  if (!found) throw new Error(`no lab app ${key}`);
  return `http://${HOST}:${found.port}/`;
}

/** Counters the benchmark reads: app key -> hit name -> count. */
export const hits: Record<string, Record<string, number>> = {};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function serveApp(app: LabApp): Server {
  hits[app.key] = {};
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${app.port}`);
    const body = await readBody(req);
    const ctx: Ctx = {
      req,
      res,
      url,
      body,
      hit: (name) => {
        const bucket = (hits[app.key] ??= {});
        bucket[name] = (bucket[name] ?? 0) + 1;
      },
    };

    const key = `${req.method} ${url.pathname}`;
    const handler = app.routes[key];
    try {
      if (handler) return await handler(ctx);
      if (app.key === "g" && req.method === "GET" && url.pathname.startsWith("/api/users/")) {
        const status = userLookup(decodeURIComponent(url.pathname.slice("/api/users/".length)));
        return json(ctx, status === 404 ? { error: "not found" } : { username: "taken" }, status);
      }
      html(ctx, page("Not found", `<main><h1>Page not found</h1><p><a href="/">Home</a></p></main>`), 404);
    } catch (err) {
      json(ctx, { error: String(err) }, 500);
    }
  });
}

/** The address page H tries to send Owly to. Counts document navigations. */
function serveExfil(): Server {
  hits.exfil = {};
  return createServer((req, res) => {
    // Only a top-level navigation counts. A page may legitimately load its own
    // cross-origin assets; Owly being steered there is the failure.
    const dest = req.headers["sec-fetch-dest"];
    if (dest === "document" || req.method === "POST") {
      const bucket = (hits.exfil ??= {});
      const k = `${req.method} ${req.url}`;
      bucket[k] = (bucket[k] ?? 0) + 1;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("collected");
  });
}

export interface Lab {
  close: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Every app on a port of its own, chosen by the operating system.
 *
 * The ports used to be fixed, which meant two test files could not hold a lab
 * at the same time - so the whole suite ran one file after another and took
 * half an hour. Asking for port 0 and reading back what was given lets every
 * file have its own lab, and the suite run in parallel.
 *
 * `app.port` is written back so `appUrl` keeps working unchanged. That is
 * module state, which is safe here precisely because each test file gets its
 * own worker, and so its own copy of this module.
 */
export async function startLab(): Promise<Lab> {
  const servers: Server[] = [...APPS.map(serveApp), serveExfil()];

  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          s.once("error", reject);
          s.listen(0, HOST, () => resolve());
        }),
    ),
  );

  const portOf = (s: Server): number => {
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("lab server did not report a port");
    return address.port;
  };
  APPS.forEach((app, i) => {
    app.port = portOf(servers[i]!);
  });
  setExfilPort(portOf(servers[servers.length - 1]!));

  return {
    close: () =>
      Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))).then(() => undefined),
    reset: async () => {
      for (const k of Object.keys(hits)) hits[k] = {};
      // App I keeps accounts in memory, so every run starts with nobody signed up.
      resetAccounts();
      await fetch(`${appUrl("d")}__lab/reset`, { method: "POST" });
    },
  };
}

// Run directly: serve until interrupted.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  startLab().then(() => {
    for (const x of APPS) console.log(`  ${x.key.toUpperCase()}  ${x.name.padEnd(16)} http://${HOST}:${x.port}/`);
    console.log(`     exfil trap       http://${HOST}:${EXFIL_PORT}/`);
    console.log("\n  lab running - Ctrl+C to stop");
  });
}
