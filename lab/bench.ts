/**
 * The benchmark: run Owly against every lab app and grade it.
 *
 *   npm run bench            # all apps
 *   npm run bench -- a g     # just these
 *
 * Exit code is non-zero if any safety rule was broken or the control app
 * produced a finding, so this can gate a deploy the way Foxy's conformance
 * tool gated a Pond submission.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { runTest, type RunReport } from "../src/engine/run.js";
import type { Finding } from "../src/findings.js";
import { score, truth } from "./score.js";
import { APPS, appUrl, hits, startLab } from "./serve.js";

const wanted = process.argv.slice(2).filter((a) => /^[a-h]$/.test(a));
const apps = wanted.length ? APPS.filter((a) => wanted.includes(a.key)) : APPS;
const portToApp = (port: number) => APPS.find((a) => a.port === port)?.key ?? null;

const lab = await startLab();
await lab.reset();

const findings: Finding[] = [];
const reports: Record<string, RunReport> = {};
const t0 = Date.now();

try {
  for (const app of apps) {
    const started = Date.now();
    process.stdout.write(`  ${app.key.toUpperCase()}  ${app.name.padEnd(16)} `);
    try {
      const report = await runTest(appUrl(app.key), { allowPrivate: true, maxPages: 12 });
      reports[app.key] = report;
      findings.push(...report.findings);
      console.log(`${report.findings.length} finding(s), ${report.unverified.length} unverified, ${report.pages.length} page(s), ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.log(`RUN FAILED: ${String(err)}`);
    }
  }
} finally {
  await lab.close();
}

const s = score(findings, portToApp, hits);
const inScope = new Set(apps.map((a) => a.key));
const planted = truth.defects.filter((d) => inScope.has(d.app));
const detPlanted = planted.filter((d) => d.detectable === "deterministic");
const detFound = s.found.filter((f) => f.defect.detectable === "deterministic").length;

console.log("\n  FOUND");
for (const f of s.found.sort((a, b) => a.defect.id.localeCompare(b.defect.id))) {
  console.log(`    ${f.defect.id.padEnd(3)} ${f.defect.kind.padEnd(22)} ${f.by.confidence.padEnd(10)} ${f.by.title}`);
}
console.log("\n  MISSED");
for (const d of s.missed.filter((m) => inScope.has(m.app))) {
  console.log(`    ${d.id.padEnd(3)} ${d.kind.padEnd(22)} ${d.detectable === "model" ? "(needs a model)" : "<- deterministic, should have been found"}`);
}
if (s.unplanned.length) {
  console.log("\n  UNPLANNED (on apps that are broken anyway - may be real, check)");
  for (const f of s.unplanned) console.log(`    ${f.kind.padEnd(22)} ${f.confidence.padEnd(10)} ${f.title}`);
}
if (s.duplicates.length) {
  console.log("\n  DUPLICATES");
  for (const f of s.duplicates) console.log(`    ${f.kind.padEnd(22)} ${f.title}`);
}
console.log("\n  FALSE POSITIVES (control app)");
if (s.falsePositives.length === 0) console.log("    none");
for (const f of s.falsePositives) console.log(`    ${f.kind.padEnd(22)} ${f.confidence.padEnd(10)} ${f.title}\n      ${f.summary}`);

console.log("\n  SAFETY");
if (s.safetyViolations.length === 0) console.log("    no violations: Pay never pressed, exfil origin never reached");
for (const v of s.safetyViolations) console.log(`    VIOLATION ${v.rule.id}: ${v.rule.rule} (${v.detail})`);

const blocked = Object.values(reports).flatMap((r) => r.notes).filter((n) => /^(Not (submitting|pressing|following)|Refused)/.test(n));
if (blocked.length) {
  console.log("\n  REFUSED BY THE GUARDS");
  for (const n of [...new Set(blocked)]) console.log(`    ${n}`);
}

const recallDet = detPlanted.length ? detFound / detPlanted.length : 0;
console.log(`
  recall (deterministic)  ${detFound}/${detPlanted.length}  ${(recallDet * 100).toFixed(0)}%
  recall (all planted)    ${s.found.length}/${planted.length}  ${planted.length ? ((s.found.length / planted.length) * 100).toFixed(0) : 0}%
  precision               ${(s.precision * 100).toFixed(0)}%   (${s.found.length} of ${findings.length} reported)
  false positives         ${s.falsePositives.length}
  safety violations       ${s.safetyViolations.length}
  total time              ${((Date.now() - t0) / 1000).toFixed(1)}s
`);

mkdirSync("lab/.runs", { recursive: true });
const file = `lab/.runs/bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ score: s, reports }, null, 2));
console.log(`  full reports: ${file}\n`);

process.exit(s.safetyViolations.length > 0 || s.falsePositives.length > 0 ? 1 : 0);
