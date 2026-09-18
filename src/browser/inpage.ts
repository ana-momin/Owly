/**
 * Code that runs inside the page under test.
 *
 * Kept as plain JavaScript strings rather than TypeScript functions handed to
 * `page.evaluate`. A bundler or test runner is free to rewrite a function body
 * (esbuild injects `__name` helpers, for one), and the page has no such
 * helpers - the result is a ReferenceError that only happens in some build
 * setups. A string is exactly what arrives in the browser.
 *
 * Every script only READS the page, except for tagging elements with
 * `data-owly-*` attributes so they can be found again. None of them click,
 * type, or submit; that is done through Playwright, behind the action guard.
 */

/** Shared helpers, prepended to the scripts that need them. */
const HELPERS = `
  var owlyVisible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    var p = el;
    while (p) { if (p.hidden) return false; p = p.parentElement; }
    return true;
  };
  var owlyName = function (el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().replace(/\\s+/g, " ").slice(0, 80);
    if (el.id) {
      var lab = document.querySelector('label[for="' + el.id + '"]');
      if (lab && lab.innerText.trim()) return lab.innerText.trim().replace(/\\s+/g, " ").slice(0, 80);
    }
    var t = (el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim();
    return t.replace(/\\s+/g, " ").slice(0, 80);
  };
  var owlyDescribe = function (el) {
    if (!el || !el.tagName) return "";
    var d = el.tagName.toLowerCase();
    if (el.id) d += "#" + el.id;
    var cls = (typeof el.className === "string" ? el.className : "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) d += "." + cls.join(".");
    return d;
  };
  var owlyRole = function (el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input" && (type === "submit" || type === "image")) return "submit";
    if (tag === "button") {
      if (type === "button" || type === "reset") return "button";
      return el.form ? "submit" : "button";
    }
    return el.getAttribute("role") || tag;
  };
`;

/** Every visible control a user could press, tagged with a stable id. */
export const LIST_CONTROLS = `(() => {
  ${HELPERS}
  var out = [];
  var n = 0;
  var els = document.querySelectorAll('a[href], button, input[type=submit], input[type=button], input[type=image], [role=button], [role=link]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!owlyVisible(el)) continue;
    if (el.disabled) continue;
    var id = el.getAttribute("data-owly-id");
    if (!id) { id = "c" + (n++); el.setAttribute("data-owly-id", id); } else { n++; }
    var form = el.form || el.closest("form");
    out.push({
      id: id,
      name: owlyName(el),
      role: owlyRole(el),
      tag: el.tagName.toLowerCase(),
      href: el.tagName.toLowerCase() === "a" ? el.href : null,
      target: el.getAttribute("target") || null,
      inForm: !!form,
      formAction: form ? (form.action || location.href) : null,
      formMethod: form ? (form.getAttribute("method") || "get").toUpperCase() : null,
      describe: owlyDescribe(el)
    });
  }
  return out;
})()`;

/** Same-origin links with the text a user sees, for the link checker. */
export const LIST_LINKS = `(() => {
  ${HELPERS}
  var out = [];
  var anchors = document.querySelectorAll("a[href]");
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var href = a.getAttribute("href") || "";
    if (/^(mailto|tel|javascript|data):/i.test(href) || href.charAt(0) === "#") continue;
    out.push({ url: a.href, text: owlyName(a) || href });
  }
  return out;
})()`;

/** How far the page scrolls sideways, and what sticks out. */
export const MEASURE_OVERFLOW = `(() => {
  ${HELPERS}
  var doc = document.documentElement;
  var vw = doc.clientWidth;
  var excess = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - vw;
  var culprits = [];
  if (excess > 1) {
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && culprits.length < 5; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && owlyVisible(el)) {
        // Report the outermost offender, not every child inside it.
        var parentSticksOut = el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1 && el.parentElement !== document.body;
        if (!parentSticksOut) culprits.push({ describe: owlyDescribe(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
  }
  return { viewportWidth: vw, excess: Math.round(excess), culprits: culprits };
})()`;

/** Text cut off by a box too small to hold it, excluding deliberate truncation. */
export const FIND_CLIPPED = `(() => {
  ${HELPERS}
  var out = [];
  var els = document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th, label, span, div, a, button, dd, dt, blockquote");
  for (var i = 0; i < els.length && out.length < 10; i++) {
    var el = els[i];
    if (!owlyVisible(el)) continue;
    var hasText = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && c.textContent.trim().length > 20) { hasText = true; break; }
    }
    if (!hasText) continue;
    var s = getComputedStyle(el);
    var clipsY = (s.overflowY === "hidden" || s.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2;
    var clipsX = (s.overflowX === "hidden" || s.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2;
    if (!clipsX && !clipsY) continue;
    // Deliberate truncation is a design decision, not a defect.
    if (s.textOverflow === "ellipsis") continue;
    if (s.webkitLineClamp && s.webkitLineClamp !== "none") continue;
    // Visually-hidden helper classes clip on purpose.
    if (el.clientWidth <= 2 || el.clientHeight <= 2) continue;
    out.push({
      describe: owlyDescribe(el),
      text: el.innerText.trim().replace(/\\s+/g, " ").slice(0, 120),
      shownPx: clipsY ? el.clientHeight : el.clientWidth,
      neededPx: clipsY ? el.scrollHeight : el.scrollWidth,
      axis: clipsY ? "vertical" : "horizontal"
    });
  }
  return out;
})()`;

