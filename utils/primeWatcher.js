// Prime Gaming watcher: keeps a local catalog of every Prime Gaming offer
// (free game claims and in-game loot) and alerts when something changes, so
// new offers can be farmed/claimed before they expire.
//
// Amazon moved Prime Gaming claims to luna.amazon.com. The catalog is public
// (no Prime login needed): the claims page hands out a session cookie and a
// csrf-key, and the same GraphQL endpoint the page uses then returns every
// offer. Each pass:
//   1. GET  /claims/home  -> session cookies + csrf-key
//   2. POST /graphql      -> LOOT / FREE_GAMES collections
//   3. Upsert PrimeOffer rows; offers gone from the feed are marked inactive.
//   4. Telegram-alert the super-admin chats about new offers, offers ending
//      within 48h, and especially any in-game loot (the resellable stuff).
const axios = require("axios");

const PrimeOffer = require("../models/PrimeOffer");
const PrimeKey = require("../models/PrimeKey");
const { sendTelegram } = require("./telegram");

const LUNA = "https://luna.amazon.com";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";
const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours
const ENDING_SOON_MS = 48 * 60 * 60 * 1000;
// A claimed key's redemption window is usually much tighter than an offer's
// claim window, so this fires well before ENDING_SOON_MS-style urgency —
// enough runway to sell it or redeem it onto a stored GOG account by hand
// (auto-redeeming isn't possible: GOG's login and redeem-code pages are both
// behind reCAPTCHA).
const KEY_EXPIRY_ALERT_MS = 72 * 60 * 60 * 1000;

// Same shape the Luna page requests, trimmed to the fields we store.
const QUERY =
  "query PrimeOffers($pageSize: Int) {\n" +
  "  inGameLoot: items(collectionType: LOOT, pageSize: $pageSize) {\n" +
  "    items { ...It } }\n" +
  "  games: items(collectionType: FREE_GAMES, pageSize: $pageSize) {\n" +
  "    items { ...It } }\n" +
  "}\n" +
  "fragment It on Item {\n" +
  "  id grantsCode category\n" +
  "  assets { title externalClaimLink shortformDescription\n" +
  "    cardMedia { defaultMedia { src1x } } }\n" +
  "  offers { startTime endTime }\n" +
  "  game { assets { title } }\n" +
  "}";

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { games: 0, loot: 0, new: 0, ended: 0 },
};

