"use strict";
// Code shop farm priority (docs/code-shop/04-OPS.md, "farmPriority.js"): point
// the owner's chosen "auto" bots at the code game that sells best.
//
// It only ever changes one thing — a bot's priorityGameNo, through the farm's
// own updateBot — and only for bots the owner listed in
// config.farmPriority.botIds that are running in "auto" mode. A change restarts
// the bot's sessions (updateBot does that so they pick it up), so it waits
// minHoursBetween after the last change and does nothing on a tie it already
// follows. Ships dark: config.farmPriority.enabled is false by default.

const mongoose = require("mongoose");

const ObjectId = mongoose.Types.ObjectId;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SALES_WINDOW_MS = 14 * DAY_MS;
// A campaign that starts within this is already worth pointing a bot at.
const START_SOON_MS = DAY_MS;
const DEFAULT_MIN_HOURS = 6;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
// SOOP's itemType "1" is a code reward; the raw list keeps SOOP's strings.
const CODE_ITEM_TYPES = ["1", 1];

const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  SoopCampaign: () => require("../../models/SoopCampaign"),
  SoopFarmTask: () => require("../../models/SoopFarmTask"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

const text = (v) => (v === undefined || v === null ? "" : String(v));

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

// Game numbers are digits: "9" comes before "12".
function cmpGame(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

function hoursOf(v, fallback) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function createFarmPriority(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const farm = typeof deps.farm === "function" ? deps.farm : () => require("../soopFarm");
  const telegram = deps.telegram || null;
  let config = deps.config || null;
  let events = deps.events || null;
  const M = (name) => modelOf(deps, name);

  function configOf() {
    if (!config) {
      const { createConfig } = require("./config");
      config = createConfig({ model: deps.models && deps.models.CodeShopConfig, now });
    }
    return config;
  }

  async function note(entry) {
    try {
      if (!events) {
        const { createEvents } = require("./events");
        events = createEvents({ model: deps.models && deps.models.CodeShopEvent, now });
      }
      await events.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  // Games with a guaranteed ("term") code campaign live now or within a day
  // that the shop sells, each scored by its distinct units sold in 14 days + 1.
  async function scoreGames(cfg, t) {
    const games = (cfg && cfg.games) || {};
    const camps = await M("SoopCampaign")
      .find(
        {
          giveCon: "term",
          gameNo: { $nin: [null, ""] },
          endDate: { $gt: new Date(t) },
          startDate: { $lte: new Date(t + START_SOON_MS) },
          "itemList.itemType": { $in: CODE_ITEM_TYPES },
        },
        { gameNo: 1 },
      )
      .lean();
    const gameNos = [...new Set(camps.map((c) => text(c.gameNo)).filter(Boolean))].filter(
      (g) => games[g] && games[g].sell === true,
    );
    if (!gameNos.length) return [];
    const counts = await M("CodeStock").aggregate([
      {
        $match: {
          gameNo: { $in: gameNos },
          state: { $in: ["sold", "dead"] },
          unit: { $ne: null },
          soldAt: { $gte: new Date(t - SALES_WINDOW_MS) },
        },
      },
      { $group: { _id: { g: "$gameNo", u: "$unit" } } },
      { $group: { _id: "$_id.g", n: { $sum: 1 } } },
    ]);
    const sold = new Map(counts.map((c) => [text(c._id), Number(c.n) || 0]));
    return gameNos
      .map((g) => ({
        gameNo: g,
        name: text(games[g].displayName) || text(games[g].marketGame) || "game " + g,
        sold: sold.get(g) || 0,
        score: (sold.get(g) || 0) + 1,
      }))
      .sort((a, b) => b.score - a.score || cmpGame(a.gameNo, b.gameNo));
  }

  async function run() {
    const t = now();
    const out = { changed: [], top: null, scores: [] };
    const cfg = (await configOf().get({ fresh: true })) || {};
    const fp = cfg.farmPriority || {};
    const botIds = [...new Set((Array.isArray(fp.botIds) ? fp.botIds : []).map(text).filter(Boolean))];
    if (!fp.enabled || !botIds.length) return { ...out, skipped: "off" };
    const last = toMs(fp.lastChangeAt);
    if (last !== null && t - last < hoursOf(fp.minHoursBetween, DEFAULT_MIN_HOURS) * HOUR_MS) {
      return { ...out, skipped: "wait" };
    }

    out.scores = await scoreGames(cfg, t);
    if (!out.scores.length) return { ...out, skipped: "no-games" };
    const best = out.scores[0].score;
    const tied = out.scores.filter((s) => s.score === best).map((s) => s.gameNo);
    out.top = tied[0];
    const nameOf = new Map(out.scores.map((s) => [s.gameNo, s]));

    const oids = botIds.filter((id) => OBJECT_ID_HEX.test(id)).map((id) => new ObjectId(id));
    const bots = oids.length
      ? await M("SoopFarmTask").find({ _id: { $in: oids } }, { label: 1, mode: 1, active: 1, priorityGameNo: 1 }).lean()
      : [];
    const byId = new Map(bots.map((b) => [String(b._id), b]));

    let api = null;
    for (const id of botIds) {
      const bot = byId.get(id);
      // Only running "auto" bots have a priority game to change.
      if (!bot || bot.active !== true || bot.mode !== "auto") continue;
      const from = text(bot.priorityGameNo);
      // A tie keeps what the bot already farms first.
      const to = tied.includes(from) ? from : out.top;
      if (from === to) continue;
      let res;
      try {
        if (!api) api = farm();
        res = await api.updateBot(id, { priorityGameNo: to });
      } catch (err) {
        res = { ok: false, error: text(err && err.message) || "failed" };
      }
      if (!res || res.ok === false) {
        await note({
          level: "warn",
          kind: "farm-priority",
          msg: `Could not point the bot "${text(bot.label) || id}" at ${nameOf.get(to).name}: ${text(res && res.error) || "refused"}`.slice(0, 500),
          data: { botId: id, from, to },
        });
        continue;
      }
      out.changed.push({ botId: id, from, to, name: text(bot.label) });
    }

    if (out.changed.length) {
      try {
        await configOf().set({ farmPriority: { lastChangeAt: new Date(t) } }, { actor: "farm-priority" });
      } catch (err) {
        await note({
          level: "warn",
          kind: "farm-priority",
          msg: "Changed a bot's priority but could not record when: " + text(err && err.message).slice(0, 200),
        });
      }
      const byGame = new Map();
      for (const c of out.changed) {
        if (!byGame.has(c.to)) byGame.set(c.to, []);
        byGame.get(c.to).push(c.name || c.botId);
      }
      const parts = [...byGame].map(([g, names]) => {
        const s = nameOf.get(g);
        return `${s.name} (${s.sold} sold in 14 days) on ${names.join(", ")}`;
      });
      const line = "Code shop: farm priority now " + parts.join("; ");
      await note({
        level: "info",
        kind: "farm-priority",
        msg: line.slice(0, 500),
        data: { changed: out.changed.map(({ botId, from, to }) => ({ botId, from, to })), scores: out.scores },
      });
      if (telegram && typeof telegram.send === "function") {
        try {
          await telegram.send(line);
        } catch (err) {
          await note({ level: "warn", kind: "farm-priority", msg: "Telegram message not sent: " + text(err && err.message).slice(0, 200) });
        }
      }
    }
    out.changed = out.changed.map(({ botId, from, to }) => ({ botId, from, to }));
    return out;
  }

  return { run };
}

module.exports = { createFarmPriority };
