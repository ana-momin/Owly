/**
 * The report page, and the live progress view while a test is running.
 *
 * Nearly every string on this page came from a website Owly does not trust:
 * console messages, page text, button labels, URLs. So every value is escaped
 * at the point it is placed, with no exceptions, and the page is served with a
 * Content-Security-Policy that allows only its own inline script (by nonce).
 * A tested site that logs `<script>` must end up as text on this page, never
 * as code.
 */

import type { Evidence, Finding } from "../findings.js";
import type { RunEvent, RunReport, RunState } from "../engine/machine.js";
import { confidenceLine, counts, issueMarkdown } from "./text.js";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const CSS = `
:root{--paper:#f7f6f2;--card:#fff;--ink:#16181d;--ink2:#4a4f5a;--dim:#8a8f99;--line:#e7e5df;
--accent:#3b3bd6;--accent-soft:#ececfd;--crit:#b42318;--high:#c2410c;--med:#a16207;--low:#4a5568;--ok:#15803d}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.w{max-width:880px;margin:0 auto;padding:40px 20px 80px}
a{color:var(--accent)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;color:var(--ink);text-decoration:none;margin-bottom:28px}
.brand i{width:26px;height:26px;border-radius:8px;background:var(--ink);display:grid;place-items:center;font-style:normal;color:#fff;font-size:14px}
h1{font-size:30px;letter-spacing:-.03em;line-height:1.15;margin:0 0 6px}
.sub{color:var(--ink2);margin:0 0 26px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:30px}
.pill{font-size:12.5px;padding:4px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--ink2)}
.pill b{color:var(--ink);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:34px}
@media(max-width:620px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:26px;letter-spacing:-.03em;line-height:1.1}
.stat span{font-size:12px;color:var(--dim)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:600;margin:34px 0 12px}
.f{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:12px;overflow:hidden}
.f summary{list-style:none;cursor:pointer;padding:16px 18px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start}
.f summary::-webkit-details-marker{display:none}
.sev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:6px;color:#fff;margin-top:2px}
.sev.critical{background:var(--crit)}.sev.high{background:var(--high)}.sev.medium{background:var(--med)}.sev.low{background:var(--low)}.sev.info{background:var(--dim)}
.f .t{font-weight:600;letter-spacing:-.01em}
.f .c{grid-column:2;font-size:13px;color:var(--dim)}
.body{padding:0 18px 18px;border-top:1px solid var(--line)}
.body p{margin:14px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}
@media(max-width:620px){.cols{grid-template-columns:1fr}}
.box{background:var(--paper);border-radius:10px;padding:12px 14px;font-size:14px}
.box b{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:4px}
ol,ul{margin:6px 0;padding-left:20px}
li{margin:3px 0}
.saw li{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12.5px;word-break:break-word}
.think{border-left:3px solid var(--accent);padding:2px 0 2px 12px;color:var(--ink2);font-size:14px}
.think em{display:block;font-style:normal;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:2px}
.ev{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12px;background:#15171c;color:#e6e6e6;border-radius:10px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.actions{display:flex;gap:8px;margin-top:14px}
button.btn{font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer}
button.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.empty{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;text-align:center;color:var(--ink2)}
.muted{color:var(--dim);font-size:13.5px}
.log{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 0;max-height:420px;overflow:auto}
.log div{display:grid;grid-template-columns:70px 1fr;gap:10px;padding:6px 16px;font-size:13.5px}
.log time{color:var(--dim);font-variant-numeric:tabular-nums}
.log .suspect span{color:var(--med)}.log .confirmed span{color:var(--ok);font-weight:600}.log .dismissed span{color:var(--dim)}.log .warn span{color:var(--high)}
.pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-right:8px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.25}}
.notice{background:var(--accent-soft);border-radius:12px;padding:14px 16px;color:#262673;font-size:14px;margin-bottom:26px}
footer{margin-top:50px;color:var(--dim);font-size:12.5px}
`;

