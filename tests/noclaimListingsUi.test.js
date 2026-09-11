// No-claim Shop listings — the Listings page (public/listings.html), contract
// docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §10.
//
// Two things are pinned here:
//
//   1. The no-claim source. The Shop tab's picker can build a listing from the
//      no-claim farm instead of the Drop Archive. A no-claim set has no Shop
//      state, only sells on the markets the no-claim layer can deliver on, and
//      every sale hands over one farm account — so its row has no
//      Publish/Unlist and no Account-listing copy, and the publish modal locks
//      delivery to automatic and refuses the other markets.
//   2. The phone layout. On the owner's iPhone an Existing-listings row's title
//      wrapped one word per line, the price overlapped and the buttons ran off
//      the screen: body is a flex row, so .page and the 1fr grid tracks kept a
//      min-content minimum set by the row buttons (flex-shrink:0) and the
//      pickers' nowrap names. The fix is CSS only, inside a 720px media query,
//      and must never be body{overflow-x:hidden}.
//
// The page is inline browser JS with no module boundary, so — like
// tests/publishPickerReset.test.js — the behavioural checks lift the exact
// source slices out of the page and run them against a stub DOM.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "listings.html");
const html = fs.readFileSync(PAGE, "utf8");

function slice(startMarker, endMarker) {
  const from = html.indexOf(startMarker);
  const to = html.indexOf(endMarker, from + 1);
  assert.ok(
    from >= 0 && to > from,
    "listings.html still contains " + JSON.stringify(startMarker),
  );
  return html.slice(from, to);
}

// The body of the first `@media (<query>) {` block, by brace matching.
function mediaBlock(query) {
  const head = "@media (" + query + ") {";
  const at = html.indexOf(head);
  assert.ok(at >= 0, "page has " + head);
  let depth = 0;
  for (let i = at + head.length - 1; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(at + head.length, i);
    }
  }
  throw new Error("unterminated " + head);
}

// One rule's declarations inside a CSS chunk: `selector { ... }`.
function rule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp("(?:^|[}\\s])" + esc + "\\s*\\{([^}]*)\\}"));
  assert.ok(m, "rule " + selector + " exists");
  return m[1].replace(/\s+/g, " ");
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

