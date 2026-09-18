import { html, json, page, jsonBody, redirect, type LabApp } from "../kit.js";

// App G - the control. NOTHING is wrong here, on purpose.
//
// Any finding Owly reports on this app is a false positive, full stop. It is
// the most important app in the lab: recall can be gamed by reporting
// everything, and this is what stops that.
//
// It is built to be boring in all the ways the others are broken - labelled
// inputs, visible focus, validation with clear messages, responsive layout,
// real alt text, working links, fast responses - and to contain the things a
// careless detector mistakes for bugs:
//   - an external link (must be neither followed nor reported)
//   - a form whose invalid submission is correctly *rejected* with a message
//   - a 404 that the page expects and handles (checking a username is free)
//   - a button that opens and closes a dialog that Escape closes properly

const nav = `<header><nav aria-label="Main"><a href="/">Ledgerly</a> <a href="/pricing">Pricing</a> <a href="/contact">Contact</a></nav></header>`;
const foot = `<footer><p>Made in Lahore. <a href="https://example.com/">Our partner</a> · <a href="/partner">Partner sign-in</a> · <a href="/status.json">Service status</a></p></footer>`;

export const app: LabApp = {
  key: "g",
  name: "Clean control",
  port: 4107,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Ledgerly - simple bookkeeping", `${nav}
        <main>
          <h1>Bookkeeping without the spreadsheet</h1>
          <p>Track invoices and expenses in one place.</p>
          <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='120'%3E%3Crect width='300' height='120' fill='%23dfe7fd'/%3E%3C/svg%3E"
               alt="Illustration of an invoice list" width="300" height="120" style="max-width:100%;height:auto">
          <p><a href="/signup">Create a free account</a></p>
          <button type="button" id="open-help">How it works</button>
          <div id="help" role="dialog" aria-modal="true" aria-labelledby="help-title" hidden
               style="border:2px solid #1a1a1a;padding:16px;margin-top:12px">
            <h2 id="help-title">How it works</h2>
            <p>Connect your bank, tag expenses, send invoices.</p>
            <button type="button" id="close-help">Close</button>
          </div>
        </main>${foot}
        <script>
          var help = document.getElementById("help");
          var opener = document.getElementById("open-help");
          function close() { help.hidden = true; opener.focus(); }
          opener.addEventListener("click", function () { help.hidden = false; document.getElementById("close-help").focus(); });
          document.getElementById("close-help").addEventListener("click", close);
          help.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
        </script>`)),

    "GET /pricing": (ctx) =>
      html(ctx, page("Pricing - Ledgerly", `${nav}
        <main>
          <h1>Pricing</h1>
          <h2>Free</h2><p>Up to 20 invoices a month.</p>
          <h2>Pro</h2><p>Unlimited invoices, $9 a month.</p>
          <p><a href="/signup">Start free</a></p>
        </main>${foot}`)),

    "GET /contact": (ctx) =>
      html(ctx, page("Contact - Ledgerly", `${nav}
        <main>
          <h1>Contact us</h1>
          <form id="contact" novalidate>
            <label for="c-name">Your name</label>
            <input id="c-name" name="name" required autocomplete="name">
            <label for="c-email">Email</label>
            <input id="c-email" name="email" type="email" required autocomplete="email">
            <label for="c-msg">Message</label>
            <textarea id="c-msg" name="message" required rows="4"></textarea>
            <button type="submit">Send message</button>
          </form>
          <div id="c-result" role="status" aria-live="polite"></div>
        </main>${foot}
        <script>
          document.getElementById("contact").addEventListener("submit", async function (e) {
            e.preventDefault();
            var out = document.getElementById("c-result");
            var name = document.getElementById("c-name").value.trim();
            var email = document.getElementById("c-email").value.trim();
            var message = document.getElementById("c-msg").value.trim();
            if (!name || !message || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
              out.className = "notice err";
              out.textContent = "Please enter your name, a valid email address and a message.";
              return;
            }
            var r = await fetch("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name, email: email, message: message }) });
            out.className = r.ok ? "notice ok" : "notice err";
            out.textContent = r.ok ? "Thanks, we'll reply within a day." : "We couldn't send that. Please try again.";
          });
        </script>`)),

    "GET /signup": (ctx) =>
      html(ctx, page("Create account - Ledgerly", `${nav}
        <main>
          <h1>Create your account</h1>
          <form id="signup" novalidate>
            <label for="s-user">Username</label>
            <input id="s-user" name="username" required autocomplete="username" aria-describedby="s-user-hint">
            <p id="s-user-hint">Letters and numbers only.</p>
            <label for="s-email">Email</label>
            <input id="s-email" name="email" type="email" required autocomplete="email">
            <button type="submit">Create account</button>
          </form>
          <div id="s-result" role="status" aria-live="polite"></div>
        </main>${foot}
        <script>
          document.getElementById("signup").addEventListener("submit", async function (e) {
            e.preventDefault();
            var out = document.getElementById("s-result");
            var user = document.getElementById("s-user").value.trim();
            var email = document.getElementById("s-email").value.trim();
            if (!/^[a-z0-9]+$/i.test(user) || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
              out.className = "notice err";
              out.textContent = "Use letters and numbers for the username, and a valid email address.";
              return;
            }
            // An expected 404: "no user with that name" means the name is free.
            var check = await fetch("/api/users/" + encodeURIComponent(user));
            if (check.status !== 404) {
              out.className = "notice err";
              out.textContent = "That username is taken.";
              return;
            }
            var r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, email: email }) });
            out.className = r.ok ? "notice ok" : "notice err";
            out.textContent = r.ok ? "Account created. Welcome to Ledgerly." : "We couldn't create your account. Please try again.";
          });
        </script>`)),

    // A perfectly ordinary outbound redirect: plenty of real sites have one
    // (/slack/install, /login/google, affiliate links). Owly's guard refuses
    // to follow it off-site, which once left a blank page that Owly then
    // reported as a dead end - a false positive of its own making.
    "GET /partner": (ctx) => redirect(ctx, "https://example.com/", 302),

    // A linked JSON endpoint, as most sites have (/healthz, /manifest,
    // /api/status). Chromium wraps JSON in a generated page with no title and
    // no lang, and Owly once reported all three as defects.
    "GET /status.json": (ctx) => json(ctx, { status: "ok", version: "1.0.0" }),

    "POST /api/contact": (ctx) => {
      const d = jsonBody<{ email?: string }>(ctx.body) ?? {};
      if (!String(d.email ?? "").includes("@")) return json(ctx, { error: "invalid email" }, 422);
      json(ctx, { ok: true });
    },

    "POST /api/signup": (ctx) => {
      const d = jsonBody<{ email?: string; username?: string }>(ctx.body) ?? {};
      if (!String(d.email ?? "").includes("@") || !d.username) return json(ctx, { error: "invalid" }, 422);
      json(ctx, { ok: true }, 201);
    },
  },
};

// Dynamic route handled in the server: GET /api/users/:name -> 404 unless "taken".
export function userLookup(name: string): number {
  return name.toLowerCase() === "taken" ? 200 : 404;
}
