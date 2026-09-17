import { html, json, page, jsonBody, type LabApp } from "../kit.js";

// App A - a signup that is broken in four independent ways.
//
//   A1  valid details -> the API returns 500              (form_server_error)
//   A2  "not-an-email" is accepted and greeted as success  (form_accepts_invalid)
//   A3  the page throws while loading                      (js_exception)
//   A4  the Terms link in the footer is a 404              (broken_link)

const shell = (main: string) => `
<header><nav aria-label="Main"><a href="/">Acme Notes</a><a href="/signup">Sign up</a></nav></header>
<main>${main}</main>
<footer><a href="/about">About</a> <a href="/terms">Terms</a></footer>`;

export const app: LabApp = {
  key: "a",
  name: "Signup",
  port: 4101,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Acme Notes", shell(`
        <h1>Notes that keep up with you</h1>
        <p>Create an account to start writing.</p>
        <a href="/signup">Get started</a>`))),

    "GET /about": (ctx) =>
      html(ctx, page("About - Acme Notes", shell(`<h1>About</h1><p>A small notes app.</p>`))),

    "GET /signup": (ctx) =>
      html(ctx, page("Sign up - Acme Notes", shell(`
        <h1>Create your account</h1>
        <form id="signup" novalidate>
          <label for="name">Full name</label>
          <input id="name" name="name" autocomplete="name">
          <label for="email">Email</label>
          <input id="email" name="email" type="text" autocomplete="email">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password">
          <button type="submit">Create account</button>
        </form>
        <div id="result" role="status"></div>
        <script>
          // A3: a leftover analytics call to an object that was never loaded.
          window.analytics.track("signup_viewed");
        </script>
        <script>
          document.getElementById("signup").addEventListener("submit", async function (e) {
            e.preventDefault();
            var body = {
              name: document.getElementById("name").value,
              email: document.getElementById("email").value,
              password: document.getElementById("password").value
            };
            var r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
            var out = document.getElementById("result");
            if (r.ok) {
              out.className = "notice ok";
              out.textContent = "Welcome aboard! Check your inbox.";
            } else {
              out.className = "notice err";
              out.textContent = "Something went wrong. Please try again.";
            }
          });
        </script>`))),

    "POST /api/signup": (ctx) => {
      const data = jsonBody<{ email?: string }>(ctx.body) ?? {};
      const email = String(data.email ?? "");
      // A2: no validation at all, so garbage sails through...
      if (!email.includes("@")) return json(ctx, { ok: true, welcome: true }, 201);
      // A1: ...while every real address hits a duplicate-check that crashes.
      return json(ctx, { error: "TypeError: Cannot read properties of undefined (reading 'rows')" }, 500);
    },
  },
};