// A stub DOM: every id is an element with the few properties the slices touch.
function makeDom() {
  const els = {};
  const $ = (id) => {
    if (!els[id])
      els[id] = {
        id,
        value: "",
        checked: false,
        disabled: false,
        textContent: "",
        innerText: "",
        innerHTML: "",
        style: { display: "" },
        cls: new Set(),
        classList: {
          add(c) {
            els[id].cls.add(c);
          },
          remove(c) {
            els[id].cls.delete(c);
          },
          toggle(c, on) {
            if (on) els[id].cls.add(c);
            else els[id].cls.delete(c);
          },
        },
        focus() {},
      };
    return els[id];
  };
  return { $, els };
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Static: the markup and the endpoints
// ---------------------------------------------------------------------------

test("the picker has the [Drop archive] [No-claim farm] switch", () => {
  const head = slice('<div class="pick-head">', '<div class="pickbar">');
  assert.match(head, /<h2>Pick items<\/h2>/);
  assert.match(head, /id="srcArchive"[\s\S]*Drop archive/);
  assert.match(head, /id="srcNoclaim"[\s\S]*No-claim farm/);
  // The choice is remembered per browser, and storage can throw (private
  // mode) — both the read and the write sit in a try.
  assert.match(
    html,
    /try \{\s*if \(localStorage\.getItem\("listingsPickSource"\) === "noclaim"\)/,
  );
  assert.match(html, /try \{\s*localStorage\.setItem\("listingsPickSource", src\);/);
});

test("the no-claim strip, hint and form badge are in the page", () => {
  for (const id of ["ncStrip", "ncSnapText", "ncRefreshBtn", "fSrcBadge", "mpNoclaimNote"])
    assert.ok(html.includes('id="' + id + '"'), "#" + id + " exists");
  assert.match(html, /Accounts already on auto-lister listings are never used\./);
  assert.match(
    html,
    /Every\s+sale re-checks the account live before it is handed over\./,
  );
  assert.match(html, /id="fSrcBadge"[^>]*>\s*No-claim farm/);
  assert.match(html, /data-lso="noclaim">No-claim</);
});

test("every §9 endpoint the page needs is called", () => {
  for (const ep of [
    '"/noclaim-stock/games"',
    '"/noclaim-stock/items"',
    '"/noclaim-stock/summary"',
    '"/noclaim-stock/refresh"',
    '"/noclaim-stock/copy"',
    '"/noclaim-stock/sets"',
  ])
    assert.ok(html.includes(ep), "calls " + ep);
  // The per-set stock (rows + modal note) and the edit.
  assert.match(html, /"\/noclaim-stock\/sets\/" \+ set\.id \+ "\/stock"/);
  assert.match(html, /"\/noclaim-stock\/sets\/" \+ encodeURIComponent\(set\.id\) \+ "\/stock"/);
  assert.match(html, /"\/noclaim-stock\/sets\/" \+ encodeURIComponent\(editId\)/);
});

test("no native datalist anywhere (iOS never opens one)", () => {
  assert.ok(!/<datalist\b/i.test(html), "no <datalist> element");
  assert.ok(!/\slist="/i.test(html), "no input list= attribute");
});

test("no overflow-x hack on the page", () => {
  // Real CSS only: the page's comments may well name the hack they avoid.
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ""))
    .join("\n");
  const inline = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]).join("\n");
  assert.ok(css.length > 1000, "found the page's stylesheets");
  for (const [where, text] of [
    ["<style>", css],
    ["style=", inline],
  ])
    assert.ok(
      !/overflow-x\s*:\s*(hidden|clip)/i.test(text),
      where + ": overflow-x:hidden/clip hides the bug instead of fixing the widths",
    );
  assert.ok(!/overflowX\s*=\s*["'](hidden|clip)/.test(html), "no script-set overflowX");
  // Nor the shorthand on html/body.
  const rootRules = css.match(/(^|[\s,}])(html|body)\s*\{[^}]*\}/g) || [];
  assert.ok(rootRules.length > 0, "found the body rule");
  for (const r of rootRules) assert.ok(!/overflow/.test(r), "no overflow on " + r);
});

// ---------------------------------------------------------------------------
// Static: the phone layout
// ---------------------------------------------------------------------------

