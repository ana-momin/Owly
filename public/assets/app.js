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
 *
 * A conversation is kept in this browser so a reload does not throw it away.
 * What is stored is the turns, not the run: the run itself lives on the
 * server and its report keeps its own address.
 */
(function () {
  var scroll = document.getElementById("scroll");
  var thread = document.getElementById("thread");
  var hello = document.getElementById("hello");
  var form = document.getElementById("composer");
  var input = document.getElementById("say");
  var send = document.getElementById("send");
  var leftChip = document.getElementById("left");
  var pastList = document.getElementById("past");
  if (!scroll || !thread || !form || !input || !send) return;

  var busy = false;
  var stopped = false;
  /** What the model is allowed to describe: the last report, as text. */
  var lastReport = null;

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

  function svg(path, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  }

  var ICON = {
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    good: svg('<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zM7 10l4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 16.8 21H7"/>'),
    tick: svg('<path d="M20 6 9 17l-5-5"/>'),
    bad: svg('<path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zM17 14l-4 7a2 2 0 0 1-3-2l1-5H6a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 7.2 3H17"/>'),
  };

  /* ------------------------------------------------------------- scrolling */

  var stick = true;
  scroll.addEventListener("scroll", function () {
    stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  });
  function toBottom(force) {
    // Belt and braces: the empty state stops the thread scrolling, so a
    // thread with anything in it must never still be wearing that class.
    if (thread.children.length && scroll.classList.contains("empty")) began();
    if (!stick && !force) return;
    // After the next paint: a block added this tick has no height yet, so
    // scrolling now would stop just short and look stuck.
    requestAnimationFrame(function () {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }

  function began() {
    if (!scroll.classList.contains("empty")) return;
    scroll.classList.remove("empty");
    if (hello) hello.hidden = true;
  }

  /* --------------------------------------------------------------- storage */

  var KEY = "owly-chats";
  var chat = null;

  /**
   * What Owly knows between one question and the next.
   *
   * Kept in the browser on purpose: Owly has no accounts, and a server-side
   * profile keyed on someone's IP address would be worse privacy AND worse
   * identity. The person's own machine holds their own history; the server
   * reasons over whatever is sent with the turn.
   */
  var MEM = "owly-memory";

  function memory() {
    try {
      var raw = JSON.parse(localStorage.getItem(MEM) || "{}");
      return {
        mine: Array.isArray(raw.mine) ? raw.mine : [],
        runs: Array.isArray(raw.runs) ? raw.runs : [],
        facts: Array.isArray(raw.facts) ? raw.facts : [],
      };
    } catch (err) {
      return { mine: [], runs: [], facts: [] };
    }
  }

  function saveMemory(m) {
    try {
      // Newest first, and bounded: a browser store is not an archive.
      m.runs = m.runs.slice(0, 40);
      m.mine = m.mine.slice(0, 40);
      m.facts = m.facts.slice(0, 30);
      localStorage.setItem(MEM, JSON.stringify(m));
    } catch (err) {
      /* private window or full: Owly simply forgets, which is survivable */
    }
  }

  function hostOf(value) {
    return String(value || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/^www\./i, "")
      .toLowerCase();
  }

  /** Remember that a run happened, and what it found. */
  function rememberRun(site, summary) {
    var m = memory();
    m.runs.unshift({
      site: hostOf(site),
      at: new Date().toISOString(),
      mode: summary.mode || "passive",
      headline: summary.headline || "",
      findings: (summary.findings || []).map(function (f) {
        return { severity: f.severity, title: f.title };
      }),
    });
    saveMemory(m);
  }

  function rememberFacts(facts, mine) {
    if ((!facts || !facts.length) && !mine) return;
    var m = memory();
    (facts || []).forEach(function (f) {
      if (f && m.facts.indexOf(f) < 0) m.facts.unshift(f);
    });
    if (mine && m.mine.indexOf(hostOf(mine)) < 0) m.mine.unshift(hostOf(mine));
    saveMemory(m);
  }

  /**
   * What changed since the last run of this site.
   *
   * Matched on severity and title, because that is what a person reads and
   * what they would call "the same bug". Returns null the first time a site
   * is seen, which is the honest answer to "did I fix it".
   */
  function changeSince(site, findings) {
    var host = hostOf(site);
    var previous = memory().runs.filter(function (r) {
      return r.site === host;
    })[0];
    if (!previous) return null;

    var key = function (f) {
      return (f.severity + "|" + f.title).toLowerCase();
    };
    var before = {};
    (previous.findings || []).forEach(function (f) {
      before[key(f)] = f;
    });
    var now = {};
    (findings || []).forEach(function (f) {
      now[key(f)] = f;
    });

    var fixed = Object.keys(before).filter(function (k) {
      return !now[k];
    });
    var still = Object.keys(now).filter(function (k) {
      return before[k];
    });
    var fresh = Object.keys(now).filter(function (k) {
      return !before[k];
    });
    return { fixed: fixed.length, still: still.length, fresh: fresh.length, at: previous.at };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var all = raw ? JSON.parse(raw) : [];
      return Array.isArray(all) ? all : [];
    } catch (err) {
      return [];
    }
  }
  function save(all) {
    try {
      // Twenty is plenty and keeps this well inside any storage quota.
      localStorage.setItem(KEY, JSON.stringify(all.slice(0, 20)));
    } catch (err) {
      /* private window, or full: the conversation still works, it just will
         not survive a reload. Never worth breaking the page over. */
    }
  }

  function newChat() {
    chat = { id: "c" + Date.now().toString(36), title: "New test", at: Date.now(), turns: [] };
  }

  function remember(turn) {
    if (!chat) newChat();
    chat.turns.push(turn);
    if (chat.title === "New test" && turn.role === "you") chat.title = turn.text.slice(0, 60);
    chat.at = Date.now();
    var all = load().filter(function (c) {
      return c.id !== chat.id;
    });
    all.unshift(chat);
    save(all);
    drawPast();
  }

  function drawPast() {
    if (!pastList) return;
    var all = load();
    pastList.innerHTML = "";
    if (!all.length) {
      pastList.appendChild(el("p", "none", "Nothing yet. Your tests will be listed here."));
      return;
    }
    pastList.appendChild(el("p", "when", "Earlier"));
    all.forEach(function (c) {
      var a = el("a", null, esc(c.title || "Test"));
      a.href = "#" + c.id;
      if (chat && c.id === chat.id) a.setAttribute("aria-current", "true");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        open(c.id);
      });
      pastList.appendChild(a);
    });
  }

  function open(id) {
    var found = load().filter(function (c) {
      return c.id === id;
    })[0];
    if (!found) return;
    chat = found;
    thread.innerHTML = "";
    lastReport = null;
    found.turns.forEach(replay);
    if (found.turns.length) began();
    drawPast();
    toBottom(true);
    closeRailOnPhone();
  }

  /** Put a stored turn back on screen. */
  function replay(t) {
    if (t.role === "you") return youSaid(t.text, true);
    if (t.role === "owly") return say(t.text, true);
    if (t.role === "report") {
      var box = owlySays();
      if (t.notes && t.notes.length) {
        var work = el("div", "work", "<ul></ul>");
        var ul = work.querySelector("ul");
        t.notes.forEach(function (n) {
          var li = el("li", n.kind || "");
          li.appendChild(el("span", "tag", n.tag));
          li.appendChild(el("span", "", esc(n.text)));
          ul.appendChild(li);
        });
        box.appendChild(work);
      }
      box.appendChild(card(t.summary, t.url));
      if (t.since) {
        var strip = el("div", "since");
        strip.appendChild(el("span", "dot-good", ""));
        strip.appendChild(el("span", "", esc(t.since)));
        box.appendChild(strip);
      }
      lastReport = t.context || null;
    }
  }

  /* ------------------------------------------------------------- messages */

  function youSaid(text, quiet) {
    began();
    var turn = el("div", "turn you");
    turn.appendChild(el("div", "bubble", esc(text)));
    thread.appendChild(turn);
    if (!quiet) remember({ role: "you", text: text });
    toBottom(true);
  }

  function owlySays() {
    began();
    var turn = el("div", "turn owly");
    var face = el("img", "face");
    face.src = "/icon-64.png";
    face.alt = "";
    face.width = 26;
    face.height = 26;
    turn.appendChild(face);
    var say = el("div", "say");
    turn.appendChild(say);
    thread.appendChild(turn);
    toBottom();
    return say;
  }

  /** Paragraphs, **bold** and `code`. Escaped first, so markup can never get in. */
  function rich(text) {
    return esc(text)
      .split(/\n{2,}/)
      .map(function (para) {
        return "<p>" + para.replace(/\n/g, "<br>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>") + "</p>";
      })
      .join("");
  }

  /**
   * Copy, and a thumb either way.
   *
   * The thumbs are honest about what they are: nothing is sent anywhere, so
   * the button says "noted" rather than pretending a rating went somewhere.
   */
  function actions(box, text) {
    var row = el("div", "acts");

    var said = el("span", "said");

    /** Say something briefly, and let the button kick as it is pressed. */
    function answer(button, words) {
      button.classList.remove("pop");
      // Reading offsetWidth restarts the animation when the same button is
      // pressed twice; without it the second press is silent.
      void button.offsetWidth;
      button.classList.add("pop");
      said.textContent = words;
      said.classList.add("show");
      clearTimeout(answer.timer);
      answer.timer = setTimeout(function () {
        said.classList.remove("show");
      }, 1700);
    }

    var copy = el("button", null, ICON.copy);
    copy.type = "button";
    copy.title = "Copy";
    copy.setAttribute("aria-label", "Copy this answer");
    copy.addEventListener("click", function () {
      var ok = function () {
        copy.classList.add("copied");
        copy.innerHTML = ICON.tick;
        answer(copy, "Copied");
        setTimeout(function () {
          copy.classList.remove("copied");
          copy.innerHTML = ICON.copy;
        }, 1700);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () {
          answer(copy, "Could not copy");
        });
      } else {
        answer(copy, "Could not copy");
      }
    });
    row.appendChild(copy);

    ["good", "bad"].forEach(function (kind) {
      var b = el("button", null, ICON[kind]);
      b.type = "button";
      b.title = kind === "good" ? "This was useful" : "This was not useful";
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", function () {
        var already = b.classList.contains("on");
        Array.prototype.forEach.call(row.querySelectorAll("button.on"), function (x) {
          x.classList.remove("on");
        });
        if (already) {
          answer(b, "");
          return;
        }
        b.classList.add("on");
        // Honest about where this goes: nowhere. Saying "Thanks" would imply
        // a rating had been sent to somebody.
        answer(b, kind === "good" ? "Noted" : "Noted - it stays in this browser");
      });
      row.appendChild(b);
    });

    row.appendChild(said);
    box.appendChild(row);
  }

  function say(text, quiet) {
    var box = owlySays();
    box.innerHTML = rich(text);
    actions(box, text);
    if (!quiet) remember({ role: "owly", text: text });
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
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.38) + "px";
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
    send.disabled = on ? false : !input.value.trim();
    send.classList.toggle("stop", on);
    send.setAttribute("aria-label", on ? "Stop" : "Send");
    send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg>';
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

  function historyForModel() {
    return (chat ? chat.turns : [])
      .filter(function (t) {
        return t.role === "you" || t.role === "owly";
      })
      .slice(-12)
      .map(function (t) {
        return { role: t.role === "you" ? "user" : "assistant", content: t.text };
      });
  }

  /* --------------------------------------------------------------- a turn */

  async function turn(text) {
    youSaid(text);
    lock(true);
    stopped = false;

    var waiting = owlySays();
    var w = el("div", "work", '<div class="now"><span class="beat"><i></i><i></i><i></i></span><span class="text">Thinking</span></div>');
    waiting.appendChild(w);
    toBottom();

    var data;
    try {
      var res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: historyForModel(), report: lastReport, memory: memory() }),
      });
      data = await res.json();
    } catch (err) {
      waiting.parentNode.remove();
      oops("I could not reach the server. Try again in a moment.");
      lock(false);
      return;
    }

    waiting.parentNode.remove();

    // Anything Owly decided was worth keeping, kept.
    if (data) rememberFacts(data.remember, data.mine);

    if (data && data.reply && data.test) say(data.reply);

    if (data && data.test) {
      await runTest(data.test);
      lock(false);
      input.focus();
      return;
    }
    say((data && data.reply) || "I test websites. Paste an address and I will take a look.");
    lock(false);
    input.focus();
  }

  /* -------------------------------------------------------------- the test */

  async function runTest(site) {
    var box = owlySays();
    var work = el("div", "work", '<div class="now"><span class="beat"><i></i><i></i><i></i></span><span class="text">Checking that address</span><span class="clock"></span></div><ul></ul>');
    box.appendChild(work);
    var head = work.querySelector(".now");
    var textEl = work.querySelector(".text");
    var clock = work.querySelector(".clock");
    var list = work.querySelector("ul");
    toBottom();

    var startedAt = Date.now();
    var tick = setInterval(function () {
      var s = Math.round((Date.now() - startedAt) / 1000);
      clock.textContent = s >= 3 ? s + "s" : "";
    }, 1000);

    var notes = [];
    function now(text) {
      textEl.textContent = text;
      toBottom();
    }
    function note(text, kind, tag) {
      var li = el("li", kind || "");
      li.appendChild(el("span", "tag", tag || "note"));
      li.appendChild(el("span", "", esc(text)));
      list.appendChild(li);
      notes.push({ text: text, kind: kind || "", tag: tag || "note" });
      toBottom();
    }
    function done() {
      clearInterval(tick);
      head.remove();
      if (!list.children.length) list.remove();
    }

    /*
     * A suspicion and its confirmation are the same sentence twice. The
     * second rewrites the first, so the line you end up with says what was
     * decided, and the checking is visible as it happens.
     */
    var claims = {};
    function claim(text, level) {
      var body = text.replace(/^(possible issue|confirmed|likely|dropped|dismissed|could not reproduce, so not reported)\s*:\s*/i, "").trim();
      var tag = level === "confirmed" ? "found" : level === "suspect" ? "checking" : "dropped";
      var kind = level === "confirmed" ? "found" : level === "suspect" ? "checking" : "";
      var known = claims[body];
      if (known) {
        known.li.className = kind;
        known.li.firstChild.textContent = tag;
        known.note.kind = kind;
        known.note.tag = tag;
        toBottom();
        return;
      }
      var li = el("li", kind);
      li.appendChild(el("span", "tag", tag));
      li.appendChild(el("span", "", body));
      list.appendChild(li);
      var rec = { text: body, kind: kind, tag: tag };
      notes.push(rec);
      claims[body] = { li: li, note: rec };
      toBottom();
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
      box.innerHTML = '<p class="oops">I could not reach the server. Try again in a moment.</p>';
      return;
    }

    if (!res.ok || !body.id) {
      done();
      box.innerHTML = "";
      if (body && body.error && body.error.code === "rate_limited") {
        setLeft(0);
        box.appendChild(spent());
      } else {
        box.innerHTML = '<p class="oops">' + esc((body && body.error && body.error.message) || "I could not start that test.") + "</p>";
      }
      return;
    }
    if (typeof body.left === "number") setLeft(body.left);

    var host = body.target;
    try {
      host = new URL(body.target).host;
    } catch (err) {}

    // Said as what WILL happen, not only what will not.
    //
    // "I will look but not touch" read as "I am about to do nothing" - and
    // then Owly worked for the better part of a minute and produced a report,
    // which looked like it had ignored its own promise. It had not: a
    // look-only pass still opens every page and checks layout, links,
    // accessibility and headers. It just never types or clicks.
    note(
      body.mode === "full"
        ? host + " is verified as yours, so this is the full test: I will fill in forms and press buttons as well as read the pages."
        : host +
            " is not verified as yours, so this is a look-only pass. I will still open its pages and check layout, links, accessibility" +
            " and security headers, which takes a minute or two - but I will not type into any form or press any button.",
      "",
      body.mode === "full" ? "full" : "reading",
    );
    now("Opening " + host);

    var seen = 0;
    var guard = 0;
    while (guard++ < 60) {
      if (stopped) {
        done();
        note("Stopped. The run carries on on the server.", "", "note");
        box.appendChild(links(body.report_url, body.mode !== "full"));
        return;
      }
      var step, data;
      try {
        step = await fetch("/api/r/" + encodeURIComponent(body.id) + "/advance", { method: "POST" });
        data = await step.json();
      } catch (err) {
        done();
        note("I lost the connection, but the run is still going on the server.", "", "note");
        box.appendChild(links(body.report_url, body.mode !== "full"));
        return;
      }

      var events = data.events || [];
      for (var i = seen; i < events.length; i++) {
        var e = events[i];
        if (e.level === "suspect" || e.level === "confirmed" || e.level === "dismissed") claim(e.text, e.level);
        else if (e.level === "warn") note(e.text, "", "note");
        else now(e.text);
      }
      seen = events.length;

      if (data.status === "completed") {
        done();
        return finish(box, data.summary, body.report_url, notes, body.target || site);
      }
      if (data.status === "failed") {
        done();
        note(data.error || "The test did not finish.", "found", "failed");
        return;
      }
    }
    done();
    note("Still running, longer than I can narrate here.", "", "note");
    box.appendChild(links(body.report_url, body.mode !== "full"));
  }

  /* -------------------------------------------------------------- the card */

  function links(url, passive) {
    var foot = el("div", "foot");
    var a = el("a", "linkish primary", "Open the full report");
    a.href = url;
    foot.appendChild(a);
    if (passive) {
      // What someone actually wants after a look-only pass is the rest of the
      // test, which means verifying the site. "Test another site" was a
      // button whose whole function was to focus the box below it.
      var verify = el("a", "linkish", "Get the full test");
      verify.href = "/how-it-works";
      foot.appendChild(verify);
    }
    return foot;
  }

  function card(summary, reportUrl) {
    var wrap = el("div", "result");
    var head = el("div", "head");
    head.appendChild(el("h2", "", esc(summary.headline)));
    head.appendChild(el("div", "sub", esc(facts(summary))));
    wrap.appendChild(head);

    if (summary.detail || (summary.findings && summary.findings.length)) {
      var body = el("div", "body");
      if (summary.detail) body.appendChild(el("p", "", esc(summary.detail)));
      (summary.findings || []).forEach(function (f) {
        var row = el("div", "item");
        row.appendChild(el("span", "sev " + esc(f.severity), esc(f.severity)));
        row.appendChild(el("span", "what", esc(f.title)));
        body.appendChild(row);
      });
      wrap.appendChild(body);
    }
    wrap.appendChild(links(reportUrl, summary.mode !== "full"));
    return wrap;
  }

  function facts(s) {
    return (
      (s.mode === "full" ? "full test" : "look-only pass") +
      " · " +
      s.pages +
      (s.pages === 1 ? " page" : " pages") +
      " · " +
      s.counts +
      " · " +
      s.seconds +
      "s"
    );
  }

  /**
   * "Did I fix it?" - answerable at last, because Owly now remembers the
   * last run of this site. Worked out BEFORE this run is recorded, or it
   * would be comparing the run against itself.
   */
  function sinceLine(change) {
    if (!change) return null;
    var bits = [];
    if (change.fixed) bits.push(change.fixed + " fixed");
    if (change.still) bits.push(change.still + (change.still === 1 ? " still there" : " still there"));
    if (change.fresh) bits.push(change.fresh + " new");
    var when = String(change.at).slice(0, 10);
    if (!bits.length) return "Same as the run on " + when + ": nothing found either time.";
    return "Since " + when + ": " + bits.join(", ") + ".";
  }

  function finish(box, summary, reportUrl, notes, site) {
    if (!summary) {
      box.appendChild(links(reportUrl, false));
      return;
    }

    var change = changeSince(site, summary.findings || []);
    rememberRun(site, summary);

    box.appendChild(card(summary, reportUrl));
    var line = sinceLine(change);
    if (line) {
      var strip = el("div", "since");
      strip.appendChild(el("span", "dot-good", ""));
      strip.appendChild(el("span", "", esc(line)));
      box.appendChild(strip);
    }

    var context = [
      summary.headline,
      summary.detail || "",
      facts(summary),
      (summary.findings || [])
        .map(function (f) {
          return "- " + f.severity + ": " + f.title;
        })
        .join("\n"),
      "Full report: " + reportUrl,
    ]
      .filter(Boolean)
      .join("\n");
    lastReport = context;
    remember({ role: "report", summary: summary, url: reportUrl, notes: notes, context: context, since: line });
    toBottom();
  }

  /** The card shown when the day's free tests are gone. */
  function spent() {
    var out = el("div", "result");
    out.appendChild(
      el(
        "div",
        "head",
        "<h2>That is today's free tests used up</h2>" +
          '<div class="sub">The site gives 3 a day so one visitor cannot spend the whole budget. It resets at midnight UTC.</div>',
      ),
    );
    out.appendChild(el("div", "body", "<p>Owly is also on Pond, where it has its own free tier and no daily cap &mdash; the same agent, with the full test rather than a look.</p>"));
    var foot = el("div", "foot");
    var pond = el("a", "linkish primary", "Use Owly on Pond");
    pond.href = "https://joinpond.ai";
    pond.rel = "noopener";
    foot.appendChild(pond);
    var plans = el("a", "linkish", "See the plans");
    plans.href = "/pricing";
    foot.appendChild(plans);
    out.appendChild(foot);
    return out;
  }

  /* ------------------------------------------------------------ the chrome */

  function setLeft(n) {
    if (!leftChip) return;
    var b = leftChip.querySelector("b");
    if (b) b.textContent = String(Math.max(0, n));
    leftChip.classList.toggle("none", n <= 0);
  }

  var root = document.documentElement;
  function closeRailOnPhone() {
    if (matchMedia("(max-width: 860px)").matches) root.classList.remove("rail-open");
  }
  function railToggle(open) {
    if (matchMedia("(max-width: 860px)").matches) {
      root.classList.toggle("rail-open", open);
      var veil = document.getElementById("rail-veil");
      if (veil) veil.hidden = !open;
      return;
    }
    root.classList.toggle("rail-closed", !open);
    try {
      localStorage.setItem("owly-rail", open ? "open" : "closed");
    } catch (err) {}
  }
  var openBtn = document.getElementById("rail-open");
  var closeBtn = document.getElementById("rail-close");
  var veil = document.getElementById("rail-veil");
  if (openBtn) openBtn.addEventListener("click", function () { railToggle(true); });
  if (closeBtn) closeBtn.addEventListener("click", function () { railToggle(false); });
  if (veil) veil.addEventListener("click", function () { railToggle(false); });

  var fresh = document.getElementById("newchat");
  if (fresh)
    fresh.addEventListener("click", function () {
      newChat();
      thread.innerHTML = "";
      lastReport = null;
      scroll.classList.add("empty");
      if (hello) hello.hidden = false;
      drawPast();
      closeRailOnPhone();
      input.focus();
    });

  var explain = document.getElementById("explain");
  if (explain)
    explain.addEventListener("click", function () {
      if (busy) return;
      turn("What can I ask you, and what do you check?");
    });

  var toggle = document.getElementById("theme") || document.getElementById("theme-rail");
  if (toggle)
    toggle.addEventListener("click", function () {
      var dark = root.getAttribute("data-theme") === "dark" || (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      var next = dark ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("owly-theme", next);
      } catch (err) {}
    });

  /* ----------------------------------------------------------------- start */

  var all = load();
  if (all.length) open(all[0].id);
  else {
    newChat();
    drawPast();
  }
  lock(false);
  grow();
  if (!matchMedia("(pointer: coarse)").matches) input.focus();
})();
