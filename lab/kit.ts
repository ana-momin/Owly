/**
 * The little web framework the lab apps are written in.
 *
 * Deliberately not Express: the lab's job is to be predictable, and every bug
 * in it must be one we put there on purpose. A hundred lines we own beats a
 * dependency whose behaviour can shift the benchmark underneath us.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: string;
  /** Per-app counters the benchmark reads - e.g. whether "Pay" was ever pressed. */
  hit: (name: string) => void;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export interface LabApp {
  key: string;
  name: string;
  port: number;
  /** "GET /signup" -> handler. */
  routes: Record<string, Handler>;
}

export function html(ctx: Ctx, body: string, status = 200): void {
  ctx.res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  ctx.res.end(body);
}

export function json(ctx: Ctx, data: unknown, status = 200): void {
  ctx.res.writeHead(status, { "content-type": "application/json" });
  ctx.res.end(JSON.stringify(data));
}

export function redirect(ctx: Ctx, to: string, status = 303): void {
  ctx.res.writeHead(status, { location: to });
  ctx.res.end();
}

/**
 * A complete, well-formed page. The clean control app depends on this being
 * genuinely correct - language set, a title, a main landmark, an icon so the
 * browser does not request a missing /favicon.ico - so that any finding on it
 * is Owly's mistake and not the lab's.
 */
export function page(title: string, main: string, opts: { head?: string; bodyAttrs?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #ffffff; }
  header, main, footer { padding: 16px; max-width: 960px; margin: 0 auto; }
  nav a { margin-right: 12px; }
  a { color: #0b57d0; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input, select, textarea { font: inherit; padding: 8px; width: 100%; max-width: 360px; border: 1px solid #6b6b6b; border-radius: 6px; }
  button { font: inherit; padding: 10px 16px; margin-top: 16px; background: #0b57d0; color: #ffffff; border: 0; border-radius: 6px; cursor: pointer; }
  .notice { padding: 12px; border-radius: 6px; margin-top: 16px; }
  .ok { background: #e6f4ea; color: #0d652d; }
  .err { background: #fce8e6; color: #a50e0e; }
</style>
${opts.head ?? ""}
</head>
<body ${opts.bodyAttrs ?? ""}>
${main}
</body>
</html>`;
}

export function formValue(body: string, name: string): string {
  return new URLSearchParams(body).get(name) ?? "";
}

export function jsonBody<T = Record<string, unknown>>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
