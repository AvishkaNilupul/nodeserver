/* Tab controller for /epic-accounts.html (contract: docs/EPIC-PAGE-UI.md).
   The tab bar and the three panel roots are static HTML; each tab script registers
   with EpicTabs.on(name, {show, hide, guard}) and loads its data only in show(). */
(function () {
  var NAMES = ["claims", "sales", "details"];
  var handlers = {};
  var current = null;

  function el(id) { return document.getElementById(id); }
  function tabBtn(name) { return el("epic-" + name + "-tab"); }
  function panel(name) { return el("epic-" + name + "-panel"); }

  // "#sales/onsale" -> ["sales", "/onsale"]; "#details?account=1" -> ["details", "?account=1"].
  function parse() {
    var m = /^#([a-z]+)(.*)$/.exec(location.hash || "");
    var name = m && NAMES.indexOf(m[1]) >= 0 ? m[1] : "";
    if (!name && new URLSearchParams(location.search).get("tab") === "sales") name = "sales";
    return [name || "claims", name && m && m[1] === name ? m[2] : ""];
  }

  function call(name, what) {
    var h = handlers[name];
    if (!h || typeof h[what] !== "function") return true;
    try { return h[what](); } catch (e) { console.error("EpicTabs " + name + "." + what, e); return true; }
  }

  function setUrl(name, suffix) {
    // Old links used ?tab=sales; drop the query once we are on a hash route.
    history.replaceState(null, "", location.pathname + "#" + name + (suffix || ""));
  }

  function paint(name) {
    NAMES.forEach(function (n) {
      var on = n === name, b = tabBtn(n), p = panel(n);
      if (b) {
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (p) p.hidden = !on;
    });
  }

  function show(name, suffix) {
    if (NAMES.indexOf(name) < 0) return false;
    if (name === current) return true;
    if (current && call(current, "guard") === false) return false;
    var prev = current;
    current = name;
    paint(name);
    setUrl(name, suffix || "");
    if (prev) call(prev, "hide");
    call(name, "show");
    document.dispatchEvent(new CustomEvent("epic:tab", { detail: { tab: name, prev: prev } }));
    return true;
  }

  window.EpicTabs = {
    current: function () { return current; },
    show: function (name) { return show(name); },
    on: function (name, h) {
      handlers[name] = h || {};
      // A script that registers after its tab is already showing still gets show().
      if (name === current) setTimeout(function () { if (current === name) call(name, "show"); }, 0);
    },
    badge: function (name, text, tone) {
      var b = tabBtn(name);
      var s = b && b.querySelector(".ep-tab-badge");
      if (!s) return;
      s.textContent = text == null ? "" : String(text);
      s.className = "ep-tab-badge" + (tone ? " is-" + tone : "");
      s.hidden = !s.textContent;
    },
    arg: function () {
      var p = parse();
      return p[0] === current ? p[1].replace(/^\//, "") : "";
    },
    setArg: function (suffix) {
      if (current) setUrl(current, suffix || "");
    },
  };

  function init() {
    var bar = document.querySelector(".ep-tabs");
    if (!bar) return;
    NAMES.forEach(function (n) {
      var b = tabBtn(n);
      if (b) b.addEventListener("click", function () { show(n); });
    });
    bar.addEventListener("keydown", function (e) {
      var i = NAMES.indexOf(current), next = null;
      if (e.key === "ArrowRight") next = NAMES[(i + 1) % NAMES.length];
      else if (e.key === "ArrowLeft") next = NAMES[(i + NAMES.length - 1) % NAMES.length];
      else if (e.key === "Home") next = NAMES[0];
      else if (e.key === "End") next = NAMES[NAMES.length - 1];
      if (!next) return;
      e.preventDefault();
      if (show(next)) tabBtn(next).focus();
    });
    window.addEventListener("hashchange", function () {
      var p = parse();
      if (p[0] !== current && !show(p[0], p[1])) setUrl(current, "");
    });
    var p = parse();
    current = p[0];
    paint(current);
    setUrl(current, p[1]);
    // Scripts that registered before this ran get their first show() now.
    if (handlers[current]) setTimeout(function () { call(current, "show"); }, 0);
  }

  // This file is loaded right after the tab bar's markup, so the bar normally exists.
  if (document.querySelector(".ep-tabs")) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
