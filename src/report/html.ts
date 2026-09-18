/**
 * The report page: the answer first, the evidence under it.
 *
 * Version 1 opened with a list of issues, which is what every scanner already
 * gives you and is not what anyone actually wants to know. This opens with the
 * one line that matters - whether a new visitor could do the thing the site is
 * for - and shows the screen where it stopped. Everything else is secondary
 * and is ordered by whether it blocks that journey.
 *
 * Nearly every string here came from a website Owly does not trust: console
 * messages, page text, button labels. Every value is escaped at the point it
 * is placed, and the page is served with a Content-Security-Policy that allows
 * only its own nonced script. A site that logs `<script>` ends up as text.
 */

import type { Evidence, Finding } from "../findings.js";
import type { Journey } from "../engine/journey.js";
import type { RunEvent, RunReport, RunState } from "../engine/machine.js";
import { confidenceLine, issueMarkdown } from "./text.js";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const CSS = `
:root{--paper:#f6f5f1;--card:#fff;--ink:#14161b;--ink2:#474c57;--dim:#5b6270;--line:#e6e4de;
--accent:#3b3bd6;--good:#0f7a43;--good-bg:#e8f6ee;--bad:#b3261e;--bad-bg:#fdecea;--warn:#8a5a00;
--crit:#b3261e;--high:#bf4408;--med:#8a6100;--low:#4b5563;--shadow:0 1px 2px rgba(20,20,30,.05),0 18px 36px -26px rgba(20,20,30,.3)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.w{max-width:940px;margin:0 auto;padding:32px 20px 80px}
a{color:var(--accent)}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.02em;text-decoration:none;color:var(--ink)}
.brand svg{width:26px;height:26px}
.meta{display:flex;gap:7px;flex-wrap:wrap}
.pill{font-size:12px;padding:4px 9px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--ink2)}

/* the verdict */
.verdict{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.verdict .head{display:grid;grid-template-columns:auto 1fr;gap:16px;padding:24px 26px}
.mark{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;flex:none}
.mark svg{width:24px;height:24px;stroke-width:2.5}
.ok .mark{background:var(--good-bg);color:var(--good)}
.no .mark{background:var(--bad-bg);color:var(--bad)}
.idle .mark{background:#eef0f4;color:var(--dim)}
.verdict h1{font-size:clamp(21px,2.9vw,29px);line-height:1.2;letter-spacing:-.03em;margin:2px 0 6px}
.verdict .why{color:var(--ink2);margin:0}
.verdict .why b{color:var(--ink);font-weight:600}
.frames{display:flex;gap:10px;overflow-x:auto;padding:0 26px 22px;scroll-snap-type:x mandatory}
.frame{flex:none;width:230px;scroll-snap-align:start;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--paper);text-align:left;padding:0;font:inherit;cursor:zoom-in}
.frame[disabled]{cursor:default}
.frame img{display:block;width:100%;height:132px;object-fit:cover;object-position:top;background:#fff;border-bottom:1px solid var(--line)}
.frame .cap{padding:9px 11px}
.frame .n{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.frame .act{font-size:13.5px;font-weight:600;letter-spacing:-.01em;margin:1px 0 3px;line-height:1.3}
.frame .out{font-size:12.5px;color:var(--ink2);line-height:1.35}
.frame.bad{border-color:#f3c4bf;background:var(--bad-bg)}
.frame.bad .out{color:var(--bad)}
dialog{border:0;border-radius:14px;padding:0;max-width:min(1100px,94vw);box-shadow:0 30px 60px -20px rgba(0,0,0,.5)}
dialog::backdrop{background:rgba(16,18,24,.66)}
dialog img{display:block;max-width:100%;max-height:78vh}
dialog .dcap{padding:12px 16px;font-size:13.5px;color:var(--ink2);display:flex;justify-content:space-between;gap:12px;align-items:center}
dialog button{font:inherit;font-weight:600;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:6px 12px;cursor:pointer}

/* counts */
.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 30px}
@media(max-width:640px){.counts{grid-template-columns:repeat(2,1fr)}}
.count{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px 16px}
.count b{display:block;font-size:25px;letter-spacing:-.03em;line-height:1.1}
.count span{font-size:12px;color:var(--dim)}

h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);font-weight:650;margin:30px 0 12px}
.f{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden}
.f summary{list-style:none;cursor:pointer;padding:15px 18px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start}
.f summary::-webkit-details-marker{display:none}
.f summary:hover{background:#fbfbf9}
.sev{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:3px 7px;border-radius:6px;color:#fff;margin-top:3px}
.sev.critical{background:var(--crit)}.sev.high{background:var(--high)}.sev.medium{background:var(--med)}.sev.low{background:var(--low)}.sev.info{background:var(--dim)}
.f .t{font-weight:600;letter-spacing:-.012em}
.f .c{grid-column:2;font-size:12.5px;color:var(--dim)}
.body{padding:2px 18px 18px;border-top:1px solid var(--line)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
@media(max-width:640px){.cols{grid-template-columns:1fr}}
.box{background:var(--paper);border-radius:10px;padding:11px 13px;font-size:14px}
.box b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:3px}
.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:650;margin:14px 0 4px}
ol,ul{margin:5px 0;padding-left:20px}
li{margin:3px 0}
.saw li{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-word}
.think{border-left:3px solid var(--accent);padding:3px 0 3px 12px;color:var(--ink2);font-size:14px;margin:12px 0}
.ev{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#14161b;color:#e8e8e8;border-radius:10px;padding:11px 13px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.shot{margin-top:10px;border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:zoom-in;background:none;padding:0;display:block;width:100%}
.shot img{display:block;width:100%}
button.btn{font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer;margin-top:14px}
.empty{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;color:var(--ink2)}
.muted{color:var(--dim);font-size:13.5px}
.log{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 0;max-height:440px;overflow:auto}
.log div{display:grid;grid-template-columns:66px 1fr;gap:10px;padding:5px 16px;font-size:13.5px}
.log time{color:var(--dim);font-variant-numeric:tabular-nums}
.log .suspect span{color:var(--warn)}.log .confirmed span{color:var(--good);font-weight:600}.log .dismissed span{color:var(--dim)}.log .warn span{color:var(--high)}
.pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-right:9px;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.25}}
footer{margin-top:44px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:16px}
`;

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#14161b"/><circle cx="11.5" cy="15" r="4" fill="#fff"/><circle cx="20.5" cy="15" r="4" fill="#fff"/><circle cx="11.5" cy="15" r="1.6" fill="#14161b"/><circle cx="20.5" cy="15" r="1.6" fill="#14161b"/><path d="M14 21l2 2 2-2" stroke="#f5b73b" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TICK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;

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
      return "";
  }
}

