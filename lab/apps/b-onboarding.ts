import { html, page, type LabApp } from "../kit.js";

// App B - onboarding that confuses rather than crashes.
//
//   B1  on phones, a fixed cookie banner sits on top of "Continue",
//       so a tap lands on the banner instead                  (action_obscured)
//   B2  step 2 has no way forward and no way back             (dead_end)
//   B3  two buttons both labelled "Submit" do different things
//       - needs judgement about intent, so a model's job      (model only)
//   B4  leaving the workspace name empty shows "Error E_1042"
//       - unhelpful, but judging "unhelpful" needs a model    (model only)

const banner = `
<style>
  .cookie { position: fixed; left: 0; right: 0; bottom: 0; background: #1a1a1a; color: #ffffff; padding: 18px 16px 90px; z-index: 10; }
  .cookie p { margin: 0; }
  @media (min-width: 700px) { .cookie { display: none; } }
  .step-actions { position: fixed; bottom: 24px; left: 16px; }
</style>
<div class="cookie"><p>We use cookies to improve your experience.</p></div>`;

export const app: LabApp = {
  key: "b",
  name: "Onboarding",
  port: 4102,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Plannr", `
        <main><h1>Plan work with your team</h1><p>Set up takes a minute.</p>
        <a href="/onboarding/1">Start setup</a></main>`)),

    "GET /onboarding/1": (ctx) =>
      html(ctx, page("Step 1 of 3 - Plannr", `
        <main>
          <h1>Step 1: Name your workspace</h1>
          <form action="/onboarding/2" method="get">
            <label for="ws">Workspace name</label>
            <input id="ws" name="ws">
            <p id="msg" role="alert"></p>
            <div class="step-actions">
              <button type="submit" id="continue">Continue</button>
              <button type="button" id="save-draft">Submit</button>
              <button type="button" id="skip">Submit</button>
            </div>
          </form>
          <script>
            document.querySelector("form").addEventListener("submit", function (e) {
              if (!document.getElementById("ws").value.trim()) {
                e.preventDefault();
                document.getElementById("msg").textContent = "Error E_1042";
              }
            });
            document.getElementById("save-draft").addEventListener("click", function () {
              document.getElementById("msg").textContent = "Draft saved.";
            });
            document.getElementById("skip").addEventListener("click", function () {
              window.location.href = "/onboarding/2?ws=untitled";
            });
          </script>
        </main>
        ${banner}`)),

    // B2: the page a user reaches and cannot leave except with the browser.
    "GET /onboarding/2": (ctx) =>
      html(ctx, page("Step 2 of 3 - Plannr", `
        <main>
          <h1>Step 2: Invite your team</h1>
          <p>Your workspace <strong>${escape(ctx.url.searchParams.get("ws") ?? "")}</strong> is ready.
          Teammates will appear here once they join.</p>
        </main>`)),
  },
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
