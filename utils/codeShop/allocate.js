"use strict";
// Code shop allocation (docs/code-shop/02-ENGINE.md, "allocate.js"): which free
// codes go into which units of which product, and which slot sets are worth a
// draft. Pure: no I/O and no clock — `now` is always passed in — so the same
// input always gives the same output. Ids may be strings or ObjectIds; they are
// compared and de-duplicated by String(id), and handed back as they came in.

const DEFAULT_MAX_UNITS = 200;
const DEFAULT_MAX_SETS = 2;

// ms from a number or a Date (a Date from Mongo, or ms from the caller).
// null/undefined -> null; anything unreadable -> NaN.
function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date || (typeof v === "object" && typeof v.getTime === "function")) return v.getTime();
  return NaN;
}

// A missing clock must not quietly become Date.now(): that would make the
// result depend on when it ran. Fail loudly instead.
function requireNow(now) {
  const t = toMs(now);
  if (!Number.isFinite(t)) throw new TypeError("codeShop.allocate: `now` must be a time (ms or Date)");
  return t;
}

// A negative lead would let codes past their use-by back on sale, so it is
// refused rather than clamped.
function leadOf(leadMs) {
  if (leadMs === null || leadMs === undefined) return 0;
  if (typeof leadMs !== "number" || !Number.isFinite(leadMs) || leadMs < 0) {
    throw new TypeError("codeShop.allocate: `leadMs` must be a finite number >= 0");
  }
  return leadMs;
}

function capOf(max) {
  if (max === null || max === undefined) return DEFAULT_MAX_UNITS;
  if (typeof max !== "number" || Number.isNaN(max)) {
    throw new TypeError("codeShop.allocate: `maxUnitsPerProduct` must be a number");
  }
  return Math.max(0, Math.floor(max));
}

// Plain code-unit order (never localeCompare: it depends on the machine's locale).
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Ascending, null last.
function cmpNullLast(a, b) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Unknown use-by (null) = usable; an unreadable one is treated as dead.
function isUsable(useBy, now, lead) {
  if (useBy === null) return true;
  if (!Number.isFinite(useBy)) return false;
  return useBy - lead > now;
}

// Oldest codes go first: earliest use-by (null last), earliest earnedAt (null
// last), then id.
function codeOrder(a, b) {
  return cmpNullLast(a.useBy, b.useBy) || cmpNullLast(a.earnedAt, b.earnedAt) || cmpStr(a.key, b.key);
}

// slotKey -> usable codes in taking order; keys in sorted order. An id seen
// twice counts once (its first row decides), so one code can never land in two
// units even when the caller's list repeats a row.
function usableQueues(free, now, lead) {
  const seen = new Set();
  const bySlot = new Map();
  for (const row of Array.isArray(free) ? free : []) {
    if (!row || row.id === null || row.id === undefined) continue;
    const key = String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.slotKey === null || row.slotKey === undefined || row.slotKey === "") continue;
    const useBy = toMs(row.useBy);
    if (!isUsable(useBy, now, lead)) continue;
    const earned = toMs(row.earnedAt);
    const slot = String(row.slotKey);
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push({ id: row.id, key, useBy, earnedAt: Number.isFinite(earned) ? earned : null });
  }
  const out = new Map();
  for (const slot of [...bySlot.keys()].sort(cmpStr)) out.set(slot, bySlot.get(slot).sort(codeOrder));
  return out;
}

function freeCounts(free, { now, leadMs } = {}) {
  const queues = usableQueues(free, requireNow(now), leadOf(leadMs));
  const counts = new Map();
  for (const [slot, queue] of queues) counts.set(slot, queue.length);
  return counts;
}

// More slots first, then older, then id; a product id seen twice is planned once.
function orderProducts(products) {
  const rows = [];
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || p.id === null || p.id === undefined) continue;
    const slots = Array.isArray(p.slots) ? p.slots.map((s) => (s === null || s === undefined ? "" : String(s))) : [];
    const created = toMs(p.createdAt);
    rows.push({ id: p.id, key: String(p.id), slots, createdAt: Number.isFinite(created) ? created : null });
  }
  rows.sort((a, b) => b.slots.length - a.slots.length || cmpNullLast(a.createdAt, b.createdAt) || cmpStr(a.key, b.key));
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}

