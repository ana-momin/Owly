/* Two small things: reveal sections as they arrive, and play the console once
   it is actually on screen. Both are decoration - the page reads the same with
   JavaScript off, and anyone who asked for less motion gets the end state. */
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var rises = document.querySelectorAll(".rise");

  if (!("IntersectionObserver" in window) || reduce) {
    for (var i = 0; i < rises.length; i++) rises[i].classList.add("seen");
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("seen"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    for (var j = 0; j < rises.length; j++) io.observe(rises[j]);
  }

  var box = document.querySelector(".console");
  if (!box) return;
  var lines = box.querySelectorAll(".ln");
  var out = box.querySelector(".out");

  function showAll() {
    for (var k = 0; k < lines.length; k++) lines[k].classList.add("on");
    if (out) out.classList.add("on");
  }
  if (reduce || !("IntersectionObserver" in window)) { showAll(); return; }

  var played = false;
  function play() {
    if (played) return;
    played = true;
    for (var k = 0; k < lines.length; k++) {
      (function (el, n) { setTimeout(function () { el.classList.add("on"); }, 420 * n + 300); })(lines[k], k);
    }
    setTimeout(function () { if (out) out.classList.add("on"); }, 420 * lines.length + 450);
  }
  var io2 = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) play(); });
  }, { threshold: 0.25 });
  io2.observe(box);
})();
