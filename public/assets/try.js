/**
 * The try-it page.
 *
 * One box, one thread. The run is driven from here: each POST to
 * /api/r/:id/advance does a slice of work on the server and returns
 * everything that has happened so far, so nothing important lives in this
 * tab - reload it and the report link still works.
 *
 * The narration is deliberately quiet. A test emits a few dozen events and
 * printing all of them reads like a log file, so the ordinary ones ("Opening
 * /pricing") replace each other on a single status line, and only the ones
 * that mean something - a suspicion, a confirmation, a refusal - stay.
 *
 * Nothing here is a language model.
 */
(function () {
  var stage = document.getElementById("stage");
  var thread = document.getElementById("thread");
  var form = document.getElementById("ask");
  var input = document.getElementById("url");
  var go = document.getElementById("go");
  var chips = document.getElementById("chips");
  if (!stage || !thread || !form || !input || !go) return;

  var busy = false;
  var status = null;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function add(node) {
    thread.appendChild(node);
    node.scrollIntoView({ block: "nearest" });
    return node;
  }

  function el(className, html) {
    var d = document.createElement("div");
    d.className = className;
    d.innerHTML = html;
    return d;
  }

  /**
   * One line that keeps being rewritten while the run works.
   *
   * A slice saves its events only when it ends, so the text can sit still for
   * the better part of a minute. The clock is the honest fix: it is counting
   * real elapsed time, not pretending to be progress.
   */
  var said = "";
  var since = 0;
  var ticker = null;
  function paint() {
    if (!status) return;
    var secs = Math.round((Date.now() - since) / 1000);
    status.lastElementChild.textContent = said + (secs >= 3 ? "  " + secs + "s" : "");
  }
  function working(text) {
    if (!status) status = add(el("status", '<span class="spin"></span><span></span>'));
    said = text;
    since = Date.now();
    paint();
    if (!ticker) ticker = setInterval(paint, 1000);
    status.scrollIntoView({ block: "nearest" });
  }
  function stopWorking() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (status && status.parentNode) status.parentNode.removeChild(status);
    status = null;
  }

  function line(text, kind) {
    add(el("line" + (kind ? " " + kind : ""), '<span class="dot"></span><span>' + esc(text) + "</span>"));
    // whatever Owly is doing now stays at the bottom, under what it just said
    if (status) thread.appendChild(status);
  }

  function lock(on) {
    busy = on;
    go.disabled = on;
    input.disabled = on;
  }

  if (chips) {
    chips.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip || busy) return;
      input.value = chip.getAttribute("data-url") || "";
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var value = input.value.trim();
    if (!value || busy) return;
    start(value);
  });

  async function start(value) {
    lock(true);
    stage.classList.add("started");
    if (chips) chips.hidden = true;
    add(el("said", esc(value)));
    input.value = "";
    working("Checking that address…");

    var res, body;
    try {
      res = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      body = await res.json();
    } catch (err) {
      stopWorking();
      line("Something went wrong reaching Owly. Try again in a moment.", "bad");
      lock(false);
      return;
    }

    if (!res.ok || !body.id) {
      stopWorking();
      line((body && body.error && body.error.message) || "I could not start that test.", "bad");
      if (body && body.error && body.error.code === "rate_limited") {
        add(el("line", '<span class="dot"></span><span>Owly is also on <a href="https://joinpond.ai" rel="noopener">Pond</a>, with its own free tier.</span>'));
      }
      lock(false);
      return;
    }

    var host = body.target;
    try {
      host = new URL(body.target).host;
    } catch (err) {}

    line(
      body.mode === "full"
        ? host + " is verified, so this is a full test: forms filled in, buttons pressed."
        : host + " is not verified as yours, so this is a look, not a touch: no typing, no pressing.",
      "good",
    );
    working("Opening " + host + "…");
    drive(body.id, body.report_url);
  }

  async function drive(id, reportUrl) {
    var seen = 0;
    var guard = 0;
    while (guard++ < 60) {
      var res, data;
      try {
        res = await fetch("/api/r/" + encodeURIComponent(id) + "/advance", { method: "POST" });
        data = await res.json();
      } catch (err) {
        stopWorking();
        add(el("line bad", '<span class="dot"></span><span>I lost the connection, but the run is still on the server: <a href="' + reportUrl + '">open it here</a>.</span>'));
        lock(false);
        return;
      }

      var events = data.events || [];
      for (var i = seen; i < events.length; i++) {
        var e = events[i];
        // Red is for things wrong with the site. Owly skipping its own work,
        // or dropping a suspicion it could not reproduce, is neither.
        if (e.level === "suspect" || e.level === "confirmed") line(e.text, "bad");
        else if (e.level === "dismissed" || e.level === "warn") line(e.text);
        else working(e.text + "…");
      }
      seen = events.length;

      if (data.status === "completed") return finish(data.summary, reportUrl);
      if (data.status === "failed") {
        stopWorking();
        line(data.error || "The test did not finish.", "bad");
        lock(false);
        return;
      }
    }
    stopWorking();
    add(el("line", '<span class="dot"></span><span>Still running, longer than I can narrate here: <a href="' + reportUrl + '">watch it</a>.</span>'));
    lock(false);
  }

  function finish(summary, reportUrl) {
    stopWorking();
    if (!summary) {
      add(el("line good", '<span class="dot"></span><span>Done. <a href="' + reportUrl + '">Open the report</a>.</span>'));
      lock(false);
      return;
    }

    var bad = /could not|cannot/i.test(summary.headline);
    var html = "";
    if (bad) html += '<span class="stamp">stopped</span>';
    html += "<h2>" + esc(summary.headline) + "</h2>";
    if (summary.detail) html += "<p>" + esc(summary.detail) + "</p>";
    html +=
      '<p class="facts">' +
      esc(summary.mode === "full" ? "full test" : "passive scan") +
      " &middot; " +
      summary.pages +
      (summary.pages === 1 ? " page" : " pages") +
      " &middot; " +
      esc(summary.counts) +
      " &middot; " +
      summary.seconds +
      "s</p>";
    if (summary.findings && summary.findings.length) {
      html += "<ul>";
      summary.findings.forEach(function (f) {
        html += '<li><i class="' + esc(f.severity) + '">' + esc(f.severity) + "</i>" + esc(f.title) + "</li>";
      });
      html += "</ul>";
    }
    html += '<div class="go-on"><a class="btn go" href="' + reportUrl + '">Open the full report</a>';
    html += '<button class="btn" type="button" data-again>Test another site</button></div>';

    var card = add(el("card" + (bad ? " bad" : ""), html));
    card.querySelector("[data-again]").addEventListener("click", function () {
      input.focus();
    });
    lock(false);
    input.focus();
  }
})();
