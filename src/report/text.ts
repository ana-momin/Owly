/**
 * The words a report is made of, in two shapes: the summary Pond shows in chat,
 * and a GitHub issue per finding.
 *
 * Both keep the spec's line between fact and inference (§33): "What Owly saw"
 * is only what the browser recorded; "What that suggests" is labelled as
 * reasoning. And neither calls anything AI. V1 is rule-based checks and
 * scripted user behaviour, and saying otherwise would be the fake demo §49
 * forbids.
 */

import type { Finding } from "../findings.js";
import type { RunReport } from "../engine/machine.js";

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

const FOCUS_LABEL: Record<RunReport["focus"], string> = {
  everything: "everything",
  forms: "forms and buttons",
  mobile: "mobile layout",
  accessibility: "accessibility",
};

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function confidenceLine(f: Finding): string {
  const r = f.reproductions;
  const word = f.confidence === "confirmed" ? "Confirmed" : f.confidence === "likely" ? "Likely" : f.confidence === "possible" ? "Possible" : "Inconclusive";
  return `${word}: seen ${r.reproduced} of ${r.attempts} attempts`;
}

export function counts(findings: Finding[]): string {
  if (findings.length === 0) return "no issues";
  const by = new Map<string, number>();
  for (const f of findings) by.set(f.severity, (by.get(f.severity) ?? 0) + 1);
  const parts = (["critical", "high", "medium", "low", "info"] as const)
    .filter((s) => by.get(s))
    .map((s) => `${by.get(s)} ${s}`);
  return `${findings.length} issue${findings.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/** The report as Pond shows it in chat. Short, with the evidence one link away. */
export function pondMarkdown(report: RunReport, reportUrl: string | null, limit = 8): string {
  const ok = report.pages.filter((p) => p.status !== null && p.status < 400).length;
  const lines: string[] = [];
  lines.push(`## Owly report: ${host(report.target)}`);

  // The verdict first. It is the one line a founder actually wants, and a list
  // of console errors is not it.
  const j = report.journey;
  if (j) {
    // Only an evidenced failure says "could not". Owly running out of road -
    // no call to action it recognises - is not the site's fault, and phrasing
    // it as one told Owly's own site it was broken when it simply has no
    // signup form.
    const blocked = j.hardFailure && !j.completed;
    const failing = j.steps.filter((s) => !s.ok)[0];
    lines.push("");
    if (j.completed) {
      lines.push(`### A new visitor could ${j.goal.toLowerCase()}`);
      lines.push(`Followed "${j.entry}" and finished in ${j.steps.length} steps.`);
    } else if (blocked) {
      lines.push(`### A new visitor could not ${j.goal.toLowerCase()}`);
      lines.push(
        failing
          ? `Stopped at step ${failing.n} of ${j.steps.length}: ${failing.action} — ${failing.outcome}.`
          : (j.reason ?? ""),
      );
    } else {
      lines.push(`### The main task was not attempted`);
      lines.push(j.reason ?? "");
    }
  }

  lines.push("");
  lines.push(
    `${report.mode === "full" ? "Full test" : "Passive scan"} · focus: ${FOCUS_LABEL[report.focus]} · ${ok} page${ok === 1 ? "" : "s"} · ${counts(report.findings)} · ${duration(report.durationMs)}`,
  );
  if (reportUrl) lines.push("", `**[Open the full report with screenshots and evidence](${reportUrl})**`);

  if (report.findings.length === 0) {
    lines.push("", "No problems reproduced. Every suspected issue was checked again in a fresh browser before it could be reported.");
  }

  report.findings.slice(0, limit).forEach((f, i) => {
    lines.push("");
    lines.push(`### ${i + 1}. ${SEVERITY_LABEL[f.severity]}: ${f.title}`);
    lines.push(`${confidenceLine(f)} · ${f.persona ?? "desktop"}${f.viewport ? ` · ${f.viewport.width}x${f.viewport.height}` : ""}`);
    lines.push("");
    lines.push(f.summary);
    lines.push("");
    lines.push("**To reproduce**");
    f.steps.forEach((s, n) => lines.push(`${n + 1}. ${s}`));
    lines.push("");
    lines.push(`**Expected:** ${f.expected}  `);
    lines.push(`**Actual:** ${f.actual}`);
  });
  if (report.findings.length > limit) {
    lines.push("", `…and ${report.findings.length - limit} more in the full report.`);
  }

  if (report.mode === "passive") {
    lines.push(
      "",
      "---",
      "This was a **passive scan**: Owly looked at pages but did not press buttons or submit forms, because ownership of the site has not been verified. Ask Owly how to verify the site to run a full test.",
    );
  }
  return lines.join("\n");
}

/** One finding as a GitHub issue a developer can act on without asking questions. */
export function issueMarkdown(f: Finding, report: Pick<RunReport, "target" | "mode" | "finishedAt">): { title: string; body: string } {
  const lines: string[] = [];
  lines.push("## Summary", "", f.summary, "");
  lines.push("## Environment", "");
  lines.push(`- **Page:** ${f.url}`);
  if (f.occurrences && f.occurrences.length > 1) lines.push(`- **Also seen on:** ${f.occurrences.slice(1).map(pathOf).join(", ")}`);
  lines.push(`- **Browser:** Chromium (headless)`);
  if (f.viewport) lines.push(`- **Viewport:** ${f.viewport.width}x${f.viewport.height}`);
  if (f.persona) lines.push(`- **Test persona:** ${f.persona}`);
  lines.push(`- **Tested:** ${report.finishedAt}`);
  lines.push("");
  lines.push("## Steps to reproduce", "");
  f.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("", "## Expected", "", f.expected, "", "## Actual", "", f.actual, "");
  lines.push("## What Owly saw", "");
  for (const o of f.observed) lines.push(`- ${o}`);
  if (f.inference.length) {
    lines.push("", "## What that suggests", "", "_Reasoning from the evidence above, not a confirmed root cause._", "");
    for (const i of f.inference) lines.push(`- ${i}`);
  }
  lines.push("", "## Severity and confidence", "");
  lines.push(`- **Severity:** ${SEVERITY_LABEL[f.severity]}`);
  lines.push(`- **Confidence:** ${confidenceLine(f)}`);
  lines.push("", `_Found by an Owly ${report.mode === "full" ? "full test" : "passive scan"} of ${report.target}._`);
  return { title: f.title, body: lines.join("\n") };
}
