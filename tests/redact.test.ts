import { describe, expect, it } from "vitest";
import { createRedactor, MASK } from "../src/policy/redact.js";

describe("secrets Owly was told about", () => {
  const secret = "Tr0ub4dor&3 horse";
  const r = createRedactor([secret]);

  it("never appear in text", () => {
    expect(r.text(`typed ${secret} into #password`)).not.toContain(secret);
  });

  // Deliberately under neutral field names. Under "password=" the generic
  // pattern would mask the value anyway, and the test would pass without the
  // exact-secret matching it exists to prove - which is what it first did.
  it("never appear URL-encoded, as they would in a request body or query", () => {
    const encoded = encodeURIComponent(secret);
    const out = r.text(`GET /search?q=${encoded}&page=2`);
    expect(out).not.toContain(encoded);
    expect(out).toContain(MASK);
  });

  it("never appear in form-encoded bodies where spaces become +", () => {
    const form = encodeURIComponent(secret).replace(/%20/g, "+");
    expect(r.text(`field_7=${form}`)).not.toContain(form);
  });

  it("never appear base64-encoded, as in a Basic auth header", () => {
    const b64 = Buffer.from(secret).toString("base64");
    expect(r.text(`header ${b64}`)).not.toContain(b64);
  });

  it("are found anywhere inside a nested trace", () => {
    const trace = {
      steps: [{ action: "type", value: secret, meta: { echoed: [`x ${secret} y`] } }],
    };
    const out = JSON.stringify(r.value(trace));
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  });

  it("does not mutate the original object", () => {
    const original = { v: secret };
    r.value(original);
    expect(original.v).toBe(secret);
  });

  it("can learn a new secret mid-run", () => {
    const later = createRedactor();
    later.add("latecomer-value-99");
    expect(later.text("saw latecomer-value-99")).toBe(`saw ${MASK}`);
  });

  it("ignores values too short to be a secret instead of masking ordinary words", () => {
    const tiny = createRedactor(["no"]);
    expect(tiny.text("no problem")).toBe("no problem");
  });
});

describe("things that look like credentials whether or not anyone said so", () => {
  const r = createRedactor();

  it.each([
    ["Authorization: Bearer abc.def.ghijklmnop", "abc.def.ghijklmnop"],
    ["authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["?password=hunter22&next=/", "hunter22"],
    ['{"api_key": "k_live_1234567890"}', "k_live_1234567890"],
    ["client_secret=zzzzyyyyxxxx", "zzzzyyyyxxxx"],
    ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGciOiJIUzI1NiJ9"],
    ["key sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["github ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["https://admin:s3cretpass@staging.example.com/", "s3cretpass"],
  ])("masks %s", (input, leaked) => {
    const out = r.text(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain(MASK);
  });

  it("keeps the label so a report still says what was hidden", () => {
    expect(r.text("password=hunter22")).toBe(`password=${MASK}`);
  });

  it("leaves ordinary text alone", () => {
    const plain = "Clicked 'Create account' and waited 1.5s for /api/signup (HTTP 500)";
    expect(r.text(plain)).toBe(plain);
  });
});
