// The publish modal's category pickers (public/listings.html).
//
// Two real defects live here, both of them a wrong CATEGORY on a live offer:
//
//   F3 — the picker selections (dsSelected, ggSelected, the FunPay node box
//        and the G2G product select) are module-level, so they outlived the
//        modal. Publish listing A to GGSel having drilled to
//        "Games > Rocket League > Twitch Drops", open listing B, click
//        "Change" and pick nothing, publish: B went live in Rocket League.
//   F4 — the owner's drilled service/brand never reached the body, so the
//        auto-resolved brand overrode an explicit pick while that pick still
//        supplied the product and attributes: one offer, two games.
//
// The modal is inline browser JS with no module boundary, so — like
// tests/autoFarmBundlesPanel.test.js — this test lifts the exact source
// slices out of the page and runs them in Node against a stub DOM. That way
// it pins the behaviour, not the wording of a comment.
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

// mpAutoOk + mpPickWins + mpResetPickerSelections, verbatim.
const PICKERS = slice(
  "      function mpAutoOk(name) {",
  "      function renderMpAuto(name) {",
);
const GG_PATH = slice(
  "      function ggRenderPath() {",
  "      function loadGgCategories(parentId) {",
);
const DS_PATH = slice(
  "      function dsRenderPath() {",
  "      function loadDsCategories(rootId) {",
);
// The per-market blocks of the Publish click handler.
const G2G_BODY = slice(
  '        if (targets.indexOf("g2g") !== -1) {',
  '        if (targets.indexOf("ggsel") !== -1) {',
);
const GG_BODY = slice(
  '        if (targets.indexOf("ggsel") !== -1) {',
  '        if (targets.indexOf("zeusx") !== -1) {',
);
const FP_BODY = slice(
  '        if (targets.indexOf("funpay") !== -1) {',
  '        var btn = $("mpPubGo");',
);

// A stub DOM: every id is an element with a .value and a .textContent.
function makeHarness() {
  const els = {};
  const $ = (id) => {
    if (!els[id]) els[id] = { value: "", textContent: "", innerHTML: "" };
    return els[id];
  };
  const toasts = [];
  const doc = { querySelectorAll: () => [] };
  const src =
    PICKERS +
    GG_PATH +
    DS_PATH +
    `
    function buildBody(targets, body) {
      ${G2G_BODY}
      ${GG_BODY}
      ${FP_BODY}
      return body;
    }
    return {
      $: $,
      toasts: toasts,
      reset: mpResetPickerSelections,
      build: buildBody,
      pickGg: function (row) { ggStack = [{ label: "Games" }]; ggSelected = row; },
      pickDs: function (row) { dsStack = [{ label: "Games" }]; dsSelected = row; },
      ggSelected: function () { return ggSelected; },
      dsSelected: function () { return dsSelected; },
      setAuto: function (auto, revealed) {
        mpAuto = auto; mpAutoRevealed = revealed || {};
      },
    };`;
  const preamble =
    "var mpAuto = {}, mpAutoRevealed = {};" +
    "var ggRows = [], ggStack = [], ggSelected = null;" +
    "var dsRows = [], dsStack = [], dsSelected = null;";
  return new Function("$", "toast", "document", "toasts", preamble + src)(
    $,
    (m) => toasts.push(m),
    doc,
    toasts,
  );
}

// The exact incident from the finding, replayed.
test("F3: a leftover GGSel pick cannot reach the next listing's body", () => {
  const h = makeHarness();
  // Listing A: the owner drilled GGSel to Rocket League > Twitch Drops.
  h.pickGg({ id: "77701", label: "Twitch Drops" });
  h.$("mpGgCategory").value = "77701";
  h.$("mpFpNode").value = "2430";
  h.$("mpG2gProduct").value = "rocket-league-product";
  // Listing B opens: auto resolved fine for all four markets.
  h.reset();
  h.setAuto(
    {
      ggsel: { ok: true, label: "Overwatch 2" },
      funpay: { ok: true, label: "Overwatch 2" },
      g2g: { ok: true, label: "Overwatch 2" },
      digiseller: { ok: true, label: "Overwatch 2" },
    },
    // …and the owner clicked "Change" on all of them to LOOK, picking nothing.
    { ggsel: true, funpay: true, g2g: true, digiseller: true },
  );
  assert.equal(h.ggSelected(), null);
  assert.equal(h.$("mpGgCategory").value, "");
  assert.equal(h.$("mpFpNode").value, "");
  assert.equal(h.$("mpG2gProduct").value, "");

  const body = h.build(["ggsel", "funpay", "g2g"], {});
  assert.ok(body, "publish is not blocked — auto still stands in");
  assert.equal(body.ggsel.categoryId, undefined);
  assert.equal(body.funpay.nodeId, undefined);
  assert.equal(body.g2g.productId, undefined);
});

