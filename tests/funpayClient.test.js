const test = require("node:test");
const assert = require("node:assert/strict");

const fc = require("../utils/funpayClient");
const { parseCookieInput, cookieHeader, createSession } = fc;

// No network: every session runs on a scripted fake transport that records each request.
// Everything below is made up — cookie values, user / offer / order ids, names and prices.
// The markup follows tests/funpayPages.test.js (checked against live pages 2026-10-26).
const GOLDEN = "gk0fake00000000000000000000000a1"; // a golden_key is 32 letters/digits
const SESSID = "sessfake0001";
const SESSID_SET = "sessfake0002"; // handed out by a Set-Cookie in the middle of a buy
const CSRF = "csrf-fake-7q2w";
const CONFIRM_KEY = "cfm-fake-5k9";
const OFFER_ID = "900001";
const OFFER_URL = `https://funpay.com/en/lots/offer?id=${OFFER_ID}`;
const ORDERS_NEW = "https://funpay.com/en/orders/new";

// A scripted FunPay: answers the queued responses in order and records every request.
// A request beyond the script throws inside the session, so a stray request fails the test.
function fakeFunpay(...script) {
  const calls = [];
  const transport = async (req) => {
    calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body });
    if (!script.length) throw new Error(`unexpected request ${req.method} ${req.url}`);
    const next = script.shift();
    const res = typeof next === "function" ? await next(req) : next;
    return { status: 200, headers: {}, body: "", ...res };
  };
  return { transport, calls };
}

