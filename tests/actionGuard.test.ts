import { describe, expect, it } from "vitest";
import { assess } from "../src/policy/actionGuard.js";

describe("controls Owly refuses to press", () => {
  it.each([
    ["Pay now", "button"],
    ["Pay $49.00", "submit"],
    ["Complete purchase", "button"],
    ["Buy now", "link"],
    ["Place order", "submit"],
    ["Place your order", "button"],
    ["Confirm payment", "button"],
    ["Delete project", "button"],
    ["delete", "menuitem"],
    ["Remove account", "button"],
    ["Close my account", "button"],
    ["Cancel subscription", "button"],
    ["Transfer funds", "button"],
    ["Withdraw", "button"],
    ["Send invite", "button"],
    ["Invite teammates", "link"],
    ["Publish", "button"],
    ["Donate", "link"],
    ["Subscribe now", "button"],
  ])('"%s" (%s)', (name, role) => {
    expect(assess({ name, role }).risk).toBe("destructive");
  });

  it("refuses sensitive words only when they actually submit", () => {
    expect(assess({ name: "Confirm", role: "submit" }).risk).toBe("destructive");
    expect(assess({ name: "Checkout", role: "submit" }).risk).toBe("destructive");
    // Opening the checkout page is a navigation worth testing, not a purchase.
    expect(assess({ name: "Checkout", role: "link", target: "/checkout" }).risk).toBe("safe");
  });

  it("refuses links whose destination acts on a plain visit", () => {
    expect(assess({ name: "Clear", role: "link", target: "/items/4/delete" }).risk).toBe("destructive");
    expect(assess({ name: "x", role: "link", target: "https://a.com/checkout/confirm?id=2" }).risk).toBe("destructive");
    // Logging out would end the session the rest of the run relies on.
    expect(assess({ name: "Bye", role: "link", target: "/logout" }).risk).toBe("destructive");
  });
});

describe("controls that are fine to press", () => {
  it.each([
    ["Sign up", "button"],
    ["Create account", "submit"],
    ["Log in", "submit"],
    ["Next", "button"],
    ["Continue", "button"],
    ["Save", "submit"],
    ["Search", "submit"],
    ["Pricing", "link"],
    ["Add to cart", "button"],
    ["Get started", "link"],
    ["Paypal-style heading", "link"],
    ["Deleted items", "link"],
  ])('"%s" (%s)', (name, role) => {
    expect(assess({ name, role, target: "/somewhere" }).risk).toBe("safe");
  });
});
