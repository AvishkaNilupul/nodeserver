// FunPay resale watcher (docs/FUNPAY-RESALE-CONTRACT.md §7).
//
// Every `watchMinutes` it reads, anonymously and one request at a time (≥ 700 ms
// apart, nothing in parallel):
//   1. the FunPay offer page of a source whose category node is not known yet;
//   2. each category page ONCE (price, online, auto-delivery, seller) — a source
//      missing from its category page is "missing since" the first run that saw it gone;
//   3. a seller's profile at most once per 24 h (rating, newest low reviews);
//   4. every same-set competitor offer on Eldorado (price, stock; stock drops = sales),
// then works out the suggested Eldorado price and the profit per unit, and keeps each
// linked Eldorado listing in step with its deal (the engine's shared "down" rule):
// paused while the deal is down, resumed only when it was THIS watcher that paused it,
// kept stocked by the engine's keepOfferStocked. Finally it re-checks each manual
// "Buy 1 now" purchase still waiting for the seller (funpayResaleOps.recheckPurchase,
// the only signed-in FunPay read here).
//
// It buys nothing and never reprices a listing.
// It never throws: a source's problems land in its lastError, the run's in the result.

const axios = require("axios");
const pages = require("./funpayPages");

const FUNPAY = "https://funpay.com";
const ELDORADO_OFFER = "https://www.eldorado.gg/api/v1/item-management/offers/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const READ_GAP_MS = 700;
const FIRST_RUN_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HISTORY_CAP = 300;
// Every pause made here is autoPaused + a lastError starting with PAUSED_PREFIX (the
// FunPay login watch hands its pauses over in the same format), and only a row like
// that is ever resumed from here.
const PAUSED_PREFIX = "paused: FunPay source down — ";
const PAUSE_FAILED_PREFIX = "pause failed: FunPay source down — ";

async function defaultFetchText(url) {
  const r = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: /eldorado\.gg/i.test(url)
        ? "application/json, text/plain, */*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeout: 20000,
    family: 4,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
  });
  return { status: r.status, text: typeof r.data === "string" ? r.data : String(r.data == null ? "" : r.data) };
}

// Everything the watcher touches, swappable by tests. The heavy modules
// (marketplaces, telegram, the engine, the ops) are only required when first used.
const deps = {
  Source: require("../models/FunpaySource"),
  Listing: require("../models/MarketplaceListing"),
  Purchase: require("../models/FunpayPurchase"),
  settings: require("./settings"),
  mp: {
    eldoradoOffer: (id) => require("./marketplaces").eldoradoOffer(id),
    eldoradoDelist: (id) => require("./marketplaces").eldoradoDelist(id),
    eldoradoRelist: (id) => require("./marketplaces").eldoradoRelist(id),
  },
  notify: (t) => require("./telegram").sendTelegram(t),
  fetchText: defaultFetchText,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // The engine's "down" rule ("" = the deal can be bought), shared with the engine
  // and the FunPay login watch.
  downReason: (src) => require("./funpayResale").sourceDownReason(src),
  // The engine's quantity upkeep (top up an Active offer, reopen one Eldorado closed
  // at 0; skips paused / non-active rows and down deals; never throws).
  keepOfferStocked: (listing, source) => require("./funpayResale").keepOfferStocked(listing, source),
  ops: () => require("./funpayResaleOps"),
};

const state = { running: false, lastRunAt: null, lastResult: null };

// ------------------------------------------------------------------ helpers

function round2(n) {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return v === 0 ? 0 : v; // never -0
}

