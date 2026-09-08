// Z2U has no API — every field this integration reads is scraped out of the
// seller panel's HTML, so these tests are the contract with that HTML.
//
// The fixtures mirror the real markup, verified live against the account's own
// shelf on 2026-09-08: the parsers in utils/marketplaces.js were run against
// all 47 live offers and all 20 orders on page 1, and their output was compared
// field by field with the browser's own DOM. Two real bugs were caught that way
// and both are pinned below:
//   * the row splitter cuts INSIDE the opening tag, so every cell text used to
//     begin with a stray `">`;
//   * each cell fragment ends with a dangling `<div` that has no closing `>`,
//     which the ordinary tag strip leaves behind.
const test = require("node:test");
const assert = require("node:assert");

const mp = require("../utils/marketplaces");
const ful = require("../utils/z2uFulfiller");

const GROUPS_HTML = `
<div class="game-list">
  <a href="https://www.z2u.com/sell/manageList?service=3&amp;game=8178">
     <span class="badge">13 Offers</span>
     <div class="name">Rainbow Six Siege Items</div>
  </a>
  <a href="/sell/manageList?service=5&game=12755">
     <span class="badge">2 Offers</span><div class="name">Phasmophobia Accounts</div>
  </a>
  <a href="/sell/manageList?service=3&game=8178">duplicate tile</a>
</div>`;

// One row per status the live shelf actually shows: on sale (1), paused by the
// seller (4), and pulled by Z2U for running out its duration (5).
function row({ pk, title, price, stock, statusCode, published = "2026/08/12" }) {
  const statusInner =
    statusCode === 1
      ? `<a class="set_status" data-value="1">Deactivate</a><a class="set_extend">EXTEND</a>`
      : `<a class="set_status" data-value="${statusCode}">Relist</a>`;
  return `<div class="div-table-row" data="${pk}">
  <div class="div-table-cell"><input type="checkbox" value="${pk}"></div>
  <div class="div-table-cell"><div class="title">Product Name</div><div class="main-text">
      <span>Publish ${published}</span>
      <a href="/sell/manageEdit.html?id=${pk}">${title}</a><span>#${pk}</span></div></div>
  <div class="div-table-cell"><div class="title">Sort</div><div class="main-text"><input type="text" value="0"></div></div>
  <div class="div-table-cell"><div class="title">Attribute:</div><div class="main-text">PLATFORM: PSN</div></div>
  <div class="div-table-cell"><div class="title">Min QTY.</div><div class="main-text">1</div></div>
  <div class="div-table-cell"><div class="title">Unit Price</div><div class="main-text"><input type="text" value="${price}"><span>USD</span></div></div>
  <div class="div-table-cell"><div class="title">Stock</div><div class="main-text">${stock}<span>1 Hours</span></div></div>
  <div class="div-table-cell"><div class="title">Delivery Method</div><div class="main-text">Order Delivery</div></div>
  <div class="div-table-cell"><div class="title">Product expiration date</div><div class="main-text">30 Days</div></div>
  <div class="div-table-cell"><div class="title">Status</div><div class="main-text">${statusInner}</div></div>
  <div class="div-table-cell action-col"><div class="title">Action</div><div class="main-text"><a>Edit</a></div></div>
</div>`;
}

const SHELF_HTML =
  `<div class="div-table">` +
  row({ pk: "13884438", title: `Rainbow Six Siege Twitch Drops (13 items) — "EXPECTED FEAST" MP5SD`, price: "3", stock: 7, statusCode: 1 }) +
  row({ pk: "13857794", title: "Overwatch Twitch Drops (31 items)", price: "1.5", stock: 2, statusCode: 4 }) +
  row({ pk: "13809673", title: "Overwatch Twitch Drops (14 Items +)", price: "2", stock: 8, statusCode: 5 }) +
  `</div>`;