let shotSeq = 0;
function shotButton(src: string, caption: string, className = "shot"): string {
  const id = `shot${shotSeq++}`;
  return `<button type="button" class="${className}" data-shot="${esc(src)}" data-cap="${esc(caption)}" id="${id}"><img src="${esc(src)}" alt="${esc(caption)}" loading="lazy"></button>`;
}

/** The answer, at the top, in one sentence. */
function verdictBlock(report: RunReport): string {
  const j = report.journey;
  if (!j) {
    return `<section class="verdict idle"><div class="head">
      <span class="mark">${EYE}</span>
      <div><h1>${esc(new URL(report.target).host)}</h1>
      <p class="why">This run did not attempt the site's main task; it focused on ${esc(report.focus)}.</p></div>
    </div></section>`;
  }

  const blocked = !j.completed && !j.lookedOnly && !j.stoppedByOwly;
  const state = j.completed ? "ok" : blocked ? "no" : "idle";
  const icon = j.completed ? TICK : blocked ? CROSS : EYE;
  const failing = j.steps.filter((s) => !s.ok)[0];

  const headline = j.completed
    ? `A new visitor could ${esc(j.goal.toLowerCase())}`
    : blocked
      ? `A new visitor could not ${esc(j.goal.toLowerCase())}`
      : `Owly did not finish trying to ${esc(j.goal.toLowerCase())}`;

  const why = j.completed
    ? `Followed <b>"${esc(j.entry ?? "")}"</b> and finished in ${j.steps.length} steps, in ${Math.round(j.durationMs / 1000)}s.`
    : failing
      ? `Stopped at step <b>${failing.n} of ${j.steps.length}</b>: ${esc(failing.action)} &mdash; ${esc(failing.outcome)}.`
      : esc(j.reason ?? "");

  const frames = j.steps
    .map((s) => {
      const cap = `Step ${s.n}: ${s.action} - ${s.outcome}`;
      const inner = s.shot
        ? `<img src="${esc(s.shot)}" alt="${esc(cap)}" loading="lazy">`
        : `<div style="height:132px;display:grid;place-items:center;color:var(--dim);font-size:12px">no screenshot</div>`;
      return `<button type="button" class="frame${s.ok ? "" : " bad"}"${s.shot ? ` data-shot="${esc(s.shot)}" data-cap="${esc(cap)}"` : " disabled"}>
        ${inner}
        <span class="cap"><span class="n">Step ${s.n}</span><span class="act">${esc(s.action)}</span><span class="out">${esc(s.outcome)}</span></span>
      </button>`;
    })
    .join("");

  return `<section class="verdict ${state}">
    <div class="head">
      <span class="mark">${icon}</span>
      <div>
        <h1>${headline}</h1>
        <p class="why">${why}</p>
        ${j.stoppedByOwly || j.lookedOnly ? `<p class="muted" style="margin:8px 0 0">${esc(j.reason ?? "")}</p>` : ""}
      </div>
    </div>
    ${frames ? `<div class="frames">${frames}</div>` : ""}
  </section>`;
}

