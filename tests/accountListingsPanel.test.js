// The Account listings tab and the publish modal's pickers
// (public/listings.html), second review round.
//
//   G2 — the "no available accounts" guard and the per-row "N available"
//        figure both read stats.available, which COUNTS the
//        conflict:"in-archive" rows claimForListing refuses. An offer whose
//        whole shelf is held back read as fully stocked and published with no
//        warning at all.
//   G4 — a category picked BEFORE the suggest-category reply landed was
//        silently discarded: only the "Change" click set mpAutoRevealed, so an
//        ok:true reply hid the picker and mpPickWins went false.
//   G5 — a large paste went up as JSON, hit express.json's app-wide 100kb cap
//        (server.js:184), and the HTML 413 made api()'s r.json() throw a
//        SyntaxError — the owner saw a parse error, not "too big".
//
// The modal and the tab are inline browser JS with no module boundary, so —
// like tests/publishPickerReset.test.js — this lifts the exact source slices
// out of the page and runs them in Node against a stub DOM, pinning the
// behaviour rather than the wording of a comment.
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

// A stub DOM: every id is an element with a value, the bits renderMpAuto
// touches, and a handler map so a registered listener can be fired by hand.
function makeDom() {
  const els = {};
  const $ = (id) => {
    if (!els[id])
      els[id] = {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        disabled: false,
        style: { display: "" },
        handlers: {},
        classList: { add() {}, remove() {} },
        addEventListener(type, fn) {
          this.handlers[type] = fn;
        },
      };
    return els[id];
  };
  return { $, els };
}

// ---------------------------------------------------------------------------
// G2 — claimable, not "available"
// ---------------------------------------------------------------------------

const CLAIMABLE = slice(
  "      function alClaimable(stats) {",
  "      function alStatusBadge(s) {",
);

function loadClaimable() {
  return new Function(CLAIMABLE + "\nreturn alClaimable;")();
}

test("G2: a shelf that is entirely held back is not claimable stock", () => {
  const alClaimable = loadClaimable();
  // The incident: every row on the shelf is also in the Drop Archive, so
  // claimForListing hands over nothing — but stats.available says 4.
  assert.deepEqual(alClaimable({ available: 4, conflicts: 4, fed: 0, sold: 0 }), {
    claimable: 0,
    heldBack: 4,
  });
});

test("G2: a clean shelf is unchanged, and a partial one splits", () => {
  const alClaimable = loadClaimable();
  assert.deepEqual(alClaimable({ available: 5, conflicts: 0 }), {
    claimable: 5,
    heldBack: 0,
  });
  assert.deepEqual(alClaimable({ available: 3, conflicts: 1 }), {
    claimable: 2,
    heldBack: 1,
  });
  assert.deepEqual(alClaimable(null), { claimable: 0, heldBack: 0 });
});

test("G2: offerStats.conflicts counts every status, so it is capped", () => {
  const alClaimable = loadClaimable();
  // Two conflicted rows are still on the shelf and three were removed by the
  // owner; `conflicts` (7) counts all of them. Capping at `available` can only
  // under-state what is claimable — it must never go negative and must never
  // claim more than the shelf holds.
  const r = alClaimable({ available: 2, removed: 3, conflicts: 7 });
  assert.equal(r.claimable, 0);
  assert.equal(r.heldBack, 2);
});

test("G2: a server-sent claimable figure wins over the fallback", () => {
  const alClaimable = loadClaimable();
  // suppliedStock.offerStats does not send these today; when it does, the
  // exact figure must be used instead of available-minus-conflicts.
  assert.deepEqual(
    alClaimable({ available: 9, conflicts: 9, claimable: 7 }),
    { claimable: 7, heldBack: 2 },
  );
  assert.deepEqual(
    alClaimable({ available: 9, conflicts: 9, claimable: 7, heldBack: 2 }),
    { claimable: 7, heldBack: 2 },
  );
});

