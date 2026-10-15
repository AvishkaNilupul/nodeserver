"use strict";
// Code shop — Eldorado same-set competitor scan (docs/code-shop/03-MARKETS.md,
// "competitors.js").
//
// Reads Eldorado's PUBLIC offer search (no login, no seller API) for a few
// search words per product, scores every offer by how many of the product's
// slot labels its title or description names, and stores the best matches
// plus the lowest price of an offer that sells the same set. pricing.js reads
// that number.
//
// Most rivals list these rewards as Twitch drops and name them only in the
// description ("19 Rewards" in the title, the list below it). The search
// answer already carries each offer's full description, so reading it costs
// no extra request. A description is a long list of OTHER rewards too, so it
// is matched strictly: a label must appear there as a phrase (accents folded,
// "player" / "code" and our own "(...)" notes optional), never as loose words
// spread over the text — "Banana Cat Spray" must not match "Banana Cat Icon
// ... Prost Spray". Titles keep the looser word rule as well.
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
// And only an offer that sells CODES (05-REVIEW-FIXES.md, R10): nearly every
// rival sells these rewards as a Twitch-drop account (log in, link the game
// account, claim within about two weeks), which is a different product from a
// redeem code that lasts months and needs no account. deliveryForm() reads it
// from the offer's wording; an offer it cannot place ("unknown") never sets
// our price either.
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
// A phrase shorter than this (spaces removed) is matched as whole words, so
// "ana" never matches inside "banana".
const MIN_COMPACT = 8;
// Words rivals often leave out of a reward's name ("Sun Tea Icon" for our
// "Sun Tea Player Icon"; "code" is ours, e.g. "(2nd code)").
const OPTIONAL_WORDS = new Set(["player", "code", "codes"]);
const MAX_DESCRIPTION = 5000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// --- pure ------------------------------------------------------------------

// Lower case, accents folded ("Skål" -> "skal"), anything else -> one space.
function normalise(text) {
  return String(text == null ? "" : text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(v) {
  return typeof v === "string" ? v.trim() : "";
}

// The owner's pinned queries when there are any; else up to 3:
// the two longest slot labels (ties keep slot order) and the game's name on
// its own. The search is already inside Eldorado's "Twitch Drops" category,
// where most sellers of these items list them as Twitch drops, not as codes:
// "<game> codes" found only the few titles that say "codes".
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
  if (displayName) add(displayName);
  return out.slice(0, MAX_QUERIES);
}

// The phrases a label may appear as, normalised: the label without our own
// "(...)" notes, and that again without OPTIONAL_WORDS. Empty phrases dropped.
function phrasesOf(label) {
  const base = normalise(String(label == null ? "" : label).replace(/\([^)]*\)/g, " "));
  const core = base
    .split(" ")
    .filter((w) => w && !OPTIONAL_WORDS.has(w))
    .join(" ");
  return [...new Set([base, core].filter(Boolean))];
}

// A text prepared once for phrase matching: spaced (" a b c ") and compact.
function phraseText(text) {
  const norm = normalise(text);
  return { spaced: " " + norm + " ", compact: norm.replace(/ /g, "") };
}

// Strict rule: one of the label's phrases appears in the text. Spaces do not
// count ("Loot Box" = "Lootbox", "Name Card" = "Namecard"), except for a short
// phrase, which must stand as whole words.
function phraseMatches(pt, label) {
  return phrasesOf(label).some((ph) => {
    const compact = ph.replace(/ /g, "");
    if (compact.length >= MIN_COMPACT) return pt.compact.includes(compact);
    return pt.spaced.includes(" " + ph + " ");
  });
}

// Loose rule, titles only: the normalised title contains the whole normalised
// label, or every word of the label that is >= 4 characters (and the label
// has at least one such word: "Ana" must appear as it is).
function labelMatches(normTitle, label) {
  const nl = normalise(label);
  if (!nl) return false;
  if (normTitle.includes(nl)) return true;
  const words = nl.split(" ").filter((w) => w.length >= MIN_WORD);
  return words.length > 0 && words.every((w) => normTitle.includes(w));
}

// Score = labels matched / labels (labels that normalise to nothing are not
// counted either way). sameSet = score >= 0.8. A label matches in the title
// (loose or strict rule) or in the description (strict rule only).
// matchedIn: "title" when the title alone names every matched label,
// "description" when the description added any, "" when nothing matched.
function scoreOffer(title, labels, description = "") {
  const list = (Array.isArray(labels) ? labels : []).filter((l) => normalise(l));
  if (!list.length) return { score: 0, sameSet: false, matches: 0, matchedIn: "" };
  const nt = normalise(title);
  const tp = phraseText(title);
  const dp = description ? phraseText(description) : null;
  let inTitle = 0;
  let matches = 0;
  for (const l of list) {
    if (labelMatches(nt, l) || phraseMatches(tp, l)) {
      inTitle += 1;
      matches += 1;
    } else if (dp && phraseMatches(dp, l)) {
      matches += 1;
    }
  }
  const score = matches / list.length;
  const matchedIn = matches === 0 ? "" : matches === inTitle ? "title" : "description";
  return { score, sameSet: score >= SAME_SET_SCORE, matches, matchedIn };
}

function positiveNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Eldorado search JSON -> [{ id, title, description, userId, priceUsd, qty }].
// description is the offer's own text (capped; "" when absent). priceUsd is
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
      description: typeof o.description === "string" ? o.description.slice(0, MAX_DESCRIPTION) : "",
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

// --- delivery form ------------------------------------------------------------

// Account words a code seller uses to say what is NOT needed ("No Twitch
// account or account linking needed", "no login details needed") are cut out
// before counting, so they never read as an account offer.
const NEG_WORDS = "no|not|without|never|don'?t|doesn'?t|do not|does not";
const ACCOUNT_TERMS =
  "twitch account|account linking|account sharing|linking|linked|link|login details|login|log in|logging in|" +
  "connect(?:ing|ed)?|password|e-?mail";
const NEGATED_BEFORE = new RegExp(`\\b(?:${NEG_WORDS})\\b[^.\\n;,!?]{0,40}\\b(?:${ACCOUNT_TERMS})\\b`, "gi");
const NEGATED_AFTER = new RegExp(
  `\\b(?:${ACCOUNT_TERMS}|account)\\b[^.\\n;,!?]{0,20}\\b(?:not|never)\\s+(?:needed|required|necessary)\\b`,
  "gi",
);
// "account" alone is no signal: a code seller says "redeem on your own account".
const ACCOUNT_SIGNALS = [
  /\btwitch accounts?\b/g,
  /\blog ?in\b|\blogging in\b/g,
  /\blink(?:s|ed|ing)?\b/g,
  /\bconnect(?:s|ed|ing)?\b/g,
  /\bclaim(?:s|ed|ing)?\b/g,
  /\bpasswords?\b/g,
  /\be-?mails?\b/g,
  /\btwitch drops?\b/g,
];
const CODE_SIGNALS = [/\bredeem(?:able)? codes?\b/g, /\b(?:cd|game|gift|activation|digital) ?keys?\b/g, /\bcodes?\b/g];
const FORMS = ["codes", "account", "unknown"];

// What an offer delivers, from its own words: "codes" when code wording
// outweighs account wording, "account" the other way round, "unknown" on a
// tie (including no wording at all).
function deliveryForm(title, description = "") {
  const t = (String(title == null ? "" : title) + "\n" + String(description == null ? "" : description))
    .toLowerCase()
    .replace(NEGATED_BEFORE, " ")
    .replace(NEGATED_AFTER, " ");
  const count = (list) => list.reduce((n, re) => n + (t.match(re) || []).length, 0);
  const account = count(ACCOUNT_SIGNALS);
  const codes = count(CODE_SIGNALS);
  if (codes > account) return "codes";
  if (account > codes) return "account";
  return "unknown";
}

// Does this same-set offer count as a price to follow? It must sell codes
// (R10), have stock, and (when our base price is known) ask at least 30 % of it.
function countsForLowest(offer, basePriceUsd) {
  if (!offer || !offer.sameSet) return false;
  if (offer.form !== "codes") return false;
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
      // The description is read for matching only; it is never stored.
      const { score, sameSet, matchedIn } = scoreOffer(o.title, labels, o.description);
      if (score <= 0) continue;
      const form = deliveryForm(o.title, o.description);
      scored.push({ id: o.id, title: o.title.slice(0, 300), priceUsd: o.priceUsd, qty: o.qty, score, sameSet, matchedIn, form });
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
    const byDescription = scored.filter((o) => o.matchedIn === "description").length;
    const byForm = { codes: 0, account: 0, unknown: 0 };
    for (const o of scored) byForm[o.form] += 1;
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
        "Scanned Eldorado for " + name + ": " + scored.length + " matching offers" +
        (byDescription ? " (" + byDescription + " named in the description only)" : "") +
        "; they sell codes " + byForm.codes + ", Twitch accounts " + byForm.account + ", unclear " + byForm.unknown + "; " +
        same.length + " same-set code " + (same.length === 1 ? "seller counts" : "sellers count") +
        (result.lowestSameSetUsd === null ? "" : ", lowest $" + result.lowestSameSetUsd.toFixed(2)),
      data: {
        requests,
        matching: scored.length,
        byDescription,
        byForm,
        sameSet: same.length,
        lowestSameSetUsd: result.lowestSameSetUsd,
      },
    });
    return result;
  }

  return { scan };
}

module.exports = {
  createCompetitors,
  queriesFor,
  scoreOffer,
  phrasesOf,
  deliveryForm,
  FORMS,
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
