/**
 * Runs before first paint, so a dark-mode visitor never gets a white flash
 * and the sidebar does not slide shut after the page has already drawn.
 *
 * A separate file rather than an inline script so the page can be served
 * with a Content-Security-Policy that refuses inline script outright. Owly
 * found its own site missing that header; this is what it cost to fix.
 */
(function () {
  try {
    var t = localStorage.getItem("owly-theme");
    if (t) document.documentElement.setAttribute("data-theme", t);
    if (localStorage.getItem("owly-rail") === "closed") document.documentElement.classList.add("rail-closed");
  } catch (e) {}
})();