test("mobile: a 720px block fixes the widths instead of hiding them", () => {
  const css = mediaBlock("max-width: 720px");
  assert.match(rule(css, ".page"), /padding: 14px 12px 60px;/);
  assert.match(rule(css, ".page"), /min-width: 0;/);
  assert.match(rule(css, ".grid"), /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(rule(css, ".card"), /padding: 14px;/);
  assert.match(rule(css, ".tabbar"), /flex-wrap: wrap;/);
  assert.match(rule(css, ".tabbar .tbtn"), /flex: 1 1 auto;/);
  assert.match(rule(css, ".pickbar"), /flex-wrap: wrap;/);
  assert.match(rule(css, ".pickbar select"), /flex: 1 1 100%;/);
  assert.match(rule(css, '.list-toolbar input[type="search"]'), /flex: 1 1 100%;/);
  assert.match(rule(css, '.list-toolbar input[type="search"]'), /max-width: none;/);
});

test("mobile: a listing row is a two-row card", () => {
  const css = mediaBlock("max-width: 720px");
  assert.match(rule(css, ".listing"), /flex-wrap: wrap;/);
  const info = rule(css, ".listing .info");
  assert.match(info, /flex: 1 1 0;/);
  assert.match(info, /min-width: 0;/);
  // Description clamps to two lines instead of one nowrap line.
  const d = rule(css, ".listing .info .d");
  assert.match(d, /-webkit-line-clamp: 2;/);
  assert.match(d, /white-space: normal;/);
  assert.match(rule(css, ".listing .price"), /margin-left: auto;/);
  const ops = rule(css, ".listing .ops");
  assert.match(ops, /flex: 1 1 100%;/, "buttons take row 2 at full width");
  assert.match(ops, /flex-wrap: wrap;/);
  assert.match(rule(css, ".listing .ops .btn"), /flex: 1 1 auto;/);
});

test("mobile: the desktop rules are untouched", () => {
  // The base (desktop) .listing / .ops rules are exactly what they were.
  const base = html.slice(0, html.indexOf("@media (max-width: 720px)"));
  assert.match(base, /\.listing \{\s*display: flex;\s*align-items: center;\s*gap: 13px;/);
  assert.match(base, /\.listing \.ops \{\s*display: flex;\s*gap: 7px;\s*flex-shrink: 0;\s*\}/);
  assert.match(base, /\.page \{\s*flex: 1;\s*padding: 26px 30px 60px;/);
  // The only .listing wrap rule lives inside the phone query.
  assert.ok(!/\.listing \{[^}]*flex-wrap/.test(base));
});

// ---------------------------------------------------------------------------
// Behaviour: the pure helpers
// ---------------------------------------------------------------------------

const HELPERS = slice(
  "      // ---- no-claim farm source: pure helpers ----",
  "      // ---- state ----",
);
function loadHelpers() {
  return new Function(
    HELPERS +
      "\nreturn { isNoclaimSet, NC_MARKETS, ncStockOf, ncStockText, ncPickSubline, ncAgo, ncSnapText, ncItemsSig };",
  )();
}

test("helpers: only stockSource 'noclaim' is a no-claim set", () => {
  const h = loadHelpers();
  assert.equal(h.isNoclaimSet({ stockSource: "noclaim" }), true);
  assert.equal(h.isNoclaimSet({ stockSource: "" }), false);
  assert.equal(h.isNoclaimSet({}), false);
  assert.equal(h.isNoclaimSet(null), false);
});

test("helpers: the no-claim markets are exactly the six the layer delivers on", () => {
  const h = loadHelpers();
  assert.deepEqual(
    [...h.NC_MARKETS].sort(),
    ["digiseller", "eldorado", "g2g", "gameflip", "ggsel", "playerauctions"],
  );
});

test("helpers: stock reads the route's top-level fields", () => {
  const h = loadHelpers();
  // routes/noclaimStockRoutes.js answers { success, ...stockForSet(set) }.
  const st = h.ncStockOf({ success: true, free: 38, stale: 3, onAuto: 83, onManual: 1, covering: 125 });
  assert.deepEqual(st, { free: 38, stale: 3, onAuto: 83, onManual: 1 });
  assert.equal(
    h.ncStockText(st),
    "38 free in no-claim farm · 3 unverified · 83 on auto-list",
  );
  assert.equal(h.ncStockText({ free: 0, stale: 0, onAuto: 0 }), "0 free in no-claim farm");
  assert.equal(h.ncStockText(null), "", "not loaded yet reads as nothing");
  assert.deepEqual(h.ncStockOf({}), { free: 0, stale: 0, onAuto: 0, onManual: 0 });
});

test("helpers: the picker sub-line names free, auto-listed and unverified", () => {
  const h = loadHelpers();
  assert.equal(
    h.ncPickSubline({ game: "Rainbow Six Siege", accounts: 41, onAuto: 83, stale: 12 }),
    "Rainbow Six Siege · 41 free · 83 on auto-list · 12 unverified",
  );
  assert.equal(h.ncPickSubline({ game: "Overwatch", accounts: 1 }), "Overwatch · 1 free");
  assert.equal(h.ncPickSubline({ game: "" }), "Other rewards · 0 free");
});

test("helpers: the snapshot line reads summary() at the top level", () => {
  const h = loadHelpers();
  const at = new Date(Date.now() - 14 * 60e3).toISOString();
  assert.equal(
    h.ncSnapText({ accounts: 806, read: 612, newestReadAt: at, sweeping: false }),
    "Snapshot: 612 of 806 accounts read · updated 14 min ago",
  );
  // lastSweep is { at, reason, ... } when nothing has a readAt yet.
  assert.equal(
    h.ncSnapText({ accounts: 1, read: 1, lastSweep: { at: new Date().toISOString() } }),
    "Snapshot: 1 account read · updated just now",
  );
  assert.match(h.ncSnapText({ read: 3, sweeping: true }), /reading the farm…$/);
  assert.equal(h.ncSnapText(null), "Snapshot: 0 accounts read");
  assert.equal(h.ncAgo(null), "");
  assert.equal(h.ncAgo(new Date(Date.now() - 3 * 3600e3)), "3 h ago");
});

test("helpers: the items signature is key + promised copies", () => {
  const h = loadHelpers();
  const a = [{ itemKey: "a|g", qty: 3 }, { itemKey: "b|g" }];
  assert.equal(h.ncItemsSig(a), "a|g×3\nb|g×1");
  assert.notEqual(h.ncItemsSig(a), h.ncItemsSig([{ itemKey: "a|g", qty: 4 }, { itemKey: "b|g" }]));
  assert.equal(h.ncItemsSig([]), "");
});

// ---------------------------------------------------------------------------
// Behaviour: Existing listings rows and filters
// ---------------------------------------------------------------------------

const ROW = slice("      function listingRow(set) {", "      var listingsCache = [];");
function loadRow() {
  return new Function(
    "esc",
    "attr",
    "imgTag",
    "isAuto",
    "alCopyButton",
    HELPERS + ROW + "\nreturn listingRow;",
  )(
    esc,
    esc,
    () => "<img>",
    (s) => !!(s && s.sourceType),
    (id) => '<button data-toacct="' + id + '">Account listing</button>',
  );
}

test("row: a no-claim set shows the No-claim badge and farm stock, no Shop controls", () => {
  const listingRow = loadRow();
  const out = listingRow({
    id: "n1",
    name: "R6 bundle",
    itemCount: 2,
    price: 4.75,
    listed: false,
    stockSource: "noclaim",
    thumbs: [],
    ncStock: { free: 38, stale: 3, onAuto: 83, onManual: 1 },
  });
  assert.ok(out.includes('<span class="badge noclaim">No-claim</span>'), out);
  assert.ok(!/badge draft|badge out|badge live/.test(out), "no Shop status badge");
  assert.ok(out.includes("38 free in no-claim farm · 3 unverified · 83 on auto-list"));
  assert.ok(!out.includes("data-toggle"), "no Publish/Unlist");
  assert.ok(!out.includes("data-toacct"), "no Account listing copy");
  for (const op of ['data-edit="n1"', 'data-mp="n1"', 'data-del="n1"'])
    assert.ok(out.includes(op), "keeps " + op);
});

test("row: an archive set renders exactly as before", () => {
  const listingRow = loadRow();
  const out = listingRow({
    id: "a1",
    name: "Archive bundle",
    itemCount: 4,
    price: 1.57,
    listed: false,
    stockSource: "",
    thumbs: [],
    stock: 2,
    stockHeld: 1,
  });
  assert.ok(out.includes('<span class="badge draft">Draft</span>'));
  assert.ok(out.includes("2 in stock · 1 held by other listings"));
  assert.ok(out.includes('data-toggle="a1">Publish</button>'));
  assert.ok(out.includes('data-toacct="a1"'));
  assert.ok(!out.includes("noclaim"));
});

test("filters: No-claim chip, Mine keeps no-claim, Draft means the Draft badge", () => {
  const MATCH = slice("      function lsMatches(set) {", "      function lsCountText() {");
  const { $ } = makeDom();
  const api = new Function(
    "$",
    HELPERS +
      "var lsFilter = 'all', lsOrigin = 'all';" +
      "function isAuto(set) { return !!(set && set.sourceType && String(set.sourceType).trim()); }" +
      MATCH +
      "\nreturn { set: function (f, o) { lsFilter = f; lsOrigin = o; }, lsMatches: lsMatches };",
  )($);
  const sets = [
    { id: "nc", name: "n", stockSource: "noclaim", listed: false, sourceType: "" },
    { id: "mine", name: "m", stockSource: "", listed: false, sourceType: "" },
    { id: "auto", name: "a", stockSource: "", listed: true, sourceType: "radar-event" },
  ];
  const ids = (f, o) => {
    api.set(f, o);
    return sets.filter(api.lsMatches).map((s) => s.id);
  };
  assert.deepEqual(ids("all", "noclaim"), ["nc"]);
  assert.deepEqual(ids("all", "mine"), ["nc", "mine"]);
  assert.deepEqual(ids("all", "auto"), ["auto"]);
  assert.deepEqual(ids("draft", "all"), ["mine"]);
  assert.deepEqual(ids("all", "all"), ["nc", "mine", "auto"]);
});

// ---------------------------------------------------------------------------
// Behaviour: switching source, saving
// ---------------------------------------------------------------------------

test("switch: picked items need a confirm, and a cancel keeps them", () => {
  const CLICK = slice(
    "      function onPickSourceClick(src) {",
    '      $("srcArchive").addEventListener("click", function () {',
  );
  const asked = [];
  let answer = false;
  const calls = [];
  const h = new Function(
    "confirm",
    "calls",
    "var pickSource = 'noclaim', editId = null, selected = [{}, {}];" +
      "function setPickSource(s) { calls.push('set:' + s); pickSource = s; }" +
      "function resetForm() { calls.push('reset'); editId = null; selected = []; }" +
      "function renderSelected() { calls.push('render'); }" +
      CLICK +
      "\nreturn { click: onPickSourceClick, state: function () { return { pickSource: pickSource, n: selected.length }; }," +
      " edit: function (id, n) { editId = id; selected = new Array(n).fill({}); } };",
  )((m) => {
    asked.push(m);
    return answer;
  }, calls);

  h.click("archive");
  assert.deepEqual(asked, ["Switch source? The 2 picked item(s) will be cleared."]);
  assert.deepEqual(h.state(), { pickSource: "noclaim", n: 2 }, "cancel changes nothing");
  assert.deepEqual(calls, []);

  answer = true;
  h.click("archive");
  assert.deepEqual(h.state(), { pickSource: "archive", n: 0 });
  assert.deepEqual(calls, ["set:archive", "render"]);

  // Mid-edit, a switch ends the edit: a set never changes source.
  calls.length = 0;
  h.edit("n1", 3);
  h.click("noclaim");
  assert.deepEqual(calls, ["set:noclaim", "reset"]);

  // No items: no question at all.
  asked.length = 0;
  h.click("archive");
  assert.deepEqual(asked, []);
});

const NC_SAVE = slice(
  "      function ncSave() {",
  '      $("publishBtn").addEventListener("click", function () {',
);
function makeSave(state) {
  const { $ } = makeDom();
  const calls = [];
  const toasts = [];
  const h = new Function(
    "$",
    "api",
    "toast",
    "resetForm",
    "loadListings",
    HELPERS +
      "var editId = " +
      JSON.stringify(state.editId || null) +
      ", selected = " +
      JSON.stringify(state.selected) +
      ", ncEditSig = null;" +
      NC_SAVE +
      "\nreturn { save: ncSave, setSig: function (items) { ncEditSig = ncItemsSig(items); } };",
  )(
    $,
    (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ success: true, set: { id: "x" } });
    },
    (m) => toasts.push(m),
    () => {},
    () => {},
  );
  $("fName").value = state.name == null ? "R6 bundle" : state.name;
  $("fNote").value = "note";
  $("fPrice").value = "4.75";
  return { h, calls, toasts, $ };
}

test("save: a new no-claim set POSTs its items to /noclaim-stock/sets", async () => {
  const s = makeSave({ selected: [{ itemKey: "a|g", qty: 3, name: "A" }, { itemKey: "b|g" }] });
  s.h.save();
  await tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "/noclaim-stock/sets");
  assert.equal(s.calls[0].opts.method, "POST");
  assert.deepEqual(s.calls[0].opts.body, {
    name: "R6 bundle",
    note: "note",
    price: 4.75,
    items: [
      { itemKey: "a|g", qty: 3 },
      { itemKey: "b|g", qty: 1 },
    ],
  });
});

