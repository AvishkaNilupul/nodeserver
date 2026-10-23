/* CHZZK farm v2 — page core (docs/CHZZK-PANEL-V2.md §3). public/soop/core.js
   adapted: owns window.Chzzk — the API client and polling, the tab registry, a
   DOM builder that never touches innerHTML, the floating layers (toast, confirm,
   modal, drawer, menu), the component kit, and Chzzk.reveal, the only code that
   writes a reward code into the page. Tab authors: read public/soop/UI-KIT.md
   first (Soop → Chzzk) and §3 of the contract for what differs. */
(function () {
  "use strict";
  var API = "/api/chzzk", STATE_MS = 5000, CAMPAIGNS_MS = 60000, BACKOFF_MS = 15000, FAIL_LIMIT = 3;
  var doc = document, noop = function () {};
  var Chzzk = (window.Chzzk = { state: null, campaigns: [] });
  function $(id) { return doc.getElementById(id); }

  // ---------- DOM builder -------------------------------------------------
  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = { svg: 1, path: 1, circle: 1, rect: 1, line: 1, polyline: 1, polygon: 1, g: 1 };
  var PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, indeterminate: 1, hidden: 1, readOnly: 1, tabIndex: 1 };
  // CHZZK supplies link and image URLs; anything that is not plainly http(s) or
  // same-site is replaced, so a "javascript:" link can never reach the page.
  function safeUrl(v) { v = String(v).trim(); return /^(https?:|mailto:|data:image\/|[/#?])/i.test(v) ? v : "#"; }
  function append(parent, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false || k === true) continue;
      if (Array.isArray(k)) append(parent, k);
      else parent.appendChild(k instanceof Node ? k : doc.createTextNode(String(k)));
    }
    return parent;
  }
  function fill(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return append(node, Array.prototype.slice.call(arguments, 1));
  }
  function el(tag, attrs) {
    var node = SVG_TAGS[tag] ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (/^on/i.test(k) && (typeof v === "function" || k.toLowerCase() in node)) {       // handlers are functions, never strings
        if (typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        return;
      }
      if (k === "innerHTML" || k === "outerHTML" || k === "srcdoc") return;      // text only, by design
      if (k === "class" || k === "className") node.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
      else if (k === "dataset") Object.keys(v).forEach(function (d) { if (v[d] != null) node.dataset[d] = v[d]; });
      else if (k === "style" && typeof v === "object") Object.keys(v).forEach(function (p) { if (p.indexOf("--") === 0) node.style.setProperty(p, v[p]); else node.style[p] = v[p]; });
      else if (PROPS[k]) node[k] = v;
      else if (k === "href" || k === "src") node.setAttribute(k, safeUrl(v));
      else node.setAttribute(k, v === true ? "" : String(v));
    });
    return append(node, kids);
  }

  // ---------- Formatting ---------------------------------------------------
  var skew = 0;                       // server clock minus this browser's clock
  var MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  function now() { return Date.now() + skew; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function toDate(v) { if (v == null || v === "") return null; var d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
  function span(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 60) return m + " min";
    if (m < 1440) return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
    var d = Math.floor(m / 1440);
    return d + (d === 1 ? " day" : " days");
  }
  var fmt = {
    mins: function (n) {
      if (n == null || n === "" || !isFinite(Number(n))) return "–";
      n = Math.max(0, Math.round(Number(n)));
      return n < 60 ? n + "m" : Math.floor(n / 60) + "h " + pad(n % 60) + "m";
    },
    ago: function (iso) {
      var d = toDate(iso); if (!d) return "–";
      var ms = now() - d.getTime();
      if (ms < 0) return fmt.until(d);
      return ms < 60000 ? "just now" : span(ms) + " ago";
    },
    until: function (iso) {
      var d = toDate(iso); if (!d) return "–";
      var ms = d.getTime() - now();
      if (ms < 0) return fmt.ago(d);
      return ms < 60000 ? "in under a minute" : "in " + span(ms);
    },
    when: function (iso) {
      var d = toDate(iso); if (!d) return "–";
      var year = d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear();
      return MONTHS[d.getMonth()] + " " + d.getDate() + year + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    },
    pct: function (a, b) {
      a = Number(a); b = Number(b);
      if (!isFinite(a) || !isFinite(b) || b <= 0) return "–";
      return Math.max(0, Math.min(100, Math.round((a / b) * 100))) + "%";
    },
    num: function (n) { return n == null || n === "" || !isFinite(Number(n)) ? "–" : Number(n).toLocaleString("en-US"); },
  };

  // ---------- Events, API, polling ----------------------------------------
  var handlers = { state: [], campaigns: [], tab: [] };
  function on(evt, fn) {
    var list = handlers[evt] || (handlers[evt] = []);
    list.push(fn);
    return function off() { var i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); };
  }
  function emit(evt, payload) {
    (handlers[evt] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error("chzzk: a '" + evt + "' handler failed:", e); }
    });
  }
  var gone = false;                   // signed out: stop everything, the page is leaving
  function fail(message, status) { var e = new Error(message); e.status = status; return e; }
  function request(method, path, body) {
    var url = path.indexOf("/api/") === 0 ? path : API + (path.charAt(0) === "/" ? "" : "/") + path;
    var opts = { method: method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (method === "POST") { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body || {}); }
    // A hung request must fail (and count toward the connection banner), not freeze polling.
    var ctl = typeof AbortController === "function" ? new AbortController() : null, guard = 0;
    if (ctl) { opts.signal = ctl.signal; guard = setTimeout(function () { ctl.abort(); }, 20000); }
    return fetch(url, opts).then(function (r) {
      clearTimeout(guard);
      if (r.status === 401 || r.status === 403) {
        if (!gone) { gone = true; window.location.href = "/admin-login.html"; }
        throw fail("You are signed out — taking you to the login page", r.status);
      }
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || j.success === false) throw fail((j && (j.message || j.error)) || "The server answered with an error (HTTP " + r.status + ")", r.status);
        return j;
      });
    }, function () { clearTimeout(guard); throw fail("Could not reach the server — check the connection", 0); });
  }
  var api = { get: function (path) { return request("GET", path); }, post: function (path, body) { return request("POST", path, body); } };

  function indexBy(list, key) {
    var m = Object.create(null);
    (list || []).forEach(function (x) { if (x && x[key] != null) m[String(x[key])] = x; });
    return m;
  }
  var idx = { acc: indexBy(), camp: indexBy() };
  var fails = 0, stateBusy = null, campBusy = null, stateTimer = 0, campTimer = 0, stateGen = 0, campAt = 0, campSeq = 0, campShown = 0, stateSeq = 0, stateShown = 0;

  // `fresh` (after an action) skips joining a request already in flight, which
  // may predate the action; the sequence number stops that older answer from
  // repainting over the newer one.
  function loadState(fresh) {
    if (stateBusy && !fresh) return stateBusy;
    var seq = ++stateSeq;
    var p = stateBusy = api.get("/state").then(function (j) {
      if (stateBusy === p) stateBusy = null;
      fails = 0;
      if (seq < stateShown) return Chzzk.state;
      stateShown = seq;
      var t = Date.parse(j.now) - Date.now();
      skew = isFinite(t) && Math.abs(t) > 5000 ? t : 0;
      Chzzk.state = j; idx.acc = indexBy(j.accounts, "id");
      banner(false); repaint(); emit("state", j);
      return j;
    }, function (e) { if (stateBusy === p) stateBusy = null; fails++; if (fails >= FAIL_LIMIT && !gone) banner(true); throw e; });
    return p;
  }
  // `fresh` skips joining a request already in flight (it may predate a rescan);
  // the sequence number stops that older answer from landing on top of the new one.
  function loadCampaigns(fresh) {
    if (campBusy && !fresh) return campBusy;
    var seq = ++campSeq;
    var p = (campBusy = api.get("/campaigns").then(function (j) {
      if (campBusy === p) campBusy = null;
      campAt = Date.now();
      if (seq < campShown) return j;
      campShown = seq;
      Chzzk.campaigns = j.campaigns || [];
      idx.camp = indexBy(Chzzk.campaigns, "campaignNo");
      repaint(); emit("campaigns", { campaigns: Chzzk.campaigns });
      return j;
    }, function (e) { if (campBusy === p) campBusy = null; campAt = Date.now(); repaint(); throw e; }));
    return p;
  }
  // Each loop is a timeout chain (never an interval), so a slow reply cannot
  // stack requests; the generation number retires a loop that was restarted.
  function pollState() {
    var gen = ++stateGen;
    clearTimeout(stateTimer);
    if (gone || (doc.hidden && Chzzk.state)) return;      // paused while hidden, except for the very first load
    loadState().catch(noop).then(function () {
      if (gen === stateGen) stateTimer = setTimeout(pollState, fails >= FAIL_LIMIT ? BACKOFF_MS : STATE_MS);
    });
  }
  function pollCampaigns() {
    clearTimeout(campTimer);
    if (gone || (doc.hidden && campAt)) return;
    var wait = campAt ? CAMPAIGNS_MS - (Date.now() - campAt) : 0;
    if (wait > 0) { campTimer = setTimeout(pollCampaigns, wait); return; }
    loadCampaigns().catch(noop).then(function () { clearTimeout(campTimer); campTimer = setTimeout(pollCampaigns, CAMPAIGNS_MS); });
  }
  function banner(show) {
    var b = $("chzzkBanner"); if (!b) return;
    if (show && b.hidden) fill(b, icon("alert"), el("span", { class: "s-grow" }, el("b", "Connection lost — retrying. "), "What you see may be out of date."),
      button("Retry now", { size: "sm", onClick: function () { pollState(); } }));
    b.hidden = !show;
  }

  // ---------- Tabs ----------------------------------------------------------
  var slots = Object.create(null), order = [], current = null, params = {}, tabDue = false, scriptsDone = false;
  function addSlot(id, label) {
    var bar = $("chzzkTabs"), btn = bar && bar.querySelector('[data-tab="' + id + '"]'), root = doc.querySelector('[data-tab-root="' + id + '"]');
    if (!btn && bar) btn = bar.appendChild(el("button", { type: "button", class: "s-tab", role: "tab", id: "tab-" + id, dataset: { tab: id }, "aria-controls": "panel-" + id },
      el("span", { class: "s-tab-label" }, label || id), el("span", { class: "s-tab-badge", hidden: true })));
    if (!root) root = ($("chzzkMain") || doc.body).appendChild(el("section", { class: "s-panel", id: "panel-" + id, role: "tabpanel", "aria-labelledby": "tab-" + id, dataset: { tabRoot: id }, hidden: true },
      el("p", { class: "s-loading" }, "Loading…")));
    order.push(id);
    return (slots[id] = { id: id, btn: btn, root: root, def: null, rendered: false });
  }
  function registerTab(def) {
    if (!def || !def.id) return;
    var s = slots[def.id] || addSlot(def.id, def.label);
    s.def = def; s.rendered = false; s.broken = false;
    var lab = s.btn && s.btn.querySelector(".s-tab-label");
    if (lab && def.label) lab.textContent = def.label;
    if (!current) route(); else repaint();
  }
  // Render once, then update. Nothing is painted until /state has loaded AND the
  // first /campaigns has answered (or failed), so render() can rely on both.
  function ready() { return !!(Chzzk.state && campAt); }
  function paint(s) {
    if (!s || !s.def || !ready() || s.broken) return;
    try {
      if (!s.rendered) { fill(s.root); s.def.render(s.root); s.rendered = true; }
      if (s.def.update) s.def.update();
      s.lastError = "";
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (msg !== s.lastError) console.error("chzzk: tab '" + s.id + "' failed:", e);       // once, not every 5 s
      s.lastError = msg;
      if (!s.rendered) { s.broken = true; fill(s.root, empty("This tab could not be shown", msg, button("Try again", { onClick: function () { s.broken = false; paint(s); } }))); }
      return;
    }
    if (tabDue && s.id === current) { tabDue = false; emit("tab", { id: current, params: params }); }
  }
  function repaint() {
    paintHeader();
    paint(slots[current]);
    order.forEach(function (id) {
      var s = slots[id], out = s.btn && s.btn.querySelector(".s-tab-badge"), v = null;
      if (!out) return;
      try { v = s.def && s.def.badge && ready() ? s.def.badge() : null; } catch (e) { v = null; }
      var text = v && typeof v === "object" ? v.text : v, show = text != null && text !== "" && text !== false;
      out.hidden = !show; out.textContent = show ? String(text) : "";
      out.className = "s-tab-badge" + (v && v.tone ? " is-" + v.tone : "");
      if (!s.def && scriptsDone && !s.failed) { s.failed = true; fill(s.root, el("p", { class: "s-loading" }, "This tab is not available yet.")); }
    });
  }
  function parseHash() {
    var h = window.location.hash.replace(/^#/, ""), q = h.indexOf("?"), out = { id: q === -1 ? h : h.slice(0, q), params: {} };
    if (q !== -1) h.slice(q + 1).split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      try { out.params[decodeURIComponent(i === -1 ? kv : kv.slice(0, i))] = i === -1 ? "" : decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed escape: skip it */ }
    });
    return out;
  }
  function route() {
    if (!order.length) return;
    var r = parseHash();
    current = slots[r.id] ? r.id : order[0]; params = r.params; tabDue = true;
    order.forEach(function (id) {
      var s = slots[id], active = id === current;
      if (s.btn) { s.btn.setAttribute("aria-selected", String(active)); s.btn.tabIndex = active ? 0 : -1; s.btn.classList.toggle("is-active", active); }
      s.root.hidden = !active;
    });
    repaint();
  }
  function go(id, p) {
    var q = Object.keys(p || {}).filter(function (k) { return p[k] != null && p[k] !== ""; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]); }).join("&");
    var hash = "#" + id + (q ? "?" + q : "");
    if (window.location.hash === hash) route(); else window.location.hash = hash;   // hashchange -> route()
  }
  function plural(n, word) { return fmt.num(n) + " " + word + (Number(n) === 1 ? "" : "s"); }
  function paintHeader() {
    var box = $("chzzkStatus"), s = Chzzk.state;
    if (!box || !s) return;
    var t = s.totals || {}, eg = s.egress || {}, alerts = s.alerts || [];
    var errs = alerts.filter(function (a) { return a && a.level === "error"; }).length;
    var tone = "muted", lead = "Idle — nothing to watch right now";
    if (!s.started) { tone = "warn"; lead = "Starting up"; }
    else if (!(s.switch && s.switch.on)) { tone = "warn"; lead = "Switched off"; }
    else if (!eg.ok) { tone = "error"; lead = "Egress is down"; }
    else if (errs) { tone = "error"; lead = "Needs attention"; }
    else if (t.watching > 0) { tone = "ok"; lead = "Farming"; }
    var bits = [fmt.num(t.watching || 0) + " of " + plural(t.accounts || 0, "login") + " watching",
      plural(t.codes || 0, "code") + " (" + fmt.num(t.codesFresh || 0) + " new)"];
    if (eg.country) bits.push("via " + eg.country);
    if (alerts.length) bits.push(plural(alerts.length, "alert"));
    fill(box, dot(tone), el("span", null, el("b", lead), " · " + bits.join(" · ")));
  }

  // ---------- Floating layers ----------------------------------------------
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(root) { return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) { return n.getClientRects().length > 0; }); }
  // Where focus returns when a layer closes; if a redraw replaced that element, the active tab is the fallback.
  function focusBack(node) {
    if (!node || node === doc.body || !node.focus) return;
    var to = doc.contains(node) ? node : slots[current] && slots[current].btn;
    if (to) to.focus({ preventScroll: true });
  }

  var TOAST_ICON = { ok: "check", warn: "alert", error: "alert", info: "info" };
  function toast(msg, tone) {
    if (msg && typeof msg === "object" && !(msg instanceof Node)) { tone = tone || "error"; msg = msg.message || String(msg); }
    if (tone === true) tone = "error";
    if (!TOAST_ICON[tone]) tone = "info";
    var host = $("chzzkToasts") || doc.body.appendChild(el("div", { class: "s-toasts", id: "chzzkToasts" }));
    var timer = 0, life = tone === "error" ? 9000 : 5000;
    var t = el("div", { class: "s-toast is-" + tone, role: tone === "error" ? "alert" : "status", onMouseenter: hold, onMouseleave: arm, onFocusin: hold, onFocusout: arm },
      icon(TOAST_ICON[tone]), el("span", { class: "s-toast-msg" }, msg),
      el("button", { type: "button", class: "s-btn is-ghost is-sm is-icon", "aria-label": "Dismiss", onClick: kill }, icon("x", 14)));
    function kill() { clearTimeout(timer); if (t.parentNode) t.parentNode.removeChild(t); }
    function hold() { clearTimeout(timer); }
    function arm() { clearTimeout(timer); timer = setTimeout(kill, life); }
    host.appendChild(t);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    arm();
  }

  var stack = [];                     // open modal / drawer / confirm layers, top last
  function layer(kind, opts) {
    var prev = doc.activeElement, closed = false, tid = "s-ov-" + Math.random().toString(36).slice(2, 8);
    var title = el("h2", { class: "s-ov-title", id: tid }, opts.title || "");
    var body = el("div", { class: "s-ov-bd" }, opts.body), foot = el("div", { class: "s-ov-ft", hidden: true });
    var panel = el("div", { class: "s-" + kind + (opts.size ? " is-" + opts.size : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": tid, tabindex: "-1" },
      el("div", { class: "s-ov-hd" }, title, el("button", { type: "button", class: "s-btn is-ghost is-icon", "aria-label": "Close", onClick: function () { h.close(); } }, icon("x"))), body, foot);
    var back = el("div", { class: "s-overlay is-" + kind, onMousedown: function (e) { if (e.target === back && !opts.sticky) h.close(); } }, panel);
    var h = {
      el: panel, body: body,
      close: function (result) {
        if (closed) return; closed = true;
        stack.splice(stack.indexOf(h), 1);
        if (back.parentNode) back.parentNode.removeChild(back);
        sweepReveals();                                   // a code shown in this layer goes with it, not a second later
        if (!stack.length) doc.documentElement.classList.remove("s-lock");
        focusBack(prev);
        if (opts.onClose) opts.onClose(result);
      },
      setTitle: function (text) { title.textContent = text == null ? "" : String(text); },
      setActions: function (list) {
        list = (list || []).filter(Boolean); foot.hidden = !list.length;
        fill(foot, list.map(function (a) {
          if (a instanceof Node) return a;
          return button(a.label, { tone: a.tone, icon: a.icon, disabled: a.disabled, onClick: function () {
            // The layer closes after the handler unless it returns false or fails.
            return run(function () { return a.onClick ? a.onClick(h) : undefined; }).then(function (v) { if (v !== false) h.close(v); });
          } });
        }));
      },
    };
    h.setActions(opts.actions);
    doc.body.appendChild(back); stack.push(h); doc.documentElement.classList.add("s-lock");
    var first = panel.querySelector("[data-autofocus]") || focusables(body)[0] || focusables(foot)[0] || panel;
    first.focus();
    return h;
  }
  doc.addEventListener("keydown", function (e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") { e.preventDefault(); top.close(); return; }
    if (e.key !== "Tab") return;
    var f = focusables(top.el), a = doc.activeElement;
    if (!f.length) { e.preventDefault(); top.el.focus(); }
    else if (!top.el.contains(a)) { e.preventDefault(); f[0].focus(); }
    else if (e.shiftKey && (a === f[0] || a === top.el)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  function modal(opts) { return layer("modal", opts || {}); }
  function drawer(opts) { return layer("drawer", opts || {}); }
  function confirmBox(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var cancel = button("Cancel", { onClick: function () { h.close(false); } });
      var ok = button(opts.okLabel || "Confirm", { tone: opts.danger ? "danger" : "primary", onClick: function () { h.close(true); } });
      (opts.danger ? cancel : ok).setAttribute("data-autofocus", "");     // the safe choice gets the Enter key
      var h = layer("modal", { title: opts.title || "Are you sure?", size: "sm", actions: [cancel, ok],
        body: typeof opts.body === "string" ? el("p", { style: { margin: "0" } }, opts.body) : opts.body,
        onClose: function (result) { resolve(result === true); } });
    });
  }

  var openMenu = null;                // { pop, anchor } — one menu at a time
  function closeMenu(refocus) {
    var m = openMenu; if (!m) return;
    openMenu = null;
    if (m.pop.parentNode) m.pop.parentNode.removeChild(m.pop);
    m.anchor.setAttribute("aria-expanded", "false");
    if (refocus) focusBack(m.anchor);
    m.anchor.dispatchEvent(new CustomEvent("chzzk:menuclose", { bubbles: true }));   // lets a table apply a held-back update
  }
  function showMenu(anchor, items) {
    closeMenu(false);
    var pop = el("div", { class: "s-menu", role: "menu" }, (items || []).filter(Boolean).map(function (it) {
      if (it === "-") return el("div", { class: "s-menu-sep", role: "separator" });
      return el("button", { type: "button", role: "menuitem", tabindex: "-1", class: "s-menu-item" + (it.danger ? " is-danger" : ""), disabled: !!it.disabled,
        onClick: function () { closeMenu(true); if (it.onClick) run(it.onClick); } }, it.icon ? icon(it.icon) : null, it.label);
    }));
    doc.body.appendChild(pop);
    var r = anchor.getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
    pop.style.top = (r.bottom + 4 + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : r.bottom + 4) + "px";
    anchor.setAttribute("aria-expanded", "true");
    openMenu = { pop: pop, anchor: anchor };
    pop.addEventListener("keydown", function (e) {
      var f = focusables(pop), i = f.indexOf(doc.activeElement), key = e.key;
      if (key === "Escape" || key === "Tab") closeMenu(true);
      else if (key === "ArrowDown") f[(i + 1) % f.length].focus();
      else if (key === "ArrowUp") f[(i - 1 + f.length) % f.length].focus();
      else if (key === "Home") f[0].focus();
      else if (key === "End") f[f.length - 1].focus();
      else return;
      e.preventDefault(); e.stopPropagation();      // an open menu's Escape must not also close the dialog under it
    });
    var f = focusables(pop);
    (f[0] || anchor).focus();
  }
  doc.addEventListener("mousedown", function (e) { if (openMenu && !openMenu.pop.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(false); }, true);
  doc.addEventListener("scroll", function (e) { if (openMenu && !openMenu.pop.contains(e.target)) closeMenu(false); }, true);
  window.addEventListener("resize", function () { closeMenu(false); });
  function menu(btn, items) {
    btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (openMenu && openMenu.anchor === btn) closeMenu(true); else showMenu(btn, typeof items === "function" ? items() : items);
    });
    return btn;
  }

  // ---------- Component kit --------------------------------------------------
  var ICONS = {
    play: "M7 4.5l12 7.5-12 7.5z", stop: "M6.5 6.5h11v11h-11z", pause: "M8 5v14M16 5v14", refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
    plus: "M12 5v14M5 12h14", trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", more: "M4 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0", check: "M5 12.5l4.5 4.5L19 7.5",
    x: "M6 6l12 12M18 6L6 18", alert: "M12 3.5l9.5 17h-19zM12 10v4.5M12 17.5h.01", info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.8-3.8", download: "M12 4v11M7 11l5 5 5-5M5 20h14", upload: "M12 20V9M7 13l5-5 5 5M5 4h14",
    edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4", eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2", chevron: "M9 6l6 6-6 6", copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1", external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0", bot: "M5 9h14v10H5zM12 9V5M9 14h.01M15 14h.01", gift: "M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C10 3 7 4 8 6s4 1 4 1 3 1 4-1-2-3-4 1",
  };
  function icon(name, size) {
    size = String(size || 16);
    return el("svg", { class: "s-icon", viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false" }, ICONS[name] ? el("path", { d: ICONS[name] }) : null);
  }
  // Runs a click handler. A promise result marks the button busy until it
  // settles; a failure is toasted and resolves false, so callers need no catch.
  function run(fn, btn) {
    var r;
    try { r = fn(); } catch (e) { console.error(e); toast(e); return Promise.resolve(false); }
    if (!r || typeof r.then !== "function") return Promise.resolve(r);
    if (btn) btn.setAttribute("aria-busy", "true");
    function done() { if (btn) btn.removeAttribute("aria-busy"); }
    return r.then(function (v) { done(); return v; }, function (e) { done(); toast(e); return false; });
  }
  function button(label, opts) {
    opts = opts || {};
    var cls = "s-btn" + (opts.tone ? " is-" + opts.tone : "") + (opts.size === "sm" ? " is-sm" : "") + (!label && opts.icon ? " is-icon" : "");
    var b = el("button", { type: "button", class: cls, disabled: !!opts.disabled, title: opts.title, "aria-label": !label ? opts.title : null }, opts.icon ? icon(opts.icon, opts.size === "sm" ? 14 : 16) : null, label || null);
    if (opts.onClick) b.addEventListener("click", function (e) { if (b.getAttribute("aria-busy") !== "true") run(function () { return opts.onClick(e); }, b); });
    return b;
  }
  function badge(text, tone) { return el("span", { class: "s-badge" + (tone ? " is-" + tone : "") }, text); }
  function dot(tone, label) { return el("span", { class: "s-dot is-" + (tone || "muted"), role: label ? "img" : null, "aria-label": label, title: label, "aria-hidden": label ? null : "true" }); }
  function progress(value, max, tone) {
    var bar = el("span", { class: "s-progress", role: "progressbar", "aria-valuemin": "0" }, el("i"));
    bar.set = function (v, m, t) {
      v = Math.max(0, Number(v) || 0); m = Math.max(0, Number(m) || 0);
      var p = m > 0 ? Math.min(100, (v / m) * 100) : 0;
      bar.className = "s-progress is-" + (t || (m > 0 && v >= m ? "ok" : "info"));
      bar.setAttribute("aria-valuemax", String(m)); bar.setAttribute("aria-valuenow", String(Math.min(v, m)));
      bar.firstChild.style.width = p + "%";
      return bar;
    };
    return bar.set(value, max, tone);
  }
  function stat(label, value, hint, tone) {
    var v = el("b", { class: "s-stat-value" }), h = el("span", { class: "s-stat-hint" }), box = el("div", { class: "s-stat" }, el("span", { class: "s-stat-label" }, label), v, h);
    box.set = function (val, hnt, t) { fill(v, val == null ? "–" : val); fill(h, hnt); h.hidden = hnt == null || hnt === ""; box.className = "s-stat" + (t ? " is-" + t : ""); return box; };
    return box.set(value, hint, tone);
  }
  function empty(title, hint, action) {
    if (action && !(action instanceof Node)) action = button(action.label, action);
    return el("div", { class: "s-empty" }, el("b", title), hint ? el("span", null, hint) : null, action);
  }
  function chips(opts) {
    var multi = !!opts.multi, options = [], value = multi ? (opts.value || []).slice() : opts.value;
    var box = el("div", { class: "s-chips", role: "group" });
    function isOn(v) { return multi ? value.indexOf(v) !== -1 : value === v; }
    function draw() {
      var at = Array.prototype.indexOf.call(box.children, doc.activeElement);
      fill(box, options.map(function (o) {
        return el("button", { type: "button", class: "s-chip" + (isOn(o.value) ? " is-on" : ""), "aria-pressed": String(isOn(o.value)), onClick: function () {
          if (!multi) { if (value === o.value) return; value = o.value; }
          else if (isOn(o.value)) value = value.filter(function (x) { return x !== o.value; });
          else value = value.concat([o.value]);
          draw();
          if (opts.onChange) opts.onChange(box.value());
        } }, multi && isOn(o.value) ? icon("check", 12) : null, o.label, o.count != null ? el("span", { class: "s-chip-count" }, String(o.count)) : null);
      }));
      if (at !== -1 && box.children[at]) box.children[at].focus();
    }
    box.value = function () { return multi ? value.slice() : value; };
    box.set = function (v) { value = multi ? (v || []).slice() : v; draw(); return box; };
    box.setOptions = function (list) { options = (list || []).map(function (o) { return o && typeof o === "object" ? o : { value: o, label: String(o) }; }); draw(); return box; };
    return box.setOptions(opts.options);
  }
  function search(opts) {
    opts = opts || {};
    var timer = 0, input = el("input", { type: "search", placeholder: opts.placeholder || "Search", "aria-label": opts.placeholder || "Search", value: opts.value || "",
      onInput: function () { clearTimeout(timer); timer = setTimeout(function () { if (opts.onInput) opts.onInput(input.value.trim()); }, 150); } });
    var box = el("label", { class: "s-search" }, icon("search"), input);
    box.input = input;
    box.value = function () { return input.value.trim(); };
    box.set = function (v) { input.value = v == null ? "" : v; return box; };
    return box;
  }

  var INTERACTIVE = "a,button,input,select,textarea,label,.s-td-check,[data-stop]", tableMemo = Object.create(null);
  function table(opts) {
    var cols = opts.columns || [], rows = [], held = null, trs = Object.create(null);
    var keyOf = typeof opts.key === "function" ? opts.key : function (r) { return r[opts.key || "id"]; };
    // Selection and scroll live in `memo`; with opts.id they also survive the table being rebuilt.
    var memo = (opts.id && tableMemo[opts.id]) || { sel: Object.create(null), top: 0, left: 0 };
    if (opts.id) tableMemo[opts.id] = memo;
    function cellClass(c) { return [c.align ? "is-" + c.align : "", c.wrap ? "is-wrap" : "", c.grow ? "is-grow" : "", c.hide === "sm" ? "s-hide-sm" : "", c.class || ""].filter(Boolean).join(" ") || null; }
    function setAll(on) { rows.forEach(function (r) { var k = String(keyOf(r)); if (on) memo.sel[k] = true; else delete memo.sel[k]; }); sync(true); }
    var all = opts.select ? el("input", { type: "checkbox", "aria-label": "Select all rows", onChange: function () { setAll(all.checked); } }) : null;
    var tbody = el("tbody");
    var wrap = el("div", { class: "s-table-wrap" + (opts.flush ? " is-flush" : ""), style: opts.maxHeight ? { maxHeight: opts.maxHeight } : null,
      onScroll: function () { memo.top = wrap.scrollTop; memo.left = wrap.scrollLeft; } },
      el("table", { class: "s-table" }, el("thead", null, el("tr", null, all ? el("th", { class: "s-td-check" }, all) : null,
        cols.map(function (c) { return el("th", { scope: "col", class: cellClass(c), style: c.width ? { width: c.width } : null }, c.label || ""); }))), tbody));
    // A row keeps its <tr> for as long as its key exists, so focus and hover on
    // the row itself survive the 5 s redraw; only the cells are rebuilt — except a
    // cell showing (or fetching) a revealed code, kept until the reveal ends.
    function rowEl(r) {
      var k = String(keyOf(r)), tr = trs[k], old = tr ? Array.prototype.slice.call(tr.cells) : [], skip = all ? 1 : 0;
      if (!tr) {
        tr = el("tr", { dataset: { key: k } });
        if (opts.onRow) {
          tr.className = "is-click"; tr.tabIndex = 0;
          tr.addEventListener("click", function (e) { if (!e.target.closest(INTERACTIVE)) opts.onRow(tr._row); });
          tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) opts.onRow(tr._row); });
        }
      }
      tr._row = r;
      return fill(tr,
        all ? el("td", { class: "s-td-check" }, el("input", { type: "checkbox", "aria-label": "Select row", onChange: function (e) { if (e.target.checked) memo.sel[k] = true; else delete memo.sel[k]; sync(true); } })) : null,
        cols.map(function (c, i) {
          var prev = old[i + skip], v;
          if (prev && holdsReveal(prev)) return prev;
          try { v = c.render ? c.render(r) : r[c.key]; } catch (e) { console.error("chzzk: column '" + (c.key || c.label) + "' failed:", e); v = "–"; }
          return el("td", { class: cellClass(c) }, v == null ? "" : v);
        }));
    }
    function sync(notify) {
      if (!all) return;
      var n = 0;
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        var box = tr.querySelector(".s-td-check input"); if (!box) return;
        var isOn = !!memo.sel[tr.dataset.key]; if (isOn) n++;
        box.checked = isOn; tr.classList.toggle("is-selected", isOn);
      });
      all.checked = n > 0 && n === rows.length; all.indeterminate = n > 0 && n < rows.length; all.disabled = !rows.length;
      if (notify && opts.onSelect) opts.onSelect(wrap.selected());
    }
    function draw() {
      // A redraw must not move the operator: keep scroll, selection and keyboard focus where they were.
      var a = doc.activeElement, mark = null, top = wrap.scrollTop, left = wrap.scrollLeft;
      if (a && tbody.contains(a)) { var ftr = a.closest("tr"), ftd = a.closest("td"); mark = { key: ftr.dataset.key, cell: ftd ? ftd.cellIndex : -1, at: ftd ? focusables(ftd).indexOf(a) : -1 }; }
      var next = Object.create(null), list = rows.map(function (r) { var tr = rowEl(r); next[tr.dataset.key] = tr; return tr; });
      trs = next;
      fill(tbody, rows.length ? list : el("tr", null, el("td", { class: "s-td-empty", colspan: String(cols.length + (all ? 1 : 0)) }, opts.empty instanceof Node ? opts.empty : empty(opts.empty || "Nothing to show"))));
      sync(false); wrap.scrollTop = top; wrap.scrollLeft = left;
      var tr = mark && trs[mark.key], target = tr && ((tr.cells[mark.cell] && focusables(tr.cells[mark.cell])[mark.at]) || tr);
      if (target && target.focus) target.focus({ preventScroll: true });
    }
    wrap.update = function (next) {
      if (openMenu && tbody.contains(openMenu.anchor)) { held = next || []; return wrap; }    // don't pull a row from under an open menu
      rows = next || []; held = null; draw(); return wrap;
    };
    wrap.selected = function () { return rows.map(function (r) { return String(keyOf(r)); }).filter(function (k) { return memo.sel[k]; }); };
    wrap.clearSelection = function () { memo.sel = Object.create(null); sync(true); return wrap; };
    wrap.addEventListener("chzzk:menuclose", function () { if (held) wrap.update(held); });
    wrap.update(opts.rows);
    if (opts.id && (memo.top || memo.left)) requestAnimationFrame(function () { wrap.scrollTop = memo.top; wrap.scrollLeft = memo.left; });
    return wrap;
  }

  // ---------- Reveal: the only code that puts a reward code on the page --------
  // One code on screen at a time; its text is wiped after 60 s or as soon as its
  // cell leaves the page. Never toasted, logged, or put in a title or URL. A
  // table keeps a cell that holds a reveal through its poll redraws (rowEl).
  var REVEAL_MS = 60000, reveals = [], revealing = [];   // on screen { cell, hide } / being fetched { cell, p }
  function holdsReveal(node) { return reveals.concat(revealing).some(function (r) { return node.contains(r.cell); }); }
  function sweepReveals() { reveals.slice().forEach(function (r) { if (!doc.contains(r.cell)) r.hide(); }); }
  function revealButton(rewardId, cell, opts) {
    return button("Reveal", { size: "sm", icon: "eye", title: "Show this code for 60 seconds", onClick: function () { return reveal(rewardId, cell, opts); } });
  }
  // A code the code shop has on sale or already sold must not also be handed
  // out by hand: ask first (opts.shop is the reward row's `shop` state).
  var SHOP_ASK = { in_unit: "is on sale in the code shop", sold: "was sold in the code shop", dead: "was sold in the code shop" };
  // Resolves true once the code is shown, false otherwise (a failure is already toasted); never rejects.
  function reveal(rewardId, cell, opts) {
    if (!(cell instanceof Node)) return Promise.resolve(false);
    var ask = opts && SHOP_ASK[opts.shop];
    if (ask && !(opts && opts.confirmed)) {
      return confirmBox({ title: "Show a code the shop is selling?", danger: true, okLabel: "Show it anyway",
        body: "This code " + ask + ". Showing it is fine for checking a buyer's problem, but never give it to anyone else: it would be sold twice." })
        .then(function (yes) { return yes ? reveal(rewardId, cell, { shop: opts.shop, confirmed: true }) : false; });
    }
    var busy = revealing.filter(function (r) { return r.cell === cell; })[0];
    if (busy) return busy.p;
    var job = { cell: cell, p: null };
    function done() { var i = revealing.indexOf(job); if (i !== -1) revealing.splice(i, 1); }
    job.p = api.post("/rewards/reveal", { id: rewardId }).then(function (j) {
      done();
      if (!doc.contains(cell)) return false;             // the row or drawer went away while we asked
      if (!j || j.code == null || j.code === "") throw fail("No code is stored for this reward", 404);
      showCode(rewardId, cell, String(j.code), opts && { shop: opts.shop });
      return true;
    }).catch(function (e) { done(); toast(e); return false; });
    revealing.push(job);
    return job.p;
  }
  function showCode(rewardId, cell, code, opts) {
    reveals.slice().forEach(function (r) { r.hide(); });
    var a = doc.activeElement, focusHere = !a || a === doc.body || cell.contains(a);
    var until = Date.now() + REVEAL_MS, timer = 0, live = { cell: cell, hide: hide };
    var field = el("span", { class: "s-code", role: "textbox", "aria-readonly": "true", "aria-label": "Reward code", tabindex: "0" }, code);
    var left = el("span", { class: "s-reveal-left" });
    var copy = button("Copy", { size: "sm", icon: "copy", onClick: function () { return copyCode(field); } });
    function tick() {
      var s = Math.ceil((until - Date.now()) / 1000);     // from the deadline, so a throttled timer still hides on time
      if (s <= 0 || !doc.contains(cell)) hide();
      else left.textContent = "hides in " + s + " s";
    }
    function hide() {
      var i = reveals.indexOf(live);
      if (i === -1) return;
      reveals.splice(i, 1); clearInterval(timer);
      field.textContent = "";                            // drop the text itself, not only its place in the page
      var refocus = cell.contains(doc.activeElement), again = revealButton(rewardId, cell, opts);
      fill(cell, again);
      if (refocus) again.focus({ preventScroll: true });
    }
    reveals.push(live);
    fill(cell, el("span", { class: "s-reveal", "data-stop": true }, field, copy,
      button("", { size: "sm", icon: "x", tone: "ghost", title: "Hide the code now", onClick: hide }), left));
    timer = setInterval(tick, 1000); tick();
    if (focusHere && reveals.indexOf(live) !== -1) copy.focus({ preventScroll: true });
  }
  function copyCode(field) {
    function byHand() { selectAll(field); toast("Could not copy — the code is selected, copy it by hand", "warn"); }
    if (!field.textContent) return null;
    if (!navigator.clipboard || !navigator.clipboard.writeText) return byHand();
    return navigator.clipboard.writeText(field.textContent).then(function () { toast("Code copied", "ok"); }, byHand);
  }
  function selectAll(node) {
    try { var r = doc.createRange(), s = window.getSelection(); r.selectNodeContents(node); s.removeAllRanges(); s.addRange(r); } catch (e) { /* nothing to select */ }
  }

  // ---------- Lookups --------------------------------------------------------
  var GAMES = { OVERWATCH: "Overwatch", Lost_Ark: "Lost Ark", Black_Desert: "Black Desert", Call_of_Duty_Modern_Warfare4: "Call of Duty: MW4",
    World_of_Warcraft_Midnight: "WoW: Midnight", dokkaebi: "Dokkaebi World", Once_Human: "Once Human", stellasora: "Stella Sora",
    WutheringWaves: "Wuthering Waves", Arknights_Endfield: "Arknights: Endfield", FIFA_ONLINE4: "FC Online" };
  var GAMES_LC = Object.create(null);
  Object.keys(GAMES).forEach(function (k) { GAMES_LC[k.toLowerCase()] = GAMES[k]; });
  function gameName(categoryId, categoryValue) {
    if (categoryId && typeof categoryId === "object") { categoryValue = categoryId.categoryValue; categoryId = categoryId.categoryId; }
    var id = categoryId == null ? "" : String(categoryId).trim();
    if (GAMES_LC[id.toLowerCase()]) return GAMES_LC[id.toLowerCase()];
    // CHZZK ids read like "Escape_from_Tarkov" or "MapleStory": spaced out, they are close enough to a name.
    var words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean);
    if (words.length) return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
    var v = categoryValue == null ? "" : String(categoryValue).trim();
    return v || "Other";
  }
  var REWARD_TYPES = { CODE_FIRST_COME: "Code", CODE_LOTTERY: "Lottery", IN_APP: "In-game" };
  function rewardType(t) { return Object.prototype.hasOwnProperty.call(REWARD_TYPES, t) ? REWARD_TYPES[t] : t ? String(t) : "–"; }

  // ---------- Farm switch + header menu actions --------------------------------
  function switchFarm(on) {
    on = !!on;
    var ask = on ? Promise.resolve(true) : confirmBox({ title: "Switch the farm off?", danger: true, okLabel: "Switch off",
      body: "All watching stops; logins, progress and codes are kept." });
    return ask.then(function (yes) {
      if (!yes) return null;
      return api.post("/switch", { on: on }).then(function (j) {
        toast(j.on ? "Farm switched on" : "Farm switched off", "ok");
        return Chzzk.refresh();
      });
    });
  }
  function checkAll() {
    return api.post("/accounts/check", {}).then(function (j) {
      toast(j.total ? "Checking " + plural(j.total, "login") + " — results show here in a minute" : "No logins to check", j.total ? "ok" : "info");
      return Chzzk.refresh();
    });
  }
  function collectAll() {
    return api.post("/rewards/collect", {}).then(function (j) {
      toast(j.queued ? "Collecting codes for " + plural(j.queued, "login") : "No codes are waiting to be collected", j.queued ? "ok" : "info");
      return Chzzk.refresh();
    });
  }
  function rescan() {
    return api.post("/campaigns/refresh", {}).then(function (j) {
      toast("Rescanned CHZZK — " + plural(j.found || 0, "campaign") + " found, " + fmt.num(j.updated || 0) + " updated", "ok");
      return Chzzk.refreshCampaigns();
    });
  }

  // ---------- Public surface ---------------------------------------------------
  Chzzk.api = api;
  Chzzk.refresh = function () { return loadState(true).catch(function () { return null; }); };
  Chzzk.refreshCampaigns = function () { return loadCampaigns(true).catch(function () { return null; }); };
  Chzzk.on = on; Chzzk.registerTab = registerTab; Chzzk.go = go; Chzzk.el = el;
  Chzzk.toast = toast; Chzzk.confirm = confirmBox; Chzzk.modal = modal; Chzzk.drawer = drawer; Chzzk.fmt = fmt;
  Chzzk.ui = { badge: badge, dot: dot, progress: progress, empty: empty, button: button, stat: stat, table: table, chips: chips, search: search, menu: menu, icon: icon };
  Chzzk.accountById = function (id) { return idx.acc[String(id)] || null; };
  Chzzk.campaignByNo = function (no) { return idx.camp[String(no)] || null; };
  Chzzk.gameName = gameName; Chzzk.rewardType = rewardType;
  Chzzk.reveal = reveal; Chzzk.switchFarm = switchFarm;

  // ---------- Boot -----------------------------------------------------------
  Array.prototype.forEach.call(doc.querySelectorAll("#chzzkTabs [data-tab]"), function (b) { addSlot(b.dataset.tab); });
  var bar = $("chzzkTabs");
  if (bar) {
    bar.addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
    bar.addEventListener("keydown", function (e) {
      var i = order.indexOf(current), n = order.length;
      var to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if (to === -1) return;
      e.preventDefault(); go(order[to]);
      if (slots[order[to]].btn) { slots[order[to]].btn.focus(); slots[order[to]].btn.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    });
  }
  if ($("chzzkMenuBtn")) menu($("chzzkMenuBtn"), function () {
    var s = Chzzk.state, isOn = !!(s && s.switch && s.switch.on);
    return [{ label: "Refresh now", icon: "refresh", onClick: function () { Chzzk.refreshCampaigns(); return Chzzk.refresh(); } },
      { label: "Check all logins", icon: "user", onClick: checkAll },
      { label: "Collect codes now", icon: "gift", onClick: collectAll },
      { label: "Rescan CHZZK campaigns", icon: "search", onClick: rescan }, "-",
      !s ? { label: "Switch farm off / on", icon: "stop", disabled: true }
        : isOn ? { label: "Switch farm off", icon: "stop", danger: true, onClick: function () { return switchFarm(false); } }
        : { label: "Switch farm on", icon: "play", onClick: function () { return switchFarm(true); } }];
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("load", function () { scriptsDone = true; repaint(); });   // tab files that never arrived stop saying "Loading…"
  doc.addEventListener("visibilitychange", function () { if (!doc.hidden) { pollState(); pollCampaigns(); } });
  route(); pollState(); pollCampaigns();
})();
