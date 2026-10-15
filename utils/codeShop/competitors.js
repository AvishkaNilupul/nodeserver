"use strict";
// Code shop — Eldorado same-set competitor scan (docs/code-shop/03-MARKETS.md,
// "competitors.js").
//
// Reads Eldorado's PUBLIC offer search (no login, no seller API) for a few
// search words per product, scores every offer by how many of the product's
// slot labels its title names, and stores the best matches plus the lowest
// price of an offer that sells the same set. pricing.js reads that number.
//
// Read-only on the market, and paced: one request at a time with a pause
// between them, at most 3 queries x 3 pages per scan. A failed request aborts
// the scan and keeps the previous one — a half-read market would make the
// lowest price look higher (or lower) than it is.
//
// Only a same-set offer that has stock (qty >= 1) and asks at least 30 % of
// our base price counts towards lowestSameSetUsd (05-REVIEW-FIXES.md, R8): an
// empty or bait-priced listing must not drag our price down. Every matching
// offer is still listed in `offers`.
//
// Our own offers are never competitors: undercutting ourselves would walk the
// price down to the floor one cent per run. They are recognised by seller id
// (config.ownEldoradoUserIds) AND by offer id (any MarketplaceListing row we
// hold with that externalId, whatever its status), so a missing seller id in
// the config still cannot let one through.

const SEARCH_URL = "https://www.eldorado.gg/api/v1/item-management/offers";
const GAME_ID = "235";
const CATEGORY = "CustomItem";
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const MAX_QUERIES = 3;
const PACE_MS = 1500;
const TIMEOUT_MS = 20000;
const TOP_OFFERS = 15;
const SAME_SET_SCORE = 0.8;
const MIN_PRICE_SHARE = 0.3;
const MIN_WORD = 4;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// --- pure ------------------------------------------------------------------

function normalise(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(v) {
  return typeof v === "string" ? v.trim() : "";
}

// The owner's pinned queries when there are any; else up to 3:
// the two longest slot labels (ties keep slot order) and "<game> codes".
// Duplicates (ignoring case and punctuation) are dropped.
function queriesFor(product, guide) {
  const p = product || {};
  const saved = p.competitors && Array.isArray(p.competitors.queries) ? p.competitors.queries.map(cleanText).filter(Boolean) : [];
  const seen = new Set();
  const out = [];
  const add = (q) => {
    const key = normalise(q);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q);
  };
  if (saved.length) {
    saved.forEach(add);
    return out;
  }
  const labels = (Array.isArray(p.slots) ? p.slots : [])
    .map((s, i) => ({ label: cleanText(s && s.label), i }))
    .filter((x) => x.label)
    .sort((a, b) => b.label.length - a.label.length || a.i - b.i);
  for (const x of labels) {
    if (out.length >= 2) break;
    add(x.label);
  }
  const displayName = cleanText(guide && guide.displayName);
  if (displayName) add(displayName + " codes");
  return out.slice(0, MAX_QUERIES);
}

// One label matches a title when the normalised title contains the whole
// normalised label, or every word of the label that is >= 4 characters (and
// the label has at least one such word: "Ana" must appear as it is).
function labelMatches(normTitle, label) {
  const nl = normalise(label);
  if (!nl) return false;
  if (normTitle.includes(nl)) return true;
  const words = nl.split(" ").filter((w) => w.length >= MIN_WORD);
  return words.length > 0 && words.every((w) => normTitle.includes(w));
}

// Score = labels matched / labels (labels that normalise to nothing are not
// counted either way). sameSet = score >= 0.8.
function scoreOffer(title, labels) {
  const list = (Array.isArray(labels) ? labels : []).filter((l) => normalise(l));
  if (!list.length) return { score: 0, sameSet: false, matches: 0 };
  const nt = normalise(title);
  const matches = list.filter((l) => labelMatches(nt, l)).length;
  const score = matches / list.length;
  return { score, sameSet: score >= SAME_SET_SCORE, matches };
}

function positiveNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Eldorado search JSON -> [{ id, title, userId, priceUsd, qty }]. priceUsd is
// pricePerUnitInUSD.amount, else pricePerUnit.amount when that is in USD, else
// null (a price we cannot read in dollars is not a price). Rows without an
// offer id are dropped.
function parseSearch(json) {
  const results = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of results) {
    const o = r && r.offer;
    if (!o || typeof o !== "object") continue;
    const id = o.id === null || o.id === undefined ? "" : String(o.id).trim();
    if (!id) continue;
    let priceUsd = positiveNumber(o.pricePerUnitInUSD && o.pricePerUnitInUSD.amount);
    if (priceUsd === null && o.pricePerUnit && String(o.pricePerUnit.currency || "").toUpperCase() === "USD") {
      priceUsd = positiveNumber(o.pricePerUnit.amount);
    }
    const qty = Number(o.quantity);
    out.push({
      id,
      title: typeof o.offerTitle === "string" ? o.offerTitle : "",
      userId: o.userId === null || o.userId === undefined ? "" : String(o.userId),
      priceUsd,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
    });
  }
  return out;
}

function searchUrl(query, pageIndex) {
  return (
    SEARCH_URL +
    "?gameId=" + GAME_ID +
    "&category=" + CATEGORY +
    "&pageIndex=" + pageIndex +
    "&pageSize=" + PAGE_SIZE +
    "&searchQuery=" + encodeURIComponent(query)
  );
}

