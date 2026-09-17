import { html, page, type LabApp } from "../kit.js";

// App C - fine on a laptop, broken on a phone.
//
//   C1  a fixed-width table forces sideways scrolling at 390px  (mobile_overflow)
//   C2  the plan description is cut off by a fixed-height box    (clipped_text)
//   C3  nav links overlap each other at 390px                    (overlapping_controls)
//   C4  the hero image points at a file that does not exist      (broken_image)

export const app: LabApp = {
  key: "c",
  name: "Responsive",
  port: 4103,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Brightly - Pricing", `
        <style>
          .topnav { position: relative; height: 44px; }
          .topnav a { position: absolute; top: 12px; white-space: nowrap; }
          .topnav a:nth-child(1) { left: 16px; }
          .topnav a:nth-child(2) { left: 120px; }
          .topnav a:nth-child(3) { left: 230px; }
          @media (max-width: 480px) {
            .topnav a:nth-child(2) { left: 70px; }
            .topnav a:nth-child(3) { left: 100px; }
          }
          .compare { width: 1100px; border-collapse: collapse; }
          .compare td, .compare th { border: 1px solid #6b6b6b; padding: 8px; }
          .plan-desc { height: 48px; overflow: hidden; }
        </style>
        <header><nav class="topnav" aria-label="Main">
          <a href="/">Brightly</a><a href="/features">Features</a><a href="/pricing-faq">Pricing FAQ</a>
        </nav></header>
        <main>
          <h1>Pricing</h1>
          <img src="/img/hero-plans.png" alt="Three plan cards side by side" width="320" height="160">
          <h2>Team plan</h2>
          <p class="plan-desc">Everything in Starter, plus shared workspaces, granular permissions for every member of your organisation, audit logs retained for twelve months, priority support with a four-hour response time, and single sign-on.</p>
          <h2>Compare plans</h2>
          <table class="compare">
            <tr><th>Feature</th><th>Starter</th><th>Team</th><th>Business</th><th>Enterprise</th></tr>
            <tr><td>Projects</td><td>3</td><td>Unlimited</td><td>Unlimited</td><td>Unlimited</td></tr>
          </table>
        </main>`)),
    "GET /features": (ctx) => html(ctx, page("Features - Brightly", `<main><h1>Features</h1><p>Fast and simple.</p><a href="/">Back to pricing</a></main>`)),
    "GET /pricing-faq": (ctx) => html(ctx, page("Pricing FAQ - Brightly", `<main><h1>Pricing FAQ</h1><p>Cancel anytime.</p><a href="/">Back to pricing</a></main>`)),
  },
};