function errText(e) {
  return String((e && e.message) || e || "error")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

async function findLean(Model, filter) {
  const q = Model.find(filter);
  return (q && typeof q.lean === "function" ? await q.lean() : await q) || [];
}

// Every network call goes through here: at least READ_GAP_MS between the starts of
// two calls (the clamp keeps a clock that moved backwards from waiting forever).
let lastNetAt = 0;
async function pace() {
  const wait = Math.min(READ_GAP_MS, Math.max(0, lastNetAt + READ_GAP_MS - deps.now()));
  if (wait > 0) await deps.sleep(wait);
  lastNetAt = deps.now();
}

// One anonymous GET. Never throws. A 403/429 means "stop": nothing more is read from
// that host for the rest of the run.
async function get(run, url) {
  const host = /eldorado\.gg/i.test(url) ? "Eldorado" : "FunPay";
  if (run.blocked[host]) return { status: 0, text: "", error: run.blocked[host] };
  await pace();
  run.reads += 1;
  let res;
  try {
    res = await deps.fetchText(url);
  } catch (e) {
    return { status: 0, text: "", error: errText(e) };
  }
  const status = Number(res && res.status) || 0;
  const text = res && typeof res.text === "string" ? res.text : "";
  if (status === 403 || status === 429) {
    run.blocked[host] = `skipped: ${host} answered HTTP ${status} earlier in this run`;
    run.problems.push(`${host} answered HTTP ${status} — no more reads there this run`);
  }
  return { status, text, error: status === 200 ? null : `HTTP ${status}` };
}

async function mpCall(run, name, ...args) {
  await pace();
  run.eldoradoCalls += 1;
  try {
    return { ok: true, value: await deps.mp[name](...args) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function say(text) {
  try {
    await deps.notify(text);
  } catch (e) {
    console.error("funpay watch: notify failed:", errText(e));
  }
}

// ------------------------------------------------------------------ pure parts

// Keeps the newest `cap` points, oldest first.
function capHistory(points, cap = HISTORY_CAP) {
  return (points || [])
    .filter((h) => h && h.at && Number.isFinite(new Date(h.at).getTime()))
    .map((h) => ({ offerId: String(h.offerId), quantity: h.quantity == null ? null : Number(h.quantity), at: new Date(h.at) }))
    .sort((a, b) => a.at - b.at)
    .slice(-cap);
}

// Units sold in the last 24 h = the sum of the stock DROPS between consecutive
// readings inside the window (a restock is not a sale).
function sold24h(history, offerId, nowMs) {
  const since = nowMs - DAY_MS;
  const pts = (history || [])
    .filter((h) => h && String(h.offerId) === String(offerId) && h.quantity != null && new Date(h.at).getTime() >= since)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  let sold = 0;
  for (let i = 1; i < pts.length; i++) {
    const drop = Number(pts[i - 1].quantity) - Number(pts[i].quantity);
    if (drop > 0) sold += drop;
  }
  return sold;
}

function derive(src, eldoradoFeePct) {
  const active = ((src && src.competitors) || []).filter(
    (c) => c && c.state === "Active" && Number.isFinite(c.priceUsd) && c.priceUsd > 0,
  );
  const lowest = active.length ? Math.min(...active.map((c) => c.priceUsd)) : null;
  const suggested = lowest == null ? null : Math.max(0.01, round2(lowest - 0.01));
  const fee = eldoradoFeePct == null || !Number.isFinite(Number(eldoradoFeePct)) ? 10 : Number(eldoradoFeePct);
  const cost = src && src.priceUsd != null ? Number(src.priceUsd) : NaN;
  const profit = suggested == null || !Number.isFinite(cost) ? null : round2(suggested * (1 - fee / 100) - cost);
  return { lowestCompetitorUsd: lowest, suggestedPriceUsd: suggested, estProfitUsd: profit };
}

// ------------------------------------------------------------------ steps

// 1. A source without a node: its offer page names the category (back link).
async function learnNodes(run, work) {
  for (const w of work) {
    if (w.doc.node) continue;
    const id = String(w.doc.offerId || "").trim();
    if (!id) {
      w.errors.push("no FunPay offer id");
      continue;
    }
    const r = await get(run, `${FUNPAY}/en/lots/offer?id=${encodeURIComponent(id)}`);
    if (r.status === 404) {
      if (!w.doc.missingSince) w.set.missingSince = new Date(deps.now());
      w.errors.push("FunPay offer page: not found (offer removed?)");
      continue;
    }
    if (r.status !== 200) {
      w.errors.push(`FunPay offer page: ${r.error}`);
      continue;
    }
    const o = pages.parseOfferPage(r.text);
    if (o.nodeKind && o.nodeKind !== "lots") {
      w.errors.push(`FunPay offer is in a "${o.nodeKind}" category — only lots categories are watched`);
      continue;
    }
    if (!o.node) {
      w.errors.push("FunPay offer page: no category link found");
      continue;
    }
    w.set.node = String(o.node);
    if (o.short) w.set.title = o.short;
    if (o.sellerId) w.set.sellerId = String(o.sellerId);
    if (o.sellerName) w.set.sellerName = o.sellerName;
  }
}

// 2. One GET per category node for every source in it.
async function readCategories(run, work) {
  const byNode = new Map();
  for (const w of work) {
    const node = w.set.node || w.doc.node;
    if (!node) continue;
    if (!byNode.has(node)) byNode.set(node, []);
    byNode.get(node).push(w);
  }
  for (const [node, list] of byNode) {
    const r = await get(run, `${FUNPAY}/en/lots/${encodeURIComponent(node)}/`);
    if (r.status !== 200) {
      for (const w of list) w.errors.push(`FunPay category page: ${r.error}`);
      continue;
    }
    const rows = pages.parseLotsPage(r.text);
    // No rows AND no FunPay app data = a block / challenge page, not an empty
    // category: it says nothing about whether our offers are still there.
    if (!rows.length && !pages.parseAppData(r.text)) {
      for (const w of list) w.errors.push("FunPay category page: not a FunPay page (blocked or changed?)");
      continue;
    }
    const byId = new Map(rows.map((x) => [String(x.offerId), x]));
    const at = new Date(deps.now());
    for (const w of list) {
      const row = byId.get(String(w.doc.offerId));
      if (!row) {
        if (!w.doc.missingSince && !w.set.missingSince) w.set.missingSince = at;
        continue;
      }
      w.set.priceUsd = Number.isFinite(row.priceUsd) ? row.priceUsd : null;
      w.set.online = !!row.online;
      w.set.autoDelivery = !!row.autoDelivery;
      if (row.sellerId) w.set.sellerId = String(row.sellerId);
      if (row.sellerName) w.set.sellerName = row.sellerName;
      if (row.reviews > 0) w.set.sellerReviews = row.reviews;
      if (row.desc) w.set.title = row.desc;
      w.set.seenAt = at;
      w.set.missingSince = null;
    }
  }
}

// 3. Seller profile, at most once per 24 h per source (and once per seller per run).
async function readSeller(run, w, cache) {
  const v = { ...w.doc, ...w.set };
  const sellerId = String(v.sellerId || "");
  if (!sellerId) return;
  const last = v.sellerCheckedAt ? new Date(v.sellerCheckedAt).getTime() : 0;
  if (last && deps.now() - last < DAY_MS) return;
  let prof = cache.get(sellerId);
  if (!prof) {
    const r = await get(run, `${FUNPAY}/en/users/${encodeURIComponent(sellerId)}/`);
    if (r.status !== 200) prof = { error: r.error };
    else {
      const u = pages.parseUserPage(r.text);
      prof = u.rating == null && u.reviewCount == null ? { error: "no rating found on the page" } : u;
    }
    cache.set(sellerId, prof);
  }
  if (prof.error) {
    // Not stamped: retried next run (the old rating stays meanwhile).
    w.errors.push(`FunPay seller profile: ${prof.error}`);
    return;
  }
  w.set.sellerRating = prof.rating;
  if (prof.reviewCount != null) w.set.sellerReviews = prof.reviewCount;
  w.set.sellerRecentLow = (prof.recentReviews || []).filter((x) => x && x.stars != null && x.stars <= 3).length;
  w.set.sellerCheckedAt = new Date(deps.now());
}

async function readEldoradoOffer(run, id) {
  const r = await get(run, ELDORADO_OFFER + encodeURIComponent(id));
  const at = new Date(deps.now());
  if (r.status === 404) return { ok: false, status: 404, error: "not found on Eldorado (removed?)" };
  if (r.status !== 200) return { ok: false, status: r.status, error: r.error };
  let j = null;
  try {
    j = JSON.parse(r.text);
  } catch {
    return { ok: false, status: 200, error: "the answer was not JSON" };
  }
  const offer = j && typeof j === "object" ? j.offer : null;
  if (!offer || typeof offer !== "object") return { ok: false, status: 200, error: "no offer in the answer" };
  const user = j.user && typeof j.user === "object" ? j.user : {};
  const price = Number(offer.pricePerUnitInUSD && offer.pricePerUnitInUSD.amount);
  const qty = offer.quantity == null ? NaN : Number(offer.quantity);
  return {
    ok: true,
    at,
    priceUsd: Number.isFinite(price) && price > 0 ? price : null,
    quantity: Number.isFinite(qty) ? qty : null,
    state: String(offer.offerState || ""),
    title: String(offer.offerTitle || ""),
    seller: String(user.username || ""),
  };
}

// 4. Same-set competitors on Eldorado. A failed read keeps the last known entry
//    (a 404 marks it "NotFound", which keeps it out of the lowest price).
async function readCompetitors(run, w, cache) {
  const ids = [...new Set((w.doc.competitorOfferIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const watched = new Set(ids);
  const prev = new Map((w.doc.competitors || []).map((c) => [String(c.offerId), c]));
  const history = (w.doc.competitorHistory || []).filter((h) => h && watched.has(String(h.offerId)));
  const competitors = [];
  for (const id of ids) {
    let r = cache.get(id);
    if (!r) {
      r = await readEldoradoOffer(run, id);
      cache.set(id, r);
    }
    const old = prev.get(id);
    if (r.ok) {
      if (r.quantity != null) history.push({ offerId: id, quantity: r.quantity, at: r.at });
      competitors.push({
        offerId: id,
        seller: r.seller || (old && old.seller) || "",
        priceUsd: r.priceUsd,
        quantity: r.quantity,
        title: r.title,
        state: r.state,
        seenAt: r.at,
        sold24h: 0,
      });
    } else {
      const base = old
        ? { ...old }
        : { offerId: id, seller: "", priceUsd: null, quantity: null, title: "", state: "", seenAt: null, sold24h: 0 };
      if (r.status === 404) base.state = "NotFound";
      competitors.push(base);
      w.errors.push(`Eldorado offer ${id.slice(0, 8)}: ${r.error}`);
    }
  }
  const kept = capHistory(history);
  const t = deps.now();
  for (const c of competitors) c.sold24h = sold24h(kept, c.offerId, t);
  w.set.competitors = competitors;
  w.set.competitorHistory = kept;
}

// 6. Linked Eldorado listings. Only ever an active row: re-read right before it is
//    looked at, and every write is conditional on the row still being as it was read
//    (the FunPay login watch and the owner write these rows too).
function note(run, w, msg) {
  if (w) w.errors.push(msg);
  else run.problems.push(msg);
}

function tagOf(l) {
  return `Eldorado listing ${String(l.externalId || "").slice(0, 8)}`;
}

// true when written; false when the row changed meanwhile (left as it is) or failed.
async function saveListing(run, w, l, patch) {
  const filter = {
    _id: l._id,
    status: "active",
    autoPaused: l.autoPaused ? true : { $ne: true },
    lastError: l.lastError ? String(l.lastError) : { $in: ["", null] },
  };
  try {
    const r = await deps.Listing.updateOne(filter, { $set: patch });
    if (r && r.matchedCount === 0) {
      note(run, w, `${tagOf(l)}: changed while the watcher ran — left as it is`);
      return false;
    }
    Object.assign(l, patch);
    return true;
  } catch (e) {
    note(run, w, `${tagOf(l)}: could not save — ${errText(e)}`);
    return false;
  }
}

function sourceLabel(src) {
  if (!src) return "(deleted)";
  return String(src.label || src.title || "offer " + src.offerId).slice(0, 60);
}

async function syncListing(run, cfg, l, w) {
  const ext = String(l.externalId || "");
  if (!ext || l.status !== "active") return;
  const src = w ? { ...w.doc, ...w.set } : null;
  const why = String(deps.downReason(src) || "");
  const lastError = String(l.lastError || "");
  const ours = !!l.autoPaused && lastError.startsWith(PAUSED_PREFIX);
  const name = `"${l.title || ext}"`;
  const label = sourceLabel(src);
  const tag = tagOf(l);

  if (why) {
    const text = PAUSED_PREFIX + why;
    if (l.autoPaused) {
      // Already off sale. Ours: keep the reason current (no page). Someone else's: theirs.
      if (ours && text !== lastError) await saveListing(run, w, l, { lastError: text });
      return;
    }
    if (!cfg.pauseListingWhenSourceDown) return;
    const read = await mpCall(run, "eldoradoOffer", ext);
    if (!read.ok) return note(run, w, `${tag}: could not read the offer to pause it — ${read.error}`);
    // Not on sale (the owner paused it, or it is closed): nothing to take down, and
    // marking it ours would let a later resume undo the owner's own pause.
    if (!read.value || read.value.offerState !== "Active") return;
    const done = await mpCall(run, "eldoradoDelist", ext);
    if (!done.ok) {
      // Still on sale while its deal is down: a real error on the row (the console
      // counts it), paged once, retried next run.
      note(run, w, `${tag}: pause failed — ${done.error}`);
      if (!lastError.startsWith(PAUSE_FAILED_PREFIX)) {
        await say(
          `⚠️ FunPay resale: could not pause the Eldorado listing ${name} — its FunPay source "${label}" is down ` +
            `(${why}): ${done.error}. It is still on sale; the watcher tries again next run.`,
        );
      }
      const failed = (PAUSE_FAILED_PREFIX + why + " — " + done.error).slice(0, 500);
      if (failed !== lastError) await saveListing(run, w, l, { lastError: failed });
      return;
    }
    if (await saveListing(run, w, l, { autoPaused: true, lastError: text })) {
      run.paused.push({ listingId: String(l._id), externalId: ext, why });
      await say(
        `⏸ FunPay resale: paused the Eldorado listing ${name} — its FunPay source "${label}" is down ` +
          `(${why}). It comes back on sale by itself once the source is healthy.`,
      );
    }
    return;
  }

  if (l.autoPaused) {
    if (!ours) return; // paused by someone else (the login watch, a sync, the owner): theirs
    // Back on sale only while FunPay can actually be bought from.
    if (!cfg.sessionOk) return note(run, w, `${tag}: stays paused — the FunPay login is not working`);
    const read = await mpCall(run, "eldoradoOffer", ext);
    if (!read.ok) return note(run, w, `${tag}: could not read the offer to resume it — ${read.error}`);
    const offerState = read.value ? read.value.offerState : "";
    if (offerState === "Active") {
      // Already back on sale (resumed by hand): just drop our flag.
      await saveListing(run, w, l, { autoPaused: false, lastError: "" });
      return;
    }
    if (offerState !== "Paused") return note(run, w, `${tag}: the offer is ${offerState || "gone"} on Eldorado — not resumed`);
    const done = await mpCall(run, "eldoradoRelist", ext);
    if (!done.ok) return note(run, w, `${tag}: resume failed — ${done.error}`);
    if (await saveListing(run, w, l, { autoPaused: false, lastError: "" })) {
      run.resumed.push({ listingId: String(l._id), externalId: ext });
      await say(`▶️ FunPay resale: resumed the Eldorado listing ${name} — its FunPay source "${label}" is healthy again.`);
    }
    return;
  }

  // Healthy and on sale by us: the engine's own quantity upkeep.
  if (lastError.startsWith(PAUSE_FAILED_PREFIX) && !(await saveListing(run, w, l, { lastError: "" }))) return;
  await pace();
  run.eldoradoCalls += 1;
  let res;
  try {
    res = await deps.keepOfferStocked(l, src);
  } catch (e) {
    res = { error: errText(e) };
  }
  if (res && res.error) return note(run, w, `${tag}: keeping it stocked failed — ${errText(res.error)}`);
  if (res && res.toppedUp) run.restocked.push({ listingId: String(l._id), externalId: ext, toppedUp: res.toppedUp });
  else if (res && res.reopened) run.restocked.push({ listingId: String(l._id), externalId: ext, reopened: res.reopened });
}

async function syncListings(run, cfg, work, onlySourceId) {
  let rows;
  try {
    rows = await findLean(deps.Listing, { marketplace: "eldorado", funpaySource: { $ne: null }, status: "active" });
  } catch (e) {
    run.problems.push("could not read the linked Eldorado listings: " + errText(e));
    return;
  }
  const byId = new Map(work.map((w) => [String(w.doc._id), w]));
  for (const listed of rows) {
    const sid = String(listed.funpaySource);
    if (onlySourceId && sid !== onlySourceId) continue;
    const w = byId.get(sid) || null;
    try {
      // The row as it is NOW (earlier listings took a few seconds each).
      const [l] = await findLean(deps.Listing, { _id: listed._id });
      if (!l || l.status !== "active" || String(l.funpaySource) !== sid) continue;
      await syncListing(run, cfg, l, w);
    } catch (e) {
      note(run, w, `${tagOf(listed)}: ${errText(e)}`);
    }
  }
}

// Manual "Buy 1 now" purchases still waiting for the seller: one re-read of each
// FunPay order per run (funpayResaleOps.recheckPurchase never throws, buys nothing).
async function recheckManualBuys(run, onlySourceId) {
  let ops = null;
  try {
    ops = deps.ops();
  } catch (e) {
    run.problems.push("manual buys: " + errText(e));
    return;
  }
  if (!ops || typeof ops.recheckPurchase !== "function") return;
  let rows;
  try {
    const q = { kind: "manual", state: "bought" };
    if (onlySourceId) q.source = onlySourceId;
    rows = await findLean(deps.Purchase, q);
  } catch (e) {
    run.problems.push("manual buys: could not read them — " + errText(e));
    return;
  }
  for (const p of rows) {
    await pace();
    try {
      const r = await ops.recheckPurchase(p._id);
      run.rechecked.push({ purchaseId: String(p._id), state: (r && r.state) || null, reason: (r && r.reason) || "" });
    } catch (e) {
      run.problems.push(`manual buy ${p._id}: ${errText(e)}`);
    }
  }
}

async function saveSource(run, w) {
  const set = { ...w.set, lastError: w.errors.join("; ").slice(0, 500), watchedAt: new Date(deps.now()) };
  try {
    await deps.Source.updateOne({ _id: w.doc._id }, { $set: set });
  } catch (e) {
    run.problems.push(`could not save source ${w.doc._id}: ${errText(e)}`);
  }
}

// ------------------------------------------------------------------ the run

async function pass(cfg, onlySourceId) {
  const startedAt = new Date(deps.now());
  const run = { reads: 0, eldoradoCalls: 0, blocked: {}, paused: [], resumed: [], restocked: [], rechecked: [], problems: [] };
  const docs = await findLean(deps.Source, onlySourceId ? { _id: onlySourceId } : {});
  if (onlySourceId && !docs.length) return { ok: false, error: "source not found" };
  const work = docs.map((doc) => ({ doc, set: {}, errors: [] }));

  await learnNodes(run, work);
  await readCategories(run, work);
  const profiles = new Map();
  const offers = new Map();
  for (const w of work) {
    await readSeller(run, w, profiles);
    await readCompetitors(run, w, offers);
    Object.assign(w.set, derive({ ...w.doc, ...w.set }, cfg.eldoradoFeePct));
  }
  await syncListings(run, cfg, work, onlySourceId);
  for (const w of work) await saveSource(run, w);
  await recheckManualBuys(run, onlySourceId);

  return {
    ok: true,
    onlySourceId: onlySourceId || null,
    sources: work.length,
    withErrors: work.filter((w) => w.errors.length).length,
    reads: run.reads,
    eldoradoCalls: run.eldoradoCalls,
    paused: run.paused,
    resumed: run.resumed,
    restocked: run.restocked,
    rechecked: run.rechecked,
    problems: run.problems,
    startedAt,
    finishedAt: new Date(deps.now()),
  };
}

// A full run is skipped while watchEnabled is false; a single-source run is the
// owner's own Refresh and always goes ahead. Single-flight, never throws.
async function runOnce({ onlySourceId } = {}) {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  try {
    const only = onlySourceId ? String(onlySourceId) : null;
    let cfg;
    try {
      cfg = deps.settings.getFunpayResale() || {};
    } catch (e) {
      return { ok: false, error: "settings: " + errText(e) };
    }
    if (!only && !cfg.watchEnabled) return { skipped: "watcher is off" };
    const result = await pass(cfg, only);
    if (!only) {
      state.lastRunAt = new Date(deps.now());
      state.lastResult = result;
      if (result.paused.length || result.resumed.length || result.problems.length) {
        console.log(
          `funpay watch: ${result.sources} sources, ${result.reads} reads, paused ${result.paused.length}, ` +
            `resumed ${result.resumed.length}` +
            (result.problems.length ? " — " + result.problems.join("; ") : ""),
        );
      }
    }
    return result;
  } catch (e) {
    const result = { ok: false, error: errText(e) };
    if (!onlySourceId) {
      state.lastRunAt = new Date(deps.now());
      state.lastResult = result;
    }
    console.error("funpay watch:", result.error);
    return result;
  } finally {
    state.running = false;
  }
}

// ------------------------------------------------------------------ schedule

let started = false;
let timer = null;

function periodMs() {
  let m = 30;
  try {
    const v = Number(deps.settings.getFunpayResale().watchMinutes);
    if (Number.isFinite(v)) m = v;
  } catch {
    /* keep the default */
  }
  return Math.min(240, Math.max(10, m)) * 60 * 1000;
}

function schedule(ms) {
  timer = setTimeout(tick, ms);
  if (timer && typeof timer.unref === "function") timer.unref();
}

async function tick() {
  timer = null;
  try {
    await runOnce();
  } catch (e) {
    console.error("funpay watch:", errText(e));
  }
  if (started && !timer) schedule(periodMs());
}

// First run 2 minutes after start, then every watchMinutes (read again each time).
function start() {
  if (started) return;
  started = true;
  schedule(FIRST_RUN_MS);
}

function stop() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  runOnce,
  state,
  deps,
  derive,
  sold24h,
  capHistory,
  PAUSED_PREFIX,
};
