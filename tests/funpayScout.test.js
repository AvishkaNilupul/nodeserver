// FunPay has no API, so research reads its public category pages. Each game's
// Twitch-drop category is one node, which makes it a cleaner signal than the
// text searches other markets need — but it also means the whole signal rests
// on scraping markup correctly, and a silent parse failure would read as "this
// game has no competition on FunPay" rather than as an error.
const test = require("node:test");
const assert = require("node:assert");

const { parseFunpayRows } = require("../utils/priceScout");

// Trimmed from a live funpay.com/en/lots/2430/ response, keeping the structure
// that matters: two offers from one seller and one from another.
const PAGE = `
<div class="tc table-hover">
<a href="https://funpay.com/en/lots/offer?id=70173381" class="tc-item" data-online="1">
<div class="tc-desc"><div class="tc-desc-text">Overwatch 2 Twitch Drops 16 ITEMS</div></div>
<div class="tc-user"><div class="media media-user online">
<div class="avatar-photo" data-href="https://funpay.com/en/users/4720521/"></div>
<div class="media-body"><div class="media-user-name">
Spanchez</div></div>
</div></div><div class="tc-price" data-s="1.612132">
<div>1.61 <span class="unit">&euro;</span></div>
</div>
</a>
<a href="https://funpay.com/en/lots/offer?id=73736701" class="tc-item" data-online="1">
<div class="tc-desc"><div class="tc-desc-text">Jynxzi&#039;s Tournament &quot;5 Alpha Pack&quot;</div></div>
<div class="tc-user"><div class="media media-user online">
<div class="avatar-photo" data-href="https://funpay.com/en/users/4720521/"></div>
<div class="media-body"><div class="media-user-name">
Spanchez</div></div>
</div></div><div class="tc-price" data-s="0.500000">
<div>0.50 <span class="unit">&euro;</span></div>
</div>
</a>
<a href="https://funpay.com/en/lots/offer?id=99999999" class="tc-item">
<div class="tc-desc"><div class="tc-desc-text">Other seller bundle</div></div>
<div class="tc-user"><div class="media media-user">
<div class="avatar-photo" data-href="https://funpay.com/en/users/19759410/"></div>
<div class="media-body"><div class="media-user-name">
HoneyDestroyer</div></div>
</div></div><div class="tc-price" data-s="2.000000">
<div>2.00 <span class="unit">&euro;</span></div>
</div>
</a>
</div>`;

test("every offer row on the page is read", () => {
  const rows = parseFunpayRows(PAGE, 1);
  assert.equal(rows.length, 3);
});

test("prices are converted out of the page's currency", () => {
  // FunPay's /en/ pages quote EUR; research works in USD throughout, and a
  // game priced in the wrong currency would tilt its whole demand score.
  const rows = parseFunpayRows(PAGE, 1 / 0.92); // EUR -> USD
  assert.equal(rows[0].price, 1.75);
  assert.equal(rows[2].price, 2.17);
});

test("seller id and name come through, so competition can dedupe", () => {
  const rows = parseFunpayRows(PAGE, 1);
  assert.equal(rows[0].seller, "4720521");
  assert.equal(rows[0].sellerName, "Spanchez");
  // Two of the three offers are the same seller — the point of capturing it.
  assert.equal(new Set(rows.map((r) => r.seller)).size, 2);
});

test("HTML entities in titles are decoded", () => {
  // Titles are a dedupe key for competition, so an encoded one would count as
  // a separate product from its decoded twin.
  const rows = parseFunpayRows(PAGE, 1);
  assert.equal(rows[1].title, `Jynxzi's Tournament "5 Alpha Pack"`);
});

test("FunPay reports no sale counters, and must not invent any", () => {
  // Its rows feed competition and price only. A zero here would read as a
  // proven non-seller rather than as "unknown".
  const rows = parseFunpayRows(PAGE, 1);
  for (const r of rows) assert.equal(r.sold, undefined);
});

test("markup with no offers yields nothing rather than throwing", () => {
  // A layout change or a block page must degrade to "no data", never crash the
  // scan for every other market.
  assert.deepEqual(parseFunpayRows("<html><body>nope</body></html>", 1), []);
  assert.deepEqual(parseFunpayRows("", 1), []);
  assert.deepEqual(parseFunpayRows(null, 1), []);
});

test("a row with no usable price is skipped", () => {
  const broken = `<a class="tc-item"><div class="tc-desc-text">X</div>
    <div class="tc-price" data-s="0"><div>0</div></div></a>`;
  assert.deepEqual(parseFunpayRows(broken, 1), []);
});