test("save: a title/price edit never sends items (a live listing answers 409 to an items change)", async () => {
  const items = [{ itemKey: "a|g", qty: 3 }];
  const s = makeSave({ editId: "n1", selected: items });
  s.h.setSig(items);
  s.h.save();
  await tick();
  assert.equal(s.calls[0].url, "/noclaim-stock/sets/n1");
  assert.equal(s.calls[0].opts.method, "PUT");
  assert.deepEqual(s.calls[0].opts.body, { name: "R6 bundle", note: "note", price: 4.75 });
});

test("save: an edit that changed the items sends them", async () => {
  const s = makeSave({ editId: "n1", selected: [{ itemKey: "a|g", qty: 4 }] });
  s.h.setSig([{ itemKey: "a|g", qty: 3 }]);
  s.h.save();
  await tick();
  assert.deepEqual(s.calls[0].opts.body.items, [{ itemKey: "a|g", qty: 4 }]);
});

test("save: nothing goes out without a title or an item", () => {
  const noName = makeSave({ name: "", selected: [{ itemKey: "a|g" }] });
  noName.h.save();
  assert.equal(noName.calls.length, 0);
  assert.deepEqual(noName.toasts, ["Title is required"]);
  const noItems = makeSave({ selected: [] });
  noItems.h.save();
  assert.equal(noItems.calls.length, 0);
  assert.deepEqual(noItems.toasts, ["Add at least one item"]);
});

