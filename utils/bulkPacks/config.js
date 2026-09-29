// Bulk packs — shared constants and the pure gates every other bulk-pack module
// reads (docs/bulk-packs/CONTRACT.md, MODULES.md §config.js).
//
// DEPENDENCY-FREE AT TOP LEVEL. models/BulkOffer.js requires OPEN_STATES /
// CLOSED_STATES from here, so this file must never pull a model or the
// settings store in at load time. The one impure function, currentGate, reaches
// utils/settings.js lazily through `deps` (CONTRACT §9), and deliveryGate only
// borrows settings.getBulkPacks — pure when handed an object — at call time.
//
// Every constant is frozen. They are the single list of where bulk offers may
// go, shared by nine modules: a stray `SOURCE_MARKETS.dropset.push(...)` in one
// of them would silently widen the market reach of all the others, so a
// mutation has to fail instead.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(o);
};

const SUPPORTED_MARKETS = deepFreeze(["eldorado", "g2g", "gameflip"]);
// Owner block since 2026-09-28: both seller accounts are blocked by the
// platforms. Refused by every gate here whatever the settings say — "plati" is
// listed beside "digiseller" so neither spelling can slip through.
const BLOCKED_MARKETS = deepFreeze(["digiseller", "plati", "ggsel"]);
// Gameflip carries dropset packs only in v1 (CONTRACT §1).
const SOURCE_MARKETS = deepFreeze({
  dropset: ["eldorado", "g2g", "gameflip"],
  noclaim: ["eldorado", "g2g"],
  farm: ["eldorado", "g2g"],
});
const KIND_OF_SOURCE = deepFreeze({
  dropset: "accounts",
  noclaim: "accounts",
  farm: "farming",
});
const MARKET_FLOORS = deepFreeze({ eldorado: 0.5, g2g: 1, gameflip: 0.75 });
const TITLE_MAX = deepFreeze({ eldorado: 160, g2g: 128, gameflip: 120 });
const DESC_MAX = deepFreeze({ eldorado: 2000, g2g: 5000, gameflip: 5000 });
// The farm services' own order-title test (utils/eldoradoFarmService.js
// FARM_TITLE). An ACCOUNT title that matched it would have its order grabbed by
// the rent-farm lane (CONTRACT I5). No g/y flag: .test() stays stateless.
const FARM_TITLE_RE = /\bAutomatic\s+Farming\b/i;
// `open` is true exactly while the state is one of these (CONTRACT §5, I6).
const OPEN_STATES = deepFreeze(["sending", "live", "paused"]);
const CLOSED_STATES = deepFreeze([
  "sold_out",
  "sold",
  "withdrawn",
  "expired",
  "error",
]);

const MARKET_LABELS = {
  eldorado: "Eldorado",
  g2g: "G2G",
  gameflip: "Gameflip",
  digiseller: "Plati (Digiseller)",
  plati: "Plati",
  ggsel: "GGSel",
};
const SOURCE_LABELS = {
  dropset: "farmed-account",
  noclaim: "no-claim",
  farm: "farming",
};

const has = (obj, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

// Blocked detection is deliberately LOOSER than the supported test: "GGSel" or
// " plati " still reads as blocked, while only the exact lowercase spelling of
// a supported market is ever accepted.
function isBlocked(market) {
  return BLOCKED_MARKETS.includes(
    String(market == null ? "" : market)
      .trim()
      .toLowerCase(),
  );
}

function labelOf(market) {
  const key = String(market == null ? "" : market)
    .trim()
    .toLowerCase();
  return (
    MARKET_LABELS[key] || String(market == null ? "" : market) || "(no market)"
  );
}

// A number, or a non-blank numeric string; anything else (null, booleans,
// arrays, "") is NaN rather than the 0/1 that Number() would make of it.
function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return NaN;
}

// ---------------------------------------------------------------------------
// Lazy dependencies (CONTRACT §9)
// ---------------------------------------------------------------------------
let depOverrides = {};
const deps = {
  get settings() {
    return depOverrides.settings || require("../settings");
  },
};
function __setDeps(partial) {
  depOverrides = {
    ...depOverrides,
    ...(partial && typeof partial === "object" ? partial : {}),
  };
}
function __resetDeps() {
  depOverrides = {};
}

// ---------------------------------------------------------------------------
// Slots, markets, tiers
// ---------------------------------------------------------------------------

// CONTRACT I6: [kind, source, setId || (game + "@" + days), market, minQty].
// The unique partial index on BulkOffer.slotKey is what turns a double click
// into a 409, so send.js and proposals.js must both build the key here.
// `kind` falls back to the source's own kind when a caller leaves it out; a
// well-formed call gets exactly the contract's string.
function slotKey({ kind, source, setId, game, days, market, minQty } = {}) {
  const k = kind || (has(KIND_OF_SOURCE, source) ? KIND_OF_SOURCE[source] : "");
  const target = setId
    ? String(setId)
    : (game == null ? "" : String(game)) +
      "@" +
      (days == null ? "" : String(days));
  return [k, source, target, market, minQty].join("|");
}

// Supported, not blocked, and switched on in bp.markets (bp = settings.getBulkPacks()).
function isMarketAllowed(market, bp) {
  if (isBlocked(market)) return false;
  if (typeof market !== "string" || !SUPPORTED_MARKETS.includes(market))
    return false;
  const list = bp && Array.isArray(bp.markets) ? bp.markets : [];
  return list.includes(market);
}

