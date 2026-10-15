/* SOOP farm — Sales tab: the code shop (docs/code-shop/04-OPS.md, "Panel").
   This file registers the tab, draws the section sub-nav, polls
   /api/code-shop/state every 20 s while the tab is on screen (plus once at page
   load, so the tab badge can show) and draws the Overview section. The other
   sections live in sales-*.js and plug in through window.SoopSales:

     SoopSales.api.get(path) / .post(path, body) / .del(path)
         `path` is relative to /api/code-shop. Resolves the JSON body; a 401/403
         goes to the login page; rejects with Error(message) when the server
         says success: false (the error also carries .status and .body).
     SoopSales.state      the last GET /state body, or null before the first load
     SoopSales.refresh()  reload /state now and repaint the current section;
                          never rejects (resolves the state, or null on failure)
     SoopSales.registerSection({ id, label, render(root, state), update?(root, state) })
         render runs once, the first time the section is shown; update runs right
         after it, after every /state load and each time the section is shown
         again. A section without update is rendered afresh instead.
     SoopSales.usd(n) "$1.00" · when(date) "Oct 6, 14:30" · dateOnly(date) "Oct 6"
     SoopSales.confirmAction(message[, { title, okLabel, danger }]) -> Promise<boolean>

   Soop.go("sales", { section: "products", product: id }) opens a section; the
   other params reach the section files through Soop.on("tab").
   Nothing here shows a code: /state carries counts, labels and prices only. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const BASE = "/api/code-shop", POLL_MS = 20000, SOON_MS = 3 * 24 * 3600 * 1000, STORE_KEY = "soop.sales.section";
  const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

  // ---------- small helpers ---------------------------------------------------
  function fill(node, ...kids) {
    node.textContent = "";
    kids.flat(3).forEach((k) => { if (k != null && k !== false && k !== true) node.append(k instanceof Node ? k : String(k)); });
    return node;
  }
  const plural = (n, one, many) => fmt.num(n || 0) + " " + (Number(n) === 1 ? one : many || one + "s");
  const nowMs = () => Date.parse(Soop.state && Soop.state.now) || Date.now();
  function toDate(v) {
    if (v == null || v === "") return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function usd(n) {
    if (n == null || n === "" || !isFinite(Number(n))) return "–";
    const v = Number(n);
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function when(date) { return fmt.when(toDate(date)); }
  function dateOnly(date) {
    const d = toDate(date);
    if (!d) return "–";
    return MONTHS[d.getMonth()] + " " + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear());
  }
  // A plain message gets a neutral title and a verb on the button; an options object goes straight to Soop.confirm.
  function confirmAction(message, opts) {
    if (message && typeof message === "object" && !(message instanceof Node)) return Soop.confirm(message);
    opts = opts || {};
    return Soop.confirm({ title: opts.title || "Are you sure?", body: message == null ? "" : message, okLabel: opts.okLabel || "Yes, go ahead", danger: !!opts.danger });
  }
  // Seconds since a time measured on this browser's clock (no server skew involved).
  function since(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " s ago";
    const m = Math.floor(s / 60);
    return m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago";
  }
  function secs(ms) { return ms == null || !isFinite(Number(ms)) ? "–" : (Number(ms) / 1000).toFixed(Number(ms) < 10000 ? 1 : 0) + " s"; }
  function readStored() { try { return window.localStorage.getItem(STORE_KEY) || ""; } catch (e) { return ""; } }
  function store(id) { try { window.localStorage.setItem(STORE_KEY, id); } catch (e) { /* private window: not remembered */ } }

  // ---------- API -----------------------------------------------------------------
  let gone = false, timer = 0, busy = null, again = null, triedAt = 0, loadedAt = 0, loadError = "";
  function fail(message, status, body) {
    const e = new Error(message);
    e.status = status;
    if (body) e.body = body;
    return e;
  }
  function request(method, path, body) {
    const p = String(path == null ? "" : path);
    const url = BASE + (p === "" || p.charAt(0) === "/" ? "" : "/") + p;
    const opts = { method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (method === "POST") { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body || {}); }
    return fetch(url, opts).then((r) => {
      if (r.status === 401 || r.status === 403) {
        if (!gone) { gone = true; clearTimeout(timer); window.location.href = "/admin-login.html"; }
        throw fail("You are signed out — taking you to the login page", r.status);
      }
      return r.json().catch(() => null).then((j) => {
        if (!r.ok || !j || j.success === false) throw fail((j && (j.message || j.error)) || "The server answered with an error (HTTP " + r.status + ")", r.status, j);
        return j;
      });
    }, () => { throw fail("Could not reach the server — check the connection", 0); });
  }
  const api = {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    del: (path) => request("DELETE", path),
  };

  // ---------- polling ---------------------------------------------------------------
  // A timeout chain, never an interval: it runs only while the Sales panel is on
  // screen and the browser tab is visible, and stops by itself otherwise. The
  // tab's update() (every 3 s while visible) restarts it.
  function visible() { return !!rootEl && !rootEl.hidden && !document.hidden; }
  function schedule() {
    clearTimeout(timer); timer = 0;
    if (gone || busy || !visible()) return;
    timer = setTimeout(() => { timer = 0; if (visible()) refresh(); }, Math.max(0, POLL_MS - (Date.now() - triedAt)));
  }
  function refresh() {
    // A refresh asked for while one is in flight (say, right after a POST) gets a fresh read afterwards.
    if (busy) {
      if (!again) again = busy.then(() => { again = null; return refresh(); });
      return again;
    }
    clearTimeout(timer); timer = 0; triedAt = Date.now();
    busy = api.get("/state").then(
      (j) => { SoopSales.state = j; loadedAt = Date.now(); loadError = ""; return j; },
      (e) => { loadError = (e && e.message) || "No answer from the server"; return null; },
    ).then((j) => { busy = null; paintAll(); schedule(); return j; });
    return busy;
  }

  // ---------- sections ----------------------------------------------------------------
  const sections = [], byId = Object.create(null);
  let wanted = readStored(), current = null, rootEl = null, navChips = null, boxHost = null, statusLine = null;

  function navOptions() { return sections.map((s) => ({ value: s.id, label: s.def.label || s.id })); }
  function mountBox(s) {
    if (s.box || !boxHost) return;
    s.box = el("div", { class: "s-sales-section", dataset: { section: s.id }, hidden: true }, el("p", { class: "s-loading" }, "Loading…"));
    boxHost.append(s.box);
  }
  function registerSection(def) {
    if (!def || !def.id || typeof def.render !== "function") throw new Error("SoopSales.registerSection needs { id, label, render }");
    const id = String(def.id);
    let s = byId[id];
    if (s) { s.def = def; s.rendered = false; s.broken = false; }
    else { s = byId[id] = { id, def, box: null, rendered: false, broken: false, lastError: "" }; sections.push(s); }
    if (rootEl) {
      mountBox(s);
      navChips.setOptions(navOptions());
      if (!current || id === wanted || id === current) show(id === wanted || !current ? wanted : current);
    }
    return s.id;
  }
  function show(id, remember) {
    if (!byId[id]) id = sections.length ? sections[0].id : null;
    if (!id) return;
    if (remember) { wanted = id; store(id); }
    current = id;
    if (navChips && navChips.value() !== id) navChips.set(id);
    sections.forEach((s) => { if (s.box) s.box.hidden = s.id !== id; });
    paintSection(byId[id]);
  }
  function paintSection(s) {
    if (!s || !s.box || s.broken) return;
    const st = SoopSales.state;
    if (!st) {
      if (!s.rendered) {
        fill(s.box, loadError
          ? el("section", { class: "s-card" }, ui.empty("The shop could not be loaded", loadError, { label: "Try again", icon: "refresh", onClick: refresh }))
          : el("p", { class: "s-loading" }, "Loading the shop…"));
      }
      return;
    }
    try {
      if (!s.rendered || !s.def.update) { s.rendered = false; fill(s.box); s.def.render(s.box, st); s.rendered = true; }
      if (s.def.update) s.def.update(s.box, st);
      s.lastError = "";
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg !== s.lastError) console.error("soop: sales section '" + s.id + "' failed:", e);     // once, not every 20 s
      s.lastError = msg;
      if (!s.rendered) {
        s.broken = true;
        fill(s.box, el("section", { class: "s-card" }, ui.empty("This section could not be shown", msg,
          ui.button("Try again", { icon: "refresh", onClick: () => { s.broken = false; paintSection(s); } }))));
      }
    }
  }
  function paintStatus() {
    if (!statusLine) return;
    const stale = loadError && SoopSales.state;
    statusLine.className = "s-small " + (stale ? "s-warn" : "s-muted");
    statusLine.textContent = stale ? "Could not refresh (" + loadError + ") — showing what was loaded " + since(loadedAt)
      : loadedAt ? "Updated " + since(loadedAt)
        : loadError ? "Not loaded" : "Loading…";
  }
  function paintAll() {
    paintStatus();
    if (rootEl && current) paintSection(byId[current]);
  }

  // ---------- Overview section ----------------------------------------------------------
  const TONE_WORD = { error: "Problem", warn: "Soon", info: "Waiting for you", muted: "Note" };
  const TONE_RANK = { error: 0, warn: 1, info: 2, muted: 3 };
  function openProduct(p) { return { label: "Open", onClick: () => Soop.go("sales", { section: "products", product: p.id }) }; }
  function isReady(p, minUnits) {
    return p.status === "draft" && !(p.problems || []).length && !p.stale && ((p.proposed && Number(p.proposed.units)) || 0) >= minUnits;
  }
  // Everything the owner should look at, most urgent first. Absolute times only,
  // so the list is rebuilt when something changes, not every minute.
  function needs(st) {
    const out = [], now = nowMs(), cfg = st.config || {}, sum = st.summary || {};
    const minUnits = Number((cfg.drafts || {}).minUnits) || 0;
    (st.products || []).forEach((p) => {
      const name = p.name || "Unnamed product", problems = p.problems || [];
      if (p.status === "draft") {
        if (problems.length) {
          out.push({ key: "problems:" + p.id, tone: "error", title: name,
            detail: "Draft with " + plural(problems.length, "problem") + ": " + problems[0] + (problems.length > 1 ? " (and " + (problems.length - 1) + " more)" : ""), action: openProduct(p) });
        } else if (p.stale) {
          out.push({ key: "stale:" + p.id, tone: "muted", title: name, detail: "Draft you edited that the planner no longer proposes — its codes may have gone elsewhere. Check it or delete it.", action: openProduct(p) });
        } else if (isReady(p, minUnits)) {
          out.push({ key: "ready:" + p.id, tone: "info", title: name,
            detail: "Ready to approve — " + plural(p.proposed.units, "bundle") + " can be built now.", action: { label: "Review", onClick: openProduct(p).onClick } });
        }
      }
      const pubErr = (p.publish && p.publish.lastError) || "";
      if (pubErr) {
        out.push({ key: "publish:" + p.id, tone: "error", title: name,
          detail: "Publishing failed" + (p.publish.lastAttemptAt ? " (" + when(p.publish.lastAttemptAt) + ")" : "") + ": " + pubErr, action: openProduct(p) });
      }
      (p.listings || []).forEach((l) => {
        if (!l || !l.lastError || l.lastError === pubErr) return;
        out.push({ key: "listing:" + p.id + ":" + (l.market || "") + ":" + (l.externalId || ""), tone: "error", title: name,
          detail: (l.market ? l.market.charAt(0).toUpperCase() + l.market.slice(1) : "A") + " listing: " + l.lastError, action: openProduct(p) });
      });
      const t = Date.parse(p.useBy);
      if (p.useBy && isFinite(t) && t - now <= SOON_MS) {
        out.push({ key: "useby:" + p.id, tone: t <= now ? "error" : "warn", title: name,
          detail: (t <= now ? "Its codes stopped working " : "Its codes stop working ") + when(p.useBy) + ". "
            + (cfg.expiryGuard === false ? "The expiry guard is OFF, so nothing takes this stock off sale by itself."
              : "Its stock is taken off sale " + fmt.num(cfg.expiryLeadHours != null ? cfg.expiryLeadHours : 36) + " h before that."),
          action: openProduct(p) });
      }
    });
    if (Number(sum.held) > 0) {
      out.push({ key: "held", tone: "warn", title: plural(sum.held, "code") + " held for checking",
        detail: "They cannot be sold safely (a vault release, a missing bundle or a duplicate) until someone looks. The list is on the Stock section.",
        action: { label: "Show", onClick: () => Soop.go("sales", { section: "stock" }) } });
    }
    if (Number(st.adoptable) > 0) {
      out.push({ key: "adopt", tone: "muted", title: plural(st.adoptable, "hand-made code listing") + " could be adopted",
        detail: "Adopting lets the shop track its codes, stock and sales. Its price stays as it is.",
        action: { label: "Settings", onClick: () => Soop.go("sales", { section: "settings" }) } });
    }
    return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  }
  function needRow(x) {
    return el("li", { class: "s-list-item" }, ui.dot(x.tone, TONE_WORD[x.tone]),
      el("div", { class: "s-grow s-stack is-tight" },
        el("b", { class: "s-trunc", title: x.title }, x.title),
        el("span", { class: "s-small s-muted" }, x.detail)),
      x.action ? ui.button(x.action.label, { size: "sm", onClick: x.action.onClick }) : null);
  }

  function overviewSection() {
    const v = {};
    return {
      id: "overview", label: "Overview",
      render(root) {
        const t = (v.t = {
          inStock: ui.stat("In stock", "–"), onSale: ui.stat("On sale", "–"), inVault: ui.stat("In a GGSel vault", "–"), sold: ui.stat("Sold", "–"),
          expiring: ui.stat("Expiring", "–"), held: ui.stat("Held", "–"), drafts: ui.stat("Drafts", "–"),
          d1: ui.stat("Last 24 h", "–"), d7: ui.stat("Last 7 days", "–"), d30: ui.stat("Last 30 days", "–"), all: ui.stat("All time", "–"),
        });
        v.count = ui.badge("0");
        v.list = el("ul", { class: "s-list" });
        v.products = el("span", { class: "s-small s-muted" });
        v.modes = el("div", { class: "s-row" });
        v.tick = el("span", { class: "s-small s-muted" });
        v.tickErr = el("div", { class: "s-note is-warn", hidden: true });
        root.append(el("div", { class: "s-stack" },
          el("div", { class: "s-stack is-tight" }, el("div", { class: "s-spread" }, el("p", { class: "s-eyebrow" }, "Codes"), v.products),
            el("div", { class: "s-stats" }, t.inStock, t.onSale, t.inVault, t.sold, t.expiring, t.held, t.drafts)),
          el("div", { class: "s-stack is-tight" }, el("p", { class: "s-eyebrow" }, "Revenue"),
            el("div", { class: "s-stats" }, t.d1, t.d7, t.d30, t.all)),
          el("section", { class: "s-card" },
            el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Needs you"), v.count),
            v.list),
          el("section", { class: "s-card" }, el("div", { class: "s-card-bd s-stack is-tight" },
            el("div", { class: "s-spread" }, v.tick, v.modes), v.tickErr))));
      },
      update(root, st) {
        const s = st.summary || {}, r = s.revenue || {}, t = v.t, cfg = st.config || {}, n = (k) => fmt.num(s[k] || 0);
        const products = st.products || [], minUnits = Number((cfg.drafts || {}).minUnits) || 0;
        const ready = products.filter((p) => isReady(p, minUnits)).length;
        t.inStock.set(n("inStock"), "free codes, not in a bundle");
        t.onSale.set(n("onSale"), "codes in bundles on sale", s.onSale ? "ok" : null);
        t.inVault.set(n("inVault"), "codes handed to GGSel");
        t.sold.set(n("sold"), s.dead ? fmt.num(s.dead) + " reported dead after sale" : "codes sold", null);
        t.expiring.set(n("expiring"), s.expired ? fmt.num(s.expired) + " already expired" : "taken off sale near their use-by", s.expiring ? "warn" : null);
        t.held.set(n("held"), s.held ? "need checking before they can sell" : "nothing held", s.held ? "warn" : null);
        t.drafts.set(n("drafts"), ready ? fmt.num(ready) + " ready to approve" : "waiting for you", null);
        t.d1.set(usd(r.d1 || 0)); t.d7.set(usd(r.d7 || 0)); t.d30.set(usd(r.d30 || 0)); t.all.set(usd(r.all || 0));

        const by = (status) => products.filter((p) => p.status === status).length;
        v.products.textContent = "Products: " + fmt.num(by("active")) + " on sale · " + fmt.num(by("paused")) + " paused · " + fmt.num(by("draft")) + " drafts";

        const items = needs(st), sig = JSON.stringify(items.map((x) => [x.key, x.tone, x.title, x.detail]));
        v.count.textContent = String(items.length);
        v.count.className = "s-badge" + (items.some((x) => x.tone === "error") ? " is-error" : items.length ? " is-warn" : " is-ok");
        if (sig !== v.sig) {      // rebuilt only when what it says changed, so its buttons keep focus
          v.sig = sig;
          fill(v.list, items.length ? items.map(needRow)
            : el("li", { class: "s-list-item" }, ui.dot("ok", "All clear"),
              el("span", { class: "s-muted" }, "Nothing needs you right now. New drafts, publish errors, held codes and codes close to their use-by date show up here.")));
        }

        const mk = cfg.markets || {};
        fill(v.modes,
          ui.badge("Eldorado " + (mk.eldorado ? "on" : "off"), mk.eldorado ? "ok" : null),
          ui.badge("GGSel " + (mk.ggsel ? "on" : "off"), mk.ggsel ? "ok" : null),
          ui.badge(cfg.autoPublish ? "Ready drafts publish by themselves" : "Drafts wait for your approval", cfg.autoPublish ? "warn" : null));
        const tick = st.lastTick;
        v.tick.textContent = tick && tick.at
          ? "The shop engine last ran " + when(tick.at) + " (" + fmt.ago(tick.at) + ")" + (tick.ms != null ? " and took " + secs(tick.ms) : "") + ". It runs every 5 minutes."
          : "The shop engine has not run since the server started. It runs every 5 minutes.";
        const steps = (tick && tick.steps) || {}, errs = Object.keys(steps).filter((k) => steps[k] && steps[k].error);
        v.tickErr.hidden = !errs.length;
        if (errs.length) {
          fill(v.tickErr, ui.icon("alert"), el("div", { class: "s-stack is-tight s-grow" },
            el("b", plural(errs.length, "step") + " failed on the last run"),
            errs.map((k) => el("span", { class: "s-small" }, el("span", { class: "s-mono" }, k), " — " + String(steps[k].error))),
            el("span", { class: "s-small s-muted" }, "The other steps still ran. Settings › Run now runs one step again.")));
        }
      },
    };
  }

  // ---------- registration ------------------------------------------------------------------
  const SoopSales = (window.SoopSales = { api, state: null, refresh, registerSection, usd, when, dateOnly, confirmAction });
  registerSection(overviewSection());

  Soop.on("tab", ({ id, params }) => {
    if (id !== "sales") { clearTimeout(timer); timer = 0; return; }
    if (params && params.section && byId[params.section]) show(params.section, true);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });

  Soop.registerTab({
    id: "sales", label: "Sales",
    render(root) {
      rootEl = root;
      navChips = ui.chips({ options: navOptions(), value: null, onChange: (id) => show(id, true) });
      navChips.setAttribute("aria-label", "Sales sections");
      statusLine = el("span", { class: "s-small s-muted", role: "status" });
      boxHost = el("div", { class: "s-stack" });
      root.append(el("div", { class: "s-stack s-sales" },
        el("div", { class: "s-spread" }, navChips,
          el("div", { class: "s-row" }, statusLine,
            ui.button("", { icon: "refresh", tone: "ghost", size: "sm", title: "Reload the shop now",
              onClick: () => refresh().then((j) => { if (!j) Soop.toast("The shop could not be reloaded: " + loadError, "error"); }) }))),
        boxHost));
      sections.forEach(mountBox);
      show(wanted);
      paintStatus();
      if (!SoopSales.state && !busy) refresh();
    },
    // Every 3 s while the tab is on screen: the "Updated …" line, and restarting the 20 s chain if it stopped.
    update() {
      paintStatus();
      if (!timer && !busy) schedule();
    },
    badge() {
      const s = SoopSales.state && SoopSales.state.summary;
      if (!s) return null;
      const n = (Number(s.drafts) || 0) + (Number(s.held) || 0);
      return n > 0 ? { text: n, tone: Number(s.held) > 0 ? "warn" : "accent" } : null;
    },
  });

  // Once at page load, for the badge (unless registerTab already rendered the tab and started a read);
  // after that only while the tab is visible.
  if (!busy && !SoopSales.state) refresh();
})();
