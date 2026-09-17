/**
 * Test data a form will accept, that no one will mistake for a real person.
 *
 * Every value is plainly synthetic (spec §8): example.com addresses, a 555
 * phone number, a name that says "Owly". A site owner reading their database
 * afterwards should be able to find and delete everything Owly created.
 */

export interface FieldInfo {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  label: string;
  required: boolean;
  min: string | null;
  max: string | null;
  options: string[];
}

export const INVALID_EMAIL = "not-an-email";

function has(field: FieldInfo, pattern: RegExp): boolean {
  return pattern.test([field.name, field.id, field.autocomplete, field.label].join(" "));
}

export function isEmailField(field: FieldInfo): boolean {
  return field.type === "email" || has(field, /e-?mail/i);
}

export interface FillValue {
  kind: "text" | "check" | "select";
  value: string;
}

/** A value for one field. `nonce` keeps repeated submissions distinct. */
export function valueFor(field: FieldInfo, nonce: string): FillValue | null {
  if (field.tag === "select") {
    const option = field.options.find((o) => o !== "");
    return option === undefined ? null : { kind: "select", value: option };
  }
  if (field.type === "checkbox") return field.required ? { kind: "check", value: "on" } : null;
  if (field.type === "radio") return { kind: "check", value: "on" };

  if (isEmailField(field)) return { kind: "text", value: `owly.qa+${nonce}@example.com` };
  if (field.type === "password" || has(field, /pass(word)?/i)) return { kind: "text", value: `Owly-Test-${nonce}-Kq2!` };
  if (field.type === "tel" || has(field, /phone|mobile|tel\b/i)) return { kind: "text", value: "+15555550123" };
  if (field.type === "url" || has(field, /website|url\b/i)) return { kind: "text", value: "https://example.com" };
  if (field.type === "number" || field.type === "range") {
    const min = Number(field.min);
    return { kind: "text", value: String(Number.isFinite(min) && field.min !== null ? min : 1) };
  }
  if (field.type === "date") return { kind: "text", value: "2030-01-15" };
  if (field.type === "time") return { kind: "text", value: "10:30" };
  if (field.type === "color") return null;
  if (field.tag === "textarea") return { kind: "text", value: "Automated QA test message from Owly. Safe to delete." };
  // Username before name: "username" also contains "name".
  if (has(field, /user(name)?|login|handle/i)) return { kind: "text", value: `owlytest${nonce.replace(/\W/g, "").slice(0, 8)}` };
  if (has(field, /name/i)) return { kind: "text", value: "Owly Tester" };
  if (field.type === "search" || has(field, /search|query|\bq\b/i)) return { kind: "text", value: "test" };
  if (has(field, /zip|postal/i)) return { kind: "text", value: "10001" };
  if (has(field, /city/i)) return { kind: "text", value: "Testville" };
  if (has(field, /company|organi[sz]ation|workspace|team/i)) return { kind: "text", value: "Owly Test Co" };
  return { kind: "text", value: "Owly test" };
}

export function nonce(): string {
  return Math.random().toString(36).slice(2, 8);
}
