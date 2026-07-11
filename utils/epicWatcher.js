// Epic free-games watcher: tracks Epic's weekly giveaway slate (current +
// announced-upcoming) from the same public endpoint the store page uses, and
// alerts when a new giveaway is announced or an announced one goes live —
// each freebie claimed onto stock Epic accounts raises the bundle's value.
const axios = require("axios");

const EpicFreebie = require("../models/EpicFreebie");
const { sendTelegram } = require("./telegram");

const FEED_URL =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions" +
  "?locale=en-US&country=US&allowCountries=US";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";
const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { live: 0, upcoming: 0, new: 0, wentLive: 0 },
};

// A giveaway window is a 100%-off promotional offer.
function freeWindow(list) {
  for (const block of list || []) {
    for (const w of (block && block.promotionalOffers) || []) {
      const pct =
        w && w.discountSetting && w.discountSetting.discountPercentage;
      if (pct === 0) return w;
    }
  }
  return null;
}

function storeUrl(el) {
  const slug =
    (el.catalogNs &&
      Array.isArray(el.catalogNs.mappings) &&
      el.catalogNs.mappings.length &&
      el.catalogNs.mappings[0].pageSlug) ||
    (el.offerMappings &&
      el.offerMappings.length &&
      el.offerMappings[0].pageSlug) ||
    (el.productSlug ? String(el.productSlug).split("/")[0] : "");
  return slug ? "https://store.epicgames.com/en-US/p/" + slug : "";
}

function normalize(el) {
  const promos = el.promotions || {};
  const cur = freeWindow(promos.promotionalOffers);
  const up = freeWindow(promos.upcomingPromotionalOffers);
  const w = cur || up;
  if (!w) return null;
  const img =
    (el.keyImages || []).find(
      (k) =>
        k && (k.type === "OfferImageWide" || k.type === "DieselStoreFrontWide"),
    ) || (el.keyImages || [])[0];
  return {
    offerId: el.id,
    namespace: el.namespace || "",
    title: el.title || "",
    description: el.description || "",
    image: (img && img.url) || "",
    url: storeUrl(el),
    originalPrice:
      (el.price &&
        el.price.totalPrice &&
        el.price.totalPrice.fmtPrice &&
        el.price.totalPrice.fmtPrice.originalPrice) ||
      "",
    startDate: w.startDate ? new Date(w.startDate) : null,
    endDate: w.endDate ? new Date(w.endDate) : null,
    upcoming: !cur,
  };
}

async function fetchFreebies() {
  const r = await axios.get(FEED_URL, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    timeout: 30000,
  });
  const els =
    (r.data &&
      r.data.data &&
      r.data.data.Catalog &&
      r.data.data.Catalog.searchStore &&
      r.data.data.Catalog.searchStore.elements) ||
    [];
  return els.map(normalize).filter(Boolean);
}

function fmtWindow(o) {
  const f = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "?");
  return f(o.startDate) + " → " + f(o.endDate);
}

async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  try {
    const offers = await fetchFreebies();
    const now = new Date();
    const seeding = (await EpicFreebie.estimatedDocumentCount()) === 0;
    const seenIds = new Set();
    const fresh = [];
    const wentLive = [];
    let live = 0;

    for (const o of offers) {
      seenIds.add(o.offerId);
      if (!o.upcoming) live++;
      const prev = await EpicFreebie.findOneAndUpdate(
        { offerId: o.offerId },
        { $set: { ...o, active: true, lastSeenAt: now } },
        { upsert: true, returnDocument: "before" },
      );
      if (!prev) fresh.push(o);
      else if (prev.upcoming && !o.upcoming && !prev.liveNotifiedAt) {
        wentLive.push(o);
      }
    }

    await EpicFreebie.updateMany(
      { active: true, offerId: { $nin: [...seenIds] } },
      { $set: { active: false } },
    );

    for (const o of seeding ? [] : fresh) {
      await sendTelegram(
        "🕹 Epic free game " +
          (o.upcoming ? "announced" : "LIVE now") +
          " — " +
          o.title +
          (o.originalPrice ? " (worth " + o.originalPrice + ")" : "") +
          "\nFree " +
          fmtWindow(o) +
          (o.url ? "\n" + o.url : ""),
      ).catch(() => {});
      await EpicFreebie.updateOne(
        { offerId: o.offerId },
        {
          $set: {
            notifiedAt: now,
            ...(o.upcoming ? {} : { liveNotifiedAt: now }),
          },
        },
      ).catch(() => {});
    }

    for (const o of seeding ? [] : wentLive) {
      await sendTelegram(
        "🕹 Epic free game is LIVE — " +
          o.title +
          (o.originalPrice ? " (worth " + o.originalPrice + ")" : "") +
          "\nClaim it before " +
          (o.endDate ? new Date(o.endDate).toISOString().slice(0, 10) : "?") +
          (o.url ? "\n" + o.url : ""),
      ).catch(() => {});
      await EpicFreebie.updateOne(
        { offerId: o.offerId },
        { $set: { liveNotifiedAt: now } },
      ).catch(() => {});
    }

    if (seeding && fresh.length) {
      // Suppress the "new/live" ping for the initial catalog, but only mark
      // liveNotifiedAt on offers already live — an "upcoming" one must keep
      // it unset so its future upcoming -> live transition still alerts.
      await EpicFreebie.updateMany({}, { $set: { notifiedAt: now } }).catch(
        () => {},
      );
      await EpicFreebie.updateMany(
        { upcoming: false },
        { $set: { liveNotifiedAt: now } },
      ).catch(() => {});
      await sendTelegram(
        "🕹 Epic free-games watcher is live — tracking " +
          live +
          " current and " +
          (fresh.length - live) +
          " upcoming giveaway(s). You'll get a ping for every new one.",
      ).catch(() => {});
    }

    state.lastCounts = {
      live,
      upcoming: offers.length - live,
      new: fresh.length,
      wentLive: wentLive.length,
    };
    // A giveaway just went live (or a brand-new one appeared already live):
    // kick the account claimer so claim links go out immediately.
    if (!seeding && (wentLive.length || fresh.some((o) => !o.upcoming))) {
      const epicClaimer = require("./epicClaimer");
      epicClaimer.runOnce().catch(() => {});
    }
    state.lastError = "";
    return state.lastCounts;
  } catch (err) {
    state.lastError = err.message || String(err);
    throw err;
  } finally {
    state.lastRun = new Date();
    state.running = false;
  }
}

function status() {
  return {
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    intervalHours: TICK_MS / 3600000,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("epicWatcher error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, 50000);
  if (t.unref) t.unref();
}

module.exports = { start, runOnce, status };
