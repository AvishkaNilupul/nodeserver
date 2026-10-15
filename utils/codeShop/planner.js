"use strict";
// Code shop — draft planner (docs/code-shop/02-ENGINE.md, "planner.js").
//
// Turns free ledger stock into DRAFT products the owner can approve. It only
// ever proposes: it reads the ledger (never writes it), and every product write
// is filtered on `status: "draft"`, so an active, paused or retired product —
// one that may own a live offer — is never touched, whatever happens in between.
//
// One pass, per campaign group of a game that sells:
// 1. slot meta from ALL the group's ledger rows (label, image, name, first earnedAt);
// 2. the group is READY when its campaign ended `graceHours` ago, no new code
//    came for `stallHours`, or its earliest free use-by is within `earlyListDays`;
// 3. allocate.bestDraftSets over the free counts says which slot sets to offer;
// 4. a set already owned by a non-retired product (any origin/status) gets no
//    new draft — a non-edited draft just gets its `proposed` estimate refreshed;
//    otherwise a draft is created, stamped once by its slot set
//    (`draft:<slotSetHash>`, so a draft deleted and proposed again is not
//    announced twice), and announced on Telegram;
// 5. the group's auto drafts no longer proposed: deleted, or `stale` when the
//    owner edited them.

const { freeCounts, bestDraftSets } = require("./allocate");
const { slotSetHash } = require("./slots");
const { defaultLabel, defaultTexts } = require("./texts");
const { guideFor } = require("./games");
const { DEFAULTS } = require("./config");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Codes sell on Eldorado only (05-REVIEW-FIXES.md, R1): GGSel never says which
// code it sold, so a draft never names it, whatever the settings say.
const MARKET_ORDER = ["eldorado"];
const ROW_FIELDS =
  "_id gameNo gameName groupKey slotKey nameRaw name image campaignTitle campaignEndAt earnedAt useBy state";

const text = (v) => (v === undefined || v === null ? "" : String(v));

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// A setting read from the config: a finite number >= 0, else the default.
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function leanOf(q) {
  return q && typeof q.lean === "function" ? q.lean() : q;
}

// Plain code-unit order (never localeCompare: it depends on the machine's locale).
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Ascending, null last.
function cmpNullLast(a, b) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

// Earliest earned first, so "first non-empty" below means "the oldest row's".
function rowOrder(a, b) {
  return cmpNullLast(toMs(a.earnedAt), toMs(b.earnedAt)) || cmpStr(text(a._id), text(b._id));
}

// Buyer text order: first earned first, then reward name, then key.
function slotOrder(a, b) {
  return cmpNullLast(a.firstEarnedAt, b.firstEarnedAt) || cmpStr(a.nameRaw, b.nameRaw) || cmpStr(a.slotKey, b.slotKey);
}

function sellableGames(cfg) {
  const games = cfg && cfg.games && typeof cfg.games === "object" ? cfg.games : {};
  return Object.keys(games)
    .filter((g) => games[g] && games[g].sell === true)
    .sort(cmpStr);
}

function marketsOf(cfg) {
  const m = cfg && cfg.markets && typeof cfg.markets === "object" ? cfg.markets : {};
  return MARKET_ORDER.filter((k) => m[k] === true);
}

// Everything the planner needs to know about one campaign group.
function summarize(groupKey, rows, { now, leadMs, sourceWords }) {
  const g = {
    groupKey,
    gameNo: "",
    gameName: "",
    campaignTitle: "",
    endAt: null, // latest campaignEndAt of its rows
    lastEarnedAt: null, // newest code of the group
    earliestFreeUseBy: null,
    slots: new Map(), // slotKey -> meta
    free: [], // in_stock rows, for allocate.freeCounts
  };
  for (const r of rows.slice().sort(rowOrder)) {
    if (!g.gameNo) g.gameNo = text(r.gameNo);
    if (!g.gameName) g.gameName = text(r.gameName);
    if (!g.campaignTitle) g.campaignTitle = text(r.campaignTitle);
    const end = toMs(r.campaignEndAt);
    if (end !== null && (g.endAt === null || end > g.endAt)) g.endAt = end;
    const earned = toMs(r.earnedAt);
    if (earned !== null && (g.lastEarnedAt === null || earned > g.lastEarnedAt)) g.lastEarnedAt = earned;

    const slotKey = text(r.slotKey);
    if (!slotKey) continue;
    let s = g.slots.get(slotKey);
    if (!s) {
      s = { slotKey, label: "", image: "", nameRaw: "", campaignTitle: "", firstEarnedAt: null, earliestFreeUseBy: null };
      g.slots.set(slotKey, s);
    }
    // Rows come oldest first, so the first value seen is the oldest row's.
    if (s.firstEarnedAt === null && earned !== null) s.firstEarnedAt = earned;
    if (!s.label) s.label = defaultLabel(r, { sourceWords });
    if (!s.image) s.image = text(r.image);
    if (!s.nameRaw) s.nameRaw = text(r.nameRaw);
    if (!s.campaignTitle) s.campaignTitle = text(r.campaignTitle);

    if (r.state !== "in_stock") continue;
    const useBy = toMs(r.useBy);
    g.free.push({ id: r._id, slotKey, useBy, earnedAt: earned });
    // Free = still usable past the expiry lead (same rule as allocate.js).
    if (useBy !== null && useBy - leadMs > now) {
      if (s.earliestFreeUseBy === null || useBy < s.earliestFreeUseBy) s.earliestFreeUseBy = useBy;
      if (g.earliestFreeUseBy === null || useBy < g.earliestFreeUseBy) g.earliestFreeUseBy = useBy;
    }
  }
  return g;
}