test("G2: the row shows the claimable count and names the held-back stock", () => {
  const ROW = slice("      function alRow(o) {", "      function alRenderOffers() {");
  const alRow = new Function(
    "esc",
    "attr",
    "alMarketChips",
    "alActiveListings",
    CLAIMABLE + ROW + "\nreturn alRow;",
  )(
    (s) => String(s == null ? "" : s),
    (s) => String(s == null ? "" : s),
    () => "",
    () => [],
  );
  const out = alRow({
    id: "o1",
    title: "Overwatch drops",
    status: "active",
    stats: { available: 5, conflicts: 3, fed: 1, sold: 2 },
  });
  assert.ok(
    out.indexOf("2 available · 3 held back · 1 fed · 2 sold") !== -1,
    "row reads claimable + held back: " + out,
  );
  assert.ok(out.indexOf("5 available") === -1, "the raw shelf count is gone");
});

test("G2: publishing an all-held-back offer warns instead of going silently live", () => {
  const GUARD = slice("        } else if (mp) {", "        } else if (dl) {");
  const { $ } = makeDom();
  const asked = [];
  const opened = [];
  const run = new Function(
    "$",
    "find",
    "confirm",
    "openPublishModal",
    "alSetLike",
    CLAIMABLE +
      "\nreturn function (mp) { if (!mp) {\n" +
      GUARD +
      "\n} };",
  )(
    $,
    (id) => find(id),
    (msg) => {
      asked.push(msg);
      return false; // the owner backs out
    },
    (setLike, offer) => opened.push(offer),
    (o) => o,
  );
  const offers = [
    { id: "held", description: "", stats: { available: 4, conflicts: 4 } },
    { id: "empty", description: "", stats: { available: 0, conflicts: 0 } },
    { id: "ok", description: "", stats: { available: 4, conflicts: 1 } },
  ];
  function find(id) {
    return offers.filter((o) => o.id === id)[0];
  }

  run({ dataset: { almp: "held" } });
  assert.equal(opened.length, 0, "the guard fired on the held-back shelf");
  assert.ok(
    /held back because they are also in the Drop Archive/.test(asked[0]),
    "the warning says WHY there is nothing claimable: " + asked[0],
  );

  run({ dataset: { almp: "empty" } });
  assert.ok(
    /no available accounts/.test(asked[1]),
    "an empty shelf still reads as empty: " + asked[1],
  );

  run({ dataset: { almp: "ok" } });
  assert.equal(asked.length, 2, "3 claimable of 4 publishes with no warning");
  assert.equal(opened.length, 1);
});

// ---------------------------------------------------------------------------
// G4 — a pick is a pick whenever it happens
// ---------------------------------------------------------------------------

const MP_AUTO = slice(
  "      var MP_AUTO_BOXES = {",
  "      // `set` may be a light list row",
);
const GG_PICK = slice(
  '      $("mpGgCategory").addEventListener("change", function () {',
  "      // Digiseller cataloguer drill-down:",
);
const DS_PICK = slice(
  '      $("mpDsCategory").addEventListener("change", function () {',
  "      // Some categories require attributes",
);
const G2G_PICK = slice(
  '      $("mpG2gProduct").addEventListener("change", function () {',
  '      $("mpPubGo").addEventListener("click", function () {',
);

function makePickerHarness() {
  const { $, els } = makeDom();
  // Everything the three drill-down handlers reach for that is not the pick
  // itself: the network loads and the breadcrumb renderers.
  const preamble =
    "var ggRows = [], ggStack = [], ggSelected = null;" +
    "var dsRows = [], dsStack = [], dsSelected = null;" +
    "function ggRenderPath() {}" +
    "function dsRenderPath() {}" +
    "function loadGgCategories() {}" +
    "function loadDsCategories() {}" +
    "function loadDsAttributes() {}" +
    "function g2gFirstArray() { return []; }" +
    // api() is only reached AFTER the pick is marked; a thenable that never
    // runs its callbacks keeps the attribute fetch out of this test.
    "function api() { return { then: function () { " +
    "return { catch: function () {} }; } }; }";
  const tail = `
    return {
      rows: function (gg, ds) { ggRows = gg; dsRows = ds; },
      setAuto: function (auto) { mpAuto = auto; mpAutoRevealed = {}; },
      reply: function (name, r) { mpAuto[name] = r; renderMpAuto(name); },
      pickWins: mpPickWins,
      boxes: MP_AUTO_BOXES,
      ggSelected: function () { return ggSelected; },
      dsSelected: function () { return dsSelected; },
    };`;
  const api = new Function(
    "$",
    "esc",
    "toast",
    preamble + MP_AUTO + GG_PICK + DS_PICK + G2G_PICK + tail,
  )($, (s) => String(s == null ? "" : s), () => {});
  return { $, els, api };
}

