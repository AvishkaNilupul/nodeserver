// Pure parsers for FunPay HTML pages (no network, no state).
//
// FunPay has no public buyer API: everything we need is in the pages a browser sees.
// Each parser returns plain data and never throws on odd HTML — a missing piece comes
// back as null / [] so the caller can decide whether that is fatal.
//
// Shapes were checked against live pages on 2026-10-26 (lots list, offer page, seller
// profile). The ORDER page parser follows the structure FunPay buyers and sellers share
// ("Paid product" block with span.secret-placeholder) and must be re-verified on the
// first real purchase (the resale engine refuses auto-buy until that has happened).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[k] !== undefined ? ENTITIES[k] : m;
  });
}

function stripTags(s) {
  return decodeEntities(
    String(s || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag || "");
  return m ? decodeEntities(m[1]) : null;
}

// <body data-app-data="{...}"> carries the CSRF token and the signed-in user id (0 = guest).
function parseAppData(html) {
  const m = /<body[^>]*\bdata-app-data="([^"]*)"/.exec(html || "");
  if (!m) return null;
  try {
    const d = JSON.parse(decodeEntities(m[1]));
    return {
      csrfToken: d["csrf-token"] || d.csrfToken || null,
      userId: Number(d.userId) || 0,
      locale: d.locale || null,
    };
  } catch (_) {
    return null;
  }
}

// The signed-in username sits in the top bar (user-link-name); guests have none.
function parseSessionUser(html) {
  const app = parseAppData(html);
  const name = /<div class="user-link-name">\s*([^<]+?)\s*<\/div>/.exec(html || "");
  return { userId: app ? app.userId : 0, username: name ? decodeEntities(name[1]).trim() : null };
}

// One category page, e.g. /en/lots/3133/ — every offer row of the category.
function parseLotsPage(html) {
  const rows = [];
  const re = /<a href="https:\/\/funpay\.com\/(?:en\/)?lots\/offer\?id=(\d+)" class="(tc-item[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html || ""))) {
    const [, id, cls, attrs, body] = m;
    const desc = /<div class="tc-desc-text">([\s\S]*?)<\/div>/.exec(body);
    const uid = /data-href="https:\/\/funpay\.com\/(?:en\/)?users\/(\d+)\/"/.exec(body);
    const uname = /<div class="media-user-name">\s*([\s\S]*?)<\/div>/.exec(body);
    const rev = /rating-mini-count">(\d+)</.exec(body);
    const stars = /rating-stars rating-(\d)/.exec(body);
    const age = /<div class="media-user-info">([\s\S]*?)<\/div>/.exec(body);
    const price = /tc-price" data-s="([\d.]+)"/.exec(body);
    rows.push({
      offerId: id,
      desc: desc ? stripTags(desc[1]) : "",
      sellerId: uid ? uid[1] : null,
      sellerName: uname ? stripTags(uname[1]) : null,
      reviews: rev ? Number(rev[1]) : 0,
      stars: stars ? Number(stars[1]) : null,
      sellerAge: age ? stripTags(age[1]) : null,
      online: /\bdata-online="1"/.test(attrs),
      autoDelivery: /\bdata-auto="1"/.test(attrs),
      promoted: /offer-promoted/.test(cls),
      priceUsd: price ? Number(price[1]) : null,
    });
  }
  // A promoted offer can appear twice (pinned + in place); keep the first.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.offerId) ? false : (seen.add(r.offerId), true)));
}

function paramItems(html) {
  const out = [];
  const re = /<div class="param-item[^"]*">\s*<h5[^>]*>([\s\S]*?)<\/h5>([\s\S]*?)<\/div>\s*(?=<div class="param-item|<\/div>|<hr|<form|$)/g;
  let m;
  while ((m = re.exec(html || ""))) out.push({ title: stripTags(m[1]), bodyHtml: m[2], body: stripTags(m[2]) });
  return out;
}

const SHORT_TITLES = ["Short description", "Краткое описание", "Короткий опис"];
const DETAIL_TITLES = ["Detailed description", "Подробное описание", "Докладний опис"];