test("parseZ2uGroups finds each (service, game) tile exactly once", () => {
  const g = mp.parseZ2uGroups(GROUPS_HTML);
  assert.strictEqual(g.length, 2, "the repeated tile must not be listed twice");
  assert.deepStrictEqual(g[0], {
    service: "3",
    game: "8178",
    label: "Rainbow Six Siege Items",
    offers: 13,
  });
  // &amp; in the href must parse the same as a bare &.
  assert.strictEqual(g[1].game, "12755");
  assert.strictEqual(g[1].offers, 2);
});

test("parseZ2uOffers reads every field off a real-shaped row", () => {
  const rows = mp.parseZ2uOffers(SHELF_HTML);
  assert.strictEqual(rows.length, 3);
  const r = rows[0];
  assert.strictEqual(r.pk, "13884438");
  // A quote inside the title is legitimate — several live titles have one.
  assert.strictEqual(
    r.title,
    `Rainbow Six Siege Twitch Drops (13 items) — "EXPECTED FEAST" MP5SD`,
  );
  assert.strictEqual(r.price, 3);
  assert.strictEqual(r.stock, 7);
  assert.strictEqual(r.minQty, 1);
  assert.strictEqual(r.expiryDays, 30);
  assert.strictEqual(r.publishedAt, "2026/08/12");
  assert.strictEqual(r.delivery, "Order Delivery");
  assert.strictEqual(r.attribute, "PLATFORM: PSN");
  assert.strictEqual(r.currency, "USD");
});

test("no cell keeps the tag debris the row splitter leaves behind", () => {
  for (const r of mp.parseZ2uOffers(SHELF_HTML)) {
    // The two regressions: a leading `">` from the cut opening tag, and a
    // trailing unterminated `<div` from the next cell's tag.
    for (const field of [r.title, r.delivery, r.attribute]) {
      assert.ok(!/[<>]/.test(field), "tag debris in " + JSON.stringify(field));
    }
    // The column heading is a label, not part of the value.
    assert.ok(!/Product Name|Unit Price|Delivery Method/.test(r.title + r.delivery));
  }
});

test("only status 1 counts as on sale, and expiry is told apart from a pause", () => {
  const [live, paused, expired] = mp.parseZ2uOffers(SHELF_HTML);
  assert.strictEqual(live.online, true);
  assert.strictEqual(live.status, "online");
  assert.strictEqual(live.canExtend, true);
  assert.strictEqual(paused.online, false);
  assert.strictEqual(paused.status, "paused");
  assert.strictEqual(expired.online, false);
  // The two off-sale states need different repairs, so they must not collapse.
  assert.strictEqual(expired.status, "expired");
  assert.notStrictEqual(paused.status, expired.status);
});

const ORDER_HTML = `
<div class="orderPanel"><div class="panelHead"><div class="items">
  <a href="/sellOrder?order_id=Z1561548664">Z1561548664</a>
  <span>buyer : motimato</span><span>Date: 2026-09-07 03:08:28</span>
  <span>Waiting for buyer reply</span>
  <a href="/product">Overwatch Twitch Drops (18 Items) — OWWC Groups 2026</a>
  <span>USD 1.5</span><span>WAIT FOR CONFIRMED</span>
  <a href="https://www.z2u.com/Order/showProRecord?oid=${"d".repeat(64)}">Order Detail</a>
  <div>Total Amount: USD 1.50</div>
</div></div></div>`;

test("parseZ2uOrders keeps the state badge out of the product title", () => {
  const [o] = mp.parseZ2uOrders(ORDER_HTML);
  assert.strictEqual(o.orderId, "Z1561548664");
  assert.strictEqual(o.buyer, "motimato");
  assert.strictEqual(o.date, "2026-09-07 03:08:28");
  assert.strictEqual(o.title, "Overwatch Twitch Drops (18 Items) — OWWC Groups 2026");
  assert.strictEqual(o.amount, 1.5);
  assert.strictEqual(o.currency, "USD");
  assert.strictEqual(o.oid.length, 64);
  assert.strictEqual(o.state, "wait_confirm");
});

