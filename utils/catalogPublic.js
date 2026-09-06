/**
 * Catalog v2 — pure helpers for the public bulk catalog.
 * Contract: docs/CATALOG-V2-CONTRACT.md §2 (vocabulary) + §3 (this file).
 *
 * Deliberately dependency-free: zero imports, no DB, no I/O, no clocks other
 * than an injectable `now`. Everything is deterministic given its
 * arguments so it can be unit-tested with `node --test` and shared by
 * routes/catalogRoutes.js without dragging models in.
 */

// Marketplace key → human label for public buy links (§2).
const MARKETPLACE_LABELS = Object.freeze({
  gameflip: "Gameflip",
  eldorado: "Eldorado.gg",
  ggsel: "GGSel",
  digiseller: "Plati",
  zeusx: "ZeusX",
  funpay: "FunPay",
  epicnpc: "EpicNPC",
  g2g: "G2G",
  z2u: "Z2U",
});

// Keys that must never appear anywhere in a public payload (§2 privacy rule).
const PRIVATE_KEYS = Object.freeze([
  "login",
  "loginLower",
  "password",
  "credPassword",
  "clientSecret",
  "twitchId",
  "botId",
  "container",
  "configFile",
  "accountScopeLogins",
  "accountScopeIds",
]);

const PRIVATE_KEY_SET = new Set(PRIVATE_KEYS);
const TITLE_MAX_CHARS = 140;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUY_LINKS = 5;
const HTTP_URL = /^https?:\/\//i;

// Representative rank patterns for dedupeListings (lower rank wins).
const KEY_EVENT = /^autofarm:(?!set:)/;
const KEY_STACK = /^autofarm-stack:/;
const KEY_ORPHAN = /^autofarm:set:/;

// ---------------------------------------------------------------------------
// Small internal utilities
// ---------------------------------------------------------------------------

function str(value) {
  return value == null ? "" : String(value).trim();
}