// The configured tier whose minQty is exactly `minQty`, as a fresh object.
function tierFor(bp, minQty) {
  const q = toNum(minQty);
  if (!Number.isInteger(q)) return null;
  const tiers = bp && Array.isArray(bp.tiers) ? bp.tiers : [];
  const t = tiers.find((x) => x && toNum(x.minQty) === q);
  if (!t) return null;
  const d = toNum(t.discountPct);
  return { minQty: q, discountPct: Number.isFinite(d) ? d : 0 };
}

// ---------------------------------------------------------------------------
// Delivery gate (CONTRACT I4)
// ---------------------------------------------------------------------------
// Nothing is published unless a sale of it would actually be delivered. The
// flags are compared STRICTLY (=== true / === false): a missing or hand-typed
// value keeps the gate shut, never open.
//
// Beyond the flags, a market must also be switched on for bulk packs
// (autoFarm.bulkPacksMarkets). I4 words Gameflip as "always ok when the market
// is enabled"; the same test is applied to every market, so no chip can read
// "live" for a market the owner has unticked.
function closed(reason) {
  return { ok: false, reason };
}

function bulkMarketsOf(af) {
  // Pure for an object argument: getBulkPacks(af) never touches settings.json
  // when it is handed the auto-farm object. A failure reads as "no market".
  try {
    const markets = require("../settings").getBulkPacks(af).markets;
    return Array.isArray(markets) ? markets : [];
  } catch {
    return [];
  }
}

function deliveryGate({ market, source, af, noclaimShop } = {}) {
  const label = labelOf(market);
  if (isBlocked(market)) {
    return closed(label + " is blocked (owner block since 2026-09-28)");
  }
  if (typeof market !== "string" || !SUPPORTED_MARKETS.includes(market)) {
    return closed(label + " is not a bulk-pack market");
  }
  if (!has(SOURCE_MARKETS, source)) {
    return closed(
      'unknown bulk-pack source "' + String(source == null ? "" : source) + '"',
    );
  }
  if (!SOURCE_MARKETS[source].includes(market)) {
    return closed(
      label + " does not carry " + SOURCE_LABELS[source] + " packs",
    );
  }
  if (!af || typeof af !== "object") {
    return closed("auto-farm settings are unavailable");
  }
  if (!bulkMarketsOf(af).includes(market)) {
    return closed(
      label + " is switched off for bulk packs (autoFarm.bulkPacksMarkets)",
    );
  }
  if (market === "eldorado") {
    if (af.eldoradoAutoDeliver !== true) {
      return closed(
        "Eldorado auto-delivery is off (autoFarm.eldoradoAutoDeliver)",
      );
    }
    if (af.eldoradoDeliverDryRun !== false) {
      return closed(
        "Eldorado delivery is in dry-run (autoFarm.eldoradoDeliverDryRun)",
      );
    }
  } else if (market === "g2g") {
    if (af.g2gAutoDeliver !== true) {
      return closed("G2G auto-delivery is off (autoFarm.g2gAutoDeliver)");
    }
    if (af.g2gDeliverDryRun !== false) {
      return closed("G2G delivery is in dry-run (autoFarm.g2gDeliverDryRun)");
    }
  }
  // gameflip: native delivery — the code rides on the listing itself.
  if (source === "noclaim") {
    if (!noclaimShop || typeof noclaimShop !== "object") {
      return closed("No-claim Shop settings are unavailable");
    }
    if (noclaimShop.enabled !== true) {
      return closed("No-claim Shop is switched off (noclaimShop.enabled)");
    }
    if (noclaimShop.autoDeliver !== true) {
      return closed("No-claim Shop delivery is off (noclaimShop.autoDeliver)");
    }
  }
  return { ok: true, reason: "" };
}

// The live gate, from the settings as they are right now. Never throws: a
// failed settings read is a CLOSED gate.
function currentGate(market, source) {
  try {
    const s = deps.settings;
    let af = null;
    let noclaimShop = null;
    let readError = "";
    try {
      af = s.getAutoFarm();
    } catch (e) {
      readError = (e && e.message) || String(e);
    }
    if (source === "noclaim") {
      try {
        noclaimShop = s.getNoclaimShopSettings();
      } catch (e) {
        readError = readError || (e && e.message) || String(e);
      }
    }
    const gate = deliveryGate({ market, source, af, noclaimShop });
    // Name the read failure only where it is the reason the gate is shut; a
    // blocked or unsupported market keeps its own, more useful, reason.
    if (!gate.ok && readError && gate.reason.endsWith("unavailable")) {
      return closed(gate.reason + ": " + readError);
    }
    return gate;
  } catch (e) {
    return closed(
      "delivery gate check failed: " + ((e && e.message) || String(e)),
    );
  }
}

module.exports = {
  SUPPORTED_MARKETS,
  BLOCKED_MARKETS,
  SOURCE_MARKETS,
  KIND_OF_SOURCE,
  MARKET_FLOORS,
  TITLE_MAX,
  DESC_MAX,
  FARM_TITLE_RE,
  OPEN_STATES,
  CLOSED_STATES,
  slotKey,
  isMarketAllowed,
  tierFor,
  deliveryGate,
  currentGate,
  __setDeps,
  __resetDeps,
};