function evidenceText(e: Evidence): string {
  switch (e.type) {
    case "network":
      return `${e.method} ${e.url} -> ${e.status ?? e.error ?? "failed"}${e.durationMs !== undefined ? ` (${e.durationMs}ms)` : ""}`;
    case "console":
      return `[${e.level}] ${e.text}`;
    case "dom":
      return `${e.selector}: ${e.snippet}`;
    case "a11y":
      return `${e.rule} (${e.impact}): ${e.help}\n${e.nodes.join("\n")}`;
    case "measurement":
      return `${e.name}: ${e.value}${e.unit}${e.threshold !== undefined ? ` (threshold ${e.threshold}${e.unit})` : ""}`;
    case "screenshot":
      return `screenshot: ${e.caption}`;
  }
}

function findingCard(f: Finding, report: RunReport, index: number): string {
  const issue = issueMarkdown(f, report);
  const where = f.occurrences && f.occurrences.length > 1 ? ` · ${f.occurrences.length} pages` : "";
  return `
<details class="f"${index === 0 ? " open" : ""}>
  <summary>
    <span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
    <span class="t">${esc(f.title)}</span>
    <span class="c">${esc(confidenceLine(f))} · ${esc(f.persona ?? "")}${f.viewport ? ` · ${f.viewport.width}x${f.viewport.height}` : ""}${esc(where)}</span>
  </summary>
  <div class="body">
    <p>${esc(f.summary)}</p>
    <div class="cols">
      <div class="box"><b>Expected</b>${esc(f.expected)}</div>
      <div class="box"><b>Actual</b>${esc(f.actual)}</div>
    </div>
    <b class="muted">To reproduce</b>
    <ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <b class="muted">What Owly saw</b>
    <ul class="saw">${f.observed.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
    ${f.inference.length ? `<div class="think"><em>What that suggests (reasoning, not a confirmed cause)</em>${f.inference.map(esc).join("<br>")}</div>` : ""}
    ${f.evidence.length ? `<p class="muted">Evidence</p><div class="ev">${f.evidence.map((e) => esc(evidenceText(e))).join("\n\n")}</div>` : ""}
    ${f.occurrences && f.occurrences.length > 1 ? `<p class="muted">Seen on: ${f.occurrences.map(esc).join(", ")}</p>` : ""}
    <div class="actions">
      <button class="btn" type="button" data-copy="issue-${index}">Copy as GitHub issue</button>
    </div>
    <textarea id="issue-${index}" hidden>${esc(`${issue.title}\n\n${issue.body}`)}</textarea>
  </div>
</details>`;
}

function shell(title: string, body: string, nonce: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="w">
<a class="brand" href="/"><i>O</i>Owly</a>
${body}
<footer>Owly runs rule-based checks and scripted user behaviour in a real browser. Every issue listed was reproduced in a fresh browser before being reported.</footer>
</div>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body></html>`;
}

export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const COPY_SCRIPT = `
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-copy]");
  if (!b) return;
  var src = document.getElementById(b.getAttribute("data-copy"));
  navigator.clipboard.writeText(src.value).then(function () {
    var old = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = old; }, 1500);
  });
});`;

export function reportPage(report: RunReport, nonce: string): string {
  const ok = report.pages.filter((p) => p.status !== null && p.status < 400).length;
  const seconds = Math.round(report.durationMs / 1000);
  const high = report.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const refused = report.notes.filter((n) => /^(Not |Refused )/.test(n));
  const other = report.notes.filter((n) => !/^(Not |Refused )/.test(n));

  const body = `
<h1>${esc(new URL(report.target).host)}</h1>
<p class="sub">${esc(counts(report.findings))}, found by trying the site as a new desktop user, an impatient phone user and a keyboard-only user.</p>
<div class="meta">
  <span class="pill"><b>${report.mode === "full" ? "Full test" : "Passive scan"}</b></span>
  <span class="pill">Focus: <b>${esc(report.focus)}</b></span>
  <span class="pill">Checks: <b>${esc(report.activities.join(", "))}</b></span>
  <span class="pill">${esc(new Date(report.finishedAt).toUTCString())}</span>
