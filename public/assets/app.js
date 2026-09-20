/**
 * The chat.
 *
 * Two things happen here and they are kept strictly apart:
 *
 *   talking   POST /api/chat. May be answered by a language model. It can
 *             say things, and it can ask for a test to be started, but it
 *             cannot start one and it never invents a result.
 *
 *   testing   POST /api/try, then /api/r/:id/advance in a loop. This is the
 *             real thing: a browser on a server opening the site. Every line
 *             the thread shows while a test runs came from that browser, in
 *             the order it happened.
 *
 * So when Owly says it found something, that is not a model talking. The
 * model only ever gets to describe a report that already exists.
 */
(function () {
  var scroll = document.getElementById("scroll");
  var thread = document.getElementById("thread");
  var hello = document.getElementById("hello");
  var form = document.getElementById("composer");
  var input = document.getElementById("say");
  var send = document.getElementById("send");
  var suggest = document.getElementById("suggest");
  if (!scroll || !thread || !form || !input || !send) return;

  var busy = false;
  var history = [];
  var lastReport = null;
  var stopped = false;

  /* ------------------------------------------------------------- plumbing */

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  var stick = true;
  scroll.addEventListener("scroll", function () {
    stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  });
  function toBottom(force) {
    if (!stick && !force) return;
    scroll.scrollTop = scroll.scrollHeight;
  }

  function began() {
    if (hello && !hello.hidden) {
      hello.hidden = true;
      if (suggest) suggest.hidden = true;
      scroll.classList.remove("empty");
    }
  }

  /* ------------------------------------------------------------- messages */

  function youSaid(text) {
    began();
    var turn = el("div", "turn you");
    turn.appendChild(el("div", "bubble", esc(text)));
    thread.appendChild(turn);
    toBottom(true);
  }

  /** An Owly turn. Returns the element its content goes in. */
  function owlySays() {
    began();
    var turn = el("div", "turn owly");
    var face = el("img", "face");
    face.src = "/icon-64.png";
    face.alt = "";
    face.width = 27;
    face.height = 27;
    turn.appendChild(face);
    var say = el("div", "say");
    turn.appendChild(say);
    thread.appendChild(turn);
    toBottom();
    return say;
  }

  /**
   * The little formatting a reply is allowed: paragraphs, **bold**, `code`.
   * Everything is escaped first, so this can never inject markup even if a
   * model is talked into trying.
   */
  function rich(text) {
    return esc(text)
      .split(/\n{2,}/)
      .map(function (para) {
        return (
          "<p>" +
          para
            .replace(/\n/g, "<br>")
            .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
            .replace(/`([^`]+)`/g, "<code>$1</code>") +
          "</p>"
        );
      })
      .join("");
  }

  function say(text) {
    var box = owlySays();
    box.innerHTML = rich(text);
    history.push({ role: "assistant", content: text });
    toBottom();
    return box;
  }

  function oops(text) {
    var box = owlySays();
    box.innerHTML = '<p class="oops">' + esc(text) + "</p>";
    toBottom();
  }

  /* -------------------------------------------------------------- the box */

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.42) + "px";
  }
  input.addEventListener("input", function () {
    grow();
    send.disabled = busy ? false : !input.value.trim();
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy && input.value.trim()) form.requestSubmit();
    }
  });

  function lock(on) {
    busy = on;
    input.disabled = false;
    send.disabled = on ? false : !input.value.trim();
    send.classList.toggle("stop", on);
    send.setAttribute("aria-label", on ? "Stop" : "Send");
    send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) {
      stopped = true;
      return;
    }
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    turn(text);
  });

  if (suggest) {
    suggest.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || busy) return;
      turn(b.getAttribute("data-say") || b.textContent.trim());
    });
  }

  /* ---------------------------------------------------------------- a turn */

  async function turn(text) {
    youSaid(text);
    history.push({ role: "user", content: text });
    lock(true);
    stopped = false;

    var thinking = owlySays();
    thinking.innerHTML = '<div class="work"><div class="now"><span class="dot"></span><span class="text">Thinking</span></div></div>';

    var data;
    try {
      var res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-12), report: lastReport }),
      });
      data = await res.json();
    } catch (err) {
      thinking.parentNode.remove();
      oops("I could not reach the server. Try again in a moment.");
      lock(false);
      return;
    }

    thinking.parentNode.remove();

    if (data && data.test) {
      await runTest(data.test);
      lock(false);
      return;
    }
    say((data && data.reply) || "I test websites. Paste an address and I will take a look.");
    lock(false);
    input.focus();
  }

  /* ------------------------------------------------------------ the test */

  function liveBox() {
    var say = owlySays();
    var work = el("div", "work", '<div class="now"><span class="dot"></span><span class="text">Checking that address</span><span class="clock"></span></div><ul></ul>');
    say.appendChild(work);
    toBottom();
    return {
      box: say,
      text: work.querySelector(".text"),
      clock: work.querySelector(".clock"),
      list: work.querySelector("ul"),
      head: work.querySelector(".now"),
    };
  }

  async function runTest(site) {
    var live = liveBox();
    var began = Date.now();
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - began) / 1000);
      live.clock.textContent = s >= 3 ? s + "s" : "";
    }, 1000);

    function now(text) {
      live.text.textContent = text;
      toBottom();
    }
    function note(text, kind) {
      var li = el("li", kind || "");
      li.appendChild(el("span", "tag", kind === "found" ? "found" : kind === "clear" ? "clear" : "note"));
      li.appendChild(el("span", "", esc(text)));
      live.list.appendChild(li);
      toBottom();
    }
    /** How the run was scoped. Not a finding either way, so not coloured. */
    function scope(text) {
      note(text, "");
    }

    /*
     * A suspicion and its confirmation are the same sentence twice - "Possible
     * issue: X" then "Confirmed: X" - and printing both reads like a stutter.
     * The second one rewrites the first instead, so the line you end up with
     * says what was decided, and the verifying is visible as it happens rather
     * than as a duplicate afterwards.
     */
    var claims = {};
    function claim(text, level) {
      // Every prefix the engine puts in front of the same sentence. Missing
      // one shows up as the line appearing twice, which is exactly the
      // stutter this is here to prevent.
      var body = text
        .replace(/^(possible issue|confirmed|likely|dropped|dismissed|could not reproduce, so not reported)\s*:\s*/i, "")
        .trim();
      var known = claims[body];
      var kind = level === "confirmed" ? "found" : level === "suspect" ? "checking" : "";
      if (known) {
        known.className = kind;
        known.firstChild.textContent = level === "confirmed" ? "found" : level === "suspect" ? "checking" : "dropped";
        known.lastChild.textContent = body;
        toBottom();
        return;
      }
      var li = el("li", kind);
      li.appendChild(el("span", "tag", level === "confirmed" ? "found" : level === "suspect" ? "checking" : "dropped"));
      li.appendChild(el("span", "", body));
      live.list.appendChild(li);
      claims[body] = li;
      toBottom();
    }
    function done() {
      clearInterval(tick);
      live.head.remove();
    }

    var res, body;
    try {
      res = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: site }),
      });
      body = await res.json();
    } catch (err) {
      done();
      live.box.innerHTML = '<p class="oops">I could not reach the server. Try again in a moment.</p>';
      return;
    }

    if (!res.ok || !body.id) {
      done();
      var why = (body && body.error && body.error.message) || "I could not start that test.";
      live.box.innerHTML = '<p class="oops">' + esc(why) + "</p>";
      if (body && body.error && body.error.code === "rate_limited") {
        live.box.innerHTML += '<p>Owly is also on <a href="https://joinpond.ai" rel="noopener">Pond</a>, with its own free tier.</p>';
      }
      return;
    }

    var host = body.target;
    try {
      host = new URL(body.target).host;
    } catch (err) {}

    scope(
      body.mode === "full"
        ? host + " is verified as yours, so this is a full test: forms filled in, buttons pressed."
        : host + " is not verified as yours, so I will look but not touch - no typing, no pressing.",
    );
    now("Opening " + host);

    var seen = 0;
    var guard = 0;
    while (guard++ < 60) {
      if (stopped) {
        done();
        note("Stopped. The run carries on on the server.", "");
        live.box.appendChild(reportLinks(body.report_url));
        return;
      }
      var step, data;
      try {
        step = await fetch("/api/r/" + encodeURIComponent(body.id) + "/advance", { method: "POST" });
        data = await step.json();
      } catch (err) {
        done();
        note("I lost the connection, but the run is still going on the server.", "");
        live.box.appendChild(reportLinks(body.report_url));
        return;
      }

      var events = data.events || [];
      for (var i = seen; i < events.length; i++) {
        var e = events[i];
        if (e.level === "suspect" || e.level === "confirmed" || e.level === "dismissed") claim(e.text, e.level);
        else if (e.level === "warn") note(e.text, "");
        else now(e.text);
      }
      seen = events.length;

      if (data.status === "completed") {
        done();
        return finish(live, data.summary, body.report_url);
      }
      if (data.status === "failed") {
        done();
        note(data.error || "The test did not finish.", "found");
        return;
      }
    }
    done();
    note("Still running, longer than I can narrate here.", "");
    live.box.appendChild(reportLinks(body.report_url));
  }

  function reportLinks(url) {
    var foot = el("div", "foot");
    var a = el("a", "linkish primary", "Open the full report");
    a.href = url;
    foot.appendChild(a);
    var again = el("button", "linkish", "Test another site");
    again.type = "button";
    again.addEventListener("click", function () {
      input.focus();
    });
    foot.appendChild(again);
    return foot;
  }

  /**
   * The run is over. The card goes UNDER what was narrated rather than over
   * it: how the run was scoped - looked at but not touched, say - is the
   * thing people most need to still be able to see afterwards, and replacing
   * the trace with a tidy summary quietly threw it away.
   */
  function finish(live, summary, reportUrl) {
    if (!live.list.children.length) live.list.remove();
    if (!summary) {
      live.box.appendChild(rowsOnly("Done.", reportUrl));
      return;
    }

    var card = el("div", "result");
    var head = el("div", "head");
    head.appendChild(el("h2", "", esc(summary.headline)));
    var facts =
      (summary.mode === "full" ? "full test" : "passive scan") +
      " · " +
      summary.pages +
      (summary.pages === 1 ? " page" : " pages") +
      " · " +
      summary.counts +
      " · " +
      summary.seconds +
      "s";
    head.appendChild(el("div", "sub", esc(facts)));
    card.appendChild(head);

    if (summary.detail || (summary.findings && summary.findings.length)) {
      var bodyEl = el("div", "body");
      if (summary.detail) bodyEl.appendChild(el("p", "", esc(summary.detail)));
      (summary.findings || []).forEach(function (f) {
        var row = el("div", "item");
        row.appendChild(el("span", "sev " + esc(f.severity), esc(f.severity)));
        row.appendChild(el("span", "what", esc(f.title)));
        bodyEl.appendChild(row);
      });
      card.appendChild(bodyEl);
    }
    card.appendChild(reportLinks(reportUrl));
    live.box.appendChild(card);

    // What the model is allowed to talk about from here on.
    lastReport = [
      summary.headline,
      summary.detail || "",
      facts,
      (summary.findings || [])
        .map(function (f) {
          return "- " + f.severity + ": " + f.title;
        })
        .join("\n"),
      "Full report: " + reportUrl,
    ]
      .filter(Boolean)
      .join("\n");
    history.push({ role: "assistant", content: lastReport });
    toBottom();
  }

  function rowsOnly(text, url) {
    var wrap = el("div", "result");
    wrap.appendChild(el("div", "head", "<h2>" + esc(text) + "</h2>"));
    wrap.appendChild(reportLinks(url));
    return wrap;
  }

  /* ---------------------------------------------------------------- theme */

  var toggle = document.getElementById("theme");
  if (toggle) {
    var saved = null;
    try {
      saved = localStorage.getItem("owly-theme");
    } catch (err) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    toggle.addEventListener("click", function () {
      var dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      var next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("owly-theme", next);
      } catch (err) {}
    });
  }

  lock(false);
  grow();
  if (!matchMedia("(pointer: coarse)").matches) input.focus();
})();