/** Pairs of controls drawn on top of each other. */
export const FIND_OVERLAPS = `(() => {
  ${HELPERS}
  var els = [];
  var nodes = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]');
  for (var i = 0; i < nodes.length; i++) if (owlyVisible(nodes[i])) els.push(nodes[i]);
  // Per line, not one box round the whole element. An inline link that wraps
  // across two lines has a bounding box covering both lines AND the gap
  // between them, which made every neighbouring link in a wrapping footer look
  // completely covered. getClientRects gives one box per line.
  var boxesOf = function (el) {
    var rects = el.getClientRects();
    if (rects.length === 0) return [el.getBoundingClientRect()];
    var out = [];
    for (var i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) out.push(rects[i]);
    return out;
  };

  var out = [];
  for (var a = 0; a < els.length; a++) {
    for (var b = a + 1; b < els.length; b++) {
      var x = els[a], y = els[b];
      if (x.contains(y) || y.contains(x)) continue;
      var boxesX = boxesOf(x), boxesY = boxesOf(y);
      var worst = 0;
      for (var i = 0; i < boxesX.length; i++) {
        for (var j = 0; j < boxesY.length; j++) {
          var r1 = boxesX[i], r2 = boxesY[j];
          var w = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
          var h = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
          if (w <= 0 || h <= 0) continue;
          var smaller = Math.min(r1.width * r1.height, r2.width * r2.height);
          if (smaller > 0) worst = Math.max(worst, (w * h) / smaller);
        }
      }
      if (worst >= 0.25) {
        out.push({ first: owlyName(x) || owlyDescribe(x), second: owlyName(y) || owlyDescribe(y), share: Math.round(worst * 100) });
      }
    }
  }
  return out.slice(0, 10);
})()`;

/**
 * For each visible control, whether a tap at its centre would land on it.
 * Scrolls each into view first, so a sticky header covering an element that
 * is merely scrolled under it does not count.
 */
export const FIND_OBSCURED = `(() => {
  ${HELPERS}
  var out = [];
  var els = document.querySelectorAll('button, input[type=submit], input[type=button], a[href], [role=button]');
  for (var i = 0; i < els.length && out.length < 20; i++) {
    var el = els[i];
    if (!owlyVisible(el) || el.disabled) continue;
    el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    var top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    // Covered by another control is the overlapping-controls problem, already
    // reported as such. Reporting it here too would be the same bug twice.
    if (top.closest('a[href], button, input, select, textarea, [role=button], [role=link]')) continue;
    // Walk up from what was hit to find the element doing the covering.
    var cover = top;
    while (cover.parentElement && cover.parentElement !== document.body && !cover.parentElement.contains(el)) {
      var ps = getComputedStyle(cover.parentElement);
      if (ps.position === "fixed" || ps.position === "sticky" || ps.position === "absolute") { cover = cover.parentElement; break; }
      cover = cover.parentElement;
    }
    out.push({ control: owlyName(el) || owlyDescribe(el), coveredBy: owlyDescribe(cover), coverText: (cover.innerText || "").trim().slice(0, 80) });
  }
  window.scrollTo(0, 0);
  return out;
})()`;

/** Whether a page offers any way to go anywhere. */
export const COUNT_WAYS_ON = `(() => {
  ${HELPERS}
  var n = 0;
  var els = document.querySelectorAll('a[href], button, input[type=submit], input[type=button], [role=button], [role=link], select, form');
  for (var i = 0; i < els.length; i++) if (els[i].tagName === "FORM" || owlyVisible(els[i])) n++;
  return { ways: n, title: document.title, heading: (document.querySelector("h1") || {}).innerText || "" };
})()`;

/** Tag every keyboard-focusable element and record how it looks unfocused. */
export const SNAPSHOT_FOCUSABLES = `(() => {
  ${HELPERS}
  var sel = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=true]';
  var els = document.querySelectorAll(sel);
  var out = {};
  var n = 0;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!owlyVisible(el) || el.disabled) continue;
    var id = "f" + (n++);
    el.setAttribute("data-owly-f", id);
    out[id] = window.__owlyStyle(el);
  }
  return out;
})()`;

