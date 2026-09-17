import { html, json, page, type LabApp } from "../kit.js";

// App D - works most of the time.
//
//   D1  saving a note fails on every third request               (flaky_request)
//       Deterministic on purpose: "one in three" by counter, not by random
//       chance, so the benchmark gives the same answer every time it runs.
//   D2  the dashboard's summary call takes six seconds            (slow_response)

let saves = 0;

export const app: LabApp = {
  key: "d",
  name: "Flaky API",
  port: 4104,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Jotter", `
        <main>
          <h1>Your notes</h1>
          <form id="note">
            <label for="text">New note</label>
            <textarea id="text" name="text" rows="3"></textarea>
            <button type="submit">Save note</button>
          </form>
          <p id="status" role="status"></p>
          <p><a href="/dashboard">Dashboard</a></p>
          <script>
            document.getElementById("note").addEventListener("submit", async function (e) {
              e.preventDefault();
              var s = document.getElementById("status");
              var r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: document.getElementById("text").value }) });
              s.textContent = r.ok ? "Saved." : "Could not save your note.";
            });
          </script>
        </main>`)),

    "POST /api/notes": (ctx) => {
      saves += 1;
      if (saves % 3 === 0) return json(ctx, { error: "upstream timeout" }, 503);
      return json(ctx, { ok: true, id: saves }, 201);
    },

    "GET /dashboard": (ctx) =>
      html(ctx, page("Dashboard - Jotter", `
        <main>
          <h1>Dashboard</h1>
          <p id="summary">Loading summary…</p>
          <p><a href="/">Back to notes</a></p>
          <script>
            fetch("/api/summary").then(function (r) { return r.json(); }).then(function (d) {
              document.getElementById("summary").textContent = d.count + " notes this week.";
            });
          </script>
        </main>`)),

    "GET /api/summary": async (ctx) => {
      await new Promise((r) => setTimeout(r, 6000));
      json(ctx, { count: saves });
    },

    "POST /__lab/reset": (ctx) => {
      saves = 0;
      json(ctx, { ok: true });
    },
  },
};
