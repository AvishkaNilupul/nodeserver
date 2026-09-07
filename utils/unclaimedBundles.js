// Unclaimed farms v3 — event bundles, qty-aware items, analytics pricing.
//
// Frozen API: docs/UNCLAIMED-BUNDLES-CONTRACT.md, section
// "utils/unclaimedBundles.js — frozen API (agent B)". Every consumer (the
// unclaimed auto-list engine, the lot publisher, the
// /bundles route, the research page) codes against that section, so the
// shapes returned here are load-bearing — change the contract first.
//
// WHY THIS EXISTS (measured on prod 2026-09-06)
// - Accounts hold EVENT bundles ("CAH Championship Week 1" + "Finals", "EWC
//   2026 DAY 1..10"), but listings were titled "(3 Items) — Pachimonarch Icon
//   + …" and priced at a flat $0.75 floor that undercut our own row.
// - Duplicate copies were lost: R6 "Community Checkpoint" grants 4× Alpha
//   Pack; a name-keyed signature listed it as "(1 Item) — Alpha Pack".
//
// Everything above `loadCatalog` is pure (no Mongo, no network, no settings
// file unless `pricing` is omitted) so tests/unclaimedBundles.test.js can run
// with node:test alone. `parseWave` is a strict SUPERSET of
// utils/radarEvents.splitEventWave: every case that module's tests cover must
// parse to the same eventName/waveLabel here (radarEvents itself is untouched).

const settings = require("./settings");

/* ------------------------------ text utils ------------------------------ */

function text(value) {
  return String(value == null ? "" : value).trim();
}

function squash(value) {
  return text(value).replace(/\s+/g, " ");
}

function lower(value) {
  return squash(value).toLowerCase();
}

// Same key the engine and CampaignDrops use: `name|game`, lowercased.
function itemKeyFor(name, game) {
  return lower(name) + "|" + lower(game);
}

// Tolerant comparison key for two itemKeys that should be the same drop:
// lowercase, collapsed whitespace, and the game half normalised the way
// settings.normGameName does ("Overwatch 2" vs "overwatch  2").
function normItemKey(key) {
  const k = lower(key);
  const cut = k.lastIndexOf("|");
  if (cut < 0) return k;
  return k.slice(0, cut).trim() + "|" + settings.normGameName(k.slice(cut + 1));
}

function dropItemKey(drop, game) {
  const d = drop || {};
  const key = text(d.itemKey);
  if (key) return key;
  return itemKeyFor(d.name, d.game || game);
}

function toTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function earlier(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return toTime(candidate) < toTime(current) ? candidate : current;
}

function later(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return toTime(candidate) > toTime(current) ? candidate : current;
}

/* ------------------------------ parseWave ------------------------------- */

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanValue(str) {
  let value = 0;
  let previous = 0;
  for (const ch of String(str).toLowerCase().split("").reverse()) {
    const current = ROMAN[ch] || 0;
    value += current < previous ? -current : current;
    previous = Math.max(previous, current);
  }
  return value;
}

function numberOrRoman(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return romanValue(token) || 0;
}

// Terminal ordinal marker. A superset of radarEvents.WAVE_SUFFIX:
//   + "w" (CoD "Modern Warfare 4 Beta W1"), "pt." (CoD "Monster Last Chance PT. 1"),
//   + an optional range ("Day 1 &2", "Day 1-2", "Days 1 & 2") → "Day 1-2".
//   + a word boundary before the marker so "Holiday 1" / "Show I" never split.
// Same optional separator, brackets and trailing "Drops" as radar.
const WAVE_SUFFIX = new RegExp(
  "\\s*(?:[-\\u2013\\u2014:|]\\s*)?[\\[(]?\\s*" +
    "\\b((week|wk|w|days?|wave|phase|part|pt\\.?|stage|round)\\s*#?\\s*" +
    "(\\d+|[ivxlcdm]+)" +
    "(?:\\s*(?:&|-|\\u2013|\\u2014|to|/)\\s*(\\d+|[ivxlcdm]+))?)" +
    "\\s*[\\])]?(?:\\s+drops)?\\s*$",
  "i",
);

