// Proves the safety tests can fail. Each mutation removes one protection from
// a guard, runs the suite, and expects failures; the file is always restored.
// A safety test that still passes with its safety removed is decoration.
//
//   node tests/mutation.mjs

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mutations = [
  ["src/policy/urlGuard.ts", `["127.0.0.0", 8, "loopback"],`, ""],
  ["src/policy/urlGuard.ts", "for (const address of addresses) {", "for (const address of addresses.slice(0, 1)) {"],
  ["src/policy/urlGuard.ts", `if (url.username || url.password) {`, `if (false) {`],
  ["src/policy/redact.ts", "forms.add(encodeURIComponent(secret));", ""],
  ["src/policy/redact.ts", `forms.add(Buffer.from(secret, "utf8").toString("base64"));`, ""],
  ["src/policy/redact.ts", "if (secret.length < 4) return;", ""],
  ["src/policy/actionGuard.ts", "/\\bdelete\\b/i,", ""],
  ["src/policy/actionGuard.ts", "/\\b(pay|payment)\\b/i,", ""],
  ["src/policy/actionGuard.ts", "if (DANGEROUS_PATHS.test(path)) {", "if (false) {"],
  ["src/policy/actionGuard.ts", "if (submits) {", "if (false) {"],
];

let survived = 0;
for (const [file, from, to] of mutations) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${file}: anchor not found -> ${from}`);
    survived++;
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  let caught = false;
  try {
    execSync("npx vitest run tests/urlGuard.test.ts tests/redact.test.ts tests/actionGuard.test.ts", { stdio: "pipe" });
  } catch {
    caught = true;
  } finally {
    writeFileSync(file, original);
  }
  console.log(`${caught ? "CAUGHT  " : "SURVIVED"} ${file}: removed ${from.slice(0, 60)}`);
  if (!caught) survived++;
}

console.log(survived === 0 ? "\nevery mutation was caught" : `\n${survived} mutation(s) not caught`);
process.exit(survived === 0 ? 0 : 1);