test("G4: a pick made before the suggest reply lands still wins", () => {
  const h = makePickerHarness();
  h.api.rows(
    [{ id: "881", label: "Twitch Drops", hasChildren: false }],
    [{ id: "77", label: "Twitch Drops", hasChildren: false }],
  );
  // No reply yet — renderMpAuto's `!r` branch leaves every picker open, which
  // is exactly the window the owner drills in.
  h.api.setAuto({});
  const gg = h.$("mpGgCategory");
  gg.value = "881";
  gg.handlers.change.call(gg);
  assert.deepEqual(h.api.ggSelected(), {
    id: "881",
    label: "Twitch Drops",
    hasChildren: false,
  });

  // …and now the reply arrives, resolving the category automatically.
  h.api.reply("ggsel", { ok: true, label: "Rocket League > Twitch Drops" });
  assert.equal(
    h.api.pickWins("ggsel"),
    true,
    "the owner's pick survives the reply instead of being thrown away",
  );
  assert.equal(
    h.$("mpGgPicker").style.display,
    "",
    "and the picker stays open on the market they chose in",
  );
});

test("G4: every one of the four pickers marks its own market", () => {
  const h = makePickerHarness();
  h.api.rows(
    [{ id: "881", label: "Leaf", hasChildren: false }],
    [{ id: "77", label: "Leaf", hasChildren: false }],
  );
  h.api.setAuto({
    ggsel: { ok: true, label: "auto" },
    digiseller: { ok: true, label: "auto" },
    funpay: { ok: true, label: "auto" },
    g2g: { ok: true, label: "auto" },
  });
  assert.deepEqual(
    ["ggsel", "digiseller", "funpay", "g2g"].map(h.api.pickWins),
    [false, false, false, false],
    "nothing is owner-chosen before anything is picked",
  );

  const gg = h.$("mpGgCategory");
  gg.value = "881";
  gg.handlers.change.call(gg);
  const ds = h.$("mpDsCategory");
  ds.value = "77";
  ds.handlers.change.call(ds);
  const fp = h.$("mpFpNode");
  fp.value = "2430";
  fp.handlers.input.call(fp);
  const pr = h.$("mpG2gProduct");
  pr.value = "prod-ow2";
  pr.handlers.change.call(pr);

  assert.deepEqual(
    ["ggsel", "digiseller", "funpay", "g2g"].map(h.api.pickWins),
    [true, true, true, true],
  );
});

test("G4: entering a BRANCH is not a pick", () => {
  const h = makePickerHarness();
  h.api.rows([{ id: "10", label: "Games", hasChildren: true }], []);
  h.api.setAuto({ ggsel: { ok: true, label: "auto" } });
  const gg = h.$("mpGgCategory");
  gg.value = "10";
  gg.handlers.change.call(gg);
  assert.equal(h.api.ggSelected(), null);
  assert.equal(
    h.api.pickWins("ggsel"),
    false,
    "drilling INTO a branch must not override the auto category",
  );
});

test("G4: an emptied FunPay box is not a pick", () => {
  const h = makePickerHarness();
  h.api.setAuto({ funpay: { ok: true, label: "auto" } });
  const fp = h.$("mpFpNode");
  fp.value = "  ";
  fp.handlers.input.call(fp);
  assert.equal(h.api.pickWins("funpay"), false);
});