/** Date | ISO string | epoch ms → epoch ms, or NaN when missing/invalid. */
function toMs(value) {
  if (value == null || value === "") return NaN;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** Injectable clock: accepts Date | epoch ms, falls back to Date.now(). */
function nowMs(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** Trim + hard-cap a title at TITLE_MAX_CHARS (§3 deriveTitle). */
function capTitle(text) {
  const trimmed = str(text);
  return trimmed.length > TITLE_MAX_CHARS
    ? trimmed.slice(0, TITLE_MAX_CHARS).trim()
    : trimmed;
}

/** "left — right", dropping empty halves so a title never starts with a dash. */
function joinDash(left, right) {
  return [str(left), str(right)].filter(Boolean).join(" — ");
}

// ---------------------------------------------------------------------------
// signatureFor
// ---------------------------------------------------------------------------

/**
 * Canonical item signature of a DropSet: `itemKeyxqty|itemKeyxqty|…`, sorted.
 * Items without an itemKey are skipped; no items → "".
 * (Same formula as §2 — routes/catalogPreorder.js re-implements it locally.)
 */
function signatureFor(set) {
  const items = set && Array.isArray(set.items) ? set.items : [];
  return items
    .filter((item) => item && item.itemKey)
    .map((item) => `${item.itemKey}x${Math.max(1, Number(item.qty) || 1)}`)
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

/**
 * Public listing title (≤140 chars, trimmed). Rules in order (§3):
 *  1. set.publicTitle when non-empty.
 *  2. kind "unclaimed" → "<category> — <eventLabel> (unclaimed drops)" or
 *     "<category> — <n> unclaimed drop(s)" (n = items.length).
 *  3. catalog_profile sets, or sets without a sourceEventName → set.name.
 *  4. event sets: event == category → "<category> Twitch Drops";
 *     event contains category → event; else "<category> — <event>".
 */
function deriveTitle({ set, category, kind, eventLabel } = {}) {
  const s = set || {};
  const publicTitle = str(s.publicTitle);
  if (publicTitle) return capTitle(publicTitle);

  const g = str(category);
  if (str(kind).toLowerCase() === "unclaimed") {
    const label = str(eventLabel);
    if (label) return capTitle(joinDash(g, `${label} (unclaimed drops)`));
    const n = Array.isArray(s.items) ? s.items.length : 0;
    return capTitle(joinDash(g, `${n} unclaimed drop${n === 1 ? "" : "s"}`));
  }

  const e = str(s.sourceEventName);
  if (s.sourceType === "catalog_profile" || !e) {
    return capTitle(str(s.name) || g);
  }

  const eLower = e.toLowerCase();
  const gLower = g.toLowerCase();
  if (g && eLower === gLower) return capTitle(`${g} Twitch Drops`);
  if (eLower.includes(gLower)) return capTitle(e);
  return capTitle(joinDash(g, e));
}

// ---------------------------------------------------------------------------
// dedupeListings
// ---------------------------------------------------------------------------

/**
 * Representative rank of a set inside a duplicate group (lower wins):
 *   0 autofarm event set   (sourceEventKey "autofarm:<campaign>")
 *   1 autofarm stack set   (sourceEventKey "autofarm-stack:…")
 *   2 autofarm orphan set  (sourceEventKey "autofarm:set:<id>")
 *   3 catalog_profile
 *   4 anything else
 * Key patterns apply to autofarm_event sets (and to sets with no sourceType
 * at all, where the key is the only evidence); other sourceTypes ignore them.
 */
function representativeRank(set) {
  const s = set || {};
  const type = str(s.sourceType);
  const key = str(s.sourceEventKey);
  if (type === "autofarm_event" || !type) {
    if (KEY_EVENT.test(key)) return 0;
    if (KEY_STACK.test(key)) return 1;
    if (KEY_ORPHAN.test(key)) return 2;
  }
  if (type === "catalog_profile") return 3;
  return 4;
}

/** true when member `a` should replace `b` as its group's representative. */
function beatsRepresentative(a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.stock !== b.stock) return a.stock > b.stock;
  const createdA = toMs(a.row.set && a.row.set.createdAt);
  const createdB = toMs(b.row.set && b.row.set.createdAt);
  const validA = Number.isFinite(createdA);
  const validB = Number.isFinite(createdB);
  if (validA && validB && createdA !== createdB) return createdA > createdB;
  if (validA !== validB) return validA;
  return false; // full tie → keep the earlier member
}

/** `now` for isNewAny: options.now first, else an optional third argument. */
function pickNow(opts, extra) {
  if (opts.now != null) return nowMs(opts.now);
  if (extra != null && typeof extra === "object" && !(extra instanceof Date)) {
    return nowMs(extra.now);
  }
  return nowMs(extra);
}

/**
 * Fold rows that advertise the identical items×qty in the same category.
 * rows = [{ set, stock, category, ...any }]. Group key =
 * `${category.toLowerCase()}::${signatureFor(set)}`; an empty signature is
 * never grouped. Each output row is a shallow copy of the group's
 * representative plus: stock (max|sum), mergedIds, mergedCount, updatedAt
 * (max member set.updatedAt), isNewAny (any member created within 24 h of
 * `now`). Output order = first appearance of each group in the input.
 */
function dedupeListings(rows, options = {}, extra) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = options && typeof options === "object" ? options : {};
  const stockMode =
    String(opts.stockMode || "max").toLowerCase() === "sum" ? "sum" : "max";
  const now = pickNow(opts, extra);

  const groups = [];
  const byKey = new Map();
  list.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const set = row.set || {};
    const member = {
      row,
      index,
      rank: representativeRank(set),
      stock: Number(row.stock) || 0,
    };
    const signature = signatureFor(set);
    if (!signature) {
      groups.push([member]);
      return;
    }
    const key = `${str(row.category).toLowerCase()}::${signature}`;
    const group = byKey.get(key);
    if (group) {
      group.push(member);
    } else {
      const created = [member];
      byKey.set(key, created);
      groups.push(created);
    }
  });

  return groups.map((members) => {
    let rep = members[0];
    for (let i = 1; i < members.length; i += 1) {
      if (beatsRepresentative(members[i], rep)) rep = members[i];
    }

    let stock = 0;
    let updatedAt = null;
    let updatedMs = -Infinity;
    let isNewAny = false;
    const mergedIds = [];
    members.forEach((member) => {
      stock =
        stockMode === "sum"
          ? stock + member.stock
          : Math.max(stock, member.stock);
      const set = member.row.set || {};
      const updated = toMs(set.updatedAt);
      if (Number.isFinite(updated) && updated > updatedMs) {
        updatedMs = updated;
        updatedAt = set.updatedAt;
      }
      const created = toMs(set.createdAt);
      if (Number.isFinite(created) && Math.abs(now - created) <= DAY_MS) {
        isNewAny = true;
      }
      if (member !== rep && set._id != null) mergedIds.push(String(set._id));
    });

    return {
      ...rep.row,
      stock,
      mergedIds,
      mergedCount: members.length - 1,
      updatedAt,
      isNewAny,
    };
  });
}

// ---------------------------------------------------------------------------
// unclaimedSummary
// ---------------------------------------------------------------------------

/**
 * Stock + labelling for a DropSet backed by UnclaimedAccount ledgers.
 * ledgers = rows of THIS set: [{ status, drops:[{ campaign }], bundleLabel }].
 *   listed    = status "listed"
 *   held      = status "skipped" with at least one drop (manual bulk stash)
 *   stock     = listed + held
 *   campaigns = [{ name, count }] of drops[].campaign, count desc then name
 *   eventLabel = most common bundleLabel → set.sourceEventName
 *                → campaigns[0].name → ""
 */
