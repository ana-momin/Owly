/**
 * A page that hangs must not hang the test.
 *
 * The first real site Owly tested in production ran one slice past Vercel's
 * 120-second limit, and the platform killed it. Nothing bounded a single work
 * item, and a page can stop an evaluation forever. This page does exactly
 * that: it loads normally, then locks its own main thread.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advance, newRun, type RunState } from "../src/engine/machine.js";

let server: Server;
const PORT = 4190;
const base = `http://127.0.0.1:${PORT}/`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/stuck") {
      res.end(`<!doctype html><html lang="en"><head><title>Stuck</title></head><body><main><h1>Stuck</h1><p><a href="/">Home</a></p></main>
        <script>setTimeout(function () { for (;;) {} }, 300);</script></body></html>`);
      return;
    }
    res.end(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p><a href="/stuck">A page that hangs</a></p></main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("a page that hangs", () => {
  it("is skipped with a note, and the run still finishes", async () => {
    const limit = 6_000;
    let state: RunState = await newRun(base, { mode: "passive", focus: "accessibility", allowPrivate: true });
    const sliceTimes: number[] = [];

    for (let i = 0; i < 60 && state.phase !== "done"; i++) {
      const started = Date.now();
      state = await advance(state, { deadline: Date.now() + 20_000, itemLimitMs: limit });
      sliceTimes.push(Date.now() - started);
      state = JSON.parse(JSON.stringify(state)) as RunState;
    }

    expect(state.phase).toBe("done");
    // No slice may run much past its deadline plus one item limit plus closing.
    expect(Math.max(...sliceTimes)).toBeLessThan(20_000 + limit + 12_000);
    const notes = state.report!.notes.join("\n");
    expect(notes).toMatch(/Skipped .*\/stuck/);
    // The healthy page was still tested.
    expect(state.report!.pages.some((p) => p.url === base && p.status === 200)).toBe(true);
  }, 400_000);
});
