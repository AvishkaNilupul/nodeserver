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
//
// Autopilot (2026-10-25, owner: "make it fully automatic"):
// - `autoLabels`: a reward whose stored name is not clean English gets a label
//   from utils/codeShop/labels.js (glossary, then machine translation), and a
//   draft the owner never edited gets labels it was missing filled in later;
// - `sellNewGames`: a game the settings have never named is added to them by
//   itself the first time it has a bundle to offer — selling when its name is
//   clean English, switched off (and the owner told) when it is not;
// - `drafts.minUnitsChzzk`: CHZZK groups come from one or two logins, so their
//   drafts need fewer bundles than SOOP's.

const { freeCounts, bestDraftSets } = require("./allocate");
const { slotSetHash } = require("./slots");
const { defaultLabel, defaultTexts } = require("./texts");
const { eventStarts } = require("./eventDates");
const { guideFor } = require("./games");
const { DEFAULTS, marketsForGame } = require("./config");
const { createLabeler, cleanLabel } = require("./labels");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Codes sell on Eldorado and PlayerAuctions (06-PLAYERAUCTIONS-PLAN.md C7):
// a draft names every one of them that is switched on. GGSel never says which
// code it sold (05-REVIEW-FIXES.md, R1), so a draft never names it.
const MARKET_ORDER = ["eldorado", "playerauctions"];
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

// CHZZK groups are "<gameNo>:chzzk-<campaign>" (docs/code-shop/07-CHZZK-SOURCE.md).
function isChzzkGroup(groupKey) {
  return /:chzzk-/.test(text(groupKey));
}

