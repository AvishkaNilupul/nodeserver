/* SOOP farm — Sales tab: the "Sold" section (docs/code-shop/04-OPS.md, afterSale.js).
   One row per sold bundle, newest first, with each code's label, shape and
   after-sale state. A code a buyer says does not work can be marked dead (or OK
   again), and the buyer can be given a replacement: the server takes a fresh code
   of the same reward from stock, marks it sold and returns it once. That code
   exists only as the text of one node inside a modal; it is wiped when the modal
   closes and is never stored, logged or kept anywhere else. Every other view here
   shows codes by shape only. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const LIMIT = 200, STALE_MS = 120000;
  const SIG_KEYS = ["sold", "dead", "revenue"];
  const MARKETS = { eldorado: "Eldorado", ggsel: "GGSel", replacement: "Replacement" };
  const STATE = { sold: { label: "Sold", tone: null }, dead: { label: "Dead", tone: "error" } };
  const AFTER = {
    ok: { label: "Marked OK", tone: "ok" },
    dead: { label: "Reported dead", tone: "error" },
    replaced: { label: "Replaced", tone: "warn" },
    replacement: { label: "Replacement", tone: "info" },
  };
  const S = () => window.SoopSales || {};

  let rows = null, err = "", busy = null, loadedAt = 0, okAt = 0, sig = "";
  let product = "", query = "", prodSig = "", layers = 0, dirty = false;
  let table, select, msgBox, foot, stamp;

  // ---------- helpers -----------------------------------------------------------------
  function fill(node, ...kids) {
    node.textContent = "";
    kids.flat(3).forEach((k) => { if (k != null && k !== false && k !== true) node.append(k); });
    return node;
  }
  const plural = (n, one, many) => fmt.num(n) + " " + (Number(n) === 1 ? one : many || one + "s");
  const when = (d) => (typeof S().when === "function" ? S().when(d) : fmt.when(d));
  const usd = (n) => (typeof S().usd === "function" ? S().usd(n) : "$" + (Number(n) || 0).toFixed(2));
  const quote = (s) => "“" + s + "”";
  function updatedText(t) {
    if (!t) return "";
    const m = Math.floor((Date.now() - t) / 60000);
    return "Updated " + (m < 1 ? "just now" : m + " min ago");
  }
  function sigOf(state) {
    const s = state && state.summary;
    return s ? SIG_KEYS.map((k) => (k === "revenue" ? JSON.stringify(s.revenue || null) : s[k])).join("|") : "";
  }
  function refreshShop() {
    if (typeof S().refresh === "function") Promise.resolve().then(() => S().refresh()).catch(() => null);
  }
  function confirmAction(msg, okLabel) {
    if (typeof S().confirmAction === "function") return Promise.resolve(S().confirmAction(msg));
    return Soop.confirm({ title: "Are you sure?", body: msg, okLabel });
  }
  // One of our dialogs is open: a reload would rebuild the row it came from, so
  // reloads wait until it closes.
  function opened() { layers++; }
  function closed() {
    layers = Math.max(0, layers - 1);
    if (!layers && dirty) { dirty = false; load(); }
  }

  // ---------- data -----------------------------------------------------------------------
  function normSold(j) {
    const src = Array.isArray(j) ? j : j && (j.sold || j.items || j.rows || j.units);
    const seen = new Set();
    return (Array.isArray(src) ? src : []).filter((r) => r && typeof r === "object").map((r, i) => {
      const p = r.product && typeof r.product === "object" ? r.product : null;
      const unitId = String(r.unitId || r.unit || r.id || r._id || "");
      let key = unitId || "row" + i;
      if (seen.has(key)) key += "#" + i;
      seen.add(key);
      return {
        key, unitId,
        productId: String((p ? p.id || p._id : r.product || r.productId) || ""),
        productName: String(r.productName || (p && p.name) || ""),
        market: String(r.market || ""), orderId: String(r.orderId || ""), soldAt: r.soldAt || null,
        usd: Number(r.usd != null ? r.usd : r.saleUsd) || 0,
        codes: (Array.isArray(r.codes) ? r.codes : []).filter((c) => c && typeof c === "object").map((c, k) => ({
          slot: c.slot != null && c.slot !== "" && isFinite(Number(c.slot)) ? Number(c.slot) : k,
          label: String(c.label || c.name || ""), codeShape: String(c.codeShape || ""), state: String(c.state || ""),
          after: typeof c.after === "string" ? { status: c.after } : c.after && typeof c.after === "object" ? c.after : { status: "" },
        })),
      };
    });
  }
  function load() {
    if (layers) { dirty = true; return Promise.resolve(); }
    if (busy) return busy;
    const want = product;
    busy = Promise.resolve().then(() => S().api.get("/sold?limit=" + LIMIT + (want ? "&product=" + encodeURIComponent(want) : ""))).then(
      (j) => { if (want === product) { rows = normSold(j); err = ""; okAt = Date.now(); } },
      (e) => { err = (e && e.message) || "Unknown error"; if (rows) Soop.toast("Sold bundles could not be refreshed: " + err, "error"); },
    ).then(() => {
      busy = null; loadedAt = Date.now();
      if (want !== product) return load();        // the filter changed while this was loading
      paint();
      return null;
    });
    return busy;
  }

  // ---------- after-sale actions ------------------------------------------------------------
  function codeName(c) { return c.label || "Code " + (c.slot + 1); }
  function report(r, c, status) {
    const dead = status === "dead";
    const note = el("textarea", { class: "s-textarea", rows: "3", maxlength: "500", style: { minHeight: "72px", fontFamily: "inherit" },
      placeholder: dead ? "e.g. the buyer says it was already used" : "e.g. the buyer redeemed it after all" });
    opened();
    Soop.modal({
      title: dead ? "Mark this code dead?" : "Mark this code OK?",
      size: "sm", sticky: true,
      body: el("div", { class: "s-stack" },
        el("p", { style: { margin: "0" } }, dead
          ? quote(codeName(c)) + " from order " + (r.orderId || "–") + " is recorded as not working. A dead code never goes back on sale. You can still give the buyer a replacement."
          : quote(codeName(c)) + " from order " + (r.orderId || "–") + " is recorded as working again."),
        el("label", { class: "s-field" }, "Note (optional)", note, el("span", { class: "s-help" }, "Kept with the code for your records. Buyers never see it."))),
      actions: [{ label: "Cancel" }, { label: dead ? "Mark dead" : "Mark OK", tone: dead ? "danger" : "primary", icon: dead ? "x" : "check", onClick: () =>
        S().api.post("/units/" + encodeURIComponent(r.unitId) + "/report", { slot: c.slot, status, note: note.value.trim() }).then(() => {
          Soop.toast(quote(codeName(c)) + (dead ? " marked dead" : " marked OK"), "ok");
          dirty = true;
          refreshShop();
        }) }],
      onClose: closed,
    });
    return null;
  }
  function replace(r, c) {
    const msg = "Give the buyer of order " + (r.orderId || "–") + " a replacement for " + quote(codeName(c)) + "? A fresh code of the same reward is taken from stock and marked sold at once. It is shown to you one time only.";
    return confirmAction(msg, "Get replacement code").then((yes) => {
      if (!yes) return null;
      return S().api.post("/units/" + encodeURIComponent(r.unitId) + "/replace", { slot: c.slot }).then((j) => {
        dirty = true;
        refreshShop();
        showOnce(j, codeName(c));
      });
    });
  }
  // The one place a code is shown. The reply's copy is dropped at once; the node's
  // text is wiped when the modal closes, however it closes.
  function showOnce(j, fallbackLabel) {
    const box = (j && (j.replacement || j.result)) || j || {};
    let code = typeof box.code === "string" ? box.code.trim() : "";
    const label = String(box.label || fallbackLabel), shape = String(box.codeShape || "");
    if (j && typeof j === "object") j.code = "";
    box.code = "";
    if (!code) {
      Soop.toast("No code came back from the server. Reload this list and look at the order before you try again.", "error");
      if (!layers) { dirty = false; load(); }
      return;
    }
    const field = el("span", { class: "s-code", role: "textbox", "aria-readonly": "true", "aria-label": "Replacement code for " + label, tabindex: "0" }, code);
    code = "";
    const copy = ui.button("Copy", { tone: "primary", icon: "copy", onClick: () => copyFrom(field) });
    copy.setAttribute("data-autofocus", "");
    opened();
    Soop.modal({
      title: "Replacement code",
      sticky: true,
      body: el("div", { class: "s-stack" },
        el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", "This code is now marked sold. It is shown this one time only: copy it and send it to the buyer before you close this window. Closing it wipes the code from the page.")),
        el("dl", { class: "s-kv" }, el("dt", "Reward"), el("dd", label), shape ? [el("dt", "Shape"), el("dd", { class: "s-mono" }, shape)] : null),
        el("div", { class: "s-row" }, field, copy)),
      actions: [{ label: "Close" }],
      onClose: () => { field.textContent = ""; closed(); },
    });
  }
  function copyFrom(field) {
    const byHand = () => Soop.toast("Could not copy. Click the code to select it, then copy it by hand", "warn");
    if (!field.textContent) return null;
    if (!navigator.clipboard || !navigator.clipboard.writeText) return byHand();
    return navigator.clipboard.writeText(field.textContent).then(() => Soop.toast("Code copied", "ok"), byHand);
  }

  // ---------- painting ---------------------------------------------------------------------
  function afterTitle(a) {
    return [a.by ? "by " + a.by : "", a.at ? when(a.at) : ""].filter(Boolean).join(", ") || null;
  }
  function codeLine(r, c) {
    const st = STATE[c.state] || { label: c.state || "Unknown", tone: "warn" };
    const a = c.after || {}, af = a.status && a.status !== c.state ? AFTER[a.status] : null;
    const canAct = !!r.unitId && (c.state === "sold" || c.state === "dead");
    const replaced = a.status === "replaced";
    return el("div", { class: "s-row" },
      el("b", codeName(c)),
      c.codeShape ? el("span", { class: "s-mono s-small s-muted", title: "Length and dash groups of the code. The code itself is not shown here." }, c.codeShape) : null,
      ui.badge(st.label, st.tone),
      af ? el("span", { title: afterTitle(a) }, ui.badge(af.label, af.tone)) : null,
      a.note ? el("span", { class: "s-small s-muted s-trunc", title: a.note, style: { maxWidth: "240px" } }, quote(a.note)) : null,
      canAct ? (c.state === "dead"
        ? ui.button("Mark OK", { size: "sm", icon: "check", title: "Record that this code works after all", onClick: () => report(r, c, "ok") })
        : ui.button("Mark dead", { size: "sm", icon: "x", title: "Record that this code does not work", onClick: () => report(r, c, "dead") })) : null,
      canAct ? ui.button("Get replacement code", { size: "sm", icon: "gift", disabled: replaced,
        title: replaced ? "A replacement was already given for this code" : "Take a fresh code of the same reward from stock for this buyer",
        onClick: () => replace(r, c) }) : null);
  }
  const COLUMNS = [
    { label: "Sold", render: (r) => (r.soldAt ? el("span", { title: fmt.ago(r.soldAt) }, when(r.soldAt)) : el("span", { class: "s-muted" }, "–")) },
    { label: "Product", render: (r) => el("span", { class: "s-trunc", title: r.productName || null }, r.productName || "Unnamed product") },
    { label: "Market", render: (r) => ui.badge(MARKETS[r.market] || r.market || "–", r.market === "replacement" ? "info" : null) },
    { label: "Order", render: (r) => (r.orderId ? el("span", { class: "s-mono s-small", title: r.orderId }, r.orderId) : el("span", { class: "s-muted" }, "–")) },
    { label: "USD", align: "right", render: (r) => el("span", { class: "s-num" }, usd(r.usd)) },
    { label: "Codes", wrap: true, render: (r) => (r.codes.length
      ? el("div", { class: "s-stack is-tight" }, r.codes.map((c) => codeLine(r, c)))
      : el("span", { class: "s-muted" }, "No codes recorded")) },
  ];
  function haystack(r) {
    return [r.orderId, r.productName, MARKETS[r.market] || r.market].concat(r.codes.map((c) => c.label)).join(" ").toLowerCase();
  }
  function paint() {
    if (!table) return;
    stamp.textContent = updatedText(okAt);
    let msg = null;
    if (!rows) {
      msg = err ? el("section", { class: "s-card" }, ui.empty("Sold bundles could not be loaded", err, { label: "Try again", icon: "refresh", onClick: load }))
        : el("p", { class: "s-muted" }, "Loading sold bundles…");
    } else if (!rows.length) {
      msg = el("section", { class: "s-card" }, ui.empty(product ? "Nothing sold from this product yet" : "Nothing sold yet", "A bundle shows up here as soon as a market reports its sale."));
    }
    msgBox.hidden = !msg; table.hidden = !!msg; foot.hidden = !!msg;
    if (msg) { fill(msgBox, msg); return; }
    const q = query.toLowerCase(), shown = q ? rows.filter((r) => haystack(r).includes(q)) : rows;
    table.update(shown);
    const dead = shown.reduce((n, r) => n + r.codes.filter((c) => c.state === "dead").length, 0);
    foot.textContent = (q ? fmt.num(shown.length) + " of " : "") + plural(rows.length, "sold bundle") + " · " + usd(shown.reduce((n, r) => n + r.usd, 0)) +
      (dead ? " · " + plural(dead, "code") + " dead" : "") + (rows.length >= LIMIT ? " · only the newest " + LIMIT + " are listed" : "");
  }
  // The filter lists the shop's products; rebuilt only when that list changes and never while it is in use.
  function syncProducts(state) {
    if (!select || document.activeElement === select) return;
    const products = list((state && state.products) || []);
    const s = products.map((p) => p.id + ":" + p.name + ":" + p.status).join("|") + "|" + product;
    if (s === prodSig) return;
    prodSig = s;
    fill(select, el("option", { value: "" }, "All products"), products.map((p) =>
      el("option", { value: String(p.id) }, (p.name || "Unnamed product") + (p.status && p.status !== "active" ? " (" + p.status + ")" : ""))),
    product && !products.some((p) => String(p.id) === product) ? el("option", { value: product }, "A product no longer listed") : null);
    select.value = product;
  }
  function list(v) { return Array.isArray(v) ? v.filter((p) => p && p.id != null) : []; }

  // ---------- section --------------------------------------------------------------------
  function render(root, state) {
    state = state || S().state;
    sig = sigOf(state); prodSig = "";
    select = el("select", { class: "s-select", "aria-label": "Show the sales of one product", style: { width: "auto", maxWidth: "280px" },
      onChange: () => { product = select.value; rows = null; err = ""; paint(); load(); } });
    stamp = el("span", { class: "s-small s-muted s-grow", role: "status" });
    msgBox = el("div", { hidden: true });
    foot = el("p", { class: "s-small s-muted", style: { margin: "0" } });
    table = ui.table({ key: "key", columns: COLUMNS, empty: "No sold bundle matches this search" });
    root.append(el("div", { class: "s-stack" },
      el("div", { class: "s-toolbar" }, select,
        ui.search({ placeholder: "Search order, product or reward", value: query, onInput: (q) => { query = q; paint(); } }), stamp,
        ui.button("", { icon: "refresh", tone: "ghost", title: "Reload sold bundles", onClick: load })),
      el("p", { class: "s-small s-muted", style: { margin: "0" } }, "The newest " + LIMIT + " sold bundles. When a buyer says a code does not work, mark it dead and give them a replacement from stock. Codes are never shown here, except a replacement, once, when you ask for it."),
      msgBox, table, foot));
    syncProducts(state);
    paint();
    load();
  }
  function update(root, state) {
    state = state || S().state;
    syncProducts(state);
    if (stamp) stamp.textContent = updatedText(okAt);
    const s = sigOf(state);
    if (s !== sig || Date.now() - loadedAt > STALE_MS) { sig = s; load(); }
  }

  function boot() {
    const s = window.SoopSales;
    if (!s || typeof s.registerSection !== "function") return false;
    s.registerSection({ id: "sold", label: "Sold", render, update });
    return true;
  }
  if (!boot()) {
    const retry = () => { if (!boot()) console.error("sales-sold: window.SoopSales is missing; load tab-sales.js before this file"); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", retry, { once: true });
    else setTimeout(retry, 0);
  }
})();
