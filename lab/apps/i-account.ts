import { formValue, html, json, jsonBody, page, redirect, type Ctx, type LabApp } from "../kit.js";

// App I - the product behind a login.
//
// Every other app in the lab is testable by a stranger. This one is not: the
// interesting half only exists once you have an account, which is exactly the
// half a scanner never sees and a QA tester always does. Owly has to sign up,
// stay signed in, do things, and check they actually happened.
//
// Signing up WORKS here, on purpose - the bugs are inside:
//
//   I1  saving your display name says "Saved" and does not save it
//   I2  pressing Create twice creates the ticket twice
//   I3  a title longer than 60 characters crashes the server
//   I4  signing out does not sign you out: the session still works
//
// Everything else is deliberately correct, so any other finding here is a
// false positive.

interface Account {
  email: string;
  name: string;
  tickets: Array<{ id: number; title: string }>;
}

const accounts = new Map<string, Account>();
let nextId = 1;

function cookie(ctx: Ctx): string | null {
  const raw = ctx.req.headers.cookie ?? "";
  const match = /(?:^|;\s*)tickly=([^;]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]!) : null;
}

function who(ctx: Ctx): Account | null {
  const id = cookie(ctx);
  return id ? (accounts.get(id) ?? null) : null;
}

export function reset(): void {
  accounts.clear();
  nextId = 1;
}

const nav = (signedIn: boolean) => `<header><nav aria-label="Main">
  <a href="/">Tickly</a>
  ${signedIn ? `<a href="/app">Tickets</a> <a href="/app/settings">Settings</a> <a href="/signout">Sign out</a>` : `<a href="/pricing">Pricing</a> <a href="/signin">Sign in</a>`}
</nav></header>`;

function shell(ctx: Ctx, title: string, main: string, signedIn: boolean, status = 200): void {
  html(ctx, page(title, `${nav(signedIn)}<main>${main}</main>`), status);
}

