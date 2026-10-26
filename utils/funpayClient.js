// FunPay as a BUYER, through the owner's own browser session (no public buyer API).
//
// What it can do: check the session (who is signed in, FunPay balance), read an offer
// page signed in, buy ONE unit of an offer paid from the FunPay balance, and read an
// order page for the goods the seller auto-delivered.
//
// Money rules enforced here, whatever the caller asks:
//   - only ever pays from the FunPay balance: it refuses when the balance is short and
//     never follows a redirect off funpay.com (a card / payment-gateway page);
//   - refuses when FunPay's own price guard is above the caller's maximum;
//   - one request at a time, spaced out (FUNPAY_GAP_MS), nothing in parallel;
//   - no secret ever goes into the trace (paths, status codes and field NAMES only).
//
// The two-step order form (preview → confirm) is read from what FunPay returns, so a
// change on FunPay's side stops the purchase with a trace instead of guessing.

const axios = require("axios");
const pages = require("./funpayPages");

const BASE = "https://funpay.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FUNPAY_GAP_MS = 1500;
const TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- cookies

// Accepts a Cookie header ("golden_key=…; PHPSESSID=…"), a browser-extension JSON
// export ([{name,value,domain},…]), Netscape cookie-file lines, or a bare golden_key.
function parseCookieInput(input) {
  const text = String(input || "").trim();
  const jar = {};
  if (!text) return jar;
  const keep = (name, value, domain) => {
    if (!name || value == null) return;
    if (domain && !/funpay\.com$/i.test(String(domain).replace(/^\./, ""))) return;
    jar[String(name).trim()] = String(value).trim();
  };
  if (/^[\[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : Array.isArray(data.cookies) ? data.cookies : [];
      for (const c of list) keep(c.name, c.value, c.domain);
      return jar;
    } catch (_) {
      /* fall through to the text formats */
    }
  }
  if (/\t/.test(text) && /funpay\.com/i.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const f = line.split("\t");
      if (f.length >= 7 && !line.startsWith("#")) keep(f[5], f[6], f[0]);
    }
    return jar;
  }
  if (/^[A-Za-z0-9]{20,64}$/.test(text)) {
    jar.golden_key = text;
    return jar;
  }
  for (const part of text.replace(/^cookie:\s*/i, "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) keep(part.slice(0, i), part.slice(i + 1));
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absorbSetCookie(jar, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const first = String(c).split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (/deleted/i.test(value) || /expires=Thu, 01 Jan 1970/i.test(c)) delete jar[name];
    else jar[name] = value;
  }
}

// ---------------------------------------------------------------- transport

function defaultTransport(req) {
  return axios({
    method: req.method,
    url: req.url,
    headers: req.headers,
    data: req.body,
    timeout: TIMEOUT_MS,
    maxRedirects: 0, // we read every Location ourselves
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
    family: 4,
  }).then((r) => ({ status: r.status, headers: r.headers || {}, body: typeof r.data === "string" ? r.data : String(r.data || "") }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A signed-in session. `cookies` is the parsed jar; `transport` is injectable for tests.
function createSession({ cookies, transport = defaultTransport, gapMs = FUNPAY_GAP_MS, now = () => Date.now() } = {}) {
  const jar = { ...(cookies || {}) };
  let lastAt = 0;
  let chain = Promise.resolve();

  function request(method, pathOrUrl, { form, referer, xhr } = {}) {
    const run = async () => {
      const wait = lastAt + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : BASE + pathOrUrl;
      const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: cookieHeader(jar) };
      let body;
      if (form) {
        body = new URLSearchParams(form).toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        headers.Origin = BASE;
        headers.Referer = referer || BASE + "/en/";
      }
      if (xhr) {
        headers["X-Requested-With"] = "XMLHttpRequest";
        headers.Accept = "application/json, text/javascript, */*; q=0.01";
      }
      const res = await transport({ method, url, headers, body });
      absorbSetCookie(jar, res.headers["set-cookie"]);
      const location = res.headers.location || res.headers.Location || null;
      return { status: res.status, url, location: location ? new URL(location, url).toString() : null, html: res.body || "" };
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  // Follow redirects that stay on funpay.com (GET only), at most 3 hops.
  async function get(path) {
    let res = await request("GET", path);
    for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400 && res.location; hop++) {
      if (new URL(res.location).hostname !== "funpay.com") break;
      res = await request("GET", res.location);
    }
    return res;
  }

  async function checkSession() {
    const res = await get("/en/");
    const who = pages.parseSessionUser(res.html);
    return { ok: res.status === 200 && who.userId > 0, status: res.status, userId: who.userId, username: who.username };
  }

  async function readOffer(offerId) {
    const res = await get(`/en/lots/offer?id=${encodeURIComponent(offerId)}`);
    return { status: res.status, offer: res.status === 200 ? pages.parseOfferPage(res.html) : null };
  }

  async function readOrder(orderId) {
    const res = await get(`/en/orders/${encodeURIComponent(orderId)}/`);
    return { status: res.status, order: res.status === 200 ? pages.parseOrderPage(res.html) : null };
  }

  // Buys ONE unit. Returns { ok, orderId?, chargedUsd?, reason?, trace }.
  async function buyOne({ offerId, maxPriceUsd }) {
    const trace = [];
    const step = (name, res, extra) => trace.push({ step: name, status: res ? res.status : null, path: res ? new URL(res.url).pathname : null, redirect: res && res.location ? new URL(res.location).hostname + new URL(res.location).pathname : null, ...extra });
    const stop = (reason) => ({ ok: false, reason, trace });

    if (!(Number(maxPriceUsd) > 0)) return stop("no maximum price given");
    const page = await get(`/en/lots/offer?id=${encodeURIComponent(offerId)}`);
    const offer = page.status === 200 ? pages.parseOfferPage(page.html) : null;
    step("offer", page, { signedIn: !!(offer && offer.userId), form: !!(offer && offer.buyForm) });
    if (!offer) return stop(`offer page answered ${page.status}`);
    if (!offer.userId) return stop("not signed in — the FunPay cookies have expired");
    if (!offer.buyForm) return stop("no buy form on the offer page (offer gone or out of stock)");
    const guardUsd = offer.priceGuard && offer.priceGuard.usd;
    if (!(guardUsd > 0)) return stop("could not read FunPay's price for this offer");
    if (guardUsd > Number(maxPriceUsd)) return stop(`price ${guardUsd} is above the maximum ${maxPriceUsd}`);
    const bal = offer.buyForm.balance || {};
    const balanceUsd = Math.max(Number(bal.totalUsd) || 0, Number(bal.usd) || 0);
    if (balanceUsd + 1e-9 < guardUsd) return stop(`FunPay balance $${balanceUsd.toFixed(2)} is below the price $${guardUsd.toFixed(2)} — top up the balance (cards are never used)`);

    const usdMethod = (offer.buyForm.methods || []).find((m) => m.id !== "0" && m.currency === "usd");
    const form1 = { ...offer.buyForm.fields, amount: "1", method: usdMethod ? usdMethod.id : "0" };
    const refer = `${BASE}/en/lots/offer?id=${encodeURIComponent(offerId)}`;
    const preview = await request("POST", offer.buyForm.action, { form: form1, referer: refer });
    step("preview", preview, { fields: Object.keys(form1) });
    const offsite = (res) => res.location && new URL(res.location).hostname !== "funpay.com";
    if (offsite(preview)) return stop("FunPay sent the order to an outside payment page — stopped, nothing paid from a card");
    const orderFrom = (res) => {
      const m = /\/orders\/([A-Z0-9]{6,12})\//.exec(res.location || "") || (res.status === 200 ? /\/orders\/([A-Z0-9]{6,12})\/?["']/.exec(res.html) : null);
      return m ? m[1] : null;
    };
    let orderId = orderFrom(preview);
    if (!orderId) {
      // Preview page: a second form (same action, no preview flag) confirms the purchase.
      const fm = /<form[^>]*action="(https:\/\/funpay\.com\/(?:en\/)?orders\/[^"]*)"[^>]*>([\s\S]*?)<\/form>/.exec(preview.html || "");
      if (preview.status !== 200 || !fm) return stop("unexpected answer to the order preview — no confirm form");
      const confirm = {};
      for (const t of fm[2].match(/<input[^>]*>/g) || []) {
        const name = /\bname="([^"]+)"/.exec(t);
        const val = /\bvalue="([^"]*)"/.exec(t);
        if (name) confirm[name[1]] = val ? pages.decodeEntities(val[1]) : "";
      }
      const sumM = /name="sum"[^>]*value="([\d.,]+)"/.exec(fm[2]);
      const shownSum = sumM ? Number(sumM[1].replace(",", ".")) : null;
      if (shownSum != null && shownSum > Number(maxPriceUsd) * 1.05) return stop(`confirm page asks ${shownSum}, above the maximum`);
      delete confirm.preview;
      const done = await request("POST", fm[1], { form: confirm, referer: preview.url });
      step("confirm", done, { fields: Object.keys(confirm) });
      if (offsite(done)) return stop("FunPay sent the order to an outside payment page — stopped, nothing paid from a card");
      orderId = orderFrom(done);
      if (!orderId) return stop(`no order number after confirming (HTTP ${done.status})`);
    }
    return { ok: true, orderId, chargedUsd: guardUsd, trace };
  }

  return { request, get, checkSession, readOffer, readOrder, buyOne, cookies: () => ({ ...jar }) };
}

module.exports = { parseCookieInput, cookieHeader, absorbSetCookie, createSession, BASE, FUNPAY_GAP_MS };