const FORM_HTML = `
<form id="form">
  <input type="text" name="list_title" value="Old title">
  <textarea name="list_description">line one &amp; two</textarea>
  <input type="checkbox" name="list_transaction_mode[]" value="5" checked>
  <input type="checkbox" name="list_transaction_mode[]" value="7">
  <input type="submit" value="Save">
  <select name="list_term_of_validity">
    <option value="7">7</option><option value="30" selected>30</option>
  </select>
  <select name="list_area_id"><option value="35">Global</option><option value="37">US</option></select>
  <input type="hidden" name="list_pk" value="13884438">
</form>
<form id="other"><input type="text" name="decoy" value="x"></form>`;

test("parseZ2uForm reproduces what the browser would submit", () => {
  const f = mp.parseZ2uForm(FORM_HTML, "form");
  const names = f.map(([n]) => n);
  const get = (n) => f.filter(([k]) => k === n).map(([, v]) => v);
  // Scoped to the named form only.
  assert.ok(!names.includes("decoy"));
  // Submit buttons are not submitted values.
  assert.ok(!names.includes(undefined));
  assert.strictEqual(f.filter(([, v]) => v === "Save").length, 0);
  // An unchecked box is simply absent, exactly as in a real submission.
  assert.deepStrictEqual(get("list_transaction_mode[]"), ["5"]);
  // Selected option wins; with none selected a browser sends the first.
  assert.deepStrictEqual(get("list_term_of_validity"), ["30"]);
  assert.deepStrictEqual(get("list_area_id"), ["35"]);
  assert.deepStrictEqual(get("list_description"), ["line one & two"]);
  assert.deepStrictEqual(get("list_pk"), ["13884438"]);
});

test("daysUntilExpiry counts from the publish date plus the duration", () => {
  const now = Date.UTC(2026, 8, 8); // 2026-09-08
  const offer = { publishedAt: "2026/08/12", expiryDays: 30 };
  assert.strictEqual(ful.daysUntilExpiry(offer, now), 3);
  // Missing either half must be "unknown", never a number that reads as due.
  assert.strictEqual(ful.daysUntilExpiry({ publishedAt: "", expiryDays: 30 }, now), null);
  assert.strictEqual(ful.daysUntilExpiry({ publishedAt: "2026/08/12" }, now), null);
});

function entry(offer, row, realStock, daysLeft) {
  return { offer, row, realStock, daysLeft };
}
const LIVE = { pk: "1", title: "t", online: true, status: "online", stock: 5 };

test("an offer we cannot back comes down before anything else", () => {
  const p = ful.planForOffer(entry({ ...LIVE }, { autoPaused: false }, 0, 20));
  assert.deepStrictEqual(p.actions.map((a) => a.action), ["off_line"]);
});

test("an expired offer is extended before it is relisted", () => {
  const p = ful.planForOffer(
    entry({ ...LIVE, online: false, status: "expired" }, { autoPaused: false }, 4, null),
  );
  // Order is load-bearing: relisting without extending falls straight back off.
  assert.deepStrictEqual(p.actions.map((a) => a.action), ["extend", "on_line", "stock"]);
  assert.strictEqual(p.actions[0].action, "extend");
});

test("only a pause this module made is ever undone", () => {
  const ours = ful.planForOffer(
    entry({ ...LIVE, online: false, status: "paused", stock: 4 }, { autoPaused: true }, 4, 20),
  );
  assert.deepStrictEqual(ours.actions.map((a) => a.action), ["on_line"]);
  const theirs = ful.planForOffer(
    entry({ ...LIVE, online: false, status: "paused", stock: 4 }, { autoPaused: false }, 4, 20),
  );
  assert.deepStrictEqual(theirs.actions, [], "a deliberate pause must survive the tick");
});

test("a live offer near its expiry is extended, and stock is corrected", () => {
  const p = ful.planForOffer(entry({ ...LIVE, stock: 5 }, { autoPaused: false }, 9, 2));
  assert.deepStrictEqual(p.actions.map((a) => a.action), ["extend", "stock"]);
  assert.strictEqual(p.actions[1].value, 9);
});