function unclaimedSummary({ set, ledgers } = {}) {
  const s = set || {};
  const rows = Array.isArray(ledgers) ? ledgers : [];
  let listed = 0;
  let held = 0;
  const campaignCounts = new Map();
  const labelCounts = new Map();

  rows.forEach((ledger) => {
    if (!ledger || typeof ledger !== "object") return;
    const drops = Array.isArray(ledger.drops) ? ledger.drops : [];
    if (ledger.status === "listed") listed += 1;
    else if (ledger.status === "skipped" && drops.length > 0) held += 1;
    drops.forEach((drop) => {
      const name = str(drop && drop.campaign);
      if (name) campaignCounts.set(name, (campaignCounts.get(name) || 0) + 1);
    });
    const label = str(ledger.bundleLabel);
    if (label) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  });

  const campaigns = [...campaignCounts]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (a, b) =>
        b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

  let eventLabel = "";
  let bestCount = 0;
  labelCounts.forEach((count, label) => {
    if (count > bestCount) {
      bestCount = count;
      eventLabel = label;
    }
  });
  if (!eventLabel) eventLabel = str(s.sourceEventName);
  if (!eventLabel && campaigns.length) eventLabel = campaigns[0].name;

  return { stock: listed + held, listed, held, eventLabel, campaigns };
}

// ---------------------------------------------------------------------------
// buyLinksFor
// ---------------------------------------------------------------------------

function labelFor(marketplace) {
  if (Object.prototype.hasOwnProperty.call(MARKETPLACE_LABELS, marketplace)) {
    return MARKETPLACE_LABELS[marketplace];
  }
  return marketplace
    ? marketplace.charAt(0).toUpperCase() + marketplace.slice(1)
    : "";
}

/** Known (positive) prices first, ascending; unknown (0) prices last. */
function priceOrder(a, b) {
  const knownA = a.price > 0;
  const knownB = b.price > 0;
  if (knownA !== knownB) return knownA ? -1 : 1;
  return a.price - b.price;
}

/**
 * Public single-unit buy links from MarketplaceListing rows
 * [{ marketplace, url, price, status }] → [{ marketplace, label, url, price }].
 * Keeps active rows with an http(s) url, one per marketplace (lowest price),
 * sorted by price asc with 0-price rows last, max 5.
 */
function buyLinksFor(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const best = new Map();
  list.forEach((row) => {
    if (!row || typeof row !== "object" || row.status !== "active") return;
    const url = str(row.url);
    if (!HTTP_URL.test(url)) return;
    const marketplace = str(row.marketplace).toLowerCase();
    if (!marketplace) return;
    const link = {
      marketplace,
      label: labelFor(marketplace),
      url,
      price: Math.max(0, Number(row.price) || 0),
    };
    const current = best.get(marketplace);
    if (!current || priceOrder(link, current) < 0) best.set(marketplace, link);
  });
  return [...best.values()].sort(priceOrder).slice(0, MAX_BUY_LINKS);
}

// ---------------------------------------------------------------------------
// scheduleEta
// ---------------------------------------------------------------------------

/**
 * Schedule-based preorder ETA when no farmingProgress rows exist yet.
 * null when requiredWatchMinutes <= 0 (incl. -1 = unknown) or farmStartedAt
 * is missing/invalid. elapsed > 2× required → overdue (no readyInMinutes).
 */
function scheduleEta({ farmStartedAt, requiredWatchMinutes, now } = {}) {
  const required = Number(requiredWatchMinutes);
  if (!Number.isFinite(required) || required <= 0) return null;
  if (!farmStartedAt) return null;
  const startedMs = toMs(farmStartedAt);
  if (!Number.isFinite(startedMs)) return null;

  const elapsed = Math.max(0, (nowMs(now) - startedMs) / 60000);
  if (elapsed > required * 2) {
    return { etaSource: "schedule", overdue: true, progressPercent: 100 };
  }
  return {
    etaSource: "schedule",
    overdue: false,
    readyInMinutes: Math.max(0, Math.round(required - elapsed)),
    progressPercent: Math.round(100 * Math.min(1, elapsed / required)),
  };
}

// ---------------------------------------------------------------------------
// assertPublicShape
// ---------------------------------------------------------------------------

/**
 * Walks objects/arrays recursively (cycle-safe) and throws
 * Error("public payload leaks <key>") on the first PRIVATE_KEYS key found.
 * Returns true when the payload is clean.
 */
function assertPublicShape(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node instanceof Date || ArrayBuffer.isView(node)) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const keys = Object.keys(node);
    for (const key of keys) {
      if (PRIVATE_KEY_SET.has(key)) {
        throw new Error(`public payload leaks ${key}`);
      }
    }
    for (const key of keys) walk(node[key]);
  };
  walk(value);
  return true;
}

module.exports = {
  MARKETPLACE_LABELS,
  PRIVATE_KEYS,
  signatureFor,
  deriveTitle,
  dedupeListings,
  unclaimedSummary,
  buyLinksFor,
  scheduleEta,
  assertPublicShape,
};
