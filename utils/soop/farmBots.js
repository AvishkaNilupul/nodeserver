// Bot operations for the SOOP farm, mixed into the SoopFarm class
// (utils/soopFarm.js). A bot is one plan — a pinned campaign, a game, or
// everything — farmed by a set of accounts (models/SoopFarmTask.js).
const SoopAccount = require("../../models/SoopAccount");
const SoopFarmTask = require("../../models/SoopFarmTask");
const { canFarm } = require("./farmViews");

const MODES = new Set(["campaign", "game", "auto"]);
const TARGETS = new Set(["all", "first"]);
const fail = (error) => ({ ok: false, error });
const uniq = (list) => [...new Set((list || []).map(String).filter(Boolean))];

function fromDoc(d) {
  return {
    id: String(d._id),
    name: d.label || (d.dropsIdx ? "Campaign " + d.dropsIdx : "Bot"),
    mode: MODES.has(d.mode) ? d.mode : "campaign",
    dropsIdx: d.dropsIdx ? String(d.dropsIdx) : null,
    gameNo: d.gameNo ? String(d.gameNo) : null,
    target: TARGETS.has(d.target) ? d.target : "all",
    codesOnly: !!d.codesOnly,
    accountIds: (d.accountIds || []).slice(),
    doneIds: (d.doneIds || []).slice(),
    active: !!d.active,
    createdAt: d.createdAt || d.startedAt || null,
    startedAt: d.startedAt || null,
    endedAt: d.endedAt || null,
  };
}