// Why the group is ready to sell, or "" while it is still earning.
function readyReason(g, cfg, now) {
  const r = (cfg && cfg.ready) || {};
  const graceMs = num(r.graceHours, DEFAULTS.ready.graceHours) * HOUR_MS;
  const stallMs = num(r.stallHours, DEFAULTS.ready.stallHours) * HOUR_MS;
  const earlyMs = num(r.earlyListDays, DEFAULTS.ready.earlyListDays) * DAY_MS;
  if (g.endAt !== null && now - g.endAt >= graceMs) return "campaign ended";
  if (g.lastEarnedAt !== null && now - g.lastEarnedAt >= stallMs) return "no new codes";
  if (g.earliestFreeUseBy !== null && g.earliestFreeUseBy - now <= earlyMs) return "use-by is near";
  return "";
}

function createPlanner(deps = {}) {
  const models = deps.models || {};
  const CodeStock = () => models.CodeStock || require("../../models/CodeStock");
  const CodeProduct = () => models.CodeProduct || require("../../models/CodeProduct");
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  // Resolved on first use so a test's fakes never load the real ones.
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig());
  const getEvents = () => events || (events = require("./events").createEvents());
  const telegram = deps.telegram || null;

  async function log(entry) {
    try {
      const ev = getEvents();
      if (ev && typeof ev.log === "function") await ev.log(entry);
    } catch (err) {
      console.error("[code-shop] planner: event not saved: " + (err && err.message));
    }
  }

  // The stamp is the "announced once" record; it is taken only after the
  // draft row exists. Telegram is best-effort: a failed send never fails the run.
  async function announce(product, { units, why }) {
    const id = String(product._id);
    const key = "draft:" + String(product.slotSetHash);
    const n = product.slots.length;
    const blank = product.slots.filter((s) => !s.label).length;
    const msg = `New draft "${product.name}" - ${n} code${n === 1 ? "" : "s"} per bundle, ${units} bundle${units === 1 ? "" : "s"} (${why})`;
    let fresh = false;
    try {
      fresh = await getEvents().stamp(key, { kind: "draft", msg });
    } catch (err) {
      console.error("[code-shop] planner: draft stamp failed for " + id + ": " + (err && err.message));
      return;
    }
    if (!fresh || !telegram || typeof telegram.send !== "function") return;
    const line =
      `Code shop: ${msg}.` +
      (blank ? ` ${blank} reward${blank === 1 ? " needs" : "s need"} an English label first.` : "") +
      " Review it in the Sales tab.";
    try {
      await telegram.send(line);
    } catch (err) {
      await log({ level: "warn", kind: "telegram", product: product._id, msg: "Draft alert not sent: " + text(err && err.message) });
    }
  }

  async function planGroup(g, cfg, ctx, out) {
    const Product = CodeProduct();
    const d = (cfg && cfg.drafts) || {};
    const leftovers = d.leftovers !== false;
    const maxSets = leftovers ? Math.floor(num(d.maxPerGroup, DEFAULTS.drafts.maxPerGroup)) : 1;
    const counts = freeCounts(g.free, { now: ctx.now, leadMs: ctx.leadMs });
    const sets = bestDraftSets(counts, { minUnits: num(d.minUnits, DEFAULTS.drafts.minUnits), maxSets });
    const at = new Date(ctx.now);

    const proposed = new Set();
    for (const set of sets) {
      const hash = slotSetHash(set.slotKeys);
      if (proposed.has(hash)) continue;
      proposed.add(hash);
      const units = set.units;

      // Any non-retired product with this exact set already covers it.
      const owners = await leanOf(Product.find({ slotSetHash: hash, status: { $ne: "retired" } }, "_id status edited stale"));
      if (owners.length) {
        for (const p of owners) {
          if (p.status !== "draft") continue; // live products are never touched
          if (!p.edited) {
            const r = await Product.updateOne(
              { _id: p._id, status: "draft", edited: false },
              { $set: { "proposed.units": units, "proposed.at": at, stale: false } },
            );
            if (r.matchedCount) out.updated += 1;
          } else if (p.stale) {
            // Proposed again: only the planner's own flag changes, never the owner's edits.
            await Product.updateOne({ _id: p._id, status: "draft", stale: true }, { $set: { stale: false } });
          }
        }
        continue;
      }

      const metas = set.slotKeys.map((k) => g.slots.get(k)).filter(Boolean).sort(slotOrder);
      const slots = metas.map((s) => ({
        slotKey: s.slotKey,
        label: s.label,
        image: s.image,
        nameRaw: s.nameRaw,
        campaignTitle: s.campaignTitle,
      }));
      let useBy = null;
      for (const s of metas) {
        if (s.earliestFreeUseBy !== null && (useBy === null || s.earliestFreeUseBy < useBy)) useBy = s.earliestFreeUseBy;
      }
      const guide = guideFor(g.gameNo, cfg);
      const n = slots.length;
      const product = await Product.create({
        name: `${g.gameName || guide.displayName} - ${g.campaignTitle} (${n} code${n === 1 ? "" : "s"})`,
        gameNo: g.gameNo,
        gameName: g.gameName,
        marketGame: guide.marketGame,
        groupKeys: [g.groupKey],
        slots,
        slotSetHash: hash,
        status: "draft",
        origin: "auto",
        kind: set.slotKeys.length === g.slots.size ? "full" : "leftover",
        edited: false,
        stale: false,
        texts: defaultTexts({ slots, guide, useBy: useBy === null ? null : new Date(useBy), now: ctx.now }),
        pricing: { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
        markets: ctx.markets,
        proposed: { units, at },
      });
      out.created += 1;
      await announce(product, { units, why: g.why });
    }

    // The group's auto drafts that this pass did not propose.
    const drafts = await leanOf(
      Product.find({ status: "draft", origin: "auto", groupKeys: g.groupKey }, "_id slotSetHash edited stale offer"),
    );
    for (const p of drafts) {
      if (proposed.has(p.slotSetHash)) continue;
      if (!p.edited && !p.offer) {
        // Guarded: an owner edit or approval that lands first wins.
        const r = await Product.deleteOne({ _id: p._id, status: "draft", origin: "auto", edited: false, offer: null });
        if (r.deletedCount) {
          out.deleted += 1;
          continue;
        }
      }
      const r = await Product.updateOne({ _id: p._id, status: "draft", stale: { $ne: true } }, { $set: { stale: true } });
      if (r.modifiedCount) out.staled += 1;
    }
  }

  async function runOnce() {
    const out = { groups: 0, created: 0, updated: 0, staled: 0, deleted: 0 };
    const cfg = await getConfig().get();
    if (!cfg || !cfg.autoDraft) return { ...out, skipped: true };

    const now = toMs(clock());
    if (now === null) throw new TypeError("codeShop.planner: `now` must return a time");
    const ctx = {
      now,
      leadMs: num(cfg.expiryLeadHours, DEFAULTS.expiryLeadHours) * HOUR_MS,
      markets: marketsOf(cfg),
    };
    const sourceWords = Array.isArray(cfg.sourceWords) ? cfg.sourceWords : DEFAULTS.sourceWords;

    // Games not marked `sell` are never read, so never drafted.
    const games = sellableGames(cfg);
    if (!games.length) return out;
    const rows = await leanOf(CodeStock().find({ gameNo: { $in: games } }, ROW_FIELDS));

    const byGroup = new Map();
    for (const r of rows || []) {
      const key = text(r.groupKey);
      if (!key) continue;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(r);
    }

    for (const key of [...byGroup.keys()].sort(cmpStr)) {
      const g = summarize(key, byGroup.get(key), { now, leadMs: ctx.leadMs, sourceWords });
      g.why = readyReason(g, cfg, now);
      if (!g.why) continue;
      out.groups += 1;
      try {
        await planGroup(g, cfg, ctx, out);
      } catch (err) {
        // One bad group must not stop the others.
        await log({ level: "error", kind: "planner", msg: `Planning ${key} failed: ${text(err && err.message)}` });
      }
    }

    if (out.deleted || out.staled) {
      await log({
        kind: "planner",
        msg: `Planner: ${out.deleted} draft${out.deleted === 1 ? "" : "s"} removed, ${out.staled} marked stale (no longer proposed)`,
        data: { ...out },
      });
    }
    return out;
  }

  // One pass at a time: two overlapping passes could both decide a set has no
  // product yet and draft it twice.
  let inFlight = null;
  function run() {
    if (!inFlight) inFlight = runOnce().finally(() => (inFlight = null));
    return inFlight;
  }

  return { run };
}

module.exports = { createPlanner };