// ------------------------------------------------------------------
// Fetching
// ------------------------------------------------------------------
function cookieHeader(setCookies) {
  return (setCookies || [])
    .map((c) => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function fetchOffers() {
  const page = await axios.get(LUNA + "/claims/home?g=s", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    timeout: 30000,
  });
  const html = String(page.data || "");
  const m = html.match(/csrf-key'\s*value='([^']+)'/);
  if (!m) throw new Error("Prime watcher: csrf-key not found on claims page");
  const cookies = cookieHeader(page.headers["set-cookie"]);

  const r = await axios.post(
    LUNA + "/graphql",
    {
      operationName: "PrimeOffers",
      variables: { pageSize: 999 },
      query: QUERY,
    },
    {
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "client-id": "CarboniteApp",
        "csrf-token": m[1],
        "prime-gaming-language": "en-US",
        referer: LUNA + "/claims/home",
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: 30000,
    },
  );
  const d = (r.data && r.data.data) || {};
  return [
    ...((d.games && d.games.items) || []),
    ...((d.inGameLoot && d.inGameLoot.items) || []),
  ];
}

// "https://gaming.amazon.com/cyclones-gog/dp/..." -> "gog"
function platformOf(item) {
  const link = (item.assets && item.assets.externalClaimLink) || "";
  const slug = (link.match(/amazon\.com\/([^/]+)\/dp\//) || [])[1] || "";
  const tail = (slug.match(/-([a-z0-9]+)$/i) || [])[1] || "";
  if (tail) return tail.toLowerCase(); // gog / epic / aga / legacy…
  return item.grantsCode ? "code" : "link";
}

function normalize(item) {
  const offer = (item.offers && item.offers[0]) || {};
  return {
    itemId: item.id,
    title: (item.assets && item.assets.title) || "",
    description: (item.assets && item.assets.shortformDescription) || "",
    category: item.category || "",
    platform: platformOf(item),
    grantsCode: !!item.grantsCode,
    claimLink: (item.assets && item.assets.externalClaimLink) || "",
    image:
      (item.assets &&
        item.assets.cardMedia &&
        item.assets.cardMedia.defaultMedia &&
        item.assets.cardMedia.defaultMedia.src1x) ||
      "",
    game: (item.game && item.game.assets && item.game.assets.title) || "",
    startTime: offer.startTime ? new Date(offer.startTime) : null,
    endTime: offer.endTime ? new Date(offer.endTime) : null,
  };
}

// ------------------------------------------------------------------
// One pass
// ------------------------------------------------------------------
async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  try {
    const items = (await fetchOffers()).filter((i) => i && i.id);
    const now = new Date();
    // Very first pass just seeds the catalog — don't blast one Telegram
    // message per already-live offer.
    const seeding = (await PrimeOffer.estimatedDocumentCount()) === 0;
    const seenIds = new Set();
    const fresh = [];
    let loot = 0;

    for (const raw of items) {
      const o = normalize(raw);
      seenIds.add(o.itemId);
      if (o.category === "LOOT") loot++;
      const prev = await PrimeOffer.findOneAndUpdate(
        { itemId: o.itemId },
        { $set: { ...o, active: true, lastSeenAt: now } },
        { upsert: true, returnDocument: "before" },
      );
      if (!prev) fresh.push(o);
    }

    // Offers no longer in the feed have ended.
    const gone = await PrimeOffer.updateMany(
      { active: true, itemId: { $nin: [...seenIds] } },
      { $set: { active: false } },
    );

    // Alerts — every alert is best-effort; a Telegram hiccup never fails the
    // pass. New in-game loot gets its own louder message since that's the
    // sellable category.
    for (const o of seeding ? [] : fresh) {
      const kind = o.category === "LOOT" ? "IN-GAME LOOT" : "free game";
      const ends = o.endTime
        ? " (until " + o.endTime.toISOString().slice(0, 10) + ")"
        : "";
      await sendTelegram(
        "🎁 Prime Gaming: new " +
          kind +
          " — " +
          o.title +
          (o.game && o.game !== o.title ? " [" + o.game + "]" : "") +
          " via " +
          o.platform +
          (o.grantsCode ? " (gives a code)" : "") +
          ends +
          "\n" +
          o.claimLink,
      ).catch(() => {});
      await PrimeOffer.updateOne(
        { itemId: o.itemId },
        { $set: { notifiedAt: now } },
      ).catch(() => {});
    }

    if (seeding && fresh.length) {
      // Only suppress the "new offer" ping for the initial catalog — leave
      // endingNotifiedAt untouched so offers already close to expiring still
      // get their 48h reminder below instead of being silenced forever.
      await PrimeOffer.updateMany({}, { $set: { notifiedAt: now } }).catch(
        () => {},
      );
      await sendTelegram(
        "🎮 Prime Gaming watcher is live — tracking " +
          fresh.length +
          " current offer(s). You'll get a ping for every new offer, new " +
          "in-game loot, and offers about to expire.",
      ).catch(() => {});
    }

    // Ending-soon reminders (once per offer).
    const endingSoon = await PrimeOffer.find({
      active: true,
      endingNotifiedAt: null,
      endTime: {
        $ne: null,
        $gt: now,
        $lt: new Date(now.getTime() + ENDING_SOON_MS),
      },
    }).lean();
    for (const o of endingSoon) {
      await sendTelegram(
        "⏳ Prime Gaming: “" +
          o.title +
          "” ends " +
          new Date(o.endTime).toISOString().slice(0, 16).replace("T", " ") +
          " UTC — claim it before it's gone.\n" +
          o.claimLink,
      ).catch(() => {});
      await PrimeOffer.updateOne(
        { _id: o._id },
        { $set: { endingNotifiedAt: now } },
      ).catch(() => {});
    }

    state.lastCounts = {
      games: items.length - loot,
      loot,
      new: fresh.length,
      ended: gone.modifiedCount || 0,
    };
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

// Warns about claimed-but-unsold/unredeemed keys before their redemption
// window closes — the alert fires once per key (expiryAlertSentAt guards
// against repeating it every tick) and leaves the actual sell/redeem
// decision to the operator, since auto-redeeming onto GOG isn't possible.
async function checkExpiringKeys() {
  const now = new Date();
  const soon = new Date(now.getTime() + KEY_EXPIRY_ALERT_MS);
  const keys = await PrimeKey.find({
    status: { $in: ["unused", "listed"] },
    expiresAt: { $ne: null, $gt: now, $lt: soon },
    expiryAlertSentAt: null,
  }).lean();
  for (const k of keys) {
    const hoursLeft = Math.max(
      1,
      Math.round((new Date(k.expiresAt).getTime() - now.getTime()) / 3600000),
    );
    await sendTelegram(
      "⏳ GOG key expiring soon: “" +
        k.title +
        "” expires in ~" +
        hoursLeft +
        "h (" +
        new Date(k.expiresAt).toISOString().slice(0, 16).replace("T", " ") +
        " UTC). Sell it now or redeem it onto a stored GOG account before " +
        "it goes dead.",
    ).catch(() => {});
    await PrimeKey.updateOne(
      { _id: k._id },
      { $set: { expiryAlertSentAt: now } },
    ).catch(() => {});
  }
  return keys.length;
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("primeWatcher error:", err.message);
    }
    try {
      await checkExpiringKeys();
    } catch (err) {
      console.error("primeWatcher expiry check error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  // First pass shortly after boot so the tab has data without waiting 6h.
  const t = setTimeout(tick, 20000);
  if (t.unref) t.unref();
}

module.exports = { start, runOnce, status, platformOf, checkExpiringKeys };