// Does this same-set offer count as a price to follow? It must have stock,
// and (when our base price is known) ask at least 30 % of it.
function countsForLowest(offer, basePriceUsd) {
  if (!offer || !offer.sameSet) return false;
  if (!(Number(offer.qty) >= 1)) return false;
  const price = Number(offer.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return false;
  const base = Number(basePriceUsd);
  if (Number.isFinite(base) && base > 0 && price < base * MIN_PRICE_SHARE) return false;
  return true;
}

// Best score first, then cheapest, then id so the order is stable.
function byScoreThenPrice(a, b) {
  return b.score - a.score || a.priceUsd - b.priceUsd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// --- scan ------------------------------------------------------------------

function leanOf(q) {
  return q && typeof q.lean === "function" ? q.lean() : q;
}

function createCompetitors(deps = {}) {
  let models = deps.models || null;
  const getModels = () => {
    if (!models) {
      models = {
        CodeProduct: require("../../models/CodeProduct"),
        MarketplaceListing: require("../../models/MarketplaceListing"),
      };
    }
    return models;
  };
  const doFetch = deps.fetch || ((...a) => globalThis.fetch(...a));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const guideFor = deps.guideFor || require("./games").guideFor;
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig());
  const getEvents = () => events || (events = require("./events").createEvents());

  async function fetchPage(query, pageIndex) {
    const init = { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT } };
    // A hung request must not hold up the whole tick.
    const AS = globalThis.AbortSignal;
    if (AS && typeof AS.timeout === "function") init.signal = AS.timeout(TIMEOUT_MS);
    let res;
    try {
      res = await doFetch(searchUrl(query, pageIndex), init);
    } catch (err) {
      throw new Error("request failed (" + ((err && err.message) || "network error") + ")");
    }
    if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "no response"));
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error("the answer was not JSON");
    }
    if (!json || typeof json !== "object" || !Array.isArray(json.results)) {
      throw new Error("the answer had no results list");
    }
    return json;
  }

  // Ids among `ids` that are our own listings (any market, any status).
  async function ownListingIds(ids) {
    if (!ids.length) return new Set();
    const rows = await leanOf(getModels().MarketplaceListing.find({ externalId: { $in: ids } }, { externalId: 1 }));
    return new Set((rows || []).map((r) => String(r.externalId)));
  }

  // Returns the stored scan, or the old one (unchanged) when anything failed.
  async function scan(productOrId) {
    let product = productOrId;
    if (!product || typeof product !== "object" || !("slots" in product || "competitors" in product)) {
      product = await leanOf(getModels().CodeProduct.findById(productOrId));
      if (!product) throw new Error("code shop product not found");
    }
    const id = product._id;
    const name = product.name || String(id);
    const old = product.competitors || null;
    const keepOld = async (why) => {
      await getEvents().log({
        level: "warn",
        kind: "competitors",
        product: id,
        msg: "Competitor scan of " + name + " failed, kept the previous one: " + why,
      });
      return old;
    };

    const cfg = (await getConfig().get()) || {};
    const guide = guideFor(product.gameNo, cfg);
    const queries = queriesFor(product, guide);
    if (!queries.length) return keepOld("no search words (no slot labels and no game name)");
    const labels = (Array.isArray(product.slots) ? product.slots : []).map((s) => (s && s.label) || "");

    const found = new Map();
    let requests = 0;
    try {
      for (const q of queries) {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          if (requests > 0) await sleep(PACE_MS);
          requests += 1;
          const json = await fetchPage(q, page);
          for (const o of parseSearch(json)) if (!found.has(o.id)) found.set(o.id, o);
          if (json.results.length < PAGE_SIZE) break;
        }
      }
    } catch (err) {
      return keepOld(err.message);
    }

    let ours;
    try {
      ours = await ownListingIds([...found.keys()]);
    } catch (err) {
      // Without this check one of our own offers could be read as the price to beat.
      return keepOld("could not check which offers are ours (" + err.message + ")");
    }
    const ownUsers = new Set((Array.isArray(cfg.ownEldoradoUserIds) ? cfg.ownEldoradoUserIds : []).map(String));

    const scored = [];
    for (const o of found.values()) {
      if (ours.has(o.id) || (o.userId && ownUsers.has(o.userId))) continue;
      // An offer without a dollar price cannot guide a price.
      if (o.priceUsd === null) continue;
      const { score, sameSet } = scoreOffer(o.title, labels);
      if (score <= 0) continue;
      scored.push({ id: o.id, title: o.title.slice(0, 300), priceUsd: o.priceUsd, qty: o.qty, score, sameSet });
    }
    scored.sort(byScoreThenPrice);
    // Our base price; a caller that passed a product without its pricing gets it read.
    let base = product.pricing ? product.pricing.priceUsd : undefined;
    if (base === undefined) {
      try {
        const doc = await leanOf(getModels().CodeProduct.findById(id).select("pricing"));
        base = doc && doc.pricing ? doc.pricing.priceUsd : null;
      } catch (err) {
        return keepOld("could not read our base price (" + err.message + ")");
      }
    }
    const same = scored.filter((o) => countsForLowest(o, base)).map((o) => o.priceUsd);
    // `queries` keeps only what the owner pinned: the words worked out from
    // the labels are not stored, so a renamed slot changes the next search.
    const pinned = product.competitors && Array.isArray(product.competitors.queries) ? product.competitors.queries : [];
    const result = {
      scannedAt: new Date(now()),
      queries: pinned,
      lowestSameSetUsd: same.length ? Math.min(...same) : null,
      offers: scored.slice(0, TOP_OFFERS),
    };

    await getModels().CodeProduct.findByIdAndUpdate(id, { $set: { competitors: result } });
    await getEvents().log({
      kind: "competitors",
      product: id,
      msg:
        "Scanned Eldorado for " + name + ": " + scored.length + " matching offers, " +
        same.length + " with the same set that count" +
        (result.lowestSameSetUsd === null ? "" : ", lowest $" + result.lowestSameSetUsd.toFixed(2)),
      data: { requests, matching: scored.length, sameSet: same.length, lowestSameSetUsd: result.lowestSameSetUsd },
    });
    return result;
  }

  return { scan };
}

module.exports = {
  createCompetitors,
  queriesFor,
  scoreOffer,
  parseSearch,
  normalise,
  searchUrl,
  countsForLowest,
  SAME_SET_SCORE,
  MIN_PRICE_SHARE,
  PAGE_SIZE,
  MAX_PAGES,
  PACE_MS,
  TOP_OFFERS,
};
