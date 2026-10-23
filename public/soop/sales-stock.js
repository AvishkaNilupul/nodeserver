/* SOOP farm — Sales tab: the "Stock" and "Logins" sections (docs/code-shop/04-OPS.md,
   views.stock() / views.logins()). Stock lists every stored code by game, campaign
   and reward slot, counted per ledger state; ticking slots of one game starts a
   custom bundle (a draft product: nothing goes on sale until the owner approves it).
   Logins says which farm login earned what. Both are read models: no code is ever
   shown here, only counts, labels and dates. Data loads on first show, when the
   shop summary in /state changes, every two minutes while visible and after an
   action, never on every poll; tables and cards are reused so a reload keeps the
   operator's ticks, focus and scroll. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const STALE_MS = 120000, SOON_MS = 72 * 3600 * 1000;
  const STATES = ["in_stock", "in_unit", "sold", "expiring", "expired", "held", "dead"];
  const S = () => window.SoopSales || {};

  // ---------- shared helpers ------------------------------------------------------
  function fill(node, ...kids) {
    node.textContent = "";
    kids.flat(3).forEach((k) => { if (k != null && k !== false && k !== true) node.append(k); });
    return node;
  }
  const plural = (n, one, many) => fmt.num(n) + " " + (Number(n) === 1 ? one : many || one + "s");
  const when = (d) => (typeof S().when === "function" ? S().when(d) : fmt.when(d));
  const dateOnly = (d) => (typeof S().dateOnly === "function" ? S().dateOnly(d) : fmt.when(d));
  const usd = (n) => (typeof S().usd === "function" ? S().usd(n) : "$" + (Number(n) || 0).toFixed(2));
  const num = (v) => Number(v) || 0;
  function ms(d) {
    if (d == null || d === "") return null;
    const t = new Date(d).getTime();
    return isFinite(t) ? t : null;
  }
  // "Updated …" for a time taken from this browser's clock (not the server's).
  function updatedText(t) {
    if (!t) return "";
    const m = Math.floor((Date.now() - t) / 60000);
    return "Updated " + (m < 1 ? "just now" : m + " min ago");
  }
  // An array as-is; an object map as its values, each keeping its key as `_k`.
  function list(v) {
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
    if (v && typeof v === "object") return Object.keys(v).filter((k) => v[k] && typeof v[k] === "object").map((k) => Object.assign({ _k: k }, v[k]));
    return [];
  }
  // A code from the CHZZK farm is held under "chzzk:<account id>" (utils/codeShop/sources.js).
  const CHZZK = "chzzk:";
  const isChzzk = (id) => String(id || "").indexOf(CHZZK) === 0;
  function who(id) {
    if (isChzzk(id)) return "CHZZK login " + String(id).slice(-6);
    const a = Soop.accountById(id);
    return a && a.nick && a.nick !== String(id) ? a.nick + " (" + id + ")" : String(id);
  }
  function loginLink(id) {
    if (!id) return el("span", { class: "s-muted" }, "–");
    if (isChzzk(id)) {
      return el("a", { class: "s-link", href: "/chzzk.html#accounts?id=" + encodeURIComponent(String(id).slice(CHZZK.length)), title: "Open this login on the CHZZK farm page" }, who(id));
    }
    return Soop.accountById(id)
      ? el("a", { class: "s-link", href: "#accounts?id=" + encodeURIComponent(id), title: "Open this login on the Accounts tab" }, who(id))
      : el("span", { title: "This login is no longer on the Accounts tab" }, String(id));
  }
  // A renamed game shows its new name at once; otherwise the name the shop stored.
  function gameLabel(gameNo, stored) {
    const n = Soop.gameName(gameNo);
    return stored && (n === "Other" || /^Game #/.test(n)) ? stored : n;
  }
  function thumb(image) {
    if (image) return el("img", { class: "s-thumb", src: image, alt: "", loading: "lazy" });
    return el("span", { class: "s-thumb s-row s-muted", style: { justifyContent: "center" }, "aria-hidden": "true" }, ui.icon("gift"));
  }
  function count(n, tone) {
    n = num(n);
    return el("span", { class: "s-num" + (!n ? " s-muted" : tone ? " s-" + tone : "") }, fmt.num(n));
  }
  function counts(c) {
    const out = {};
    STATES.forEach((k) => { out[k] = num(c && c[k]); });
    return out;
  }
  function addCounts(a, b) { STATES.forEach((k) => { a[k] += b[k]; }); return a; }
  // A change in the shop's summary (from /state) means the ledger moved: reload.
  function sigOf(state, keys) {
    const s = state && state.summary;
    if (!s) return "";
    return keys.map((k) => (k === "revenue" ? JSON.stringify(s.revenue || null) : s[k])).join("|");
  }
  // Products is another section of this tab (tab-sales.js): its own switch when it
  // has one, else the tab's hash route with the section as a parameter.
  function goSection(id, params) {
    const s = S(), fn = typeof s.go === "function" ? s.go : typeof s.show === "function" ? s.show : null;
    if (fn) return fn.call(s, id, params || {});
    return Soop.go("sales", Object.assign({ section: id }, params || {}));
  }
  function refreshShop() {
    if (typeof S().refresh === "function") Promise.resolve().then(() => S().refresh()).catch(() => null);
  }

  // =================================================================================
  // Stock
  // =================================================================================
  const STOCK_SIG = ["inStock", "onSale", "inVault", "sold", "expiring", "expired", "held", "dead", "drafts"];
  let stock = null, stockErr = "", stockBusy = null, stockAt = 0, stockOkAt = 0, stockSig = "";
  let query = "", show = "now";
  let searchBox, chips, stampLine, msgBox, cardsBox, heldCard, heldTable, heldBadge;
  const cards = new Map();            // gameNo -> its card parts, reused across reloads

  function normStock(j) {
    const s = (j && (j.stock || j.data)) || j || {};
    const games = list(s.games || s.byGame || (Array.isArray(s) ? s : null)).map((g) => {
      const gameNo = String(g.gameNo != null ? g.gameNo : g._k || "");
      const groups = list(g.groups || g.campaigns || g.byGroup).map((gr) => {
        const groupKey = String(gr.groupKey || gr.key || gr._k || "");
        const slots = list(gr.slots || gr.bySlot).map((sl, i) => {
          const slotKey = String(sl.slotKey || sl.key || sl._k || "");
          return {
            key: slotKey || groupKey + "#" + i, slotKey, gameNo, groupKey,
            label: String(sl.label || sl.name || sl.nameRaw || ""), nameRaw: String(sl.nameRaw || ""), image: sl.image || "",
            campaignTitle: sl.campaignTitle || "", counts: counts(sl.counts || sl), nextUseBy: sl.nextUseBy || sl.useBy || null,
          };
        });
        const title = gr.campaignTitle || gr.title || gr.name || (slots[0] && slots[0].campaignTitle) || "";
        return { groupKey, title, endAt: gr.campaignEndAt || gr.endAt || null, slots };
      });
      return { gameNo, name: g.gameName || g.name || "", groups };
    });
    const held = list(s.held || (j && j.held)).map((h, i) => {
      const id = String(h.id || h._id || h.rowId || "");
      return {
        key: id || i + "|" + (h.loginId || "") + "|" + (h.label || ""), id, loginId: String(h.loginId || ""),
        label: String(h.label || h.name || h.nameRaw || ""), problem: String(h.problem || ""),
        releasable: h.releasable !== false,
      };
    });
    return { games, held };
  }

  // ---- held codes: the owner may hand one back to stock (R6) -----------------------
  // The server re-reads the code, re-checks it and refuses what it cannot release.
  const releasing = new Set();
  function confirmRelease(h) {
    const msg = "Release this code back to stock? Only if you are sure it was never given to anyone.";
    const opts = { title: h.label ? "Release “" + h.label + "”?" : "Release a held code?", okLabel: "Release code", danger: true };
    if (typeof S().confirmAction === "function") return Promise.resolve(S().confirmAction(msg, opts));
    return Soop.confirm(Object.assign({ body: msg }, opts));
  }
  function releaseHeld(h) {
    if (!h.id || releasing.has(h.id)) return null;
    return confirmRelease(h).then((yes) => {
      if (!yes) return null;
      releasing.add(h.id);
      return S().api.post("/held/" + encodeURIComponent(h.id) + "/release", {}).then((j) => {
        const row = (j && j.row) || {};
        const state = row.state && row.state !== "in_stock" ? " (now " + String(row.state).replace(/_/g, " ") + ")" : "";
        Soop.toast((h.label ? "“" + h.label + "”" : "The code") + " is back in stock" + state, "ok");
      }).then(() => { releasing.delete(h.id); refreshShop(); loadStock(); },
        (e) => { releasing.delete(h.id); loadStock(); throw e; });
    });
  }
  function releaseCell(h) {
    const why = !h.id ? "The stock view sent no id for this code, so it cannot be released from here"
      : !h.releasable ? "This code cannot be released: the shop keeps it held"
        : "Put this code back in free stock — only if it was never given to anyone";
    const b = ui.button("Release", { size: "sm", icon: "refresh", tone: "ghost", disabled: !h.id || !h.releasable, title: why, onClick: () => releaseHeld(h) });
    return b.disabled ? el("span", { title: why }, b) : b;
  }

  function loadStock() {
    if (stockBusy) return stockBusy;
    stockBusy = Promise.resolve().then(() => S().api.get("/stock")).then(
      (j) => { stock = normStock(j); stockErr = ""; stockOkAt = Date.now(); },
      (e) => { stockErr = (e && e.message) || "Unknown error"; if (stock) Soop.toast("The stock could not be refreshed: " + stockErr, "error"); },
    ).then(() => { stockBusy = null; stockAt = Date.now(); paintStock(); });
    return stockBusy;
  }

  const holding = (c) => c.in_stock + c.in_unit + c.expiring + c.held > 0;
  function slotShown(g, gr, sl) {
    if (show === "now" && !holding(sl.counts)) return false;
    if (!query) return true;
    return [sl.label, sl.nameRaw, gr.title, gameLabel(g.gameNo, g.name)].join(" ").toLowerCase().includes(query.toLowerCase());
  }
  function clearFilters() {
    query = ""; show = "now";
    searchBox.set(""); chips.set("now");
    paintStock();
  }

  function useBy(d) {
    const t = ms(d);
    if (t == null) return el("span", { class: "s-muted" }, "–");
    const left = t - Date.now();
    return el("span", { class: left < 0 ? "s-muted" : left <= SOON_MS ? "s-warn" : null, title: when(d) },
      dateOnly(d) + " · " + (left < 0 ? fmt.ago(d) : fmt.until(d)));
  }
  const SLOT_COLUMNS = [
    { label: "", width: "52px", render: (sl) => thumb(sl.image) },
    { label: "Reward", grow: true, render: (sl) => el("div", { class: "s-stack is-tight" },
      el("b", { class: "s-trunc", title: sl.label }, sl.label || "Unnamed reward"),
      sl.nameRaw && sl.nameRaw !== sl.label ? el("span", { class: "s-small s-muted s-trunc", title: "Name as the farm received it: " + sl.nameRaw }, sl.nameRaw) : null) },
    { label: "In stock", align: "right", render: (sl) => count(sl.counts.in_stock, "ok") },
    { label: "In bundles", align: "right", render: (sl) => count(sl.counts.in_unit) },
    { label: "Sold", align: "right", render: (sl) => count(sl.counts.sold) },
    { label: "Expiring", align: "right", render: (sl) => count(sl.counts.expiring, "warn") },
    { label: "Expired", align: "right", hide: "sm", render: (sl) => count(sl.counts.expired) },
    { label: "Held", align: "right", hide: "sm", render: (sl) => count(sl.counts.held, "warn") },
    { label: "Dead", align: "right", hide: "sm", render: (sl) => count(sl.counts.dead, "error") },
    { label: "Next use-by", render: (sl) => useBy(sl.nextUseBy) },
  ];

  // ---- one card per game; one table per campaign group inside it -------------------
  function gameCard(g) {
    const key = g.gameNo || "?";
    let c = cards.get(key);
    if (c) return c;
    c = { key, groups: new Map(), order: [], slots: new Map(), game: g };
    c.title = el("h2", { class: "s-card-title" });
    c.badges = el("div", { class: "s-row" });
    c.pickNote = el("span", { class: "s-small s-muted", role: "status" });
    c.clearBtn = ui.button("Clear", { size: "sm", tone: "ghost", title: "Untick every reward of this game", onClick: () => { c.groups.forEach((gp) => gp.table.clearSelection()); } });
    c.makeBtn = ui.button("Make a bundle from selected", { size: "sm", tone: "primary", icon: "plus", disabled: true, onClick: () => makeBundle(c) });
    c.groupsBox = el("div", { class: "s-stack" });
    c.node = el("section", { class: "s-card" },
      el("div", { class: "s-card-hd" }, el("div", { class: "s-grow s-stack is-tight" }, c.title, c.badges),
        el("div", { class: "s-row" }, c.pickNote, c.clearBtn, c.makeBtn)),
      el("div", { class: "s-card-bd" }, c.groupsBox));
    cards.set(key, c);
    return c;
  }
  function groupBlock(c, gr) {
    const key = gr.groupKey || gr.title || "?";
    let gp = c.groups.get(key);
    if (gp) return gp;
    gp = { key, head: el("div", { class: "s-spread" }) };
    gp.table = ui.table({ key: "key", select: true, columns: SLOT_COLUMNS, empty: "No rewards", onSelect: () => updatePick(c) });
    gp.node = el("div", { class: "s-stack is-tight" }, gp.head, gp.table);
    c.groups.set(key, gp);
    return gp;
  }
  function paintGame(c, x) {
    const g = x.g;
    c.game = g;
    c.title.textContent = gameLabel(g.gameNo, g.name);
    const tot = g.groups.reduce((a, gr) => gr.slots.reduce((b, sl) => addCounts(b, sl.counts), a), counts());
    fill(c.badges, ui.badge(fmt.num(tot.in_stock) + " in stock", tot.in_stock ? "ok" : null), ui.badge(fmt.num(tot.in_unit) + " in bundles", tot.in_unit ? "info" : null),
      ui.badge(fmt.num(tot.sold) + " sold"), tot.expiring ? ui.badge(fmt.num(tot.expiring) + " expiring", "warn") : null,
      tot.held ? ui.badge(fmt.num(tot.held) + " held", "warn") : null, tot.dead ? ui.badge(fmt.num(tot.dead) + " dead", "error") : null);
    c.slots = new Map();
    c.order = [];
    const keep = new Set();
    x.groups.forEach((y, i) => {
      const gp = groupBlock(c, y.gr);
      keep.add(gp.key); c.order.push(gp.key);
      y.gr.slots.forEach((sl) => c.slots.set(sl.key, { slot: sl, group: y.gr }));
      const gt = y.gr.slots.reduce((a, sl) => addCounts(a, sl.counts), counts()), end = ms(y.gr.endAt);
      fill(gp.head,
        el("div", { class: "s-grow s-stack is-tight" }, el("b", y.gr.title || "Campaign without a title"),
          el("span", { class: "s-small s-muted" }, [plural(y.gr.slots.length, "reward"),
            end == null ? "" : (end < Date.now() ? "Campaign ended " : "Campaign ends ") + dateOnly(y.gr.endAt)].filter(Boolean).join(" · "))),
        el("span", { class: "s-small s-muted" }, fmt.num(gt.in_stock) + " in stock · " + fmt.num(gt.in_unit) + " in bundles · " + fmt.num(gt.sold) + " sold"));
      gp.node.hidden = !y.slots.length;
      gp.table.update(y.slots);
      if (c.groupsBox.children[i] !== gp.node) c.groupsBox.insertBefore(gp.node, c.groupsBox.children[i] || null);
    });
    c.groups.forEach((gp, k) => { if (!keep.has(k)) { gp.node.remove(); gp.table.update([]); } });
    updatePick(c);
  }
  // Ticked rewards of one game, in the order shown (visible rows only).
  function picked(c) {
    const out = [];
    c.order.forEach((k) => { const gp = c.groups.get(k); if (gp && !gp.node.hidden) gp.table.selected().forEach((s) => out.push(s)); });
    return out;
  }
  function updatePick(c) {
    const n = picked(c).length;
    c.makeBtn.disabled = !n;
    c.clearBtn.hidden = !n;
    c.pickNote.textContent = n ? plural(n, "reward") + " ticked" : "Tick rewards to bundle them";
  }

  function makeBundle(c) {
    const picks = picked(c).map((k) => c.slots.get(k)).filter((p) => p && p.slot.slotKey);
    if (!picks.length) { Soop.toast("Tick at least one reward of this game first", "warn"); return null; }
    const game = gameLabel(c.game.gameNo, c.game.name);
    const name = el("input", { class: "s-input", maxlength: "120", placeholder: game + " bundle", dataset: { autofocus: "" } });
    return Soop.modal({
      title: "New bundle from " + plural(picks.length, "reward"),
      sticky: true,
      body: el("div", { class: "s-stack" },
        el("div", { class: "s-note" }, ui.icon("info"), el("span", "This makes a draft product of " + game + " on the Products page. Nothing goes on sale until you approve it there, and you can still rename the slots, change the texts and set the price first.")),
        el("ul", { class: "s-list" }, picks.map((p) => el("li", { class: "s-list-item" }, thumb(p.slot.image),
          el("div", { class: "s-grow s-stack is-tight" }, el("b", { class: "s-trunc" }, p.slot.label || "Unnamed reward"),
            el("span", { class: "s-small s-muted s-trunc" }, (p.group.title || "Campaign without a title") + " · " + fmt.num(p.slot.counts.in_stock) + " in stock"))))),
        el("label", { class: "s-field" }, "Bundle name (optional)", name, el("span", { class: "s-help" }, "Only shown in this panel. Left empty, the shop names it."))),
      actions: [{ label: "Cancel" }, { label: "Make draft bundle", tone: "primary", icon: "plus", onClick: () => createBundle(c, picks, name.value.trim()) }],
      onClose: (made) => { if (made && made.done) goSection("products", made.id ? { product: made.id } : {}); },
    });
  }
  function createBundle(c, picks, name) {
    const body = { slotKeys: picks.map((p) => p.slot.slotKey) };
    if (name) body.name = name;
    return S().api.post("/products", body).then((j) => {
      const p = (j && (j.product || j.draft)) || j || {}, shown = p.name || name;
      Soop.toast("Draft bundle " + (shown ? "“" + shown + "” " : "") + "made. Check it on Products, then approve it to sell.", "ok");
      c.groups.forEach((gp) => gp.table.clearSelection());
      refreshShop();
      loadStock();
      return { done: true, id: String(p.id || p._id || "") };
    });
  }

  function paintStamp() { if (stampLine) stampLine.textContent = updatedText(stockOkAt); }
  function paintStock() {
    if (!cardsBox) return;
    paintStamp();
    if (!stock) {
      cardsBox.hidden = true; msgBox.hidden = false;
      fill(msgBox, stockErr
        ? el("section", { class: "s-card" }, ui.empty("The stock could not be loaded", stockErr, { label: "Try again", icon: "refresh", onClick: loadStock }))
        : el("p", { class: "s-muted" }, "Loading the stock…"));
      heldCard.hidden = true;
      return;
    }
    let nowN = 0, allN = 0;
    stock.games.forEach((g) => g.groups.forEach((gr) => gr.slots.forEach((sl) => { allN++; if (holding(sl.counts)) nowN++; })));
    chips.setOptions([{ value: "now", label: "Holding codes", count: nowN }, { value: "all", label: "All rewards", count: allN }]);

    const shown = [];
    stock.games.forEach((g) => {
      const groups = g.groups.map((gr) => ({ gr, slots: gr.slots.filter((sl) => slotShown(g, gr, sl)) }));
      if (groups.some((y) => y.slots.length)) shown.push({ g, groups });
    });
    let msg = null;
    if (!stock.games.length) msg = ui.empty("No codes stored yet", "Codes the farm claims are added here on the shop's next run, every 5 minutes.");
    else if (!shown.length) {
      msg = ui.empty("No rewards match", show === "now" && !query ? "No reward holds a code right now. Pick “All rewards” to see sold and expired ones." : "Nothing fits this search and filter.",
        { label: "Clear filters", onClick: clearFilters });
    }
    msgBox.hidden = !msg;
    if (msg) fill(msgBox, el("section", { class: "s-card" }, msg));
    cardsBox.hidden = !shown.length;

    const keep = new Set();
    shown.forEach((x, i) => {
      const c = gameCard(x.g);
      keep.add(c.key);
      paintGame(c, x);
      if (cardsBox.children[i] !== c.node) cardsBox.insertBefore(c.node, cardsBox.children[i] || null);
    });
    // A game that is filtered out keeps its card (and its ticks) off the page.
    cards.forEach((c, k) => { if (!keep.has(k)) { c.node.remove(); c.groups.forEach((gp) => gp.table.update([])); } });

    heldCard.hidden = false;
    fill(heldBadge, ui.badge(stock.held.length ? plural(stock.held.length, "code") : "None", stock.held.length ? "warn" : null));
    heldTable.update(stock.held);
  }

  function renderStock(root, state) {
    cards.clear();
    stockSig = sigOf(state || S().state, STOCK_SIG);
    searchBox = ui.search({ placeholder: "Search rewards or campaigns", value: query, onInput: (q) => { query = q; paintStock(); } });
    chips = ui.chips({ options: [], value: show, onChange: (v) => { show = v; paintStock(); } });
    stampLine = el("span", { class: "s-small s-muted s-grow", role: "status" });
    msgBox = el("div", { hidden: true });
    cardsBox = el("div", { class: "s-stack" });
    heldBadge = el("span");
    heldTable = ui.table({ key: "key", flush: true, maxHeight: "40vh", empty: "No code is held",
      columns: [{ label: "Login", render: (h) => loginLink(h.loginId) },
        { label: "Reward", render: (h) => el("span", { class: "s-trunc", title: h.label }, h.label || "–") },
        { label: "Why it is held", wrap: true, render: (h) => h.problem || el("span", { class: "s-muted" }, "No reason recorded") },
        { label: "", align: "right", render: releaseCell }] });
    root.append(el("div", { class: "s-stack" },
      el("div", { class: "s-toolbar" }, searchBox, chips, stampLine,
        ui.button("", { icon: "refresh", tone: "ghost", title: "Reload the stock", onClick: loadStock })),
      el("p", { class: "s-small s-muted", style: { margin: "0" } }, "Every stored code by game, campaign and reward. Tick rewards of one game and make a bundle from them: that makes a draft on the Products page, and nothing goes on sale until you approve it."),
      msgBox, cardsBox,
      (heldCard = el("section", { class: "s-card", hidden: true },
        el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Held for checking"), heldBadge),
        el("div", { class: "s-card-bd s-small s-muted" }, "Codes kept off sale because they could not be sold safely: released from a GGSel vault, a unit that went missing, a duplicate code, or a code shown in the farm panel. They are never put back on sale by themselves. "
          + "Release puts one back in free stock: use it only when you are sure the code was never given to anyone. The shop checks the code again first and keeps it held if it cannot release it."),
        heldTable))));
    paintStock();
    loadStock();
  }
  function updateStock(root, state) {
    paintStamp();
    const sig = sigOf(state || S().state, STOCK_SIG);
    if (sig !== stockSig || Date.now() - stockAt > STALE_MS) { stockSig = sig; loadStock(); }
  }

  // =================================================================================
  // Logins
  // =================================================================================
  const LOGIN_SIG = ["inStock", "onSale", "sold", "revenue"];
  const LOGIN_COLS = [
    { key: "loginId", label: "Login", type: "text" },
    { key: "codes", label: "Codes" },
    { key: "inStock", label: "In stock" },
    { key: "onSale", label: "On sale" },
    { key: "sold", label: "Sold" },
    { key: "usd", label: "Sales" },
    { key: "lastEarnedAt", label: "Last earned", type: "date" },
  ];
  let logins = null, loginErr = "", loginBusy = null, loginAt = 0, loginOkAt = 0, loginSig = "", loginQuery = "";
  let sortKey = "codes", sortDir = -1;
  let loginTable, loginMsg, loginFoot, loginStamp;
  const heads = {};                   // sort key -> { button, arrow }

  function normLogins(j) {
    const src = j && (j.logins || j.rows || j.items || j.data);
    return list(src || j).map((r) => ({
      loginId: String(r.loginId || r.login || r.id || r._k || ""), codes: num(r.codes), inStock: num(r.inStock), onSale: num(r.onSale),
      sold: num(r.sold), usd: num(r.usd), lastEarnedAt: r.lastEarnedAt || null,
    })).filter((r) => r.loginId);
  }
  function loadLogins() {
    if (loginBusy) return loginBusy;
    loginBusy = Promise.resolve().then(() => S().api.get("/logins")).then(
      (j) => { logins = normLogins(j); loginErr = ""; loginOkAt = Date.now(); },
      (e) => { loginErr = (e && e.message) || "Unknown error"; if (logins) Soop.toast("The logins could not be refreshed: " + loginErr, "error"); },
    ).then(() => { loginBusy = null; loginAt = Date.now(); paintLogins(); });
    return loginBusy;
  }
  function sortHead(col) {
    const arrow = el("span", { "aria-hidden": "true" });
    const button = el("button", { type: "button", class: "s-btn is-ghost is-sm", title: "Sort by " + col.label.toLowerCase(), onClick: () => {
      if (sortKey === col.key) sortDir = -sortDir;
      else { sortKey = col.key; sortDir = col.type === "text" ? 1 : -1; }
      paintLogins();
    } }, col.label, arrow);
    heads[col.key] = { button, arrow };
    return button;
  }
  function paintHeads() {
    Object.keys(heads).forEach((k) => {
      const h = heads[k], on = k === sortKey, th = h.button.closest("th");
      h.arrow.textContent = on ? (sortDir > 0 ? " ▲" : " ▼") : "";
      if (th) th.setAttribute("aria-sort", on ? (sortDir > 0 ? "ascending" : "descending") : "none");
    });
  }
  function sorted(rows) {
    const col = LOGIN_COLS.filter((c) => c.key === sortKey)[0] || LOGIN_COLS[1];
    const val = (r) => (col.type === "text" ? who(r.loginId).toLowerCase() : col.type === "date" ? ms(r[col.key]) : num(r[col.key]));
    return rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return a.loginId < b.loginId ? -1 : a.loginId > b.loginId ? 1 : 0;
      if (x == null) return 1;            // no date sorts last, either direction
      if (y == null) return -1;
      return (x < y ? -1 : 1) * sortDir;
    });
  }
  function paintLogins() {
    if (!loginTable) return;
    loginStamp.textContent = updatedText(loginOkAt);
    paintHeads();
    if (!logins) {
      loginTable.hidden = true; loginFoot.hidden = true; loginMsg.hidden = false;
      fill(loginMsg, loginErr
        ? el("section", { class: "s-card" }, ui.empty("The logins could not be loaded", loginErr, { label: "Try again", icon: "refresh", onClick: loadLogins }))
        : el("p", { class: "s-muted" }, "Loading the logins…"));
      return;
    }
    if (!logins.length) {
      loginTable.hidden = true; loginFoot.hidden = true; loginMsg.hidden = false;
      fill(loginMsg, el("section", { class: "s-card" }, ui.empty("No login has earned a code yet", "A login shows up here once the shop has stored a code it earned.")));
      return;
    }
    loginMsg.hidden = true; loginTable.hidden = false; loginFoot.hidden = false;
    const q = loginQuery.toLowerCase(), rows = q ? logins.filter((r) => who(r.loginId).toLowerCase().includes(q)) : logins;
    loginTable.update(sorted(rows));
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    loginFoot.textContent = (q ? fmt.num(rows.length) + " of " : "") + plural(logins.length, "login") + " · " + plural(sum("codes"), "code") +
      " · " + fmt.num(sum("sold")) + " sold · " + usd(sum("usd")) + " in sales";
  }
  function renderLogins(root, state) {
    loginSig = sigOf(state || S().state, LOGIN_SIG);
    Object.keys(heads).forEach((k) => { delete heads[k]; });
    const cell = (k, tone) => (r) => count(r[k], tone);
    loginTable = ui.table({ key: "loginId", empty: "No login matches",
      columns: [
        { label: sortHead(LOGIN_COLS[0]), grow: true, render: (r) => loginLink(r.loginId) },
        { label: sortHead(LOGIN_COLS[1]), align: "right", render: cell("codes") },
        { label: sortHead(LOGIN_COLS[2]), align: "right", render: cell("inStock", "ok") },
        { label: sortHead(LOGIN_COLS[3]), align: "right", hide: "sm", render: cell("onSale") },
        { label: sortHead(LOGIN_COLS[4]), align: "right", render: cell("sold") },
        { label: sortHead(LOGIN_COLS[5]), align: "right", render: (r) => el("span", { class: "s-num" + (r.usd ? "" : " s-muted") }, usd(r.usd)) },
        { label: sortHead(LOGIN_COLS[6]), render: (r) => (r.lastEarnedAt ? el("span", { title: fmt.ago(r.lastEarnedAt) }, when(r.lastEarnedAt)) : el("span", { class: "s-muted" }, "Never")) },
      ] });
    loginMsg = el("div", { hidden: true });
    loginFoot = el("p", { class: "s-small s-muted", style: { margin: "0" } });
    loginStamp = el("span", { class: "s-small s-muted s-grow", role: "status" });
    root.append(el("div", { class: "s-stack" },
      el("div", { class: "s-toolbar" }, ui.search({ placeholder: "Search logins", value: loginQuery, onInput: (q) => { loginQuery = q; paintLogins(); } }), loginStamp,
        ui.button("", { icon: "refresh", tone: "ghost", title: "Reload the logins", onClick: loadLogins })),
      el("p", { class: "s-small s-muted", style: { margin: "0" } }, "What each farm login has earned for the shop: codes stored, still free, on sale and sold, and the sales they brought in. Click a column to sort."),
      loginMsg, loginTable, loginFoot));
    paintLogins();
    loadLogins();
  }
  function updateLogins(root, state) {
    if (loginStamp) loginStamp.textContent = updatedText(loginOkAt);
    const sig = sigOf(state || S().state, LOGIN_SIG);
    if (sig !== loginSig || Date.now() - loginAt > STALE_MS) { loginSig = sig; loadLogins(); }
  }

  // ---------- registration -------------------------------------------------------------
  function boot() {
    const s = window.SoopSales;
    if (!s || typeof s.registerSection !== "function") return false;
    s.registerSection({ id: "stock", label: "Stock", render: renderStock, update: updateStock });
    s.registerSection({ id: "logins", label: "Logins", render: renderLogins, update: updateLogins });
    return true;
  }
  if (!boot()) {
    const retry = () => { if (!boot()) console.error("sales-stock: window.SoopSales is missing; load tab-sales.js before this file"); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", retry, { once: true });
    else setTimeout(retry, 0);
  }
})();