export const app: LabApp = {
  key: "i",
  name: "Account and tickets",
  port: 4109,
  routes: {
    "GET /": (ctx) =>
      shell(
        ctx,
        "Tickly - a help desk that fits in your head",
        `<h1>A help desk that fits in your head</h1>
         <p>Track what people ask you, and what you said back.</p>
         <p><a href="/signup">Create a free account</a></p>`,
        false,
      ),

    "GET /pricing": (ctx) =>
      shell(ctx, "Tickly pricing", `<h1>Pricing</h1><p>Free while it is small.</p><p><a href="/signup">Create a free account</a></p>`, false),

    "GET /signup": (ctx) =>
      shell(
        ctx,
        "Create your Tickly account",
        `<h1>Create your account</h1>
         <form method="post" action="/signup">
           <label for="name">Your name</label>
           <input id="name" name="name" type="text" autocomplete="name" required>
           <label for="email">Email</label>
           <input id="email" name="email" type="email" autocomplete="email" required>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" autocomplete="new-password" required>
           <button type="submit">Create account</button>
         </form>`,
        false,
      ),

    // Signing up works. That is the point: the bugs are behind it.
    "POST /signup": (ctx) => {
      const email = formValue(ctx.body, "email");
      const name = formValue(ctx.body, "name") || "New user";
      if (!email.includes("@")) {
        shell(ctx, "Create your Tickly account", `<h1>Create your account</h1><p class="notice err">That email does not look right.</p>`, false, 400);
        return;
      }
      const id = `s${accounts.size + 1}-${Date.now().toString(36)}`;
      accounts.set(id, { email, name, tickets: [] });
      ctx.res.writeHead(303, { location: "/app", "set-cookie": `tickly=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax` });
      ctx.res.end();
    },

    "GET /signin": (ctx) =>
      shell(
        ctx,
        "Sign in to Tickly",
        `<h1>Sign in</h1>
         <form method="post" action="/signin">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" autocomplete="email" required>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" autocomplete="current-password" required>
           <button type="submit">Sign in</button>
         </form>
         <p>No account yet? <a href="/signup">Create one</a>.</p>`,
        false,
      ),

    "POST /signin": (ctx) => {
      const email = formValue(ctx.body, "email");
      const found = [...accounts.entries()].find(([, a]) => a.email === email);
      if (!found) {
        shell(ctx, "Sign in to Tickly", `<h1>Sign in</h1><p class="notice err">No account with that email.</p><p><a href="/signup">Create one</a></p>`, false, 401);
        return;
      }
      ctx.res.writeHead(303, { location: "/app", "set-cookie": `tickly=${encodeURIComponent(found[0])}; Path=/; HttpOnly; SameSite=Lax` });
      ctx.res.end();
    },

    "GET /app": (ctx) => {
      const me = who(ctx);
      if (!me) return redirect(ctx, "/signin");
      ctx.hit("dashboard");
      const list = me.tickets.length
        ? `<ul>${me.tickets.map((t) => `<li>${t.title}</li>`).join("")}</ul>`
        : `<p>No tickets yet.</p>`;
      shell(
        ctx,
        "Your tickets - Tickly",
        `<h1>Your tickets</h1>
         <p>Signed in as ${me.name} (${me.email}).</p>
         <p data-count="${me.tickets.length}">${me.tickets.length} open</p>
         ${list}
         <p><a href="/app/new">New ticket</a></p>`,
        true,
      );
    },

    "GET /app/new": (ctx) => {
      const me = who(ctx);
      if (!me) return redirect(ctx, "/signin");
      shell(
        ctx,
        "New ticket - Tickly",
        `<h1>New ticket</h1>
         <form id="new-ticket">
           <label for="title">Title</label>
           <input id="title" name="title" type="text" required>
           <label for="details">Details</label>
           <textarea id="details" name="details" rows="4"></textarea>
           <button type="submit">Create ticket</button>
         </form>
         <p id="said" class="notice" hidden></p>
         <script>
           var form = document.getElementById("new-ticket");
           form.addEventListener("submit", function (e) {
             e.preventDefault();
             // No guard of any kind: the button stays live and every press
             // sends another ticket. This is the planted bug (I2).
             fetch("/app/new", {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify({
                 title: document.getElementById("title").value,
                 details: document.getElementById("details").value
               })
             }).then(function (r) {
               if (r.ok) { window.location.href = "/app"; return; }
               var said = document.getElementById("said");
               said.hidden = false;
               said.className = "notice err";
               said.textContent = "Something went wrong.";
             });
           });
         </script>`,
        true,
      );
    },

    // I2: no idempotency at all - press Create twice and you get two tickets.
    // I3: a long title crashes it.
    "POST /app/new": (ctx) => {
      const me = who(ctx);
      if (!me) return redirect(ctx, "/signin");
      const sent = jsonBody<{ title?: string }>(ctx.body);
      const title = (sent?.title ?? formValue(ctx.body, "title")).trim() || "Untitled";
      if (title.length > 60) {
        ctx.hit("crash");
        html(ctx, page("Error", `<main><h1>Something went wrong</h1><p>RangeError: title index out of range</p></main>`), 500);
        return;
      }
      me.tickets.push({ id: nextId++, title });
      ctx.hit("created");
      if (sent) return json(ctx, { ok: true, id: nextId - 1 });
      redirect(ctx, "/app");
    },

    "GET /app/settings": (ctx) => {
      const me = who(ctx);
      if (!me) return redirect(ctx, "/signin");
      const saved = ctx.url.searchParams.get("saved") === "1";
      shell(
        ctx,
        "Settings - Tickly",
        `<h1>Settings</h1>
         ${saved ? `<p class="notice ok">Saved.</p>` : ""}
         <form method="post" action="/app/settings">
           <label for="display">Display name</label>
           <input id="display" name="display" type="text" value="${me.name}" required>
           <button type="submit">Save changes</button>
         </form>`,
        true,
      );
    },

    // I1: the lost write. It says Saved and means nothing - the new name is
    // never stored, so a reload shows the old one.
    "POST /app/settings": (ctx) => {
      const me = who(ctx);
      if (!me) return redirect(ctx, "/signin");
      ctx.hit("settings_saved");
      redirect(ctx, "/app/settings?saved=1");
    },

    // I4: signing out does not sign you out. The cookie is left alone, so the
    // session still works afterwards.
    "GET /signout": (ctx) => {
      ctx.hit("signout");
      redirect(ctx, "/?signedout=1");
    },
  },
};
