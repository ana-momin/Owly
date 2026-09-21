/**
 * The conversation layer.
 *
 * The thing these tests are really protecting is the line between talking and
 * testing. A model may write the words; it may never be the reason a browser
 * opens someone's website, and it may never be the source of a finding. So
 * what is checked here is mostly what does NOT happen.
 */

import { describe, expect, it } from "vitest";
import { activeProvider, decide, findSite } from "../src/api/chat.js";

describe("spotting a site in a sentence", () => {
  it("finds one however it is written", () => {
    expect(findSite("acme.dev")).toBe("acme.dev");
    expect(findSite("can you check https://acme.dev/pricing please")).toBe("https://acme.dev/pricing");
    expect(findSite("test www.acme.co.uk for me")).toBe("www.acme.co.uk");
  });

  it("does not mistake ordinary writing for an address", () => {
    // Each of these would start a real browser against a real server.
    expect(findSite("what do you check, e.g. forms")).toBeNull();
    expect(findSite("my app is built with next.js")).toBeNull();
    expect(findSite("the bug is in checkout.ts")).toBeNull();
    expect(findSite("hello, what can you do?")).toBeNull();
    expect(findSite("does it work on mobile")).toBeNull();
  });
});

describe("sites that are obviously not yours", () => {
  it("declines them instead of spending a test on a site you cannot change", async () => {
    for (const site of ["facebook.com", "x.ai", "www.youtube.com/feed", "google.co.uk"]) {
      const out = await decide([{ role: "user", content: site }], null);
      expect(out.test, `${site} should not be tested`).toBeNull();
      expect(out.reply).toMatch(/not yours/i);
    }
  });

  it("still tests a small site nobody has heard of", async () => {
    // The failure that would really hurt: telling someone their own product
    // is not theirs. Anything not on the short list gets tested.
    for (const site of ["acme.dev", "mycoolstartup.io", "owly-demo-rho.vercel.app", "tryowly.vercel.app"]) {
      const out = await decide([{ role: "user", content: site }], null);
      expect(out.test, `${site} should be tested`).toBe(site);
    }
  });

  it("lets the owner overrule the guess", async () => {
    const first = await decide([{ role: "user", content: "facebook.com" }], null);
    const then = await decide(
      [
        { role: "user", content: "facebook.com" },
        { role: "assistant", content: first.reply },
        { role: "user", content: "it's mine" },
      ],
      null,
    );
    expect(then.test).toBe("facebook.com");
  });
});

describe("what a turn decides", () => {
  it("asks for a test when the turn is an address, without needing a model", async () => {
    const out = await decide([{ role: "user", content: "acme.dev" }], null);
    expect(out.test).toBe("acme.dev");
    expect(out.byModel).toBe(false);
  });

  it("answers in words, and starts nothing, when the turn is a question", async () => {
    const out = await decide([{ role: "user", content: "what do you actually check?" }], null);
    expect(out.test).toBeNull();
    expect(out.reply.length).toBeGreaterThan(10);
  });

  it("still works with no model configured at all", async () => {
    // The product must not depend on somebody's free tier being up.
    const out = await decide([{ role: "user", content: "hello" }], null);
    expect(out.test).toBeNull();
    expect(out.reply).toMatch(/address/i);
    if (!activeProvider()) expect(out.byModel).toBe(false);
  });

  it("never turns a question into a test, even when a site is mentioned", async () => {
    // A report already exists, so this is someone asking about it - not
    // asking for acme.dev to be opened all over again.
    const out = await decide(
      [{ role: "user", content: "why is acme.dev slow?" }],
      "Owly report: acme.dev\n- low: The site does not send 3 security headers",
    );
    expect(out.test).toBeNull();
  });
});