const sessionOn = (fake, cookies = { golden_key: GOLDEN, PHPSESSID: SESSID }) => createSession({ cookies, transport: fake.transport, gapMs: 0 });
const redirect = (location, status = 302) => ({ status, headers: { location } });
const formOf = (call) => Object.fromEntries(new URLSearchParams(call.body || ""));
const cookiesOf = (call) =>
  Object.fromEntries(
    String(call.headers.Cookie || "")
      .split("; ")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
const lines = (calls) => calls.map((c) => `${c.method} ${c.url}`);
const steps = (result) => result.trace.map((t) => t.step);

// ---------------------------------------------------------------- FunPay pages

const appData = (userId) =>
  `<body class="x" data-app-data="{&quot;locale&quot;:&quot;en&quot;,&quot;csrf-token&quot;:&quot;${CSRF}&quot;,&quot;userId&quot;:${userId}}">`;
const topBar = (name) => `<div class="user-link-name">${name}</div>`;
const priceGuard = (usd) => Buffer.from(`rub:${Math.round(usd * 90)}|usd:${usd}|eur:${(usd * 0.9).toFixed(3)}`).toString("base64");

// An offer page; signed in it carries the buy form (POST /orders/new with preview=1).
function offerPage({ userId = 5150, form = true, guard = true, guardUsd = 1.2, balanceUsd = 10 } = {}) {
  const buyForm = `<form action="${ORDERS_NEW}" method="post" class="mb40">
<input type="hidden" name="csrf_token" value="${CSRF}">
<input type="hidden" name="type" value="lot">
<input type="hidden" name="preview" value="1">
<input type="hidden" name="offer_id" value="${OFFER_ID}">
${guard ? `<input type="hidden" name="price_guard" value="${priceGuard(guardUsd)}">` : ""}
<select class="form-control" name="method" data-balance-rub="0" data-balance-usd="${balanceUsd}" data-balance-total-usd="${balanceUsd}" data-balance-eur="0">
<option value="0" class="hidden" data-content="&lt;span&gt;Not selected&lt;/span&gt;"></option>
<option value="21" data-cy="rub" data-content="&lt;span&gt;Method R&lt;/span&gt;"></option>
<option value="35" data-cy="usd" data-content="&lt;span&gt;Method U&lt;/span&gt;"></option>
</select>
<input type="text" class="form-control" name="amount" value="1">
</form>`;
  return `${appData(userId)}${userId ? topBar("TestBuyer") : ""}
<div class="param-item"><h5>Short description</h5><div>Made-up item bundle</div></div>
<div class="media-user-name"><a href="https://funpay.com/en/users/700007/">SellerAlpha</a></div>
${form ? buyForm : '<div class="alert alert-warning">This offer is not available</div>'}`;
}

// The answer to the preview POST: a second form (same action) that confirms the purchase.
function previewPage({ sum = "1.20", guardUsd = 1.2, extra = "" } = {}) {
  return `${appData(5150)}${topBar("TestBuyer")}
<h1>Order confirmation</h1>
<form action="${ORDERS_NEW}" method="post" class="form-order">
<input type="hidden" name="csrf_token" value="${CSRF}">
<input type="hidden" name="type" value="lot">
<input type="hidden" name="preview" value="1">
<input type="hidden" name="offer_id" value="${OFFER_ID}">
<input type="hidden" name="amount" value="1">
<input type="hidden" name="method" value="35">
<input type="hidden" name="price_guard" value="${priceGuard(guardUsd)}">
${sum == null ? "" : `<input type="hidden" name="sum" value="${sum}">`}
<input type="hidden" name="confirm_key" value="${CONFIRM_KEY}">
<input type="hidden" name="label" value="Bundle &amp; more">
<button type="submit" class="btn btn-primary">Pay</button>
</form>${extra}`;
}

const orderPage = (id) => `${appData(5150)}${topBar("TestBuyer")}<a href="https://funpay.com/en/orders/${id}/">#${id}</a>
<div class="param-item"><h5>Paid product</h5><div><span class="secret-placeholder">fakeuser_02 : FakePass!2</span></div></div>`;

async function buy(script, args = {}) {
  const fake = fakeFunpay(...script);
  const result = await sessionOn(fake).buyOne({ offerId: OFFER_ID, maxPriceUsd: 1.5, ...args });
  return { result, calls: fake.calls };
}

// ---------------------------------------------------------------- 1. cookie input

test("parseCookieInput: a Cookie header, with or without the leading 'Cookie:'", () => {
  const want = { golden_key: GOLDEN, PHPSESSID: SESSID, cookie_prefs: "1" };
  assert.deepEqual(parseCookieInput(`golden_key=${GOLDEN}; PHPSESSID=${SESSID}; cookie_prefs=1`), want);
  assert.deepEqual(parseCookieInput(`Cookie: golden_key=${GOLDEN}; PHPSESSID=${SESSID}; cookie_prefs=1`), want);
  assert.deepEqual(parseCookieInput(`  cookie:golden_key=${GOLDEN};PHPSESSID=${SESSID};cookie_prefs=1;\n`), want);
  assert.deepEqual(parseCookieInput("golden_key = abc ; _ga=GA1.1.1=2=="), { golden_key: "abc", _ga: "GA1.1.1=2==" }, "'=' inside a value is kept");
});

test("parseCookieInput: a cookie-extension JSON export keeps the funpay.com cookies only", () => {
  const exported = [
    { domain: ".funpay.com", name: "golden_key", value: GOLDEN, path: "/", httpOnly: true, secure: true },
    { domain: "funpay.com", name: "PHPSESSID", value: SESSID, path: "/" },
    { domain: ".google.com", name: "NID", value: "other-site-1" },
    { domain: "example.org", name: "sid", value: "other-site-2" },
    { domain: "funpay.com.example.net", name: "trap", value: "other-site-3" },
  ];
  const want = { golden_key: GOLDEN, PHPSESSID: SESSID };
  assert.deepEqual(parseCookieInput(JSON.stringify(exported)), want);
  assert.deepEqual(parseCookieInput(JSON.stringify({ cookies: exported }, null, 2)), want, "{ cookies: [...] } wrapper");
});

// BUG — utils/funpayClient.js:35: the domain test /funpay\.com$/ is a bare suffix match with no
// label boundary, so a look-alike domain ("notfunpay.com") counts as FunPay and its cookie is
// kept (and later sent to funpay.com). Same `keep` is used for Netscape lines.
test("parseCookieInput drops look-alike domains such as notfunpay.com", () => {
  const exported = [
    { domain: ".funpay.com", name: "golden_key", value: GOLDEN },
    { domain: ".notfunpay.com", name: "sid", value: "other-site-4" },
  ];
  assert.deepEqual(parseCookieInput(JSON.stringify(exported)), { golden_key: GOLDEN });
});

test("parseCookieInput: Netscape cookie-file lines", () => {
  const file = [
    "# Netscape HTTP Cookie File",
    "# This is a generated file! Do not edit.",
    "",
    `.funpay.com\tTRUE\t/\tTRUE\t1830000000\tgolden_key\t${GOLDEN}`,
    `funpay.com\tFALSE\t/\tFALSE\t0\tPHPSESSID\t${SESSID}`,
    ".example.org\tTRUE\t/\tFALSE\t0\tsid\tother-site",
  ].join("\r\n");
  assert.deepEqual(parseCookieInput(file), { golden_key: GOLDEN, PHPSESSID: SESSID });
});

// BUG — utils/funpayClient.js:51: curl-style cookie files mark HttpOnly cookies by prefixing the
// domain with "#HttpOnly_"; the `!line.startsWith("#")` test skips those lines as comments, so an
// HttpOnly golden_key in such a file is silently lost (fail-safe: saveSession then finds no key).
test("parseCookieInput keeps Netscape lines marked #HttpOnly_", () => {
  const file = ["# Netscape HTTP Cookie File", `#HttpOnly_.funpay.com\tTRUE\t/\tTRUE\t1830000000\tgolden_key\t${GOLDEN}`].join("\n");
  assert.deepEqual(parseCookieInput(file), { golden_key: GOLDEN });
});

test("parseCookieInput: a bare golden_key; empty input gives an empty jar", () => {
  assert.deepEqual(parseCookieInput(GOLDEN), { golden_key: GOLDEN });
  assert.deepEqual(parseCookieInput(`  ${GOLDEN}\n`), { golden_key: GOLDEN });
  for (const empty of ["", "  \n ", null, undefined]) assert.deepEqual(parseCookieInput(empty), {});
  assert.deepEqual(parseCookieInput("hello"), {}, "neither a key nor name=value");
});

test("cookieHeader: name=value pairs joined by '; ', empty values left out", () => {
  const jar = { golden_key: GOLDEN, PHPSESSID: SESSID };
  assert.equal(cookieHeader(jar), `golden_key=${GOLDEN}; PHPSESSID=${SESSID}`);
  assert.equal(cookieHeader({ a: "1", gone: "", nul: null, b: "x=y" }), "a=1; b=x=y");
  assert.equal(cookieHeader({}), "");
  assert.equal(cookieHeader(null), "");
  assert.deepEqual(parseCookieInput(cookieHeader(jar)), jar, "round trip");
});

// ---------------------------------------------------------------- 2. cookie jar

test("a Set-Cookie is sent on the next request and a deleted cookie is dropped", async () => {
  const fake = fakeFunpay(
    { status: 302, headers: { location: "/en/", "set-cookie": ["PHPSESSID=sessfake0009; path=/; HttpOnly", "locale=en; path=/"] } },
    { body: appData(5150) },
    { headers: { "set-cookie": "PHPSESSID=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/" } },
    { headers: { "set-cookie": ["locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"] } },
    {},
  );
  const start = { golden_key: GOLDEN };
  const s = createSession({ cookies: start, transport: fake.transport, gapMs: 0 });
  await s.get("/"); // 302 → /en/ (two requests)
  await s.get("/en/a");
  await s.get("/en/b");
  await s.get("/en/c");
  assert.equal(fake.calls.length, 5);
  assert.deepEqual(cookiesOf(fake.calls[0]), { golden_key: GOLDEN });
  assert.deepEqual(cookiesOf(fake.calls[1]), { golden_key: GOLDEN, PHPSESSID: "sessfake0009", locale: "en" }, "the redirect hop carries it");
  assert.deepEqual(cookiesOf(fake.calls[2]), { golden_key: GOLDEN, PHPSESSID: "sessfake0009", locale: "en" });
  assert.deepEqual(cookiesOf(fake.calls[3]), { golden_key: GOLDEN, locale: "en" }, "PHP's 'deleted' marker removes it");
  assert.deepEqual(cookiesOf(fake.calls[4]), { golden_key: GOLDEN }, "an epoch expiry removes it");

  assert.deepEqual(s.cookies(), { golden_key: GOLDEN });
  assert.deepEqual(start, { golden_key: GOLDEN }, "the jar passed in is copied, never mutated");
  const out = s.cookies();
  out.golden_key = "tampered";
  assert.equal(s.cookies().golden_key, GOLDEN, "cookies() hands out a copy");
});

// ---------------------------------------------------------------- 3. session check, reads

test("checkSession: a signed-in home page is ok with the user id and name", async () => {
  const fake = fakeFunpay({ body: `${appData(5150)}${topBar("TestBuyer")}<main>home</main>` });
  assert.deepEqual(await sessionOn(fake).checkSession(), { ok: true, status: 200, userId: 5150, username: "TestBuyer" });
  assert.deepEqual(lines(fake.calls), ["GET https://funpay.com/en/"]);
  assert.deepEqual(cookiesOf(fake.calls[0]), { golden_key: GOLDEN, PHPSESSID: SESSID });
});

test("checkSession: a guest page (expired cookies) or an error page is not ok", async () => {
  const guest = fakeFunpay({ body: `${appData(0)}<main>home</main>` });
  assert.deepEqual(await sessionOn(guest).checkSession(), { ok: false, status: 200, userId: 0, username: null });
  const down = fakeFunpay({ status: 503, body: `${appData(5150)}${topBar("TestBuyer")}` });
  assert.equal((await sessionOn(down).checkSession()).ok, false);
});

test("get() follows funpay.com redirects (at most 3 hops) and never an outside one", async () => {
  const hops = fakeFunpay(redirect("/en/"), redirect("https://funpay.com/en/lots/1/"), { body: "landed" });
  const res = await sessionOn(hops).get("/");
  assert.equal(res.status, 200);
  assert.equal(res.html, "landed");
  assert.deepEqual(lines(hops.calls), ["GET https://funpay.com/", "GET https://funpay.com/en/", "GET https://funpay.com/en/lots/1/"]);

  const off = fakeFunpay(redirect("https://login.example.net/sso?from=funpay"));
  const out = await sessionOn(off).get("/en/");
  assert.equal(out.status, 302);
  assert.equal(out.location, "https://login.example.net/sso?from=funpay");
  assert.equal(off.calls.length, 1, "the outside Location is never requested");

  const loop = fakeFunpay(redirect("/en/1"), redirect("/en/2"), redirect("/en/3"), redirect("/en/4"));
  assert.equal((await sessionOn(loop).get("/en/")).status, 302);
  assert.equal(loop.calls.length, 4, "the first request + 3 hops");
});

test("readOffer and readOrder read the signed-in pages; a non-200 answer gives null", async () => {
  const fake = fakeFunpay({ body: offerPage() }, { body: orderPage("ABCD1234") }, { status: 404, body: "gone" });
  const s = sessionOn(fake);
  const offer = await s.readOffer(OFFER_ID);
  assert.equal(offer.status, 200);
  assert.equal(offer.offer.offerId, OFFER_ID);
  assert.equal(offer.offer.userId, 5150);
  assert.deepEqual(await s.readOrder("ABCD1234"), {
    status: 200,
    order: { orderId: "ABCD1234", status: "paid", secrets: ["fakeuser_02 : FakePass!2"], hasPaidBlock: true },
  });
  assert.deepEqual(await s.readOrder("ZZZZ9999"), { status: 404, order: null });
  assert.deepEqual(lines(fake.calls), [`GET ${OFFER_URL}`, "GET https://funpay.com/en/orders/ABCD1234/", "GET https://funpay.com/en/orders/ZZZZ9999/"]);
});

// ---------------------------------------------------------------- 4. buyOne refuses before paying

test("buyOne without a positive maxPriceUsd stops before any request", async () => {
  for (const maxPriceUsd of [undefined, null, 0, -1, "", "abc", NaN]) {
    const { result, calls } = await buy([], { maxPriceUsd });
    assert.deepEqual(result, { ok: false, reason: "no maximum price given", trace: [] }, String(maxPriceUsd));
    assert.equal(calls.length, 0);
  }
});

for (const [when, answer, reason] of [
  ["not signed in (guest offer page)", { body: offerPage({ userId: 0 }) }, /^not signed in/],
  ["the offer page has no buy form", { body: offerPage({ form: false }) }, /^no buy form on the offer page/],
  ["FunPay's price guard is above the maximum", { body: offerPage({ guardUsd: 1.6 }) }, /^price 1\.6 is above the maximum 1\.5$/],
  ["FunPay's price cannot be read", { body: offerPage({ guard: false }) }, /^could not read FunPay's price/],
  ["the FunPay balance is below the price", { body: offerPage({ guardUsd: 1.2, balanceUsd: 1.19 }) }, /^FunPay balance \$1\.19 is below the price \$1\.20/],
  ["the offer page answers 404", { status: 404, body: "<html>Not found</html>" }, /^offer page answered 404$/],
]) {
  test(`buyOne stops with no POST when ${when}`, async () => {
    const { result, calls } = await buy([answer]);
    assert.equal(result.ok, false);
    assert.match(result.reason, reason);
    assert.deepEqual(lines(calls), [`GET ${OFFER_URL}`], "only the offer page was read");
    assert.deepEqual(steps(result), ["offer"]);
  });
}

// ---------------------------------------------------------------- 5. never off funpay.com

test("buyOne stops when the preview redirects off funpay.com, and sends nothing after it", async () => {
  for (const location of ["https://pay.gateway.example/checkout/abc123?session=gw-fake", "//pay.gateway.example/checkout/abc123?session=gw-fake"]) {
    const { result, calls } = await buy([{ body: offerPage() }, redirect(location, 303)]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /outside payment page/);
    assert.deepEqual(lines(calls), [`GET ${OFFER_URL}`, `POST ${ORDERS_NEW}`]);
    assert.equal(result.trace.at(-1).redirect, "pay.gateway.example/checkout/abc123");
  }
});

test("buyOne stops when the confirm redirects off funpay.com; an outside offer-page redirect is never followed", async () => {
  const confirmOff = await buy([{ body: offerPage() }, { body: previewPage() }, redirect("https://pay.gateway.example/checkout/abc123")]);
  assert.equal(confirmOff.result.ok, false);
  assert.match(confirmOff.result.reason, /outside payment page/);
  assert.deepEqual(lines(confirmOff.calls), [`GET ${OFFER_URL}`, `POST ${ORDERS_NEW}`, `POST ${ORDERS_NEW}`]);

  const offerOff = await buy([redirect("https://login.example.net/sso")]);
  assert.equal(offerOff.result.ok, false);
  assert.equal(offerOff.result.reason, "offer page answered 302");
  assert.equal(offerOff.calls.length, 1);
});

// ---------------------------------------------------------------- 6. a successful buy

test("buyOne: the preview answers 302 to the new order → bought, no confirm step", async () => {
  const { result, calls } = await buy([{ body: offerPage({ guardUsd: 1.2 }) }, redirect("https://funpay.com/en/orders/ABCD1234/")]);
  assert.equal(result.ok, true);
  assert.equal(result.orderId, "ABCD1234");
  assert.equal(result.chargedUsd, 1.2);
  assert.equal(result.reason, undefined);
  assert.deepEqual(steps(result), ["offer", "preview"]);
  assert.equal(result.trace[1].redirect, "funpay.com/en/orders/ABCD1234/");

  assert.deepEqual(lines(calls), [`GET ${OFFER_URL}`, `POST ${ORDERS_NEW}`]);
  const post = calls[1];
  assert.deepEqual(formOf(post), {
    csrf_token: CSRF,
    type: "lot",
    preview: "1",
    offer_id: OFFER_ID,
    price_guard: priceGuard(1.2),
    amount: "1",
    method: "35", // the USD method, never "0"
  });
  assert.match(post.headers["Content-Type"], /^application\/x-www-form-urlencoded/);
  assert.equal(post.headers.Origin, "https://funpay.com");
  assert.equal(post.headers.Referer, OFFER_URL);
  assert.deepEqual(cookiesOf(post), { golden_key: GOLDEN, PHPSESSID: SESSID });
});

test("buyOne: preview page with a confirm form → confirm POST without `preview` → bought", async () => {
  const { result, calls } = await buy([{ body: offerPage({ guardUsd: 1.2 }) }, { body: previewPage({ sum: "1.20" }) }, redirect("/orders/ABCD1234/")]);
  assert.deepEqual({ ok: result.ok, orderId: result.orderId, chargedUsd: result.chargedUsd }, { ok: true, orderId: "ABCD1234", chargedUsd: 1.2 });
  assert.deepEqual(steps(result), ["offer", "preview", "confirm"]);
  assert.equal(result.trace[2].redirect, "funpay.com/orders/ABCD1234/");

  assert.deepEqual(lines(calls), [`GET ${OFFER_URL}`, `POST ${ORDERS_NEW}`, `POST ${ORDERS_NEW}`]);
  assert.equal(formOf(calls[1]).preview, "1", "the first POST is the preview");
  const confirm = calls[2];
  const sent = formOf(confirm);
  assert.equal("preview" in sent, false, "the preview flag is dropped");
  assert.deepEqual(sent, {
    csrf_token: CSRF,
    type: "lot",
    offer_id: OFFER_ID,
    amount: "1",
    method: "35",
    price_guard: priceGuard(1.2),
    sum: "1.20",
    confirm_key: CONFIRM_KEY,
    label: "Bundle & more", // entity-decoded
  });
  assert.equal(confirm.headers.Referer, ORDERS_NEW);
  assert.equal(confirm.headers.Origin, "https://funpay.com");

  // A 200 answer to the confirm is NOT read for an order number, even when it looks like
  // an order page: a page can link an earlier order. The money may be gone, so it is a
  // stop marked uncertain (the engine sends it to the owner), never a success or a retry.
  const page = await buy([{ body: offerPage() }, { body: previewPage() }, { body: orderPage("ABCD1234") }]);
  assert.equal(page.result.ok, false);
  assert.equal(page.result.uncertain, true);
  assert.equal(page.result.reason, "no order number after confirming (HTTP 200)");
  assert.equal(page.calls.length, 3);

  // a confirm redirecting to an order page through one more hop is followed (GET only)
  const hop = await buy([{ body: offerPage() }, { body: previewPage() }, redirect("/en/orders/after?x=1"), redirect("/en/orders/ABCD1234/"), { body: orderPage("ABCD1234") }]);
  assert.equal(hop.result.ok, true);
  assert.equal(hop.result.orderId, "ABCD1234");
  assert.deepEqual(lines(hop.calls).slice(3), ["GET https://funpay.com/en/orders/after?x=1", "GET https://funpay.com/en/orders/ABCD1234/"]);
});

test("stops after a purchase request are marked uncertain; refusals before it are not", async () => {
  const refused = await buy([{ body: offerPage({ guardUsd: 2 }) }], { maxPriceUsd: 1.5 });
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.uncertain, undefined);
  const noForm = await buy([{ body: offerPage() }, { body: `${appData(5150)}<div>?</div>` }]);
  assert.equal(noForm.result.uncertain, true);
  const offsite = await buy([{ body: offerPage() }, redirect("https://pay.gateway.example/x")]);
  assert.equal(offsite.result.uncertain, undefined, "an outside payment page is never followed, nothing is paid");
});

test("the confirm form must state a readable price within the maximum", async () => {
  const noPrice = previewPage({ sum: null }).replace(/<input type="hidden" name="price_guard"[^>]*>/, "");
  const r1 = await buy([{ body: offerPage() }, { body: noPrice }]);
  assert.equal(r1.result.reason, "confirm page shows no price — stopped before paying");
  assert.equal(r1.calls.length, 2);
  const r2 = await buy([{ body: offerPage() }, { body: previewPage({ sum: "about 1.2" }) }]);
  assert.equal(r2.result.reason, "confirm page total could not be read — stopped before paying");
  const r3 = await buy([{ body: offerPage() }, { body: previewPage({ sum: null, guardUsd: 1.4 }) }, redirect("/orders/ABCD1234/")]);
  assert.equal(r3.result.ok, true);
  assert.equal(r3.result.chargedUsd, 1.4, "the confirmed price is what is counted against the cap");
});

test("the session is never sent anywhere but https://funpay.com", async () => {
  const fake = fakeFunpay();
  const s = sessionOn(fake);
  await assert.rejects(s.request("GET", "http://funpay.com/en/"), /refusing to send the FunPay session/);
  await assert.rejects(s.request("GET", "https://evil.example/"), /refusing to send the FunPay session/);
  assert.equal(fake.calls.length, 0);
  const viaHttp = fakeFunpay(redirect("http://funpay.com/en/"));
  const res = await sessionOn(viaHttp).get("/en/");
  assert.equal(res.status, 302, "a redirect to plain http is not followed");
  assert.equal(viaHttp.calls.length, 1);
});

test("buyOne stops on an unexpected preview or confirm answer", async () => {
  const noForm = await buy([{ body: offerPage() }, { body: `${appData(5150)}<div class="alert">Something went wrong</div>` }]);
  assert.equal(noForm.result.reason, "unexpected answer to the order preview — no confirm form");
  assert.equal(noForm.calls.length, 2);

  const serverError = await buy([{ body: offerPage() }, { status: 500, body: previewPage() }]);
  assert.equal(serverError.result.reason, "unexpected answer to the order preview — no confirm form");
  assert.equal(serverError.calls.length, 2);

  const noOrder = await buy([{ body: offerPage() }, { body: previewPage() }, { body: `${appData(5150)}<div>Thank you</div>` }]);
  assert.equal(noOrder.result.ok, false);
  assert.equal(noOrder.result.reason, "no order number after confirming (HTTP 200)");
  assert.equal(noOrder.calls.length, 3);
});

// BUG — utils/funpayClient.js:193 + 196: on a 200 preview answer orderFrom() takes the FIRST
// "/orders/<ID>/" link anywhere in the page as the NEW order, before the confirm form is looked
// for. A preview page that has its confirm form but also links an earlier order (e.g. a chat line
// about a previous purchase from the same seller) makes buyOne return ok:true with that OLD id and
// never send the confirm — the caller would then read the old order's delivered login.
test("a preview page with a confirm form is confirmed even when it links an earlier order", async () => {
  const oldOrder = '<div class="chat-msg-text">Order <a href="https://funpay.com/en/orders/OLDX0001/">#OLDX0001</a> closed</div>';
  const { result, calls } = await buy([{ body: offerPage() }, { body: previewPage({ extra: oldOrder }) }, redirect("/orders/ABCD1234/")]);
  assert.equal(calls.length, 3, "the confirm POST is sent");
  assert.equal(result.orderId, "ABCD1234");
});

// ---------------------------------------------------------------- 7. confirm-page sum guard

test("a confirm form whose sum is above 1.05 × the maximum stops before confirming", async () => {
  for (const sum of ["1.60", "1,60"]) {
    const { result, calls } = await buy([{ body: offerPage({ guardUsd: 1.2 }) }, { body: previewPage({ sum }) }], { maxPriceUsd: 1.5 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "confirm page asks 1.6, above the maximum");
    assert.equal(calls.length, 2, "no confirm POST");
    assert.deepEqual(steps(result), ["offer", "preview"]);
  }
  // within the 5 % allowance (1.57 ≤ 1.575) it goes ahead
  const ok = await buy([{ body: offerPage({ guardUsd: 1.2 }) }, { body: previewPage({ sum: "1.57" }) }, redirect("/orders/ABCD1234/")], {
    maxPriceUsd: 1.5,
  });
  assert.equal(ok.result.ok, true);
  assert.equal(ok.calls.length, 3);
});

// BUG — utils/funpayClient.js:199-211: any form under https://funpay.com/(en/)orders/ on a 200
// preview answer is POSTed with `preview` removed, and its price is re-checked ONLY through an
// input literally named "sum"; the form's own price_guard is never compared with maxPriceUsd. If
// FunPay answers the preview with the buy form again (e.g. the seller raised the price: new
// price_guard, no sum), buyOne places the order at the new price — above the maximum — and still
// reports chargedUsd = the OLD price (the 24 h spend cap under-counts).
test("a preview answer whose price_guard is above the maximum stops before confirming", async () => {
  const { result, calls } = await buy([{ body: offerPage({ guardUsd: 1.2 }) }, { body: offerPage({ guardUsd: 2.5 }) }, redirect("/orders/ABCD1234/")], {
    maxPriceUsd: 1.5,
  });
  assert.equal(calls.length, 2, "no second POST");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------- 8. one request at a time

test("requests are serialised: two calls started together reach FunPay one after the other", async () => {
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport = async (req) => {
    const { pathname, search } = new URL(req.url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start ${pathname}${search}`);
    // the first call is the slow one: run in parallel, the second would finish first
    await new Promise((r) => setTimeout(r, pathname === "/en/" ? 30 : 1));
    events.push(`end ${pathname}${search}`);
    inFlight--;
    return { status: 200, headers: {}, body: `${appData(5150)}${topBar("TestBuyer")}` };
  };
  const s = createSession({ cookies: { golden_key: GOLDEN }, transport, gapMs: 0 });
  const [who, offer] = await Promise.all([s.checkSession(), s.readOffer(OFFER_ID)]);
  assert.equal(who.ok, true);
  assert.equal(offer.status, 200);
  assert.equal(maxInFlight, 1, "never two requests in flight");
  assert.deepEqual(events, ["start /en/", "end /en/", `start /en/lots/offer?id=${OFFER_ID}`, `end /en/lots/offer?id=${OFFER_ID}`]);
});

test("a failed request does not jam the queue", async () => {
  const seen = [];
  const transport = async (req) => {
    seen.push(req.url);
    if (req.url.endsWith("/boom/")) throw new Error("socket hang up");
    return { status: 200, headers: {}, body: "" };
  };
  const s = createSession({ cookies: {}, transport, gapMs: 0 });
  const [a, b] = await Promise.allSettled([s.request("GET", "/boom/"), s.request("GET", "/en/")]);
  assert.equal(a.status, "rejected");
  assert.match(a.reason.message, /socket hang up/);
  assert.equal(b.status, "fulfilled");
  assert.equal(b.value.status, 200);
  assert.deepEqual(seen, ["https://funpay.com/boom/", "https://funpay.com/en/"]);
});

test("requests are spaced by gapMs, start to start (default 1.5 s)", async () => {
  assert.equal(fc.FUNPAY_GAP_MS, 1500);
  const starts = [];
  const transport = async () => {
    starts.push(Date.now());
    return { status: 200, headers: {}, body: "" };
  };
  const s = createSession({ cookies: {}, transport, gapMs: 40 });
  await Promise.all([s.request("GET", "/a"), s.request("GET", "/b"), s.request("GET", "/c")]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 35, `gap 1: ${starts[1] - starts[0]} ms`);
  assert.ok(starts[2] - starts[1] >= 35, `gap 2: ${starts[2] - starts[1]} ms`);
});

// ---------------------------------------------------------------- 9. no secret in the trace

test("the result and trace never carry a cookie value, the CSRF token or any form value", async () => {
  const runs = [
    // a Set-Cookie on the offer page answer, then preview → confirm → order
    await buy([{ headers: { "set-cookie": `PHPSESSID=${SESSID_SET}; path=/; HttpOnly` }, body: offerPage() }, { body: previewPage() }, redirect("/orders/ABCD1234/")]),
    await buy([{ body: offerPage() }, redirect("https://funpay.com/en/orders/ABCD1234/")]),
    await buy([{ body: offerPage() }, redirect("https://pay.gateway.example/checkout/abc123")]),
    await buy([{ body: offerPage() }, { body: previewPage({ sum: "9.99" }) }]),
    await buy([{ body: offerPage({ balanceUsd: 0 }) }]),
    await buy([{ body: offerPage({ userId: 0 }) }]),
  ];
  // the requests did carry them, so the check below means something
  assert.equal(cookiesOf(runs[0].calls[1]).PHPSESSID, SESSID_SET);
  assert.equal(formOf(runs[0].calls[2]).confirm_key, CONFIRM_KEY);
  assert.equal(formOf(runs[0].calls[2]).csrf_token, CSRF);

  const secrets = [GOLDEN, SESSID, SESSID_SET, CSRF, CONFIRM_KEY, priceGuard(1.2)];
  const traceKeys = ["step", "status", "path", "redirect", "signedIn", "form", "fields"];
  for (const { result } of runs) {
    const text = JSON.stringify(result);
    for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked ${secret} in ${text}`);
    for (const entry of result.trace) for (const key of Object.keys(entry)) assert.ok(traceKeys.includes(key), `unexpected trace key ${key}`);
  }
  // field NAMES are what the trace keeps
  assert.ok(runs[0].result.trace[2].fields.includes("csrf_token"));
  assert.ok(!runs[0].result.trace[2].fields.includes("preview"));
});