// ---------------------------------------------------------------------------
// Behaviour: the publish modal
// ---------------------------------------------------------------------------

test("modal: unsupported markets are disabled for a no-claim set only", () => {
  const TARGETS = slice("      function renderPubTargets() {", "      function loadExtListings(setId) {");
  const { $ } = makeDom();
  let nc = true;
  const render = new Function(
    "$",
    "esc",
    "attr",
    "mpIsNoclaim",
    HELPERS +
      "var MP_LABELS = { gameflip: 'Gameflip', digiseller: 'Plati', g2g: 'G2G', ggsel: 'GGSel', funpay: 'FunPay', epicnpc: 'EpicNPC', zeusx: 'ZeusX', eldorado: 'Eldorado', playerauctions: 'PlayerAuctions', z2u: 'Z2U' };" +
      "var mpStatus = { gameflip: {configured: true}, digiseller: {configured: true}, g2g: {configured: true}, ggsel: {configured: true}, funpay: {configured: true}, zeusx: {configured: true}, eldorado: {configured: true}, playerauctions: {configured: true}, z2u: {configured: false} };" +
      TARGETS +
      "\nreturn renderPubTargets;",
  )($, esc, esc, () => nc);

  const labels = () =>
    $("mpPubTargets")
      .innerHTML.split("</label>")
      .filter(Boolean)
      .map((l) => ({
        mp: l.match(/data-mptarget="([^"]+)"/)[1],
        disabled: / disabled/.test(l),
        text: l.replace(/<[^>]*>/g, ""),
      }));

  render();
  for (const l of labels()) {
    const off = ["funpay", "epicnpc", "zeusx", "z2u"].includes(l.mp);
    assert.equal(l.disabled, off, l.mp + " disabled iff unsupported");
    if (off) assert.ok(l.text.endsWith(" (not for no-claim)"), l.text);
  }

  nc = false;
  render();
  for (const l of labels()) {
    assert.ok(!l.text.includes("not for no-claim"), l.text);
    // Back to the keys rule alone.
    assert.equal(l.disabled, l.mp === "z2u", l.mp);
  }
});

