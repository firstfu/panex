// panex website: three small conveniences, all optional (pages work without JS).
(function () {
  // 1) On a Mac show ⌘ / ⌥ instead of Ctrl / Alt in key caps marked with data-mac.
  var isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
  if (isMac) {
    document.querySelectorAll("kbd").forEach(function (k) {
      var t = k.textContent;
      if (t === "Ctrl") k.textContent = "⌘";
      else if (t === "Alt") k.textContent = "⌥";
    });
  }

  // 2) Install tabs: preselect the visitor's OS.
  var tabs = document.querySelectorAll(".tabbar button");
  function pick(name) {
    tabs.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll(".panel").forEach(function (p) { p.hidden = p.id !== "tab-" + name; });
  }
  tabs.forEach(function (b) { b.addEventListener("click", function () { pick(b.dataset.tab); }); });
  if (tabs.length) pick(isMac ? "mac" : "win");

  // 3) Guide page: highlight the section being read in the side index.
  var links = document.querySelectorAll(".toc a[href^='#']");
  if (links.length && "IntersectionObserver" in window) {
    var map = {};
    links.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          links.forEach(function (a) { a.classList.remove("on"); });
          if (map[e.target.id]) map[e.target.id].classList.add("on");
        }
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
