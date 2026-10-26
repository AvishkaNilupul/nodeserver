const test = require("node:test");
const assert = require("node:assert/strict");

const p = require("../utils/funpayPages");

// Hand-written fixtures in FunPay's markup (checked against live pages 2026-10-26).
// Names, ids and prices are made up.
const appData = (userId) =>
  `<body class="x" data-app-data="{&quot;locale&quot;:&quot;en&quot;,&quot;csrf-token&quot;:&quot;tok123abc&quot;,&quot;userId&quot;:${userId}}">`;

const row = (id, { name = "SellerOne", uid = 111, price = 1.25, online = 1, auto = 1, reviews = 900, cls = "tc-item" } = {}) => `
<a href="https://funpay.com/en/lots/offer?id=${id}" class="${cls}" data-online="${online}" data-user="${uid}" data-auto="${auto}">
<div class="tc-desc"><div class="tc-desc-text">🔥 52 DROPS &amp; more 🔥</div></div>
<div class="tc-user"><div class="media media-user online style-circle"><div class="media-left">
<div class="avatar-photo" tabindex="0" data-href="https://funpay.com/en/users/${uid}/" style=""></div></div>
<div class="media-body"><div class="media-user-name">
${name}</div><div class="media-user-reviews"><div class="rating-stars rating-5"></div><span class="rating-mini-count">${reviews}</span></div>
<div class="media-user-info">6 years</div></div></div></div>
<div class="tc-price" data-s="${price}"><div>${price} <span class="unit">$</span></div></div>
</a>`;

test("lots page rows: price, seller, online and auto-delivery flags", () => {
  const html = appData(0) + row("1001") + row("1002", { name: "Other", uid: 222, price: 0.3, online: 0, auto: 0, reviews: 5 }) + row("1001", { cls: "tc-item offer-promo" });
  const rows = p.parseLotsPage(html);
  assert.equal(rows.length, 2, "a promoted duplicate is dropped");
  assert.deepEqual(
    { ...rows[0] },
    {
      offerId: "1001",
      desc: "🔥 52 DROPS & more 🔥",
      sellerId: "111",
      sellerName: "SellerOne",
      reviews: 900,
      stars: 5,
      sellerAge: "6 years",
      online: true,
      autoDelivery: true,
      promoted: false,
      priceUsd: 1.25,
    },
  );
  assert.equal(rows[1].online, false);
  assert.equal(rows[1].autoDelivery, false);
});

const offerPage = (balanceUsd) => `${appData(4242)}
<div class="user-link-name">BuyerName</div>
<div class="param-item"><h5>Short description</h5><div>52 DROPS</div></div>
<div class="param-item"><h5>Detailed description</h5><div>Line one<br>Line two</div></div>
<div class="media-user-name"><a href="https://funpay.com/en/users/111/">SellerOne</a></div>
<form action="https://funpay.com/en/orders/new" method="post" class="mb40">
<input type="hidden" name="csrf_token" value="tok123abc">
<input type="hidden" name="type" value="lot">
<input type="hidden" name="preview" value="1">
<input type="hidden" name="offer_id" value="1001">
<input type="hidden" name="price_guard" value="${Buffer.from("rub:92|usd:1.114|eur:0.993").toString("base64")}">
<select class="form-control" name="method" data-balance-rub="0" data-balance-usd="${balanceUsd}" data-balance-total-usd="${balanceUsd}" data-balance-eur="0">
<option value="0" class="hidden" data-content="&lt;span&gt;Not selected&lt;/span&gt;"></option>
<option value="35" data-cy="usd" data-content="&lt;span class=&quot;payment-title&quot;&gt;Bank card&lt;/span&gt;"></option>
</select>
<input type="text" class="form-control" name="amount" value="1">
</form>`;

test("offer page: descriptions, seller, buy form, price guard, balance", () => {
  const o = p.parseOfferPage(offerPage(7.5));
  assert.equal(o.offerId, "1001");
  assert.equal(o.csrfToken, "tok123abc");
  assert.equal(o.userId, 4242);
  assert.equal(o.short, "52 DROPS");
  assert.equal(o.detail, "Line one\nLine two");
  assert.equal(o.sellerId, "111");
  assert.equal(o.sellerName, "SellerOne");
  assert.deepEqual(o.priceGuard, { rub: 92, usd: 1.114, eur: 0.993 });
  assert.equal(o.buyForm.action, "https://funpay.com/en/orders/new");
  assert.deepEqual(Object.keys(o.buyForm.fields), ["csrf_token", "type", "preview", "offer_id", "price_guard"]);
  assert.equal(o.buyForm.balance.usd, 7.5);
  assert.deepEqual(
    o.buyForm.methods.map((m) => m.id),
    ["0", "35"],
  );
  assert.deepEqual(p.parseSessionUser(offerPage(0)), { userId: 4242, username: "BuyerName" });
});

test("a guest page has user id 0 and no username", () => {
  assert.deepEqual(p.parseSessionUser(appData(0) + "<div>no top bar</div>"), { userId: 0, username: null });
  assert.equal(p.parseAppData("<html>no body attr</html>"), null);
});

test("seller profile: rating, review count, newest reviews", () => {
  const html = `${appData(0)}
<h5 class="text-bold">Registration date</h5> <div class="text-nowrap"> 4 January 2021, 17:57<br> 6 years ago </div>
<div class="rating-value text-nowrap inline-block-vat mr10"><span class="big">4.9</span> <span>out of 5</span></div>
<div class="rating-full-count"><a href="#">1 923 reviews</a></div>
<div class="review-container"><div class="review-item"><div class="review-item-row"><div class="review-compiled-review"><div class="review-item-user">
<div class="review-item-rating pull-right hidden-xs"><div class="rating"><div class="rating5"></div></div></div>
<div class="review-item-date">This month</div><div class="review-item-detail">Rocket League, 1 $</div></div>
<div class="review-item-text"> Fast, all good </div></div></div></div></div>`;
  const u = p.parseUserPage(html);
  assert.equal(u.rating, 4.9);
  assert.equal(u.reviewCount, 1923);
  assert.equal(u.registered, "4 January 2021, 17:57");
  assert.deepEqual(u.recentReviews, [{ stars: 5, date: "This month", detail: "Rocket League, 1 $", text: "Fast, all good" }]);
});

test("order page: paid product secrets and status", () => {
  const html = `${appData(4242)}<a href="https://funpay.com/en/orders/ABCD1234/">#ABCD1234</a>
<div class="param-item"><h5>Paid product</h5><div><span class="secret-placeholder">fakeuser_01 : Pa55word!x</span></div></div>`;
  const o = p.parseOrderPage(html);
  assert.equal(o.orderId, "ABCD1234");
  assert.equal(o.status, "paid");
  assert.deepEqual(o.secrets, ["fakeuser_01 : Pa55word!x"]);
  assert.equal(p.parseOrderPage(html + '<span class="text-success">Closed</span>').status, "closed");
  assert.equal(p.parseOrderPage(html + '<span class="text-warning">Refund</span>').status, "refunded");
  assert.deepEqual(p.parseOrderPage(appData(1) + "<div>nothing yet</div>").secrets, []);
});