function findingCard(f: Finding, report: RunReport, index: number): string {
  const issue = issueMarkdown(f, report);
  const where = f.occurrences && f.occurrences.length > 1 ? ` · ${f.occurrences.length} pages` : "";
  const shots = f.evidence.filter((e): e is Extract<Evidence, { type: "screenshot" }> => e.type === "screenshot");
  const rest = f.evidence.filter((e) => e.type !== "screenshot");
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
    <p class="lbl">To reproduce</p>
    <ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <p class="lbl">What Owly saw</p>
    <ul class="saw">${f.observed.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
    ${f.inference.length ? `<div class="think"><b class="lbl" style="margin:0 0 2px">What that suggests &mdash; reasoning, not a confirmed cause</b>${f.inference.map(esc).join("<br>")}</div>` : ""}
    ${rest.length ? `<p class="lbl">Evidence</p><div class="ev">${rest.map((e) => esc(evidenceText(e))).join("\n\n")}</div>` : ""}
    ${shots.map((s) => shotButton(s.ref, s.caption)).join("")}
    ${f.occurrences && f.occurrences.length > 1 ? `<p class="muted">Seen on: ${f.occurrences.map(esc).join(", ")}</p>` : ""}
    <button class="btn" type="button" data-copy="issue-${index}">Copy as GitHub issue</button>
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
<div class="top"><a class="brand" href="/">${LOGO} Owly</a></div>
${body}
<footer>Owly ran rule-based checks and scripted user behaviour in a real browser. Every issue listed was reproduced in a fresh browser before being reported.</footer>
</div>
<dialog id="zoom"><img alt=""><div class="dcap"><span></span><button type="button" data-close>Close</button></div></dialog>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body></html>`;
}

export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const PAGE_SCRIPT = `
var zoom = document.getElementById("zoom");
document.addEventListener("click", function (e) {
  var shot = e.target.closest("[data-shot]");
  if (shot) {
    zoom.querySelector("img").src = shot.getAttribute("data-shot");
    zoom.querySelector(".dcap span").textContent = shot.getAttribute("data-cap") || "";
    zoom.showModal();
    return;
  }
  if (e.target.closest("[data-close]") || e.target === zoom) { zoom.close(); return; }
  var copy = e.target.closest("[data-copy]");
  if (copy) {
    var src = document.getElementById(copy.getAttribute("data-copy"));
    navigator.clipboard.writeText(src.value).then(function () {
      var old = copy.textContent; copy.textContent = "Copied"; setTimeout(function () { copy.textContent = old; }, 1500);
    });
  }
});`;

export function reportPage(report: RunReport, nonce: string): string {
  shotSeq = 0;
  const ok = report.pages.filter((p) => p.status !== null && p.status < 400).length;
  const seconds = Math.round(report.durationMs / 1000);
  const blocking = report.findings.filter((f) => f.severity === "critical" || f.severity === "high");
  const rest = report.findings.filter((f) => f.severity !== "critical" && f.severity !== "high" && f.category !== "accessibility");
  const access = report.findings.filter((f) => f.severity !== "critical" && f.severity !== "high" && f.category === "accessibility");
  const refused = report.notes.filter((n) => /^(Not |Refused |Skipped )/.test(n));
  const other = report.notes.filter((n) => !/^(Not |Refused |Skipped )/.test(n));

  const body = `
<div class="meta">
  <span class="pill">${esc(new URL(report.target).host)}</span>
  <span class="pill">${report.mode === "full" ? "Full test" : "Passive scan"}</span>
  <span class="pill">Focus: ${esc(report.focus)}</span>
  <span class="pill">${esc(new Date(report.finishedAt).toUTCString())}</span>
</div>

${verdictBlock(report)}

<div class="counts">
  <div class="count"><b>${report.findings.length}</b><span>issues reproduced</span></div>
  <div class="count"><b>${blocking.length}</b><span>serious enough to fix first</span></div>
  <div class="count"><b>${ok}</b><span>pages tested</span></div>
  <div class="count"><b>${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}</b><span>test time</span></div>
</div>

${blocking.length ? `<h2>Fix first</h2>${blocking.map((f, i) => findingCard(f, report, i)).join("")}` : ""}
${rest.length ? `<h2>Also found</h2>${rest.map((f, i) => findingCard(f, report, blocking.length + i)).join("")}` : ""}
${access.length ? `<h2>Accessibility (${access.length})</h2>${access.map((f, i) => findingCard(f, report, blocking.length + rest.length + i)).join("")}` : ""}
${report.findings.length === 0 ? `<div class="empty">No issues reproduced. Every suspected problem was checked again in a fresh browser before it could be listed here.</div>` : ""}

${report.unverified.length ? `<h2>Seen once, not reproduced</h2><p class="muted">These happened during the test but not again on replay, so they are not counted as issues.</p><ul class="muted">${report.unverified.map((f) => `<li>${esc(f.title)}</li>`).join("")}</ul>` : ""}
${refused.length ? `<h2>What Owly would not do</h2><ul class="muted">${refused.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${other.length ? `<h2>Notes</h2><ul class="muted">${other.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}

<details><summary class="muted" style="cursor:pointer;margin-top:26px">Pages tested (${report.pages.length}) and full timeline (${report.events.length} events)</summary>
<ul class="muted">${report.pages.map((p) => `<li>${esc(p.url)} <span>(${p.status ?? "no response"})</span></li>`).join("")}</ul>
<div class="log">${report.events.map(eventRow).join("")}</div></details>`;

  return shell(`Owly: ${new URL(report.target).host}`, body, nonce, PAGE_SCRIPT);
}

function eventRow(e: RunEvent): string {
  const t = new Date(e.at).toISOString().slice(11, 19);
  return `<div class="${esc(e.level)}"><time>${t}</time><span>${esc(e.text)}</span></div>`;
}

/**
 * While a test runs. The page advances the run itself as well as watching it,
 * so a test keeps going if the chat that started it has gone quiet.
 */
export function progressPage(id: string, state: RunState, nonce: string): string {
  const body = `
<section class="verdict idle"><div class="head">
  <span class="mark">${EYE}</span>
  <div><h1><span class="pulse"></span>Testing ${esc(new URL(state.target).host)}</h1>
  <p class="why">${state.mode === "full" ? "Full test" : "Passive scan"} &middot; focus: ${esc(state.focus)}. Every line below is something that actually happened.</p></div>
</div></section>
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
    `<section class="verdict no"><div class="head"><span class="mark">${CROSS}</span>
     <div><h1>The test of ${esc(host(target))} did not finish</h1><p class="why">${esc(error)}</p></div></div></section>`,
    nonce,
  );
}

export function notFoundPage(nonce: string): string {
  return shell(
    "Owly: report not found",
    `<section class="verdict idle"><div class="head"><span class="mark">${EYE}</span>
     <div><h1>Report not found</h1><p class="why">It may have been removed: reports are kept for 30 days.</p></div></div></section>`,
    nonce,
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Exported for the journey summary in text reports. */
export type { Journey };
