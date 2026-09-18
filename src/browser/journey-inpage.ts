/**
 * Finding the way in, from inside the page.
 *
 * A scanner asks "what is wrong with this page". A journey asks "how would a
 * person start the thing this site is for". That means judging which control a
 * newcomer's eye lands on, which is a visual question: how big it is, how high
 * on the page, whether it looks like a button, and whether its words promise
 * the task.
 *
 * Plain JS strings for the same reason as inpage.ts: a bundler must not be
 * able to rewrite what runs in the page.
 */

export const RANK_ENTRY_POINTS = `((taskPatterns) => {
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    var s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  var nameOf = function (el) {
    var t = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").trim();
    return t.replace(/\\s+/g, " ").slice(0, 80);
  };
  var describe = function (el) {
    var d = el.tagName.toLowerCase();
    if (el.id) d += "#" + el.id;
    return d;
  };

  var out = [];
  var n = 0;
  var els = document.querySelectorAll('a[href], button, input[type=submit], [role=button]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!visible(el) || el.disabled) continue;
    var name = nameOf(el);
    if (!name) continue;

    var task = null;
    for (var k = 0; k < taskPatterns.length; k++) {
      if (new RegExp(taskPatterns[k][1], "i").test(name)) { task = taskPatterns[k][0]; break; }
    }
    if (!task) continue;

    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    // How much a newcomer's eye is drawn to it: size, how high up it sits,
    // and whether it is styled as a button rather than a line of text.
    var area = Math.min(r.width * r.height, 40000) / 40000;
    var height = Math.max(0, 1 - Math.max(0, r.top + scrollY) / 1600);
    var looksLikeButton = 0;
    var bg = s.backgroundColor || "";
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") looksLikeButton += 0.5;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") looksLikeButton += 0.3;
    if (parseFloat(s.borderRadius) > 2) looksLikeButton += 0.2;
    var inNav = el.closest("nav, header") ? 0.15 : 0;
    var inFooter = el.closest("footer") ? -0.4 : 0;

    var id = "e" + (n++);
    el.setAttribute("data-owly-entry", id);
    out.push({
      id: id,
      name: name,
      task: task,
      href: el.tagName.toLowerCase() === "a" ? el.href : null,
      describe: describe(el),
      prominence: Math.round((area * 0.9 + height * 1.2 + looksLikeButton + inNav + inFooter) * 100) / 100,
      top: Math.round(r.top + scrollY)
    });
  }
  out.sort(function (a, b) { return b.prominence - a.prominence; });
  return out.slice(0, 12);
})(TASK_PATTERNS)`;

/** What the page says happened, in the words a user would read. */
export const READ_OUTCOME = `(() => {
  var text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
  var live = [];
  var regions = document.querySelectorAll('[role=status], [role=alert], [aria-live], .error, .success, .notice');
  for (var i = 0; i < regions.length; i++) {
    var t = (regions[i].innerText || "").replace(/\\s+/g, " ").trim();
    if (t) live.push(t.slice(0, 200));
  }
  var invalid = [];
  var fields = document.querySelectorAll("input, textarea, select");
  for (var j = 0; j < fields.length; j++) {
    var f = fields[j];
    if (f.getAttribute("aria-invalid") === "true" || (f.willValidate && f.validationMessage && !f.checkValidity())) {
      invalid.push((f.getAttribute("name") || f.id || f.type) + ": " + (f.validationMessage || "marked invalid"));
    }
  }
  return {
    url: location.href,
    title: document.title,
    heading: (document.querySelector("h1") || { innerText: "" }).innerText.trim().slice(0, 120),
    live: live.slice(0, 5),
    invalid: invalid.slice(0, 5),
    textLength: text.length,
    text: text.slice(0, 3000)
  };
})()`;

/** Is there a form here a newcomer would be expected to fill in? */
export const DESCRIBE_MAIN_FORM = `(() => {
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  var forms = document.querySelectorAll("form");
  var best = null;
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    if (!visible(f)) continue;
    var fields = f.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
    var count = 0;
    for (var j = 0; j < fields.length; j++) if (visible(fields[j])) count++;
    if (count === 0) continue;
    if (!best || count > best.count) {
      f.setAttribute("data-owly-journey-form", "1");
      best = { index: i, count: count };
    }
  }
  return best;
})()`;