const DEFAULTS = slice(
  "      var mpGgBeforeOffer = null;",
  "      function openPublishModal(set, offer) {",
);
function makeModal() {
  const { $ } = makeDom();
  const apiCalls = [];
  const h = new Function(
    "$",
    "api",
    "patchRow",
    HELPERS +
      "var mpSet = null, mpOffer = null, listingsCache = [];" +
      DEFAULTS +
      "\nreturn { open: function (set, offer) { mpSet = set; mpOffer = offer || null;" +
      " mpUndoNoclaimDefaults(); mpApplyOfferDefaults(); mpApplyNoclaimDefaults(); } };",
  )(
    $,
    (url) => {
      apiCalls.push(url);
      return Promise.resolve({ success: true, free: 7, stale: 2, onAuto: 0, onManual: 0 });
    },
    () => {},
  );
  // What the owner left the controls on before any of this.
  $("mpGfAuto").checked = false;
  $("mpGgDelivery").value = "manual";
  $("mpDsDelivery").value = "manual";
  return { h, $, apiCalls };
}
const NC = { id: "n1", name: "nc", stockSource: "noclaim" };
const PLAIN = { id: "a1", name: "plain", stockSource: "" };
const OFFER = { id: "o1" };

function controls($) {
  return {
    gf: [$("mpGfAuto").checked, $("mpGfAuto").disabled],
    gg: [$("mpGgDelivery").value, $("mpGgDelivery").disabled],
    ds: [$("mpDsDelivery").value, $("mpDsDelivery").disabled],
  };
}