// "Finals", "Final", "Grand Finals", "Playoffs" → always the last wave.
const FINALS_SUFFIX = new RegExp(
  "\\s*(?:[-\\u2013\\u2014:|]\\s*)?[\\[(]?\\s*" +
    "\\b(grand\\s+finals?|finals?|playoffs?)" +
    "\\s*[\\])]?(?:\\s+drops)?\\s*$",
  "i",
);
const FINALS_ORDER = 1000;

// Bare trailing number after a season/year token: "R6S S1 2026 9" → event
// "R6S S1 2026", wave 9. The number must be small (1-99) so the year itself in
// "R6S S1 2026" is never read as a wave, and the token before it must be a
// season ("S1", "Season 4") or a year — a bare number elsewhere stays part of
// the name (radar rule: never strip a bare number, season or version).
const BARE_NUMBER_SUFFIX = /\b((?:s\d+|season\s*\d+|(?:19|20)\d{2}))\s+(\d{1,2})\s*$/i;

function parseWave(name) {
  const clean = text(name) || "Unnamed event";
  const none = { eventName: clean, waveLabel: "", order: 0 };

  const m = clean.match(WAVE_SUFFIX);
  if (m) {
    const eventName = clean.slice(0, m.index).trim();
    if (eventName) {
      const first = numberOrRoman(m[3]);
      let waveLabel = squash(m[1]);
      if (m[4]) {
        // Range → "<Word> a-b" (keep the word as written, collapse "1 &2").
        waveLabel = squash(m[2]) + " " + m[3] + "-" + m[4];
      }
      return { eventName, waveLabel, order: first };
    }
  }

  const f = clean.match(FINALS_SUFFIX);
  if (f) {
    const eventName = clean.slice(0, f.index).trim();
    if (eventName) {
      return { eventName, waveLabel: squash(f[1]), order: FINALS_ORDER };
    }
  }

  const b = clean.match(BARE_NUMBER_SUFFIX);
  if (b) {
    const eventName = clean.slice(0, b.index + b[1].length).trim();
    const n = Number(b[2]);
    if (eventName && n > 0) {
      return { eventName, waveLabel: "Wave " + n, order: n };
    }
  }

  return none;
}

/* ------------------------------ event keys ------------------------------ */

function eventKeyFor(game, eventName) {
  return settings.normGameName(game) + "|" + lower(eventName);
}

// Display label for a wave inside an event. An unmarked campaign ("R6S S2
// 2026" next to "R6S S2 2026 1") is the event's main wave.
function waveDisplayLabel(wave, event) {
  if (wave.waveLabel) return wave.waveLabel;
  return event && event.waves && event.waves.length > 1 ? "Main" : "";
}

function labelsText(labels) {
  return labels.filter(Boolean).join(" + ");
}

/* ---------------------------- buildEventCatalog ------------------------- */

