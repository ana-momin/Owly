/**
 * What happens at the edges of a field.
 *
 * Every other form check here submits a reasonable value. This one submits an
 * unreasonable but entirely legal one - a title pasted out of an email, a
 * hundred and fifty characters where the designer pictured five words - and
 * watches what the server does with it.
 *
 * The rule that keeps this honest: a form that REFUSES a long value is
 * working. Saying "too long" is a product decision, and Owly has no opinion
 * about it. The only finding here is a server that breaks - a 5xx, or an error
 * page it clearly did not mean to show - because that is never the intended
 * answer to a long line of text, and the person who pastes one gets a wall of
 * stack trace instead of their work.
 *
 * Fields the page already limits (maxlength) are left alone: the browser
 * enforces those, so a user cannot get there and neither should Owly.
 */

import type { Evidence } from "../findings.js";
import type { NetRecord, Session } from "../browser/session.js";
import * as js from "../browser/inpage.js";
import { assess } from "../policy/actionGuard.js";
import { sameOrigin } from "../policy/urlGuard.js";
import { unitKey, type Candidate } from "./candidate.js";
import type { FormInfo, UnitResult } from "./probes.js";
import { fillAndSubmit, path } from "./probes.js";

/** Long, but nothing exotic: no script, no markup, no control characters. */
const LONG = `Owly boundary test ${"x".repeat(160)}`;

/** Text fields a long value can sensibly go into. */
function longCandidates(form: FormInfo) {
  return form.fields.filter(
    (f) =>
      (f.tag === "textarea" || f.type === "text" || f.type === "search") &&
      !f.maxLength &&
      f.type !== "password",
  );
}

const isMutation = (r: NetRecord) => r.method !== "GET" && r.method !== "HEAD";

export async function boundaryUnit(s: Session, url: string, maxForms = 2): Promise<UnitResult> {
  const unit = unitKey(s.opts.persona.key, "boundary", url);
  const result: UnitResult = { candidates: [], discovered: [], notes: [], refusedLinks: [] };
  const status = await s.goto(url);
  if (status !== null && status >= 400) return result;

  const forms = (await s.eval<FormInfo[]>(js.LIST_FORMS)).slice(0, maxForms);

  for (const form of forms) {
    if (!form.submit || form.fields.length === 0) continue;
    if (!sameOrigin(form.action, s.opts.target)) continue;
    if (assess({ name: form.submit.name, role: "submit", target: form.action, method: form.method }).risk === "destructive") {
      continue;
    }
    const target = longCandidates(form)[0];
    if (!target) continue;

    const attempt = await fillAndSubmit(s, url, form, {
      override: (field) => (field.key === target.key ? { kind: "text", value: LONG } : undefined),
    });
    if (!attempt) continue;

    const broke = attempt.requests.filter((r) => isMutation(r) && r.status !== null && r.status >= 500);
    if (!broke.length) {
      // A refusal, a validation message, or a successful save are all fine.
      continue;
    }

    // The long value is only to blame if the form works without it. On a form
    // that is broken for everyone, this probe would otherwise re-report a
    // failure another unit already found, and blame the wrong thing for it.
    const control = await fillAndSubmit(s, url, form);
    const alsoBroken = (control?.requests ?? []).some((r) => isMutation(r) && r.status !== null && r.status >= 500);
    if (!control || alsoBroken) {
      result.notes.push(
        `A long value in "${target.label || target.name || "a field"}" on ${path(url)} returned a server error, but so did an ordinary one, so the length is not what broke it.`,
      );
      continue;
    }

    const fieldName = target.label || target.name || "a text field";
    result.candidates.push({
      kind: "form_server_error",
      title: `A long value in "${fieldName}" on ${path(url)} breaks the server`,
      severity: "high",
      url,
      persona: s.opts.persona.key,
      summary: `Submitting "${form.submit.name}" with ${LONG.length} characters in "${fieldName}" answered HTTP ${broke[0]!.status}.`,
      expected: "A value that is too long is refused with a message, not a server error.",
      actual: `${broke[0]!.method} ${path(broke[0]!.url)} answered ${broke[0]!.status}.`,
      steps: [
        `Open ${url}`,
        `Type ${LONG.length} characters into "${fieldName}"`,
        `Fill the rest of the form normally and press "${form.submit.name}"`,
      ],
      evidence: broke.slice(0, 2).map(
        (r): Evidence => ({ type: "network", method: r.method, url: r.url, status: r.status }),
      ),
      observed: [
        `"${fieldName}" has no maxlength, so a person can paste any amount of text into it`,
        `${LONG.length} characters -> HTTP ${broke[0]!.status}`,
        "the same form submitted with an ordinary value did not fail, so the length is what broke it",
      ],
      inference: [
        "Anyone pasting a long line - a subject copied out of an email, a sentence instead of a phrase - loses what they were doing.",
        "Refusing the value would be a fine answer; the finding is the server error, not the limit.",
      ],
      deterministic: true,
      fingerprint: `form_server_error|${new URL(url).pathname}|${target.key}`,
      unit,
    });
  }
  return result;
}
