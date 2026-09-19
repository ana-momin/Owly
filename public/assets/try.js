/**
 * The try-it conversation.
 *
 * Owly talks, you answer with a URL, and the run is driven from here: each
 * POST to /api/r/:id/advance does one slice of work on the server and hands back
 * everything that has happened so far. No polling loop on a timer, no state
 * kept in this page that matters - reload it and the report link still works.
 *
 * Nothing here is a language model. The lines are Owly's own run events, in
 * the order the browser recorded them.
 */
(function () {
  var log = document.getElementById("log");
  var form = document.getElementById("ask");
  var input = document.getElementById("url");
  var go = document.getElementById("go");
  var strap = document.getElementById("strap-note");
  if (!log || !form || !input || !go) return;

  var OWL = "/icon-64.png";
  var busy = false;
  var thinking = null;

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }

  function bubble(html, kind) {
    var row = document.createElement("div");
    row.className = "msg" + (kind === "me" ? " me" : "");
    if (kind !== "me") {
      // One avatar per run of messages, the way a chat actually looks.
      var last = log.lastElementChild;
      var img = document.createElement("img");
      img.src = OWL;
      img.alt = "";
      img.width = 40;
      img.height = 40;
      if (last && last.className.indexOf("me") === -1) img.className = "blank";
      row.appendChild(img);
    }
    var say = document.createElement("div");
    say.className = "say" + (kind && kind !== "me" ? " " + kind : "");
    say.innerHTML = html;
    row.appendChild(say);
    log.appendChild(row);
    scroll();
    return row;
  }

  function text(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function startThinking() {
    if (thinking) return;
    thinking = bubble('<span class="dots"><i></i><i></i><i></i></span>');
  }
  function stopThinking() {
    if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
    thinking = null;
  }

  function say(html, kind, delay) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        bubble(html, kind);
        resolve();
      }, delay || 0);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return;
    var value = input.value.trim();
    if (!value) return;
    start(value);
  });

  function lock(on) {
    busy = on;
    go.disabled = on;
    input.disabled = on;
    go.textContent = on ? "Working" : "Go";
  }

  async function start(value) {
    lock(true);
    bubble(text(value), "me");
    input.value = "";
    startThinking();

    var res, body;
    try {
      res = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      body = await res.json();
    } catch (err) {
      stopThinking();
      await say("Something went wrong on my side reaching that. Try again in a moment.", "bad");
      lock(false);
      return;
    }
    stopThinking();

    if (!res.ok || !body.id) {
      var message = (body && body.error && body.error.message) || "I could not start that test.";
      await say(text(message), "bad");
      if (body && body.error && body.error.code === "rate_limited") {
        await say('You can keep going on <a href="https://joinpond.ai" rel="noopener">Pond</a>, where Owly has its own free tier.', "note", 400);
      }
      lock(false);
      return;
    }

    if (strap) strap.textContent = body.mode === "full" ? "verified site - full test" : "unverified site - passive scan";

    var host = body.target;
    try {
      host = new URL(body.target).host;
    } catch (err) {}

    await say(
      body.mode === "full"
        ? "Right. <b>" + text(host) + "</b> is verified, so this is a full test: I will fill forms in and press things."
        : "Right. I will look at <b>" + text(host) + "</b> but not touch anything - it is not verified as yours, so no typing and no pressing.",
      null,
      250,
    );
    await say("This takes about ninety seconds. I will tell you what I see as I go.", null, 400);
    if (typeof body.left === "number") {
      await say(body.left > 0 ? "Free tests left from here today: <b>" + body.left + "</b>." : "That was your last free test today.", "note", 300);
    }

    drive(body.id, body.report_url);
  }

  async function drive(id, reportUrl) {
    var seen = 0;
    var guard = 0;
    while (guard++ < 60) {
      startThinking();
      var res, data;
      try {
        res = await fetch("/api/r/" + encodeURIComponent(id) + "/advance", { method: "POST" });
        data = await res.json();
      } catch (err) {
        stopThinking();
        await say('I lost the connection. The run is still on the server: <a href="' + reportUrl + '">open it here</a>.', "bad");
        lock(false);
        return;
      }
      stopThinking();

      var events = data.events || [];
      for (var i = seen; i < events.length; i++) {
        var e = events[i];
        var kind = e.level === "confirmed" ? "note" : e.level === "warn" || e.level === "suspect" ? "bad" : null;
        await say(text(e.text), kind, i === seen ? 0 : 260);
      }
      seen = events.length;

      if (data.status === "completed") {
        await finish(data.summary, reportUrl);
        return;
      }
      if (data.status === "failed") {
        await say(text(data.error || "The test did not finish."), "bad");
        lock(false);
        return;
      }
    }
    await say('This one is taking longer than I can narrate. It is still running: <a href="' + reportUrl + '">watch it here</a>.', "note");
    lock(false);
  }

  async function finish(summary, reportUrl) {
    if (!summary) {
      await say('Done. <a href="' + reportUrl + '">Open the report</a>.', "note");
      lock(false);
      return;
    }
    var html = '<b class="head">' + text(summary.headline) + "</b>";
    if (summary.detail) html += "<p>" + text(summary.detail) + "</p>";
    html +=
      '<span class="mono">' +
      text(summary.mode === "full" ? "full test" : "passive scan") +
      " &middot; " +
      summary.pages +
      (summary.pages === 1 ? " page" : " pages") +
      " &middot; " +
      text(summary.counts) +
      " &middot; " +
      summary.seconds +
      "s</span>";
    (summary.findings || []).forEach(function (f) {
      html += '<span class="find"><i class="' + text(f.severity) + '">' + text(f.severity) + "</i>" + text(f.title) + "</span>";
    });
    await say(html, summary.headline.indexOf("could not") === 0 || /cannot|could not/.test(summary.headline) ? "bad" : null);
    await say('<a class="btn sun" href="' + reportUrl + '">Open the full report</a>', "plain", 350);
    await say("Want me to look at another one? Drop it in below.", null, 450);
    lock(false);
  }
})();