function minUnitsFor(groupKey, d) {
  return isChzzkGroup(groupKey)
    ? num(d.minUnitsChzzk, DEFAULTS.drafts.minUnitsChzzk)
    : num(d.minUnits, DEFAULTS.drafts.minUnits);
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
      s = { slotKey, label: "", image: "", nameRaw: "", name: "", campaignTitle: "", firstEarnedAt: null, earliestFreeUseBy: null };
      g.slots.set(slotKey, s);
    }
    // Rows come oldest first, so the first value seen is the oldest row's.
    if (s.firstEarnedAt === null && earned !== null) s.firstEarnedAt = earned;
    if (!s.label) s.label = defaultLabel(r, { sourceWords });
    if (!s.image) s.image = text(r.image);
    if (!s.nameRaw) s.nameRaw = text(r.nameRaw);
    if (!s.name) s.name = text(r.name);
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
  const SoopCampaign = () => models.SoopCampaign || require("../../models/SoopCampaign");
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  // Resolved on first use so a test's fakes never load the real ones.
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig());
  const getEvents = () => events || (events = require("./events").createEvents());
  const telegram = deps.telegram || null;
  // One labeler per planner, so a machine translation is asked for once per
  // reward name per process. No `fetch` (tests) = offline steps only.
  let labeler = deps.labeler || null;
  const getLabeler = () =>
    labeler ||
    (labeler = createLabeler({ fetch: typeof deps.fetch === "function" ? deps.fetch : null, now: clock, log: (e) => log(e) }));

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

  // The texts a draft of these slots gets (the same inputs as at creation).
  async function textsFor(slots, g, cfg, ctx) {
    let useBy = null;
    for (const s of slots) {
      const m = g.slots.get(s.slotKey);
      const u = m ? m.earliestFreeUseBy : null;
      if (u !== null && u !== undefined && (useBy === null || u < useBy)) useBy = u;
    }
    const guide = guideFor(g.gameNo, cfg);
    const starts = await eventStarts({ SoopCampaign: SoopCampaign(), ChzzkCampaign: models.ChzzkCampaign, CodeStock: CodeStock() }, [g.groupKey]);
    return defaultTexts({ slots, guide, useBy: useBy === null ? null : new Date(useBy), now: ctx.now, eventStarts: starts });
  }

  // -> { slots, texts } when a blank label of this (non-edited) draft can be
  // filled from the group's labels now, else null.
  async function repairLabels(p, g, cfg, ctx) {
    const slots = Array.isArray(p.slots) ? p.slots : [];
    if (!slots.some((s) => !text(s && s.label))) return null;
    let changed = false;
    const next = slots.map((s) => {
      if (text(s.label)) return s;
      const label = text((g.slots.get(s.slotKey) || {}).label);
      if (!label) return s;
      changed = true;
      return { ...s, label };
    });
    if (!changed) return null;
    return { slots: next, texts: await textsFor(next, g, cfg, ctx) };
  }

  // Fill the blank labels of a ready group's slots (autoLabels) — only slots
  // with a code still free to sell: an old group's sold or expired rewards need
  // no label, and asking for them would spend the translator's daily quota.
  async function labelGroup(g, cfg, ctx) {
    if (cfg.autoLabels !== true) return;
    const sourceWords = Array.isArray(cfg.sourceWords) ? cfg.sourceWords : DEFAULTS.sourceWords;
    const free = new Set(
      g.free.filter((f) => f.useBy === null || f.useBy - ctx.leadMs > ctx.now).map((f) => f.slotKey),
    );
    for (const s of g.slots.values()) {
      if (s.label || !free.has(s.slotKey)) continue;
      try {
        const r = await getLabeler().labelOf({ name: s.name, nameRaw: s.nameRaw }, { sourceWords });
        if (r && r.label) s.label = r.label;
      } catch (err) {
        await log({ level: "warn", kind: "label", msg: `No label for a reward of ${g.groupKey}: ${text(err && err.message)}` });
      }
    }
  }

  async function planGroup(g, cfg, ctx, out) {
    const Product = CodeProduct();
    const d = (cfg && cfg.drafts) || {};
    const leftovers = d.leftovers !== false;
    const maxSets = leftovers ? Math.floor(num(d.maxPerGroup, DEFAULTS.drafts.maxPerGroup)) : 1;
    const counts = freeCounts(g.free, { now: ctx.now, leadMs: ctx.leadMs });
    const sets = bestDraftSets(counts, { minUnits: minUnitsFor(g.groupKey, d), maxSets });
    const at = new Date(ctx.now);

    // A game the settings never named: added the first time it has a bundle to
    // offer (sellNewGames). Off = its rows were never read, so never here.
    if (sets.length && ctx.isNewGame(g.gameNo)) {
      const entry = await ctx.registerGame(g);
      if (!entry || entry.sell !== true) return;
    }

    const proposed = new Set();
    for (const set of sets) {
      const hash = slotSetHash(set.slotKeys);
      if (proposed.has(hash)) continue;
      proposed.add(hash);
      const units = set.units;

      // Any non-retired product with this exact set already covers it.
      const owners = await leanOf(Product.find({ slotSetHash: hash, status: { $ne: "retired" } }, "_id status edited stale slots"));
      if (owners.length) {
        for (const p of owners) {
          if (p.status !== "draft") continue; // live products are never touched
          if (!p.edited) {
            const $set = { "proposed.units": units, "proposed.at": at, stale: false };
            // A label this draft was made without, known now: fill it in and
            // rebuild the texts it feeds (never on a draft the owner edited).
            const repaired = await repairLabels(p, g, cfg, ctx);
            if (repaired) Object.assign($set, repaired);
            const r = await Product.updateOne({ _id: p._id, status: "draft", edited: false }, { $set });
            if (r.matchedCount) out.updated += 1;
            if (r.matchedCount && repaired) ctx.extra.relabelled += 1;
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
      const starts = await eventStarts({ SoopCampaign: SoopCampaign(), ChzzkCampaign: models.ChzzkCampaign, CodeStock: CodeStock() }, [g.groupKey]);
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
        texts: defaultTexts({ slots, guide, useBy: useBy === null ? null : new Date(useBy), now: ctx.now, eventStarts: starts }),
        pricing: { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
        // PlayerAuctions only for a game allowed there (Overwatch, not Delta Force).
        markets: marketsForGame(ctx.markets, g.gameNo, cfg),
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

  // A game the settings never named, the first time it has a bundle to offer.
  // Its name becomes its title and Eldorado game when it is clean English (it
  // then sells); otherwise it is added switched off and the owner is told once.
  // -> the entry now in the settings (and in this pass's cfg).
  async function registerGame(g, cfg, ctx) {
    const no = text(g.gameNo);
    const sourceWords = Array.isArray(cfg.sourceWords) ? cfg.sourceWords : DEFAULTS.sourceWords;
    const name = cleanLabel(g.gameName, { sourceWords });
    const entry = name ? { sell: true, marketGame: name, displayName: name } : { sell: false, marketGame: "", displayName: "" };
    try {
      const c = getConfig();
      if (c && typeof c.set === "function") await c.set({ games: { [no]: entry } }, { actor: "code shop (new game)" });
    } catch (err) {
      await log({ level: "warn", kind: "planner", msg: `New game ${no} could not be saved to the settings: ${text(err && err.message)}` });
    }
    if (!cfg.games || typeof cfg.games !== "object") cfg.games = {};
    cfg.games[no] = entry;
    ctx.extra.newGames += 1;
    const msg = name
      ? `New game "${name}" (#${no}) now sells by itself; switch it off in Sales > Settings if it should not`
      : `New game #${no}${g.gameName ? ` ("${text(g.gameName).slice(0, 60)}")` : ""} has codes but no English name; give it one in Sales > Settings to sell it`;
    let fresh = true;
    try {
      fresh = await getEvents().stamp("new-game:" + no, { kind: "planner", msg });
    } catch {
      fresh = true;
    }
    if (fresh && telegram && typeof telegram.send === "function") {
      try {
        await telegram.send("Code shop: " + msg + ".");
      } catch (err) {
        await log({ level: "warn", kind: "telegram", msg: "New-game alert not sent: " + text(err && err.message) });
      }
    }
    return entry;
  }

  async function runOnce() {
    const out = { groups: 0, created: 0, updated: 0, staled: 0, deleted: 0 };
    const cfg = await getConfig().get();
    if (!cfg || !cfg.autoDraft) return { ...out, skipped: true };

    const now = toMs(clock());
    if (now === null) throw new TypeError("codeShop.planner: `now` must return a time");
    const known = cfg.games && typeof cfg.games === "object" ? cfg.games : {};
    const sellNew = cfg.sellNewGames === true;
    const ctx = {
      now,
      leadMs: num(cfg.expiryLeadHours, DEFAULTS.expiryLeadHours) * HOUR_MS,
      markets: marketsOf(cfg),
      extra: { relabelled: 0, newGames: 0 },
      isNewGame: (gameNo) => sellNew && !Object.prototype.hasOwnProperty.call(known, text(gameNo)),
      registerGame: (g) => registerGame(g, cfg, ctx),
    };
    const sourceWords = Array.isArray(cfg.sourceWords) ? cfg.sourceWords : DEFAULTS.sourceWords;

    // Games not marked `sell` are never read, so never drafted. With
    // sellNewGames, games the settings never named are read too (registerGame
    // decides on them); a game switched off by name stays unread.
    const games = sellableGames(cfg);
    if (!games.length && !sellNew) return out;
    const off = Object.keys(known).filter((k) => !(known[k] && known[k].sell === true));
    const query = sellNew ? { gameNo: { $nin: off } } : { gameNo: { $in: games } };
    const rows = await leanOf(CodeStock().find(query, ROW_FIELDS));

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
        await labelGroup(g, cfg, ctx);
        await planGroup(g, cfg, ctx, out);
      } catch (err) {
        // One bad group must not stop the others.
        await log({ level: "error", kind: "planner", msg: `Planning ${key} failed: ${text(err && err.message)}` });
      }
    }

    // Only when they happened, so a pass with nothing new reads as before.
    if (ctx.extra.relabelled) out.relabelled = ctx.extra.relabelled;
    if (ctx.extra.newGames) out.newGames = ctx.extra.newGames;

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
