import { describe, expect, it } from "vitest";
import { blockedReason, checkUrl, pinArgs, sameOrigin } from "../src/policy/urlGuard.js";

// A resolver that answers from a table, so no test depends on real DNS.
const fakeDns = (table: Record<string, string[]>) => async (host: string) => {
  const hit = table[host];
  if (!hit) throw new Error(`NXDOMAIN ${host}`);
  return hit;
};

const strict = { allowPrivate: false, resolve: fakeDns({ "example.com": ["93.184.216.34"] }) };

describe("addresses a tested site must never reach", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.1.2.3", "private network"],
    ["172.16.0.1", "private network"],
    ["172.31.255.255", "private network"],
    ["192.168.1.1", "private network"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fd00::1", "unique local (private network)"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local / cloud metadata"],
  ];
  it.each(cases)("%s is blocked (%s)", (address, why) => {
    expect(blockedReason(address)).toBe(why);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])("%s is public", (address) => {
    expect(blockedReason(address)).toBeNull();
  });
});

describe("checkUrl", () => {
  it("accepts a public https site", async () => {
    const v = await checkUrl("https://example.com/signup", strict);
    expect(v.ok).toBe(true);
  });

  it.each([
    "http://127.0.0.1:3000/",
    "http://localhost/", // resolves below
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    // Numeric encodings that browsers happily resolve to loopback.
    "http://2130706433/",
    "http://0x7f.1/",
    "http://127.1/",
    "http://0177.0.0.1/",
  ])("refuses %s", async (url) => {
    const v = await checkUrl(url, {
      allowPrivate: false,
      resolve: fakeDns({ localhost: ["127.0.0.1"] }),
    });
    expect(v.ok).toBe(false);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const v = await checkUrl("https://internal.example.net/", {
      allowPrivate: false,
      resolve: fakeDns({ "internal.example.net": ["10.0.0.5"] }),
    });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain("10.0.0.5");
  });

  it("refuses a host with one public and one private address", async () => {
    // How DNS rebinding hides: checking only the first answer would pass this.
    const v = await checkUrl("https://mixed.example.net/", {
      allowPrivate: false,
      resolve: fakeDns({ "mixed.example.net": ["93.184.216.34", "127.0.0.1"] }),
    });
    expect(v.ok).toBe(false);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com/", "chrome://settings"])(
    "refuses the scheme in %s",
    async (url) => {
      expect((await checkUrl(url, strict)).ok).toBe(false);
    },
  );

  it("refuses credentials embedded in the URL", async () => {
    expect((await checkUrl("https://admin:hunter2@example.com/", strict)).ok).toBe(false);
  });

  it("refuses what it cannot resolve rather than guessing", async () => {
    expect((await checkUrl("https://nope.invalid/", strict)).ok).toBe(false);
  });

  it("allows private targets only when explicitly told to (the lab)", async () => {
    const v = await checkUrl("http://127.0.0.1:4101/", { allowPrivate: true });
    expect(v.ok).toBe(true);
  });
});

describe("helpers", () => {
  it("compares origins including scheme and port", () => {
    expect(sameOrigin("https://a.com/x", "https://a.com/y")).toBe(true);
    expect(sameOrigin("https://a.com", "http://a.com")).toBe(false);
    expect(sameOrigin("https://a.com", "https://a.com:8443")).toBe(false);
    expect(sameOrigin("https://a.com", "https://sub.a.com")).toBe(false);
  });

  it("pins the target host to the validated address", () => {
    expect(pinArgs(new URL("https://example.com/"), "93.184.216.34")).toEqual([
      "--host-resolver-rules=MAP example.com 93.184.216.34",
    ]);
    expect(pinArgs(new URL("https://example.com/"), "2606:4700::1111")[0]).toContain("[2606:4700::1111]");
  });
});
