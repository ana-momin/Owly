/**
 * Enforces the input schema each action declares in the manifest.
 *
 * Foxy's fourth Pond rejection point was exactly this: `additionalProperties:
 * false` declared, nothing checked, so a misspelled field was silently
 * ignored. The rule here is that the manifest is the contract - the same
 * schema object Pond reads is the one requests are validated against, so the
 * two cannot drift.
 */

export interface ValueSchema {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: ValueSchema;
}

export interface InputSchema {
  type: "object";
  properties: Record<string, ValueSchema>;
  required?: string[];
  additionalProperties: false;
}

export class Invalid extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

function checkValue(value: unknown, schema: ValueSchema, field: string): void {
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const ok =
    schema.type === "integer"
      ? typeof value === "number" && Number.isInteger(value)
      : schema.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : schema.type === "array"
          ? Array.isArray(value)
          : schema.type === "object"
            ? actual === "object"
            : typeof value === schema.type;
  if (!ok) throw new Invalid(`${field} must be ${schema.type === "integer" ? "an integer" : `a ${schema.type}`}, got ${actual}.`, field);

  if (schema.enum && !schema.enum.includes(value)) {
    throw new Invalid(`${field} must be one of: ${schema.enum.map(String).join(", ")}.`, field);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Invalid(`${field} must be at least ${schema.minLength} characters.`, field);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Invalid(`${field} must be at most ${schema.maxLength} characters.`, field);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Invalid(`${field} must be at least ${schema.minimum}.`, field);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Invalid(`${field} must be at most ${schema.maximum}.`, field);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => checkValue(v, schema.items!, `${field}[${i}]`));
  }
}

export function validate(params: unknown, schema: InputSchema): Record<string, unknown> {
  if (params === undefined || params === null) params = {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Invalid("parameters must be an object.", "parameters");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!(key in schema.properties)) {
      throw new Invalid(`Unknown parameter "${key}". Accepted: ${Object.keys(schema.properties).join(", ") || "none"}.`, `parameters.${key}`);
    }
  }
  for (const key of schema.required ?? []) {
    if (p[key] === undefined || p[key] === null || p[key] === "") {
      throw new Invalid(`${key} is required.`, `parameters.${key}`);
    }
  }
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    checkValue(value, schema.properties[key]!, `parameters.${key}`);
  }
  return p;
}