test("modal: a no-claim open forces automatic delivery and says what backs it", async () => {
  const m = makeModal();
  m.h.open(NC);
  assert.deepEqual(controls(m.$), {
    gf: [true, true],
    gg: ["auto", true],
    ds: ["auto", true],
  });
  assert.equal(m.$("mpNoclaimNote").style.display, "");
  assert.deepEqual(m.apiCalls, ["/noclaim-stock/sets/n1/stock"]);
  await tick();
  assert.equal(
    m.$("mpNoclaimNote").textContent,
    "No-claim stock: 7 free account(s) hold this bundle — each sale hands over one of them." +
      " 2 more are unverified (Refresh stock re-reads them).",
  );
});

test("modal: every forced control is restored on the next non-no-claim open", () => {
  const m = makeModal();
  m.h.open(NC);
  m.h.open(PLAIN);
  assert.deepEqual(controls(m.$), {
    gf: [false, false],
    gg: ["manual", false],
    ds: ["manual", false],
  });
  assert.equal(m.$("mpNoclaimNote").style.display, "none");
});

test("modal: the no-claim lock and the account-listing default compose in any order", () => {
  // offer -> no-claim -> plain
  const a = makeModal();
  a.h.open(PLAIN, OFFER);
  assert.equal(a.$("mpGgDelivery").value, "auto", "an offer starts GGSel on auto");
  a.h.open(NC);
  assert.deepEqual(controls(a.$).gg, ["auto", true]);
  a.h.open(PLAIN);
  assert.deepEqual(controls(a.$), { gf: [false, false], gg: ["manual", false], ds: ["manual", false] });

  // no-claim -> offer -> plain: the offer must not remember the LOCKED value.
  const b = makeModal();
  b.h.open(NC);
  b.h.open(PLAIN, OFFER);
  assert.deepEqual(controls(b.$).gg, ["auto", false], "offer default, unlocked");
  assert.deepEqual(controls(b.$).gf, [false, false], "Gameflip box back to the owner's");
  b.h.open(PLAIN);
  assert.deepEqual(controls(b.$), { gf: [false, false], gg: ["manual", false], ds: ["manual", false] });
});

test("modal: openPublishModal lifts the lock, applies offer defaults, then locks", () => {
  const open = slice(
    "      function openPublishModal(set, offer) {",
    '      $("mpPubClose").addEventListener(',
  );
  assert.match(
    open,
    /mpUndoNoclaimDefaults\(\);\s*mpApplyOfferDefaults\(\);\s*mpApplyNoclaimDefaults\(\);/,
  );
});

test("modal: a no-claim description is the set's note, with no second item list", () => {
  const BUILD = slice("      function mpBuildDescription(set) {", "      function renderPubTargets() {");
  const build = new Function(HELPERS + BUILD + "\nreturn mpBuildDescription;")();
  const items = [{ name: "A", qty: 2, game: "G" }];
  assert.equal(build({ stockSource: "noclaim", note: "  engine copy  ", items }), "engine copy");
  assert.equal(build({ stockSource: "", note: "n", items }), "n\n\nIncludes:\n- 2× A (G)");
});