</div>
${report.mode === "passive" ? `<div class="notice">This was a passive scan. Owly looked at every page but did not press buttons or submit forms, because ownership of the site has not been verified. Verify the site to run a full test.</div>` : ""}
<div class="stats">
  <div class="stat"><b>${report.findings.length}</b><span>issues</span></div>
  <div class="stat"><b>${high}</b><span>high or critical</span></div>
  <div class="stat"><b>${ok}</b><span>pages tested</span></div>
  <div class="stat"><b>${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}</b><span>test time</span></div>
</div>

<h2>Issues</h2>
${report.findings.length ? report.findings.map((f, i) => findingCard(f, report, i)).join("") : `<div class="empty">No problems reproduced. Every suspected issue was checked again in a fresh browser before it could be listed here.</div>`}

${report.unverified.length ? `<h2>Seen once, not reproduced</h2><p class="muted">These appeared during the test but did not happen again on replay, so they are not counted as issues.</p><ul class="muted">${report.unverified.map((f) => `<li>${esc(f.title)}</li>`).join("")}</ul>` : ""}

${refused.length ? `<h2>What Owly refused to do</h2><ul class="muted">${refused.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${other.length ? `<h2>Notes</h2><ul class="muted">${other.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}

<h2>Pages</h2>
<ul class="muted">${report.pages.map((p) => `<li>${esc(p.url)} <span>(${p.status ?? "no response"})</span></li>`).join("")}</ul>

<details><summary class="muted" style="cursor:pointer;margin-top:26px">Full timeline (${report.events.length} events)</summary>
<div class="log" style="margin-top:10px">${report.events.map(eventRow).join("")}</div></details>`;

  return shell(`Owly report: ${new URL(report.target).host}`, body, nonce, COPY_SCRIPT);
}

function eventRow(e: RunEvent): string {
  const t = new Date(e.at).toISOString().slice(11, 19);
  return `<div class="${esc(e.level)}"><time>${t}</time><span>${esc(e.text)}</span></div>`;
}

/**
 * While a test runs. The page advances the run itself as well as watching it,
 * so a test keeps going if the chat that started it has gone quiet. The lease
 * in the store means this and a Pond poll can never run the same slice twice.
 */
export function progressPage(id: string, state: RunState, nonce: string): string {
  const body = `
<h1><span class="pulse"></span>Testing ${esc(new URL(state.target).host)}</h1>
<p class="sub">${state.mode === "full" ? "Full test" : "Passive scan"} · focus: ${esc(state.focus)}. This page updates as Owly works. Every line below is something that actually happened.</p>
<div class="log" id="log">${state.events.map(eventRow).join("")}</div>`;

  const script = `
var id = ${JSON.stringify(id)};
var log = document.getElementById("log");
function row(e) {
  var d = document.createElement("div"); d.className = e.level;
  var t = document.createElement("time"); t.textContent = e.at.slice(11, 19);
  var s = document.createElement("span"); s.textContent = e.text;
  d.appendChild(t); d.appendChild(s); return d;
}
var shown = log.children.length;
async function tick() {
  try {
    var r = await fetch("/api/r/" + encodeURIComponent(id) + "/advance", { method: "POST" });
    var data = await r.json();
    var events = data.events || [];
    for (var i = shown; i < events.length; i++) log.appendChild(row(events[i]));
    shown = events.length;
    log.scrollTop = log.scrollHeight;
    if (data.status === "completed" || data.status === "failed") { location.reload(); return; }
  } catch (e) {}
  setTimeout(tick, 1500);
}
tick();`;
  return shell(`Testing ${new URL(state.target).host}`, body, nonce, script);
}

export function failedPage(target: string, error: string, nonce: string): string {
  return shell(
    "Owly: test did not finish",
    `<h1>The test of ${esc(host(target))} did not finish</h1><p class="sub">${esc(error)}</p>`,
    nonce,
  );
}

export function notFoundPage(nonce: string): string {
  return shell("Owly: report not found", `<h1>Report not found</h1><p class="sub">It may have been removed: reports are kept for 30 days.</p>`, nonce);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