function planUnits({ products, free, now, leadMs, maxUnitsPerProduct = DEFAULT_MAX_UNITS } = {}) {
  const queues = usableQueues(free, requireNow(now), leadOf(leadMs));
  const cap = capOf(maxUnitsPerProduct);
  const taken = new Map(); // slotKey -> how many of its queue are used
  const remaining = (slot) => (queues.has(slot) ? queues.get(slot).length - (taken.get(slot) || 0) : 0);
  const take = (slot) => {
    const i = taken.get(slot) || 0;
    taken.set(slot, i + 1);
    return queues.get(slot)[i].id;
  };

  const plans = [];
  for (const p of orderProducts(products)) {
    // A slot listed twice needs two codes per unit; with distinct slots this is
    // simply the smallest slot count.
    const need = new Map();
    for (const s of p.slots) need.set(s, (need.get(s) || 0) + 1);
    let n = p.slots.length ? cap : 0;
    for (const [slot, per] of need) n = Math.min(n, Math.floor(remaining(slot) / per));
    const units = [];
    for (let u = 0; u < n; u++) units.push(p.slots.map(take));
    plans.push({ productId: p.id, units });
  }

  const left = new Map();
  for (const slot of queues.keys()) left.set(slot, remaining(slot));
  return { plans, left };
}

// Map, plain object or [key, count] entries -> Map of whole counts > 0.
function normalizeCounts(counts) {
  const entries = counts instanceof Map ? counts.entries()
    : Array.isArray(counts) ? counts
      : counts && typeof counts === "object" ? Object.entries(counts) : [];
  const out = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [k, v] = entry;
    if (k === null || k === undefined || k === "") continue;
    const key = String(k);
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0 || out.has(key)) continue;
    out.set(key, n);
  }
  return out;
}

function bestDraftSets(counts, { minUnits, maxSets = DEFAULT_MAX_SETS, fullFirst = true } = {}) {
  // A set needs at least one unit; a fractional minimum rounds up (units are whole).
  let min = 1;
  if (minUnits !== null && minUnits !== undefined) {
    if (typeof minUnits !== "number" || Number.isNaN(minUnits)) {
      throw new TypeError("codeShop.allocate: `minUnits` must be a number");
    }
    min = Math.max(1, Math.ceil(minUnits));
  }
  let max = DEFAULT_MAX_SETS;
  if (maxSets !== null && maxSets !== undefined) {
    if (typeof maxSets !== "number" || Number.isNaN(maxSets)) {
      throw new TypeError("codeShop.allocate: `maxSets` must be a number");
    }
    max = Math.max(0, Math.floor(maxSets));
  }

  const pool = normalizeCounts(counts); // our own copy: the caller's counts stay as they were
  const sets = [];
  let pass = 0;
  while (sets.length < max) {
    const ranked = [...pool].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
    if (!ranked.length) break;
    let pick = null;
    if (pass === 0 && fullFirst) {
      const smallest = ranked[ranked.length - 1][1];
      if (smallest >= min) pick = { k: ranked.length, units: smallest };
    }
    if (!pick) {
      let best = null;
      for (let k = 1; k <= ranked.length; k++) {
        const units = ranked[k - 1][1];
        if (units < min) break; // counts only shrink from here on
        if (!best || units * k >= best.value) best = { k, units, value: units * k };
      }
      if (best) pick = { k: best.k, units: best.units };
    }
    pass++;
    if (!pick) break;
    const slotKeys = ranked.slice(0, pick.k).map(([key]) => key);
    for (const key of slotKeys) pool.set(key, pool.get(key) - pick.units);
    sets.push({ slotKeys, units: pick.units });
  }
  return sets;
}

module.exports = { freeCounts, planUnits, bestDraftSets };