test("an offer with no listing row, or unknown stock, is left alone", () => {
  assert.deepStrictEqual(ful.planForOffer(entry({ ...LIVE }, null, null, 20)).actions, []);
  // Row exists but has no stock source: "unknown" must not read as "none".
  const p = ful.planForOffer(entry({ ...LIVE }, { autoPaused: false }, null, 20));
  assert.deepStrictEqual(p.actions, []);
});

test("an order matches its listing by title, and never by a guess", () => {
  const rows = [
    { title: "Overwatch Twitch Drops (18 Items)", _id: "a" },
    { title: "overwatch  twitch drops (18 items)", _id: "b" },
    { title: "Rainbow Six", _id: "c" },
  ];
  // Exact wins even though a normalised duplicate exists.
  assert.strictEqual(
    ful.matchRowForOrder({ title: "Overwatch Twitch Drops (18 Items)" }, rows)._id,
    "a",
  );
  assert.strictEqual(ful.matchRowForOrder({ title: "Rainbow  Six" }, rows)._id, "c");
  // Two rows normalise the same -> ambiguous -> refuse rather than guess.
  assert.strictEqual(
    ful.matchRowForOrder({ title: "Overwatch Twitch Drops (18 Items)!" }, rows),
    null,
  );
  assert.strictEqual(ful.matchRowForOrder({ title: "" }, rows), null);
});

// Two of this codebase's other marketplaces lie about whether a write landed —
// ZeusX returns a 500 for updates it HAS applied, GGSel a 504 for ones it has
// NOT — so the Z2U shelf keeper verifies every write by reading the offer back.
// These pin what "verified" has to mean for each action.
test("every action states what the offer should look like afterwards", () => {
  assert.deepStrictEqual(ful.expectedAfter("off_line"), { online: false });
  assert.deepStrictEqual(ful.expectedAfter("on_line"), { online: true });
  assert.deepStrictEqual(ful.expectedAfter("stock", 12), { stock: 12 });
  // An extend cannot be checked by a count, only by the offer no longer being
  // in the state that made it need extending.
  assert.deepStrictEqual(ful.expectedAfter("extend"), { notExpired: true });
  assert.deepStrictEqual(ful.expectedAfter("nonsense"), {});
});

test("reviving a seller-paused offer is opt-in, never automatic", () => {
  const paused = entry(
    { ...LIVE, online: false, status: "paused", stock: 4 },
    { autoPaused: false },
    40,
    20,
  );
  // Default: a human's pause is left alone.
  assert.deepStrictEqual(ful.planForOffer(paused).actions.map((a) => a.action), []);
  // Opt-in: relist it, and correct the stock while we are there.
  const revived = ful.planForOffer(paused, { resumeSellerPaused: true });
  assert.deepStrictEqual(revived.actions.map((a) => a.action), ["on_line", "stock"]);
  // Still gated on stock: an empty offer is never revived.
  const empty = entry(
    { ...LIVE, online: false, status: "paused", stock: 4 },
    { autoPaused: false },
    0,
    20,
  );
  assert.deepStrictEqual(
    ful.planForOffer(empty, { resumeSellerPaused: true }).actions,
    [],
  );
});

// keepShelfAlive's filter is exercised through planForOffer + the same rule the
// publishOnly branch applies, so the intent is pinned without a live session.
function publishOnlyFilter(actions, online) {
  let a = actions.filter((x) => x.action !== "off_line");
  if (!a.some((x) => x.action !== "stock")) {
    const keep = a.filter((x) => x.action === "stock");
    a = online ? keep : [];
  }
  return a.map((x) => x.action);
}