/** Installed once per page: how an element looks, as far as focus is concerned. */
export const INSTALL_STYLE_PROBE = `(() => {
  window.__owlyStyle = function (el) {
    var s = getComputedStyle(el);
    var p = el.parentElement ? getComputedStyle(el.parentElement) : null;
    return [
      s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow,
      s.borderTopColor, s.borderBottomColor, s.borderTopWidth,
      s.backgroundColor, s.color, s.textDecorationLine, s.transform, s.filter,
      p ? p.outlineStyle + "|" + p.boxShadow + "|" + p.backgroundColor + "|" + p.borderTopColor : ""
    ].join(";");
  };
  return true;
})()`;

/** The focused element, and whether it looks any different from unfocused. */
export const READ_FOCUS = `(() => {
  ${HELPERS}
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return {
    fid: el.getAttribute("data-owly-f"),
    name: owlyName(el) || owlyDescribe(el),
    describe: owlyDescribe(el),
    style: window.__owlyStyle ? window.__owlyStyle(el) : "",
    dialog: (function () { var d = el.closest('[role=dialog], dialog, [aria-modal=true]'); return d ? owlyDescribe(d) : null; })()
  };
})()`;

/** Visible dialogs right now. */
export const OPEN_DIALOGS = `(() => {
  ${HELPERS}
  var out = [];
  var els = document.querySelectorAll('[role=dialog], dialog, [aria-modal=true]');
  for (var i = 0; i < els.length; i++) {
    if (owlyVisible(els[i])) out.push({ describe: owlyDescribe(els[i]), label: (els[i].getAttribute("aria-label") || (document.getElementById(els[i].getAttribute("aria-labelledby") || "") || {}).innerText || "").trim().slice(0, 80) });
  }
  return out;
})()`;

/** Images that failed to load. */
export const FIND_BROKEN_IMAGES = `(() => {
  ${HELPERS}
  var out = [];
  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var src = img.currentSrc || img.src || "";
    if (!src || src.indexOf("data:") === 0) continue;
    if (img.complete && img.naturalWidth === 0) out.push({ src: src, alt: img.getAttribute("alt") || "" });
  }
  return out;
})()`;

/**
 * Forms, with enough about each field to fill it with plausible synthetic data.
 * Fields are tagged `data-owly-field` so they can be filled through Playwright.
 */
export const LIST_FORMS = `(() => {
  ${HELPERS}
  var forms = document.querySelectorAll("form");
  var out = [];
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    f.setAttribute("data-owly-form", String(i));
    var fields = [];
    var els = f.querySelectorAll("input, textarea, select");
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      var type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file"].indexOf(type) >= 0) continue;
      if (!owlyVisible(el) || el.disabled || el.readOnly) continue;
      var key = "fd" + i + "_" + j;
      el.setAttribute("data-owly-field", key);
      var options = [];
      if (el.tagName === "SELECT") for (var k = 0; k < el.options.length; k++) options.push(el.options[k].value);
      fields.push({
        key: key,
        tag: el.tagName.toLowerCase(),
        type: type,
        name: el.getAttribute("name") || "",
        id: el.id || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        label: owlyName(el),
        required: !!el.required,
        min: el.getAttribute("min"),
        max: el.getAttribute("max"),
        options: options
      });
    }
    var submit = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (submit && !owlyVisible(submit)) submit = null;
    if (submit) submit.setAttribute("data-owly-submit", String(i));
    out.push({
      index: i,
      action: f.action || location.href,
      method: (f.getAttribute("method") || "get").toUpperCase(),
      fields: fields,
      submit: submit ? { name: owlyName(submit), role: "submit" } : null
    });
  }
  return out;
})()`;

/** What a user would read as the page's reaction. */
export const READ_STATE = `(() => {
  var live = [];
  var regions = document.querySelectorAll('[role=status], [role=alert], [aria-live]');
  for (var i = 0; i < regions.length; i++) live.push((regions[i].innerText || "").trim());
  var invalid = 0;
  var fields = document.querySelectorAll("input, textarea, select");
  for (var j = 0; j < fields.length; j++) {
    if (fields[j].getAttribute("aria-invalid") === "true") invalid++;
    else if (fields[j].validationMessage && fields[j].willValidate && !fields[j].checkValidity()) invalid++;
  }
  return {
    url: location.href,
    text: (document.body ? document.body.innerText : "").slice(0, 20000),
    live: live.join(" | ").slice(0, 500),
    invalid: invalid
  };
})()`;

/** Standalone buttons: not in a form, not links. Candidates for "press and watch". */
export const LIST_LOOSE_BUTTONS = `(() => {
  ${HELPERS}
  var out = [];
  var els = document.querySelectorAll('button, [role=button], input[type=button]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!owlyVisible(el) || el.disabled) continue;
    if (el.closest("form")) continue;
    var key = "b" + i;
    el.setAttribute("data-owly-btn", key);
    out.push({ key: key, name: owlyName(el) || owlyDescribe(el), role: "button" });
  }
  return out;
})()`;