module.exports = {
  async _loadBots() {
    const docs = await SoopFarmTask.find({}).sort({ startedAt: -1 }).limit(300).lean();
    this.bots = new Map(docs.map((d) => [String(d._id), fromDoc(d)]));
  },

  _saveBot(bot, set) {
    Object.assign(bot, set);
    const doc = { ...set };
    if ("name" in doc) {
      doc.label = doc.name;
      delete doc.name;
    }
    return SoopFarmTask.updateOne({ _id: bot.id }, { $set: doc });
  },

  // Which of `ids` cannot join a bot, and why. `exceptBotId` is the bot being edited.
  async _blockers(ids, exceptBotId = null) {
    const rows = await SoopAccount.find({ loginId: { $in: ids } }).select("loginId status sold").lean();
    const byId = new Map(rows.map((r) => [r.loginId, r]));
    const out = [];
    for (const id of ids) {
      const a = byId.get(id);
      const other = [...this.bots.values()].find(
        (b) => b.active && b.id !== exceptBotId && b.accountIds.includes(id),
      );
      if (!a) out.push(`${id} does not exist`);
      else if (a.sold) out.push(`${id} is marked sold`);
      else if (!canFarm(a)) out.push(`${id} is logged out`);
      else if (other) out.push(`${id} is already in the bot "${other.name}"`);
    }
    return out;
  },

  // Starts every account that should be running and is not: after a restart,
  // a cookie re-import, an un-sold, or a session that ended on a passing error.
  async _reconcile() {
    const active = [...this.bots.values()].filter((b) => b.active);
    if (active.length) {
      const accounts = new Map((await this._accounts({ fresh: true })).map((a) => [a.loginId, a]));
      for (const bot of active) {
        const done = new Set(bot.doneIds);
        for (const id of bot.accountIds) {
          const a = accounts.get(id);
          if (a && canFarm(a) && !done.has(id) && !this.sessions.has(id)) {
            this._startSession(id, bot);
          }
        }
        await this._maybeFinish(bot);
      }
    }
    this.invTotals = await this.inventory
      .summary()
      .then((s) => s.totals)
      .catch(() => this.invTotals);
  },

  async _accountDone(bot, id, reason, detail) {
    if (!this.bots.has(bot.id)) return;
    if (!bot.doneIds.includes(id)) bot.doneIds.push(id);
    await SoopFarmTask.updateOne({ _id: bot.id }, { $addToSet: { doneIds: id } });
    if (reason === "ended") {
      this.activity.add({ level: "warn", kind: "done", accountId: id, botId: bot.id, msg: `${id}: ${detail}` });
    }
    await this._maybeFinish(bot);
  },

  // A pinned-campaign bot is finished once every account has reached its goal.
  async _maybeFinish(bot) {
    if (!bot.active || bot.mode !== "campaign" || !bot.accountIds.length) return;
    const done = new Set(bot.doneIds);
    if (!bot.accountIds.every((id) => done.has(id))) return;
    await this._saveBot(bot, { active: false, endedAt: new Date() });
    this.activity.add({ kind: "bot", botId: bot.id, msg: `Bot "${bot.name}" finished — every account reached its goal` });
  },

  async createBot({ name, mode = "campaign", dropsIdx, gameNo, accountIds, target = "all", codesOnly = false } = {}) {
    if (!MODES.has(mode)) return fail("Choose what the bot should farm");
    if (!TARGETS.has(target)) return fail("Unknown target");
    const ids = uniq(accountIds);
    if (!ids.length) return fail("Pick at least one account");

    let label = String(name || "").trim();
    if (mode === "campaign") {
      if (!dropsIdx) return fail("Choose a campaign");
      await this.listCampaigns().catch(() => {});
      const camp = await this.store.get(String(dropsIdx));
      if (!camp) return fail(`Campaign ${dropsIdx} is not known yet — refresh the campaign list`);
      if (!(camp.steps || []).length) return fail("That campaign has no watch-time rewards to earn");
      label = label || camp.title;
    } else if (mode === "game") {
      if (!gameNo) return fail("Choose a game");
      const g = this.store.games().find((x) => String(x.gameNo) === String(gameNo));
      label = label || (g ? g.name : "Game #" + gameNo);
    } else {
      label = label || "Everything guaranteed";
    }

    const blockers = await this._blockers(ids);
    if (blockers.length) return fail(blockers.slice(0, 5).join("; "));

    const doc = await SoopFarmTask.create({
      label: label.slice(0, 120),
      mode,
      dropsIdx: mode === "campaign" ? String(dropsIdx) : "",
      gameNo: mode === "game" ? String(gameNo) : "",
      target,
      codesOnly: !!codesOnly,
      accountIds: ids,
      doneIds: [],
      active: true,
      startedAt: new Date(),
    });
    const bot = fromDoc(doc.toObject());
    this.bots.set(bot.id, bot);
    this.activity.add({ kind: "bot", botId: bot.id, msg: `Bot "${bot.name}" started with ${ids.length} account(s)` });
    await this._reconcile();
    return { ok: true, bot: await this._viewBot(bot) };
  },

  async updateBot(id, { name, target, addIds, removeIds } = {}) {
    const bot = this.bots.get(String(id));
    if (!bot) return fail("Unknown bot");
    const set = {};
    if (typeof name === "string" && name.trim()) set.name = name.trim().slice(0, 120);
    if (target != null) {
      if (!TARGETS.has(target)) return fail("Unknown target");
      set.target = target;
    }
    const add = uniq(addIds).filter((x) => !bot.accountIds.includes(x));
    const remove = new Set(uniq(removeIds));
    if (add.length) {
      const blockers = await this._blockers(add, bot.id);
      if (blockers.length) return fail(blockers.slice(0, 5).join("; "));
    }
    if (add.length || remove.size) {
      set.accountIds = [...bot.accountIds.filter((x) => !remove.has(x)), ...add];
      set.doneIds = bot.doneIds.filter((x) => !remove.has(x));
    }
    const retarget = set.target && set.target !== bot.target;
    for (const x of bot.accountIds) {
      const mine = this.sessions.get(x) && this.sessions.get(x).botId === bot.id;
      if (mine && (remove.has(x) || retarget)) await this._stopSession(x);
    }
    // A longer target can un-finish accounts that had reached the first step.
    if (retarget) set.doneIds = [];
    if (Object.keys(set).length) await this._saveBot(bot, set);
    if (bot.active) await this._reconcile();
    return { ok: true, bot: await this._viewBot(bot) };
  },

  async stopBot(id) {
    const bot = this.bots.get(String(id));
    if (!bot) return fail("Unknown bot");
    await this._saveBot(bot, { active: false, endedAt: new Date() });
    for (const x of bot.accountIds) {
      const s = this.sessions.get(x);
      if (s && s.botId === bot.id) await this._stopSession(x);
    }
    this.activity.add({ kind: "bot", botId: bot.id, msg: `Bot "${bot.name}" stopped` });
    return { ok: true };
  },

  async resumeBot(id) {
    const bot = this.bots.get(String(id));
    if (!bot) return fail("Unknown bot");
    if (bot.active) return { ok: true };
    const clash = bot.accountIds.filter((x) =>
      [...this.bots.values()].some((b) => b.active && b.id !== bot.id && b.accountIds.includes(x)),
    );
    if (clash.length) {
      return fail(`${clash.slice(0, 5).join(", ")} now farm in another bot — remove them first`);
    }
    await this._saveBot(bot, { active: true, endedAt: null, startedAt: new Date() });
    this.activity.add({ kind: "bot", botId: bot.id, msg: `Bot "${bot.name}" resumed` });
    await this._reconcile();
    return { ok: true };
  },

  async deleteBot(id) {
    const bot = this.bots.get(String(id));
    if (!bot) return fail("Unknown bot");
    if (bot.active) await this.stopBot(bot.id);
    this.bots.delete(bot.id);
    await SoopFarmTask.deleteOne({ _id: bot.id });
    return { ok: true };
  },

  async stopAllBots() {
    const active = [...this.bots.values()].filter((b) => b.active);
    for (const bot of active) await this.stopBot(bot.id);
    return active.length;
  },
};