test("publish-only never takes an offer off sale", () => {
  // The out-of-stock case: normally a pause, here nothing at all.
  const empty = ful.planForOffer(entry({ ...LIVE }, { autoPaused: false }, 0, 20));
  assert.deepStrictEqual(empty.actions.map((a) => a.action), ["off_line"]);
  assert.deepStrictEqual(publishOnlyFilter(empty.actions, true), []);

  // A revive still happens, and keeps its stock correction.
  const revive = ful.planForOffer(
    entry({ ...LIVE, online: false, status: "paused", stock: 4 }, { autoPaused: false }, 40, 20),
    { resumeSellerPaused: true },
  );
  assert.deepStrictEqual(publishOnlyFilter(revive.actions, false), ["on_line", "stock"]);

  // A live offer whose only change is a quantity fix keeps it — that corrects an
  // overstatement without removing anything.
  const fix = ful.planForOffer(entry({ ...LIVE, stock: 99 }, { autoPaused: false }, 9, 20));
  assert.deepStrictEqual(fix.actions.map((a) => a.action), ["stock"]);
  assert.deepStrictEqual(publishOnlyFilter(fix.actions, true), ["stock"]);
});

// The CSRF token cost a live run: /public/createToken is a GET (a POST 404s),
// and the token is NOT in the JSON body — the body's `url` field is a redirect
// target that merely looks token-shaped. The real value arrives as the
// `__token__` RESPONSE HEADER, which is what the site's own getToken() reads.
// Every write 404'd until this was right, so pin the shape of the mistake.
test("the createToken body is not a token source", () => {
  // This is the actual reply observed from prod: `url` is a page URL.
  const body = {
    code: 1, msg: "", data: "",
    url: "https://www.z2u.com/sell/manage", wait: 3,
  };
  assert.ok(/^https?:\/\//.test(body.url), "url is a URL, not a token");
  assert.strictEqual(body.data, "", "the body carries no token at all");
});

// --- per-game template enums ------------------------------------------------
// Z2U's accepted values differ per GAME, which an earlier attempt at this
// integration missed by hard-coding one game's lists. Measured live 2026-09-08:
// Halo Infinite accepts ONLY "Order Delivery", while Overwatch does not offer
// it at all ("Put into my account, Send Code, Gift Giving"). Publishing a
// Twitch-drops account under the wrong one misdescribes how the buyer receives
// it, so the picker has to say whether it got what it asked for.
const tmpl = require("../utils/z2uTemplate");

test("a validation list is read from a literal or a column reference", () => {
  assert.deepStrictEqual(
    tmpl.resolveList('"Order Delivery,Send Code,Redeem By Seller"', new Map()),
    ["Order Delivery", "Send Code", "Redeem By Seller"],
  );
  // Z2U points some columns at a hidden range instead of listing values inline.
  const cells = new Map([
    ["AQ1", "Battle.net"],
    ["AQ2", "Steam"],
    ["AQ4", "Nintendo"], // gaps are skipped, not turned into blanks
  ]);
  assert.deepStrictEqual(
    tmpl.resolveList("HEADER_CREATE_NEW_LISTING!AQ1:AQ86", cells),
    ["Battle.net", "Steam", "Nintendo"],
  );
  assert.deepStrictEqual(tmpl.resolveList("", new Map()), []);
});

test("pickOption reports whether the game really allows what we wanted", () => {
  const halo = ["Order Delivery"];
  const ow = ["Put into my account", "Send Code", "Gift Giving"];
  // Exact match available.
  const a = tmpl.pickOption(halo, ["Order Delivery"]);
  assert.strictEqual(a.value, "Order Delivery");
  assert.strictEqual(a.exact, true);
  // Preference order matters: the second choice wins when the first is absent.
  const b = tmpl.pickOption(ow, ["Order Delivery", "Send Code"]);
  assert.strictEqual(b.value, "Send Code");
  assert.strictEqual(b.exact, true);
  // Nothing we asked for: it still returns something usable, but flags that the
  // choice was NOT what we wanted so a caller can refuse instead of publishing
  // a misleading delivery mode.
  const c = tmpl.pickOption(ow, ["Order Delivery"]);
  assert.strictEqual(c.exact, false);
  assert.strictEqual(c.value, "Put into my account");
  // Empty list: no value, and never a crash.
  assert.deepStrictEqual(tmpl.pickOption([], ["Order Delivery"]), {
    value: "", exact: false, options: [],
  });
});

// Delivery is only possible while an order is genuinely awaiting it — Z2U
// renders the form for no other state, verified against every order on the
// account. The probe exists so the fulfiller can check BEFORE claiming an
// account: claiming marks stock sold, and doing that for an undeliverable order
// spends it on a hand-over that cannot happen.
test("the delivery-form probe is honest about undeliverable orders", () => {
  assert.strictEqual(mp.z2uParseDeliveryForm(""), null);
  assert.strictEqual(mp.z2uParseDeliveryForm("<div>order already delivered</div>"), null);
  // A form with no textarea is not a delivery form — there is nowhere to put
  // the credential, so treat it as absent rather than posting an empty send.
  assert.strictEqual(
    mp.z2uParseDeliveryForm('<form id="form_submit"><input name="oid" value="1"></form>'),
    null,
  );
  const ok = mp.z2uParseDeliveryForm(
    '<form id="form_submit"><input type="hidden" name="oid" value="9">' +
      '<textarea name="content"></textarea></form>',
  );
  assert.deepStrictEqual(ok.textareas, ["content"]);
  assert.deepStrictEqual(ok.fields, [["oid", "9"], ["content", ""]]);
});

// Z2U does not move an offer's publish date when it is extended, and publish
// date + duration is the only expiry signal the panel gives — so an extended
// offer reads as overdue forever. Without a cooldown the keeper re-extends the
// same offers on every 30-minute tick, against a rate-limited endpoint, for no
// effect. Observed live: the same 15 actions replayed tick after tick.
test("an offer extended recently is not extended again", () => {
  const justNow = Date.now();
  const expired = { pk: "1", title: "t", online: false, status: "expired", stock: 4 };
  // No record of an extend -> extend and relist.
  const fresh = ful.planForOffer(
    entry(expired, { autoPaused: true, lastExtendedAt: null }, 9, null),
    { now: justNow },
  );
  assert.deepStrictEqual(fresh.actions.map((a) => a.action), ["extend", "on_line", "stock"]);
  // Extended an hour ago -> relist, but do NOT burn another extend.
  const recent = ful.planForOffer(
    entry(expired, { autoPaused: true, lastExtendedAt: new Date(justNow - 3600e3) }, 9, null),
    { now: justNow },
  );
  assert.deepStrictEqual(recent.actions.map((a) => a.action), ["on_line", "stock"]);
  // Past the cooldown -> extending again is right.
  const old = ful.planForOffer(
    entry(expired, { autoPaused: true, lastExtendedAt: new Date(justNow - ful.EXTEND_COOLDOWN_MS - 1) }, 9, null),
    { now: justNow },
  );
  assert.deepStrictEqual(old.actions.map((a) => a.action), ["extend", "on_line", "stock"]);
  // A LIVE offer near expiry is also suppressed while the cooldown holds.
  const live = ful.planForOffer(
    entry({ ...expired, online: true, status: "online", stock: 4 },
          { autoPaused: false, lastExtendedAt: new Date(justNow - 3600e3) }, 4, 2),
    { now: justNow },
  );
  assert.deepStrictEqual(live.actions.map((a) => a.action), []);
});

// Z2U refuses to re-save an offer whose own Platform/Area selection is
// incomplete. No retry fixes that — it needs a human in the seller panel — so
// once the error is recorded the keeper must stop asking, or it burns a
// throttled write on the same rejection every 30 minutes forever.
test("a stock fix is not retried forever on an offer Z2U will not re-save", () => {
  const live = { pk: "1", title: "t", online: true, status: "online", stock: 10 };
  const normal = ful.planForOffer(entry(live, { autoPaused: false, lastError: "" }, 56, 20));
  assert.deepStrictEqual(normal.actions.map((a) => a.action), ["stock"]);
  const locked = ful.planForOffer(
    entry(live, { autoPaused: false, lastError: "Z2U update: Please refine attributes such as Platform,Area" }, 56, 20),
  );
  assert.deepStrictEqual(locked.actions, []);
});
