// Bot operations for the SOOP farm, mixed into the SoopFarm class
// (utils/soopFarm.js). A bot is one plan — a pinned campaign, a game, or
// everything — farmed by a set of accounts (models/SoopFarmTask.js).
const SoopAccount = require("../../models/SoopAccount");
const SoopFarmTask = require("../../models/SoopFarmTask");
const { canFarm } = require("./farmViews");
const { goalOf } = require("../soopWorker");

// How often the watcher re-reads the campaign list while bots are asleep.
const WATCH_SOON_MS = 60000; // a campaign starts within 15 minutes
const WATCH_ACTIVE_MS = 120000; // a campaign is inside its window, or something is farming
const WATCH_IDLE_MS = 600000; // nothing can go live soon
const SOON_MS = 15 * 60000;
const time = (d) => (d ? new Date(d).getTime() : null);

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
    priorityGameNo: d.priorityGameNo ? String(d.priorityGameNo) : null,
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

  // Sleep / wake, the SOOP version of the Twitch farm's park-when-farmed: an
  // account only has a session while there is something it can earn. The rest
  // of the time nothing runs for it and nothing is held in memory; this watcher
  // re-reads the campaign list on a slow, adaptive schedule and starts exactly
  // the accounts that have work. Also covers a restart, a cookie re-import, an
  // un-sold, and a session that ended on a passing error.
  async _reconcile({ force = false } = {}) {
    const active = [...this.bots.values()].filter((b) => b.active);
    if (active.length && (force || this.clock.now() >= this.nextWatchAt)) await this._wake(active);
    this.invTotals = await this.inventory
      .summary()
      .then((s) => s.totals)
      .catch(() => this.invTotals);
  },

  async _wake(active) {
    const now = this.clock.now();
    const accounts = new Map((await this._accounts({ fresh: true })).map((a) => [a.loginId, a]));
    const list = await this.farmable().catch(() => null);
    let next = WATCH_IDLE_MS;
    for (const bot of active) {
      const cands = list ? await this._candidates(bot, list) : null;
      const done = new Set(bot.doneIds);
      for (const id of bot.accountIds) {
        const a = accounts.get(id);
        if (!a || !canFarm(a) || done.has(id) || this.sessions.has(id)) continue;
        if (!cands) {
          this._sleep(id, { detail: "Cannot read the campaign list right now — will try again" });
          continue;
        }
        const v = this._verdict(bot, id, cands, now);
        const z = this.sleep.get(id);
        if (v.done) await this._accountDone(bot, id, v.done, v.detail);
        else if (v.go && !(z && z.coolUntil > now)) this._startSession(id, bot);
        else this._sleep(id, v);
      }
      if (cands) next = Math.min(next, this._cadence(cands, now));
      await this._maybeFinish(bot);
    }
    if (!list) next = WATCH_ACTIVE_MS;
    if (this.sessions.size) next = Math.min(next, WATCH_ACTIVE_MS);
    this.nextWatchAt = now + (this.timings.watchMs ?? next);
  },

  // The campaigns a bot would farm, live or not.
  async _candidates(bot, list) {
    if (bot.mode === "campaign") {
      const key = String(bot.dropsIdx);
      const hit = list.find((c) => String(c.dropsIdx) === key) || (await this.store.get(key));
      return hit ? [hit] : [];
    }
    return list.filter(
      (c) =>
        c.guaranteed &&
        (c.steps || []).length > 0 &&
        (!bot.codesOnly || !c.needsLink) &&
        (bot.mode === "auto" || String(c.gameNo) === String(bot.gameNo)),
    );
  },

  // What one account should do now: { go } start farming · { done } it is
  // finished with this bot · otherwise sleep, with the reason to show.
  _verdict(bot, id, cands, now) {
    const prog = this.progress.get(id) || {};
    const reached = (c) => {
      const p = prog[String(c.dropsIdx)];
      const goal = goalOf(c, bot.target);
      return !!(p && (p.done || (goal != null && (Number(p.max) || 0) >= goal)));
    };
    const ref = (c) => ({ dropsIdx: c.dropsIdx, title: c.title, goal: goalOf(c, bot.target) });
    const open = cands.filter((c) => !(time(c.endAt) && time(c.endAt) < now));
    if (bot.mode === "campaign") {
      if (!cands.length) return { detail: `Campaign ${bot.dropsIdx} is not listed by SOOP yet` };
      if (reached(cands[0])) return { done: "finished" };
      if (!open.length) return { done: "ended", detail: "The campaign ended before the goal was reached" };
    }
    if (!open.length) return { detail: "Nothing to farm right now — sleeping until a campaign appears" };
    const todo = open.filter((c) => !reached(c));
    if (!todo.length) return { ...ref(open[0]), detail: "Everything is farmed — sleeping until the next campaign" };
    // A campaign that left SOOP's list has no trustworthy live flag: try it.
    const rank = (c) => (bot.priorityGameNo && String(c.gameNo) === String(bot.priorityGameNo) ? 0 : 1);
    // Listed-and-live before delisted (whose state is only a guess), then the priority game.
    const guess = (c) => (c.filter === "unlisted" ? 1 : 0);
    // SOOP can flag a campaign live hours before its window opens; it is not farmable until then.
    const started = (c) => !time(c.startAt) || time(c.startAt) - 120000 <= now;
    const live = todo.filter((c) => (c.live || c.filter === "unlisted") && started(c)).sort((a, b) => guess(a) - guess(b) || rank(a) - rank(b));
    if (live.length) return { go: true, ...ref(live[0]), detail: "Starting" };
    const first = todo.slice().sort((a, b) => (time(a.startAt) || 0) - (time(b.startAt) || 0))[0];
    const later = time(first.startAt) && time(first.startAt) > now;
    return {
      ...ref(first),
      detail: later ? "Campaign has not started yet" : "Campaign is not live right now — sleeping until the next broadcast",
    };
  },

  // Look often only when something can actually go live soon.
  _cadence(cands, now) {
    let ms = WATCH_IDLE_MS;
    for (const c of cands) {
      const start = time(c.startAt);
      const end = time(c.endAt);
      if (end && end < now) continue;
      if (start && start > now) {
        if (start - now <= SOON_MS) ms = Math.min(ms, WATCH_SOON_MS);
      } else {
        ms = Math.min(ms, WATCH_ACTIVE_MS);
      }
    }
    return ms;
  },

  _sleep(id, v) {
    const z = this.sleep.get(id) || { at: new Date(this.clock.now()), coolUntil: 0 };
    this.sleep.set(id, { ...z, detail: v.detail, dropsIdx: v.dropsIdx || null, title: v.title || null, goal: v.goal ?? null });
    this._primeOnce(id);
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

  async createBot({ name, mode = "campaign", dropsIdx, gameNo, accountIds, target = "all", codesOnly = false, priorityGameNo } = {}) {
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
      priorityGameNo: mode === "auto" && priorityGameNo ? String(priorityGameNo) : "",
      accountIds: ids,
      doneIds: [],
      active: true,
      startedAt: new Date(),
    });
    const bot = fromDoc(doc.toObject());
    this.bots.set(bot.id, bot);
    this.activity.add({ kind: "bot", botId: bot.id, msg: `Bot "${bot.name}" started with ${ids.length} account(s)` });
    await this._reconcile({ force: true });
    return { ok: true, bot: await this._viewBot(bot) };
  },

  async updateBot(id, { name, target, addIds, removeIds, priorityGameNo } = {}) {
    const bot = this.bots.get(String(id));
    if (!bot) return fail("Unknown bot");
    const set = {};
    if (typeof name === "string" && name.trim()) set.name = name.trim().slice(0, 120);
    if (target != null) {
      if (!TARGETS.has(target)) return fail("Unknown target");
      set.target = target;
    }
    // "" clears it; undefined leaves it alone. Sessions are restarted so they pick it up.
    const reprioritise = priorityGameNo != null && bot.mode === "auto" && String(priorityGameNo) !== String(bot.priorityGameNo || "");
    if (reprioritise) set.priorityGameNo = String(priorityGameNo);
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
      if (mine && (remove.has(x) || retarget || reprioritise)) await this._stopSession(x);
    }
    // A longer target can un-finish accounts that had reached the first step.
    if (retarget) set.doneIds = [];
    if (Object.keys(set).length) await this._saveBot(bot, set);
    if (bot.active) await this._reconcile({ force: true });
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
    await this._reconcile({ force: true });
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