// ---------------------------------------------------------------------------
// G5 — a large paste, and a non-JSON error body
// ---------------------------------------------------------------------------

const API = slice(
  "      function api(url, opts) {",
  "      // Range label for items",
);

function loadApi(fetchStub) {
  return new Function("fetch", API + "\nreturn api;")(fetchStub);
}

function reply(status, body, ok) {
  return Promise.resolve({
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    text: () => Promise.resolve(body),
  });
}

test("G5: an HTML 413 says the paste is too large, not 'Unexpected token'", async () => {
  const api = loadApi(() =>
    reply(413, "<!DOCTYPE html><html><body>PayloadTooLargeError</body></html>"),
  );
  await assert.rejects(api("/account-listings/x/accounts", { method: "POST" }), (e) => {
    assert.ok(!/JSON|token/i.test(e.message), "not a parse error: " + e.message);
    assert.ok(/too large/i.test(e.message), e.message);
    return true;
  });
});

test("G5: a non-JSON body on any status produces a readable message", async () => {
  const gateway = loadApi(() => reply(502, "<html>502 Bad Gateway</html>"));
  await assert.rejects(gateway("/x", {}), /Request failed \(502\)/);
  // A 200 whose body is not JSON used to throw a SyntaxError too.
  const truncated = loadApi(() => reply(200, "<html>hi</html>"));
  await assert.rejects(truncated("/x", {}), /Unreadable reply from the server/);
});

test("G5: a JSON error body still speaks for itself", async () => {
  const api = loadApi(() => reply(400, JSON.stringify({ success: false, message: "bad id" })));
  await assert.rejects(api("/x", {}), /bad id/);
  const okish = loadApi(() =>
    reply(200, JSON.stringify({ success: false, message: "no such offer" })),
  );
  await assert.rejects(okish("/x", {}), /no such offer/);
});

test("G5: api leaves a string body and its content type alone", async () => {
  const seen = [];
  const api = loadApi((url, opts) => {
    seen.push(opts);
    return reply(200, JSON.stringify({ success: true }));
  });
  await api("/x", {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "a:b\nc:d",
  });
  assert.equal(seen[0].body, "a:b\nc:d");
  assert.equal(seen[0].headers["Content-Type"], "text/plain; charset=utf-8");
  // …while an object body is still JSON, as every other call site relies on.
  await api("/x", { method: "POST", body: { a: 1 } });
  assert.equal(seen[1].headers["Content-Type"], "application/json");
  assert.equal(seen[1].body, '{"a":1}');
});

test("G5: 'Add accounts' posts the paste as raw text/plain", async () => {
  const ADD = slice(
    '      $("alAddBtn").addEventListener("click", function () {',
    '      $("alStock").addEventListener("click", function (e) {',
  );
  const { $ } = makeDom();
  const calls = [];
  const preamble =
    'var alStockId = "offer-1";' +
    "function alCountOf(v) { return Array.isArray(v) ? v.length : 0; }" +
    "function alReported(x) { return String(x); }" +
    "function alLoadStock() { return Promise.resolve(); }" +
    "function alLoad() { return Promise.resolve(); }";
  new Function(
    "$",
    "esc",
    "toast",
    "api",
    preamble + ADD,
  )(
    $,
    (s) => String(s == null ? "" : s),
    () => {},
    (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ added: 2, duplicates: [], conflicts: [], badLines: [] });
    },
  );

  // A paste far past express.json's 100kb cap — the size that used to 413.
  const big = Array.from({ length: 4000 }, (_, i) => "user" + i + ":pw" + i).join("\n");
  $("alPaste").value = big;
  $("alAddBtn").handlers.click();
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].opts.headers["Content-Type"],
    "text/plain; charset=utf-8",
    "the paste bypasses express.json's 100kb cap by not being JSON",
  );
  assert.equal(
    calls[0].opts.body,
    big,
    "the raw paste is the body — routes/accountListingRoutes.js reads it as text",
  );
});
