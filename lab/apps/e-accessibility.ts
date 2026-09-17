import { html, page, type LabApp } from "../kit.js";

// App E - usable with a mouse, hostile to everyone else.
//
//   E1  search and filter inputs have no labels                  (a11y_violation: label)
//   E2  buttons remove the focus outline and show nothing else   (focus_invisible)
//   E3  the newsletter dialog traps keyboard focus: Tab and
//       Escape never leave it                                    (keyboard_trap)
//   E4  the footer text is pale grey on white                    (a11y_violation: color-contrast)
//   E5  the team photo has no alt text                           (a11y_violation: image-alt)

export const app: LabApp = {
  key: "e",
  name: "Accessibility",
  port: 4105,
  routes: {
    "GET /": (ctx) =>
      html(ctx, page("Recipe Box", `
        <style>
          .plain:focus { outline: none; }
          .fine-print { color: #c4c4c4; }
          .dialog { position: fixed; inset: 20% 10% auto; background: #ffffff; border: 2px solid #1a1a1a; padding: 16px; }
        </style>
        <main>
          <h1>Recipe Box</h1>
          <input id="q" placeholder="Search recipes">
          <select id="cat"><option>All</option><option>Dinner</option></select>
          <button class="plain" type="button">Search</button>
          <button class="plain" type="button" id="open">Get the newsletter</button>
          <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='80'/%3E" width="200" height="80">
          <p><a href="/recipes">All recipes</a></p>
          <div class="dialog" id="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" hidden>
            <h2 id="dlg-title">Join the newsletter</h2>
            <label for="nl-email">Email</label>
            <input id="nl-email" type="email">
            <button type="button" id="join">Join</button>
          </div>
        </main>
        <footer><p class="fine-print">Recipes are for inspiration only. Check allergens before cooking.</p></footer>
        <script>
          var dialog = document.getElementById("dialog");
          document.getElementById("open").addEventListener("click", function () {
            dialog.hidden = false;
            document.getElementById("nl-email").focus();
          });
          // E3: focus is forced back inside on every Tab, and nothing closes it.
          dialog.addEventListener("keydown", function (e) {
            if (e.key === "Tab") {
              e.preventDefault();
              document.getElementById("nl-email").focus();
            }
            if (e.key === "Escape") e.preventDefault();
          });
        </script>`)),
    "GET /recipes": (ctx) =>
      html(ctx, page("All recipes - Recipe Box", `<main><h1>All recipes</h1><p>Soup, salad, stew.</p><a href="/">Home</a></main>`)),
  },
};