// An offer page: descriptions, seller, and the purchase form (POST /orders/new).
function parseOfferPage(html) {
  const h = html || "";
  const app = parseAppData(h);
  const items = paramItems(h);
  const pick = (titles) => {
    const it = items.find((i) => titles.includes(i.title));
    return it ? it.body : "";
  };
  const formM = /<form action="(https:\/\/funpay\.com\/(?:en\/)?orders\/new)" method="post"[^>]*>([\s\S]*?)<\/form>/.exec(h);
  let buyForm = null;
  if (formM) {
    const fhtml = formM[2];
    const fields = {};
    for (const t of fhtml.match(/<input[^>]*>/g) || []) {
      const name = attr(t, "name");
      if (name && /type="hidden"/.test(t)) fields[name] = attr(t, "value") || "";
    }
    const sel = /<select[^>]*name="method"[^>]*>/.exec(fhtml);
    const balance = sel
      ? {
          usd: Number(attr(sel[0], "data-balance-usd")) || 0,
          rub: Number(attr(sel[0], "data-balance-rub")) || 0,
          eur: Number(attr(sel[0], "data-balance-eur")) || 0,
          totalUsd: Number(attr(sel[0], "data-balance-total-usd")) || 0,
        }
      : null;
    const methods = [];
    const ore = /<option value="(\d+)"([^>]*)>/g;
    let o;
    while ((o = ore.exec(fhtml))) {
      const dc = attr(o[2], "data-content");
      methods.push({ id: o[1], currency: attr(o[2], "data-cy"), label: dc ? stripTags(dc) : "" });
    }
    buyForm = { action: formM[1], fields, balance, methods };
  }
  let priceGuard = null;
  if (buyForm && buyForm.fields.price_guard) {
    try {
      priceGuard = {};
      for (const part of Buffer.from(buyForm.fields.price_guard, "base64").toString("utf8").split("|")) {
        const [cy, v] = part.split(":");
        if (cy && v && Number.isFinite(Number(v))) priceGuard[cy] = Number(v);
      }
    } catch (_) {
      priceGuard = null;
    }
  }
  const seller = /<div class="media-user-name">\s*<a href="https:\/\/funpay\.com\/(?:en\/)?users\/(\d+)\/"[^>]*>([^<]+)<\/a>/.exec(h);
  // The "back" link names the category: <a href=".../lots/<node>/" class="js-back-link">…<span class="inside">Name</span>
  const back = /<a href="https:\/\/funpay\.com\/(?:en\/)?(lots|chips)\/(\d+)\/" class="js-back-link">[\s\S]*?<span class="inside">([^<]*)<\/span>/.exec(h);
  return {
    node: back ? back[2] : null,
    nodeKind: back ? back[1] : null,
    category: back ? decodeEntities(back[3]).trim() : null,
    offerId: buyForm ? buyForm.fields.offer_id || null : null,
    csrfToken: app ? app.csrfToken : null,
    userId: app ? app.userId : 0,
    short: pick(SHORT_TITLES),
    detail: pick(DETAIL_TITLES),
    sellerId: seller ? seller[1] : null,
    sellerName: seller ? decodeEntities(seller[2]).trim() : null,
    buyForm,
    priceGuard,
  };
}

// A seller profile: rating out of 5, review count, registration, newest reviews.
function parseUserPage(html) {
  const h = html || "";
  const rating = /<span class="big">([\d.]+)<\/span>/.exec(h);
  const count = /<div class="rating-full-count">\s*(?:<a[^>]*>)?\s*([^<]+)</.exec(h);
  const reg = /Registration date<\/h5>\s*<div class="text-nowrap">\s*([^<]+)<br>/.exec(h);
  const reviews = [];
  const re = /<div class="review-item">([\s\S]*?)<div class="review-item-text">\s*([\s\S]*?)\s*<\/div>/g;
  let m;
  while ((m = re.exec(h))) {
    const b = m[1];
    const st = /review-item-rating pull-right[^>]*><div class="rating"><div class="rating(\d)"/.exec(b);
    const dt = /review-item-date">\s*([^<]+?)\s*</.exec(b);
    const de = /review-item-detail">\s*([^<]+?)\s*</.exec(b);
    reviews.push({ stars: st ? Number(st[1]) : null, date: dt ? dt[1] : "", detail: de ? decodeEntities(de[1]) : "", text: stripTags(m[2]) });
  }
  const countNum = count ? Number(String(count[1]).replace(/[^\d]/g, "")) : null;
  return {
    rating: rating ? Number(rating[1]) : null,
    reviewCount: Number.isFinite(countNum) ? countNum : null,
    registered: reg ? reg[1].trim() : null,
    recentReviews: reviews,
  };
}

const PAID_TITLES = ["Paid product", "Paid products", "Оплаченный товар", "Оплаченные товары", "Оплачений товар", "Оплачені товари"];

// A buyer's order page /orders/<ID>/: status, sum and the auto-delivered goods.
function parseOrderPage(html) {
  const h = html || "";
  const idM = /\/orders\/([A-Z0-9]{6,12})\//.exec(h);
  let status = "paid";
  const succ = /<span class="text-success">\s*([^<]+?)\s*<\/span>/.exec(h);
  const warn = /<span class="text-warning">\s*([^<]+?)\s*<\/span>/.exec(h);
  if (warn && /^(Refund|Возврат|Повернення)$/i.test(warn[1])) status = "refunded";
  else if (succ && /^(Closed|Закрыт|Закрито)$/i.test(succ[1])) status = "closed";
  const secrets = [];
  for (const it of paramItems(h)) {
    if (!PAID_TITLES.includes(it.title)) continue;
    const re = /<span class="secret-placeholder">([\s\S]*?)<\/span>/g;
    let s;
    while ((s = re.exec(it.bodyHtml))) secrets.push(stripTags(s[1]));
    if (!secrets.length && it.body) secrets.push(it.body);
  }
  return { orderId: idM ? idM[1] : null, status, secrets, hasPaidBlock: secrets.length > 0 };
}

module.exports = {
  decodeEntities,
  stripTags,
  parseAppData,
  parseSessionUser,
  parseLotsPage,
  parseOfferPage,
  parseUserPage,
  parseOrderPage,
};