// Manifest drops → [{itemKey,name,qty}], counting identical itemKeys as copies
// (4× Alpha Pack), sorted by name.
function manifestItems(manifest, game) {
  const byKey = new Map();
  for (const raw of (manifest && manifest.drops) || []) {
    const name = text(raw && raw.name) || "Reward";
    const itemKey = dropItemKey(raw, (manifest && manifest.game) || game);
    if (!itemKey) continue;
    const cur = byKey.get(itemKey);
    if (cur) {
      cur.qty += 1;
      continue;
    }
    byKey.set(itemKey, { itemKey, name, qty: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.itemKey.localeCompare(b.itemKey),
  );
}

function sortWaves(waves) {
  waves.sort(
    (a, b) =>
      a.order - b.order ||
      toTime(a.startAt) - toTime(b.startAt) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

function buildEventCatalog(campaigns, manifests) {
  const manifestById = new Map();
  for (const mf of manifests || []) {
    const id = text(mf && mf.campaignId);
    if (id) manifestById.set(id, mf);
  }

  // Radar's "Drops" alias: "KORD BREACH S1 Drops" is the same event as "KORD
  // BREACH S1" when this game also supplies the name without the suffix.
  const baseNames = new Map(); // gameKey → Set(lower eventName)
  const rows = [];
  const seenIds = new Set();
  const pushRow = (row) => {
    const campaignId = text(row.campaignId);
    if (campaignId) {
      if (seenIds.has(campaignId)) return;
      seenIds.add(campaignId);
    }
    const game = text(row.game);
    const parsed = parseWave(row.name);
    rows.push({ row, campaignId, game, parsed });
    const gk = settings.normGameName(game);
    if (!baseNames.has(gk)) baseNames.set(gk, new Set());
    baseNames.get(gk).add(lower(parsed.eventName));
  };
  for (const c of campaigns || []) if (c) pushRow(c);
  // A manifest whose campaign is missing from `campaigns` still describes a
  // real wave (name + game are on the manifest) — keep it rather than lose it.
  for (const mf of manifests || []) {
    if (!mf || !text(mf.campaignId) || seenIds.has(text(mf.campaignId))) continue;
    pushRow({ campaignId: mf.campaignId, name: mf.name, game: mf.game });
  }

  const catalog = new Map();
  for (const { row, campaignId, game, parsed } of rows) {
    const gameKey = settings.normGameName(game);
    let eventName = parsed.eventName;
    const stripped = eventName.replace(/\s+drops$/i, "").trim();
    if (
      stripped &&
      stripped !== eventName &&
      baseNames.get(gameKey) &&
      baseNames.get(gameKey).has(lower(stripped))
    ) {
      eventName = stripped;
    }
    const key = eventKeyFor(game, eventName);
    let event = catalog.get(key);
    if (!event) {
      event = {
        key,
        game,
        gameKey,
        name: eventName,
        waves: [],
        startAt: null,
        endAt: null,
      };
      catalog.set(key, event);
    }
    const manifest = campaignId ? manifestById.get(campaignId) : null;
    event.waves.push({
      campaignId,
      name: text(row.name) || eventName,
      waveLabel: parsed.waveLabel,
      order: parsed.order,
      startAt: row.startAt || null,
      endAt: row.endAt || null,
      items: manifest ? manifestItems(manifest, game) : [],
    });
    event.startAt = earlier(event.startAt, row.startAt);
    event.endAt = later(event.endAt, row.endAt);
  }
  for (const event of catalog.values()) sortWaves(event.waves);
  return catalog;
}

/* ----------------------------- classifyHoldings ------------------------- */

function waveStarted(wave, now) {
  const start = toTime(wave.startAt);
  const end = toTime(wave.endAt);
  if (!start && !end) return true; // unknown dates: assume live
  if (start && start <= now) return true;
  if (end && end < now) return true;
  return false;
}

function qtyItems(drops, game) {
  const byKey = new Map();
  for (const d of drops || []) {
    if (!d) continue;
    const itemKey = dropItemKey(d, game);
    if (!itemKey) continue;
    const cur = byKey.get(itemKey);
    if (cur) {
      cur.qty += 1;
      continue;
    }
    byKey.set(itemKey, { itemKey, name: text(d.name) || "Reward", qty: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.itemKey.localeCompare(b.itemKey),
  );
}

function emptyClassification(game, drops) {
  return {
    game,
    event: null,
    waves: [],
    wavesHeld: 0,
    wavesTotal: 0,
    full: false,
    items: qtyItems(drops, game),
    bundleKey: "",
    bundleLabel: "",
  };
}

function classifyHoldings(game, drops, catalog, now = Date.now()) {
  const list = (drops || []).filter(Boolean);
  const base = emptyClassification(game, list);
  if (!catalog || typeof catalog.values !== "function" || !list.length) return base;

  // Same tolerance as isNoClaimGame: "overwatch" ↔ "overwatch 2". The drops'
  // own game labels count too (the ledger may store a shorter label).
  const gameKeys = new Set([settings.normGameName(game)]);
  for (const d of list) {
    const k = settings.normGameName(d.game);
    if (k) gameKeys.add(k);
  }
  gameKeys.delete("");
  const sameGame = (e) => {
    const ek = e.gameKey || settings.normGameName(e.game);
    if (!ek) return false;
    for (const k of gameKeys) {
      if (ek === k || ek.includes(k) || k.includes(ek)) return true;
    }
    return false;
  };
  const events = [...catalog.values()].filter((e) => e && sameGame(e));
  if (!events.length) return base;

  // Pass 1: match each drop to a wave by its campaign name (event + label).
  // Pass 2: leftover drops fall back to the wave whose manifest lists the item.
  const held = new Map(); // wave → Map(normItemKey → qty)
  const eventHits = new Map(); // event → drops matched
  const bump = (event, wave, key) => {
    if (!held.has(wave)) held.set(wave, new Map());
    const m = held.get(wave);
    m.set(key, (m.get(key) || 0) + 1);
    eventHits.set(event, (eventHits.get(event) || 0) + 1);
  };
  // "<event name>|<wave label>" (both lowercased) → {event, wave}, over the
  // same-game events only, so the game half of the key never has to agree.
  const waveKeyed = new Map();
  for (const event of events) {
    for (const wave of event.waves) {
      const k = lower(event.name) + "|" + lower(wave.waveLabel);
      if (!waveKeyed.has(k)) waveKeyed.set(k, { event, wave });
    }
  }

  const leftovers = [];
  for (const drop of list) {
    const campaign = text(drop.campaign);
    let hit = null;
    if (campaign) {
      const parsed = parseWave(campaign);
      hit =
        waveKeyed.get(lower(parsed.eventName) + "|" + lower(parsed.waveLabel)) ||
        // Radar's "Drops" alias ("KORD BREACH S1 Drops" → "KORD BREACH S1").
        waveKeyed.get(
          lower(parsed.eventName.replace(/\s+drops$/i, "")) + "|" + lower(parsed.waveLabel),
        ) ||
        null;
    }
    if (hit) bump(hit.event, hit.wave, normItemKey(dropItemKey(drop, game)));
    else leftovers.push(drop);
  }

  for (const drop of leftovers) {
    const key = normItemKey(dropItemKey(drop, game));
    let target = null;
    let first = null;
    // Prefer the event the campaign-matched drops already point at, then any
    // wave with an unfilled copy of the item, then the first wave listing it.
    const ordered = [...events].sort(
      (a, b) => (eventHits.get(b) || 0) - (eventHits.get(a) || 0),
    );
    outer: for (const event of ordered) {
      for (const wave of event.waves) {
        const want = wave.items.find((it) => normItemKey(it.itemKey) === key);
        if (!want) continue;
        if (!first) first = { event, wave };
        const have = (held.get(wave) && held.get(wave).get(key)) || 0;
        if (have < want.qty) {
          target = { event, wave };
          break outer;
        }
      }
    }
    target = target || first;
    if (target) bump(target.event, target.wave, key);
  }

  if (!eventHits.size) return base;

  // The bundle's event: the one most drops resolved to (ties → earliest start).
  let event = null;
  for (const [e, n] of eventHits) {
    if (
      !event ||
      n > eventHits.get(event) ||
      (n === eventHits.get(event) && toTime(e.startAt) < toTime(event.startAt))
    ) {
      event = e;
    }
  }

  const primary = analyseEvent(event, held, now);

  // Every event at least one drop resolved to, oldest first. Holdings that
  // span several events ("R6S Y11S3" + "R6S S2 2026") used to be described
  // by the primary alone — "R6S Y11S3 COMPLETE BUNDLE (2 Items)" while one
  // item came from the other event. Now: `full` only when EVERY matched event
  // is complete, and the label names them all.
  const matched = [...eventHits.keys()].sort(
    (a, b) =>
      toTime(a.startAt) - toTime(b.startAt) ||
      (eventHits.get(b) || 0) - (eventHits.get(a) || 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const matchedEvents = matched.map((e) => ({
    key: e.key,
    name: e.name,
    complete: e === event ? primary.full : analyseEvent(e, held, now).full,
  }));
  const multi = matchedEvents.length > 1;
  const full = multi ? matchedEvents.every((e) => e.complete) : primary.full;

  const labels = labelsText(primary.heldLabels);
  const bundleKey =
    event.key + "|" + primary.heldLabels.map((l) => lower(l)).join("+");
  const state = full ? "complete" : "partial";
  let bundleLabel;
  if (multi) {
    bundleLabel = matchedEvents.map((e) => e.name).join(" + ") + " (" + state + ")";
  } else {
    bundleLabel = labels
      ? event.name + " — " + labels + " (" + state + ")"
      : event.name + " (" + state + ")";
  }

  return {
    game,
    event: { key: event.key, name: event.name },
    // Every matched event (primary included), oldest first; `complete` is that
    // event's own every-started-wave-complete verdict.
    events: matchedEvents,
    // waves / wavesHeld / wavesTotal / heldLabels describe the PRIMARY event.
    waves: primary.waves,
    wavesHeld: primary.wavesHeld,
    wavesTotal: primary.wavesTotal,
    full,
    items: qtyItems(list, game),
    bundleKey,
    bundleLabel,
    // Display labels of the waves held, in wave order (superset of the frozen
    // shape; what bundleLabel/bundleTitle render between the dashes).
    heldLabels: primary.heldLabels,
  };
}

// Per-event wave analysis over the drops resolved to its waves (`held`: wave →
// Map(normItemKey → qty)). `full` = every STARTED wave complete (and at least
// one started); waves that have not started and hold nothing are skipped.
function analyseEvent(event, held, now) {
  const waves = [];
  const heldLabels = [];
  let wavesTotal = 0;
  let wavesHeld = 0;
  let full = true;
  for (const wave of event.waves) {
    const heldMap = held.get(wave) || new Map();
    const started = waveStarted(wave, now);
    if (!started && !heldMap.size) continue;
    if (started) wavesTotal += 1;
    const heldKeys = [];
    const missing = [];
    const seen = new Set();
    for (const it of wave.items) {
      const k = normItemKey(it.itemKey);
      seen.add(k);
      const have = heldMap.get(k) || 0;
      if (have > 0) heldKeys.push(it.itemKey);
      if (have < it.qty) missing.push(it.itemKey);
    }
    // Items held from this wave that its manifest does not list (manifest
    // unknown or stale) still count as held.
    let unmatched = 0;
    for (const k of heldMap.keys()) {
      if (!seen.has(k)) {
        heldKeys.push(k);
        unmatched += 1;
      }
    }
    // Name-mismatch fallback: CampaignDrops manifests carry BENEFIT names
    // ("Elsa Bloodstone Spray") while the inventory reports DROP names ("Elsa
    // Bloodstone「Will of Galacta」Spray"), so a wave can look "missing" while
    // every one of its drops is held. Drops are attributed to this wave by
    // campaign name, so when the held set has at least as many distinct keys
    // AND copies as the manifest — and some held key matched nothing — the
    // wave is complete by count.
    if (missing.length && unmatched > 0) {
      const heldTotal = [...heldMap.values()].reduce((a, b) => a + b, 0);
      const manifestTotal = wave.items.reduce((a, it) => a + (it.qty || 1), 0);
      if (
        manifestTotal > 0 &&
        heldTotal >= manifestTotal &&
        heldMap.size >= wave.items.length
      ) {
        missing.length = 0;
      }
    }
    const complete = heldKeys.length > 0 && missing.length === 0;
    if (heldKeys.length) {
      wavesHeld += 1;
      heldLabels.push(waveDisplayLabel(wave, event));
    }
    if (started && !complete) full = false;
    waves.push({
      waveLabel: wave.waveLabel,
      order: wave.order,
      complete,
      held: heldKeys,
      missing,
    });
  }
  if (!wavesTotal) full = false;
  return { waves, heldLabels, wavesTotal, wavesHeld, full };
}

/* ---------------------------- title / description ----------------------- */

const TITLE_MAX = 120;

function itemsOf(items, classification) {
  const src =
    Array.isArray(items) && items.length
      ? items
      : (classification && classification.items) || [];
  return src.map((i) => ({
    itemKey: text(i.itemKey),
    name: text(i.name) || "Reward",
    qty: Math.max(1, Math.floor(Number(i.qty) || 1)),
  }));
}

function totalQty(items) {
  return items.reduce((n, i) => n + i.qty, 0);
}

function itemLabel(i) {
  return (i.qty > 1 ? i.qty + "× " : "") + i.name;
}

// "1 Item" / "N Items" — every title form goes through this so a one-item
// bundle never reads "(1 Items)" (a live dry-run produced exactly that).
function itemsWord(total) {
  return total + " Item" + (total === 1 ? "" : "s");
}

function countBit(total) {
  return "(" + itemsWord(total) + ")";
}

// Names of every matched event when the holdings span MORE THAN ONE event
// (classification.events, added 2026-09-06); [] for a single-event or
// event-less classification so the single-event paths stay unchanged.
function multiEventNames(classification) {
  const list = classification && Array.isArray(classification.events)
    ? classification.events.map((e) => text(e && e.name)).filter(Boolean)
    : [];
  return list.length > 1 ? list : [];
}

function heldLabelsOf(classification) {
  if (!classification || !classification.event) return [];
  if (Array.isArray(classification.heldLabels)) {
    return classification.heldLabels.map((s) => text(s)).filter(Boolean);
  }
  // A classification rebuilt from a stored bundleLabel (no heldLabels field).
  const raw = text(classification.bundleLabel);
  const name = text(classification.event.name);
  // bundleLabel = "<event> — <labels> (state)" | "<event> (state)"
  const m = raw.match(/^(.*?)\s+—\s+(.*)\s+\((complete|partial)\)$/);
  if (m && lower(m[1]) === lower(name)) {
    return m[2].split(" + ").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function clampTitle(candidates) {
  for (const c of candidates) if (c.length <= TITLE_MAX) return c;
  return candidates[candidates.length - 1].slice(0, TITLE_MAX);
}

// Item tail in the auto-lister's house style, qty-aware:
// " — 4× Alpha Pack + SMELLS LIKE BURNING +1 more"
function itemTail(items, take) {
  if (!items.length) return "";
  const shown = items.slice(0, take).map(itemLabel).join(" + ");
  const more = items.length > take ? " +" + (items.length - take) + " more" : "";
  return " — " + shown + more;
}

function bundleTitle({ game, items, classification } = {}) {
  const list = itemsOf(items, classification);
  const total = totalQty(list);
  const g = text(game) || text(classification && classification.game);
  const prefix = g + " Twitch Drops";
  const count = countBit(total);
  const cls = classification || null;
  const event = cls && cls.event ? cls.event : null;
  const labels = labelsText(heldLabelsOf(cls));
  const multi = multiEventNames(cls);
  // House-style title with no event claim, qty-aware: "(5 Items) — 4× Alpha Pack + …"
  const plainHead = prefix + " " + count;
  const plain = [plainHead + itemTail(list, 2), plainHead + itemTail(list, 1), plainHead];

  // Holdings spanning several events: claim "COMPLETE BUNDLE" only when every
  // matched event is complete; otherwise make no event claim at all (the
  // primary event's name would misdescribe the other items).
  if (event && multi.length) {
    if (!cls.full) return clampTitle(plain);
    const head = prefix + " — " + multi.join(" + ") + " COMPLETE BUNDLE";
    return clampTitle([head + " " + count, head, ...plain]);
  }

  if (event && cls.full) {
    const head = prefix + " — " + event.name + " COMPLETE BUNDLE";
    const inner = labels ? labels + " · " + itemsWord(total) : itemsWord(total);
    return clampTitle([
      head + " (" + inner + ")",
      head + " " + count,
      head,
      prefix + " " + count,
    ]);
  }

  if (event) {
    const head =
      prefix + " — " + event.name + (labels ? " " + labels : "") + " " + count;
    return clampTitle([
      head + itemTail(list, 2),
      head + itemTail(list, 1),
      head,
      prefix + " — " + event.name + " " + count,
      prefix + " " + count,
    ]);
  }

  return clampTitle(plain);
}

const BULK_QTY_MARKETS = new Set(["digiseller", "ggsel", "plati"]);

function bundleDescriptionLines({
  game,
  items,
  classification,
  marketplace,
  lotsEnabled,
  lotSize,
} = {}) {
  const list = itemsOf(items, classification);
  const cls = classification || null;
  const lines = [];

  if (cls && cls.event) {
    const multi = multiEventNames(cls);
    // Several events: name them all; the wave labels/counts describe only the
    // primary event, so they are left out.
    const labels = multi.length ? "" : labelsText(heldLabelsOf(cls));
    const names = multi.length ? multi.join(" + ") : cls.event.name;
    let line = "Event: " + names + (labels ? " — " + labels : "");
    if (cls.full) line += ", complete bundle";
    else {
      line += ", partial bundle";
      if (!multi.length && cls.wavesTotal > 0) {
        line += " (" + cls.wavesHeld + " of " + cls.wavesTotal + " waves)";
      }
    }
    lines.push(line);
  }

  const copies = list.filter((i) => i.qty > 1);
  if (copies.length) {
    lines.push(
      "Copies: " +
        copies.map(itemLabel).join(", ") +
        " — duplicate drops are separate copies, all on this one account.",
    );
  }

  const market = lower(marketplace);
  if (BULK_QTY_MARKETS.has(market)) {
    lines.push(
      "Bulk: buy several units in one order — quantity is available on this page.",
    );
  } else if (market === "gameflip" && lotsEnabled) {
    const n = Math.max(2, Math.floor(Number(lotSize) || 0)) || 5;
    lines.push(
      "Bulk: lots of " + n + " accounts are listed separately at a discount.",
    );
  }

  void game; // the game is already in the house template's first line
  return lines;
}

/* -------------------------------- pricing ------------------------------- */

const MIN_SOLD_SAMPLES = 3;
const MAX_ANCHOR_USD = 10;
const DEFAULT_ANCHOR_USD = 1.0;

function round25(x) {
  return Math.round(Number(x) * 4) / 4;
}

function ceil25(x) {
  return Math.ceil(Number(x) * 4 - 1e-9) / 4;
}

function pos(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pricingOr(pricing) {
  return pricing && typeof pricing === "object"
    ? pricing
    : settings.getUnclaimedPricing();
}

// Same substring rule as settings.gameFloorFor, but over the floors carried in
// `pricing` so a caller (or a test) can price without the settings file.
function gameFloorFrom(pricing, game) {
  const floors = pricing && pricing.gameFloors;
  if (!floors || typeof floors !== "object") return settings.gameFloorFor(game);
  const g = settings.normGameName(game);
  if (!g) return 0;
  for (const k of Object.keys(floors)) {
    const key = settings.normGameName(k);
    if (key && g.includes(key)) return Math.max(0, pos(floors[k]));
  }
  return 0;
}

function pickAnchor(research) {
  const m = (research && research.markets) || {};
  const gf = m.gameflip || {};
  const gg = m.ggsel || {};
  const pl = m.plati || {};
  if (Number(gf.soldRecent) >= MIN_SOLD_SAMPLES && pos(gf.avgSoldPrice)) {
    return {
      anchor: Math.min(pos(gf.avgSoldPrice), MAX_ANCHOR_USD),
      anchorSource: "gameflip.avgSoldPrice",
    };
  }
  // Every anchor is capped: one $500 troll listing must not price a bundle.
  if (pos(gf.lowestOther)) {
    return {
      anchor: Math.min(pos(gf.lowestOther), MAX_ANCHOR_USD),
      anchorSource: "gameflip.lowestOther",
    };
  }
  if (pos(gf.median)) {
    return { anchor: Math.min(pos(gf.median), MAX_ANCHOR_USD), anchorSource: "gameflip.median" };
  }
  const others = [
    ["ggsel.median", pos(gg.median)],
    ["plati.median", pos(pl.median)],
  ].filter(([, v]) => v > 0);
  if (others.length) {
    others.sort((a, b) => a[1] - b[1]);
    return { anchor: Math.min(others[0][1], MAX_ANCHOR_USD), anchorSource: others[0][0] };
  }
  return { anchor: DEFAULT_ANCHOR_USD, anchorSource: "default" };
}

// `soldFloorUsd` (optional, default 0): the highest price this exact set has
// actually sold at recently. The final price is never below it (ceil to the
// $0.25 grid), so a reprice never drops a price that is proving itself.
function bundlePrice({
  research,
  game,
  items,
  classification,
  pricing,
  soldFloorUsd = 0,
} = {}) {
  const p = pricingOr(pricing);
  const list = itemsOf(items, classification);
  const total = Math.max(1, totalQty(list));
  const full = !!(classification && classification.full);
  const { anchor, anchorSource } = pickAnchor(research);

  const stepPct = Math.max(0, Number(p.itemStepPct) || 0);
  const capMult = Math.max(1, Number(p.itemCapMult) || 1);
  const bonusPct = Math.max(0, Number(p.fullEventBonusPct) || 0);
  const floor = Math.max(pos(p.floorUsd), gameFloorFrom(p, game));
  const soldFloor = pos(soldFloorUsd);

  let price = anchor * Math.min(capMult, 1 + (stepPct / 100) * (total - 1));
  if (full) price *= 1 + bonusPct / 100;
  price = round25(price);
  if (price < floor) price = ceil25(floor);
  if (price < soldFloor) price = ceil25(soldFloor);

  return {
    price: Math.round(price * 100) / 100,
    anchor: Math.round(anchor * 100) / 100,
    anchorSource,
    floor: Math.round(floor * 100) / 100,
    soldFloor: Math.round(soldFloor * 100) / 100,
    totalQty: total,
    full,
  };
}

// `game` (optional 4th arg) lets the per-game floor apply too: the unit price
// already honours it, so a discounted lot must not land below N × gameFloor.
function lotPrice(unitPrice, n, pricing, game) {
  const p = pricingOr(pricing);
  const units = Math.max(1, Math.floor(Number(n) || 1));
  const discount = Math.min(90, Math.max(0, Number(p.lotDiscountPct) || 0));
  let unitFloor = pos(p.floorUsd);
  if (game) {
    try {
      unitFloor = Math.max(unitFloor, pos(settings.gameFloorFor(game)));
    } catch {
      /* settings unavailable — absolute floor only */
    }
  }
  const floor = unitFloor * units;
  let price = round25(pos(unitPrice) * units * (1 - discount / 100));
  if (price < floor) price = ceil25(floor);
  return Math.round(price * 100) / 100;
}

/* ------------------------------- DB loader ------------------------------ */

const CATALOG_WINDOW_DAYS = 120;

// Catalog for the given games, or (no games) every no-claim game plus every
// game a web-token bot is pinned to. Campaigns from the last 120 days by
// endAt (open-ended ones included); manifests keyed by campaignId. Game
// filtering happens in JS with settings.normGameName (substring, like
// isNoClaimGame) — the window holds a few hundred campaigns at most.
async function loadCatalog({ games } = {}) {
  const TwitchCampaign = require("../models/TwitchCampaign");
  const CampaignDrops = require("../models/CampaignDrops");

  const since = new Date(Date.now() - CATALOG_WINDOW_DAYS * 86400000);
  const campaigns = await TwitchCampaign.find(
    { $or: [{ endAt: { $gte: since } }, { endAt: null }] },
    { campaignId: 1, name: 1, game: 1, startAt: 1, endAt: 1, status: 1, active: 1 },
  ).lean();

  const list = Array.isArray(games) ? games.filter(Boolean) : games ? [games] : [];
  let keep;
  if (list.length) {
    const wanted = list.map((g) => settings.normGameName(g)).filter(Boolean);
    keep = (c) => {
      const g = settings.normGameName(c.game);
      return !!g && wanted.some((k) => g === k || g.includes(k));
    };
  } else {
    keep = (c) => settings.isNoClaimGame(c.game);
  }
  return finishCatalog(campaigns.filter(keep), CampaignDrops);
}

async function finishCatalog(campaigns, CampaignDrops) {
  const ids = campaigns.map((c) => text(c.campaignId)).filter(Boolean);
  const manifests = ids.length
    ? await CampaignDrops.find(
        { campaignId: { $in: ids } },
        { campaignId: 1, name: 1, game: 1, drops: 1 },
      ).lean()
    : [];
  return buildEventCatalog(campaigns, manifests);
}

module.exports = {
  parseWave,
  eventKeyFor,
  buildEventCatalog,
  classifyHoldings,
  bundleTitle,
  bundleDescriptionLines,
  bundlePrice,
  lotPrice,
  loadCatalog,
  // internals exported for tests / siblings that want the same rules
  WAVE_SUFFIX,
  FINALS_ORDER,
  itemKeyFor,
  round25,
};