test("F3: the no-auto path cannot ride a leftover pick either", () => {
  const h = makeHarness();
  h.pickGg({ id: "77701", label: "Twitch Drops" });
  h.reset();
  // Nothing resolved for GGSel on this listing, and nothing was picked: the
  // guard must fire instead of publishing the previous listing's category.
  h.setAuto({ ggsel: { ok: false, reason: "no mapping" } }, {});
  assert.equal(h.build(["ggsel"], {}), undefined);
  assert.ok(
    h.toasts.some((t) => /GGSel catalog category/.test(t)),
    "the drill-down guard fired: " + JSON.stringify(h.toasts),
  );
});

test("an owner's fresh pick still wins after the reset", () => {
  const h = makeHarness();
  h.reset();
  h.setAuto({ ggsel: { ok: true, label: "Overwatch 2" } }, { ggsel: true });
  h.pickGg({ id: "88802", label: "Overwatch 2 Twitch Drops" });
  const body = h.build(["ggsel"], {});
  assert.equal(body.ggsel.categoryId, "88802");
});

test("F4: a drilled G2G product sends its service and brand with it", () => {
  const h = makeHarness();
  h.reset();
  h.setAuto({ g2g: { ok: true, label: "auto brand" } }, { g2g: true });
  h.$("mpG2gService").value = "svc-1";
  h.$("mpG2gBrand").value = "brand-ow2";
  h.$("mpG2gProduct").value = "prod-ow2";
  const body = h.build(["g2g"], {});
  assert.equal(body.g2g.productId, "prod-ow2");
  assert.equal(body.g2g.serviceId, "svc-1");
  assert.equal(body.g2g.brandId, "brand-ow2");
});

// G3: F3 cleared the product but not the rest of the G2G chain — and F4 then
// made brandId the field that decides ownership, so a stale service/brand IS
// the F3 incident again in the fields that now settle it.
test("G3: the whole G2G chain is cleared on open, not just the product", () => {
  const h = makeHarness();
  // Listing A: drilled all the way down on G2G, with the brand list filtered.
  h.$("mpG2gService").value = "svc-1";
  h.$("mpG2gBrandFilter").value = "rocket";
  h.$("mpG2gBrand").value = "brand-rocket-league";
  h.$("mpG2gCategory").value = "cat-9";
  h.$("mpG2gProduct").value = "prod-rocket-league";
  // Listing B opens.
  h.reset();
  assert.equal(h.$("mpG2gService").value, "");
  assert.equal(h.$("mpG2gBrand").value, "");
  assert.equal(h.$("mpG2gBrandFilter").value, "");
  assert.equal(h.$("mpG2gCategory").value, "");
  assert.equal(h.$("mpG2gProduct").value, "");

  // The owner reveals G2G to look and picks nothing: no brandId reaches the
  // body, so the auto resolution — not Rocket League — decides the placement.
  h.setAuto({ g2g: { ok: true, label: "Overwatch 2" } }, { g2g: true });
  const body = h.build(["g2g"], {});
  assert.equal(body.g2g.brandId, undefined);
  assert.equal(body.g2g.serviceId, undefined);
  assert.equal(body.g2g.productId, undefined);
});

test("F4: nothing picked sends no service/brand at all", () => {
  const h = makeHarness();
  h.reset();
  h.setAuto({ g2g: { ok: true, label: "auto brand" } }, { g2g: true });
  // A service/brand can sit in the selects from the previous open without a
  // product ever being chosen — that is not a pick, and must not be sent.
  h.$("mpG2gService").value = "svc-1";
  h.$("mpG2gBrand").value = "brand-rocket-league";
  const body = h.build(["g2g"], {});
  assert.equal(body.g2g.productId, undefined);
  assert.equal(body.g2g.serviceId, undefined);
  assert.equal(body.g2g.brandId, undefined);
});

// The reset is worthless if the modal never calls it.
test("openPublishModal clears the picker selections on every open", () => {
  const open = slice(
    "      function openPublishModal(set, offer) {",
    '      $("mpPubClose").addEventListener(',
  );
  assert.ok(
    /mpResetPickerSelections\(\)/.test(open),
    "openPublishModal calls mpResetPickerSelections()",
  );
});
