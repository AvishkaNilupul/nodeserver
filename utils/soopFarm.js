/* global AbortController, setInterval, clearInterval */
// The SOOP farm service: many accounts watched from one Node process, grouped
// into bots that survive a restart (docs/SOOP-FARM-CONTRACT.md §10).
//
// Started from server.js after the Mongo connection, like utils/autoFarmer.js.
// The watch sockets are in memory; accounts, bots, remembered campaigns,
// per-campaign progress, inventory and the activity log are durable.
// Bot operations live in ./soop/farmBots.js and are mixed in at the bottom.
const SoopAccount = require("../models/SoopAccount");
const SoopFarmTask = require("../models/SoopFarmTask");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const { makeClient, parseCookieInput, splitCookieExports, sharedGeo } = require("./soopClient");
const { getTransport } = require("./soop/http");
const { createCampaignStore } = require("./soop/campaignStore");
const { createActivityLog } = require("./soop/activity");
const { createInventoryService } = require("./soop/inventory");
const { createHealthService } = require("./soop/health");
const { createMetrics } = require("./soop/metrics");
const { isAuthError, plainMessage } = require("./soop/errors");
const { runSession, sleep } = require("./soopWorker");
const { encrypt, decrypt } = require("./secretBox");
const views = require("./soop/farmViews");

const ACCOUNT_FIELDS = "-cookies -check -progress";
const RECONCILE_MS = 60000;
const PROGRESS_FLUSH_MS = 15000;
const IMPORT_PACE_MS = 1500;
const INVENTORY_AFTER_STEP_MS = 90000;
const BOOT_SWEEP_MS = 120000;
const SCAN_FAIL_COOLDOWN_MS = 30000;

class SoopFarm {
  constructor() {
    this.clientFactory = (cookies, o) => makeClient(cookies, o);
    this.clock = { now: Date.now, sleep };
    this.timings = {}; // worker timing overrides (tests)
    this.autoInventory = true;
    this._build();
  }

  _build(opts = {}) {
    this.started = false;
    this.sessions = new Map(); // loginId -> { id, botId, ctrl, view, promise }
    this.clients = new Map(); // loginId -> client
    this.bots = new Map(); // botId -> bot record
    this.progress = new Map(); // loginId -> { [dropsIdx]: { minutes, max, goal, done, at } }
    this.dirty = new Map(); // "loginId dropsIdx" -> [loginId, dropsIdx]
    this.egressCountry = null;
    this.invTotals = null;
    this.accountsCache = null;
    this.scanCursor = 0;
    this.scanFailure = null;
    this.timers = [];
    this.invTimers = new Map();
    this.store = createCampaignStore(opts.store || {});
    this.activity = createActivityLog();
    this.inventory = createInventoryService({
      getClient: (id) => this.ensureClient(id),
      activity: this.activity,
    });
    this.health = createHealthService({
      getClient: (id) => this.ensureClient(id),
      activity: this.activity,
      onDead: (id, reason) => this._onDead(id, reason),
    });
    this.metrics = createMetrics();
  }

  // ---- lifecycle ----------------------------------------------------------

  setClientFactory(fn) {
    this.clientFactory = fn;
    this.clients.clear();
  }

  setClock(clock) {
    this.clock = { ...this.clock, ...clock };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      await this.store.load();
      await this._loadBots();
      await this._loadProgress();
    } catch (err) {
      console.error("[soop] startup load failed:", err.message);
    }
    this.metrics.start();
    this.health.start();
    this._every(RECONCILE_MS, () => this._reconcile());
    this._every(PROGRESS_FLUSH_MS, () => this._flushProgress());
    // The health service only sweeps on its interval, and this process restarts
    // more often than that — so check every login once, shortly after boot.
    this.bootTimer = setTimeout(() => {
      this.checkAccounts([]).catch((err) => console.error("[soop] boot health sweep failed:", err.message));
    }, BOOT_SWEEP_MS);
    if (this.bootTimer.unref) this.bootTimer.unref();
    await this._reconcile();
    const active = [...this.bots.values()].filter((b) => b.active).length;
    console.log(`[soop] farm service ready (${active} active bot(s))`);
  }

  // Tests and the dev harness: stop everything and forget all state.
  async _reset(opts = {}) {
    for (const id of [...this.sessions.keys()]) await this._stopSession(id);
    for (const t of this.timers) clearInterval(t);
    for (const t of this.invTimers.values()) clearTimeout(t);
    clearTimeout(this.bootTimer);
    this.metrics.stop();
    this.health.stop();
    this.activity.stop();
    this._build(opts);
  }

  _every(ms, fn) {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error("[soop] background task failed:", err.message));
    }, ms);
    if (t.unref) t.unref();
    this.timers.push(t);
  }

  // ---- accounts -----------------------------------------------------------

  async _accounts({ fresh = false } = {}) {
    const c = this.accountsCache;
    if (!fresh && c && Date.now() - c.at < 2000) return c.rows;
    const rows = await SoopAccount.find({}).select(ACCOUNT_FIELDS).sort({ createdAt: 1 }).lean();
    this.accountsCache = { at: Date.now(), rows };
    return rows;
  }

  async _loadProgress() {
    const rows = await SoopAccount.find({}).select("loginId progress").lean();
    for (const r of rows) this.progress.set(r.loginId, { ...(r.progress || {}) });
  }

  async ensureClient(id) {
    const cached = this.clients.get(id);
    if (cached) return cached;
    const doc = await SoopAccount.findOne({ loginId: id }).select("loginId cookies").lean();
    if (!doc) throw new Error("unknown account " + id);
    const cookies = JSON.parse(decrypt(doc.cookies) || "null");
    if (!Array.isArray(cookies)) throw new Error("stored cookie for " + id + " cannot be read");
    const client = this.clientFactory(cookies, { id });
    this.clients.set(id, client);
    return client;
  }

  // One or many Cookie-Editor exports. Each is proven logged in before it is stored.
  async importAccounts(text) {
    const results = [];
    const parts = splitCookieExports(String(text || ""));
    for (let i = 0; i < parts.length; i++) {
      if (i) await this.clock.sleep(IMPORT_PACE_MS);
      try {
        results.push({ ok: true, ...(await this._importOne(parts[i])) });
      } catch (e) {
        results.push({ ok: false, id: null, nick: null, country: null, error: e.message });
      }
    }
    this.accountsCache = null;
    await this._reconcile();
    return results;
  }

  async _importOne(text) {
    const cookies = parseCookieInput(text);
    const probe = this.clientFactory(cookies, { id: "import" });
    const info = await probe.privateInfo();
    if (!info.loggedIn) throw new Error("This export is logged out — export it again while signed in to SOOP");
    const id = String(info.loginId || "").trim();
    if (!id) throw new Error("SOOP did not return a login id for this cookie");
    if (info.country) this.egressCountry = info.country;
    await SoopAccount.findOneAndUpdate(
      { loginId: id },
      {
        $set: {
          nickname: info.nick || "",
          country: info.country || "",
          cookies: encrypt(JSON.stringify(cookies)),
          cookieAt: new Date(),
          status: "untested",
          lastError: "",
          deadAt: null,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    // Swap, never delete: a running session picks the new login up on its next loop.
    this.clients.set(id, this.clientFactory(cookies, { id }));
    if (!this.progress.has(id)) this.progress.set(id, {});
    this.activity.add({ kind: "account", accountId: id, msg: `Imported ${id}` });
    await this.health.check(id).catch(() => {});
    return { id, nick: info.nick || null, country: info.country || null };
  }

  async checkAccounts(ids) {
    let list = (ids || []).filter(Boolean);
    if (!list.length) {
      list = (await this._accounts({ fresh: true })).filter((a) => !a.sold).map((a) => a.loginId);
    }
    this.accountsCache = null;
    return this.health.checkMany(list);
  }

  async updateAccount(id, { sold, note } = {}) {
    const set = {};
    if (typeof sold === "boolean") set.sold = sold;
    if (typeof note === "string") set.note = note.slice(0, 500);
    if (!Object.keys(set).length) return false;
    const r = await SoopAccount.updateOne({ loginId: id }, { $set: set });
    this.accountsCache = null;
    if (!r.matchedCount) return false;
    if (set.sold === true) {
      await this._stopSession(id);
      this.activity.add({ kind: "account", accountId: id, msg: `${id} marked sold — farming stopped` });
    } else if (set.sold === false) {
      await this._reconcile();
    }
    return true;
  }

  async deleteAccounts(ids) {
    const list = [...new Set((ids || []).filter(Boolean))];
    for (const id of list) {
      await this._stopSession(id);
      this.clients.delete(id);
      this.progress.delete(id);
      for (const bot of this.bots.values()) {
        if (bot.accountIds.includes(id)) {
          bot.accountIds = bot.accountIds.filter((x) => x !== id);
          bot.doneIds = bot.doneIds.filter((x) => x !== id);
        }
      }
    }
    await SoopFarmTask.updateMany({}, { $pull: { accountIds: { $in: list }, doneIds: { $in: list } } });
    await SoopInventoryItem.deleteMany({ loginId: { $in: list } });
    const r = await SoopAccount.deleteMany({ loginId: { $in: list } });
    this.accountsCache = null;
    return r.deletedCount || 0;
  }

  async _markDead(id, reason) {
    await SoopAccount.updateOne(
      { loginId: id },
      { $set: { status: views.DEAD, lastError: String(reason || "logged out").slice(0, 300), deadAt: new Date() } },
    );
    this.accountsCache = null;
    this.activity.add({ level: "error", kind: "auth", accountId: id, msg: `${id} is logged out — re-import its cookie` });
  }

  // The health sweep found a dead login: stop burning a socket on it.
  _onDead(id) {
    this.accountsCache = null;
    this._stopSession(id).catch(() => {});
  }

  // ---- per-campaign progress ---------------------------------------------

  _progressApi(id) {
    return {
      get: (dropsIdx) => (this.progress.get(id) || {})[String(dropsIdx)] || null,
      set: (dropsIdx, patch) => {
        const all = this.progress.get(id) || {};
        all[String(dropsIdx)] = { ...(all[String(dropsIdx)] || {}), ...patch, at: new Date() };
        this.progress.set(id, all);
        this.dirty.set(id + " " + dropsIdx, [id, String(dropsIdx)]);
      },
    };
  }

  async _flushProgress() {
    const batch = [...this.dirty.values()];
    this.dirty.clear();
    const ops = batch
      .filter(([id, d]) => /^[\w-]+$/.test(d) && (this.progress.get(id) || {})[d])
      .map(([id, d]) => ({
        updateOne: {
          filter: { loginId: id },
          update: { $set: { ["progress." + d]: this.progress.get(id)[d] } },
        },
      }));
    if (ops.length) await SoopAccount.bulkWrite(ops, { ordered: false });
  }

  // ---- campaigns ----------------------------------------------------------

  // The list is the same for every account, so one login reads it for all.
  // Rotate the reader so a single dead login cannot blind the farm.
  async _scan() {
    const eligible = (await this._accounts()).filter(views.canFarm).map((a) => a.loginId);
    if (!eligible.length) throw new Error("Import a logged-in account first");
    const start = this.scanCursor++ % eligible.length;
    const order = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, 3);
    let lastErr;
    for (const id of order) {
      try {
        return await (await this.ensureClient(id)).campaignsAll();
      } catch (e) {
        lastErr = e;
        if (isAuthError(e)) this.health.check(id).catch(() => {});
      }
    }
    throw lastErr;
  }

  // The store does not cache a failed scan, so without this every idle session
  // would retry a broken egress on its own schedule.
  async listCampaigns(force = false) {
    const f = this.scanFailure;
    if (!force && f && this.clock.now() - f.at < SCAN_FAIL_COOLDOWN_MS) throw f.error;
    try {
      const list = await this.store.list({ scan: () => this._scan(), force });
      this.scanFailure = null;
      return list;
    } catch (error) {
      this.scanFailure = { at: this.clock.now(), error };
      throw error;
    }
  }

  async campaignsView({ force = false } = {}) {
    // A failed scan is reported through `scan`, next to whatever is remembered;
    // a farm with no account yet simply has nothing to list.
    let failure = null;
    await this.listCampaigns(force).catch((e) => (failure = e));
    const all = this.store.all();
    const botIds = new Map();
    for (const bot of this.bots.values()) {
      if (!bot.active) continue;
      for (const c of all) {
        const hit =
          bot.mode === "campaign"
            ? String(c.dropsIdx) === String(bot.dropsIdx)
            : c.guaranteed && (bot.mode === "auto" || String(c.gameNo) === String(bot.gameNo));
        if (hit) botIds.set(c.dropsIdx, [...(botIds.get(c.dropsIdx) || []), bot.id]);
      }
    }
    return {
      campaigns: all.map((c) => ({ ...c, botIds: botIds.get(c.dropsIdx) || [] })),
      games: this.store.games(),
      scan: this._scanView(failure),
    };
  }

  // When the campaign list was last read, in words the panel can show as is.
  _scanView(failure = null) {
    const last = this.store.lastScan();
    const f = failure || (this.scanFailure && this.scanFailure.error) || null;
    if (!f) return last.ok ? last : { ...last, error: last.error ? "The campaign list could not be read" : null };
    return { ...last, ok: false, error: plainMessage(f) };
  }

  renameGame(gameNo, name) {
    return this.store.setGameName(String(gameNo), String(name).trim());
  }

  setTranslation(source, english) {
    return this.store.setTranslation(String(source), String(english).trim());
  }

  // ---- sessions -----------------------------------------------------------

  _startSession(id, bot) {
    if (this.sessions.has(id)) return false;
    const s = {
      id,
      botId: bot.id,
      ctrl: new AbortController(),
      view: {
        state: "starting", detail: "Starting", dropsIdx: null, title: null, channel: null,
        minutes: 0, goal: null, since: new Date(), lastEventAt: null, credited: null,
      },
    };
    this.sessions.set(id, s);
    s.promise = this._run(s, bot).catch((err) => {
      console.error("[soop] session crashed:", id, err.message);
      if (this.sessions.get(id) === s) this.sessions.delete(id);
    });
    return true;
  }

  async _run(s, bot) {
    let out;
    try {
      await this.ensureClient(s.id);
      out = await runSession({
        id: s.id,
        getClient: () => this.clients.get(s.id),
        plan: { mode: bot.mode, dropsIdx: bot.dropsIdx, gameNo: bot.gameNo, target: bot.target, codesOnly: bot.codesOnly },
        campaigns: () => this.listCampaigns(),
        resolveCampaign: (d) => this.store.get(d),
        progress: this._progressApi(s.id),
        onEvent: (ev) => this._onEvent(s, ev),
        signal: s.ctrl.signal,
        clock: this.clock,
        timings: this.timings,
      });
    } catch (e) {
      out = { reason: "error", detail: e.message };
    }
    // Only the session that still owns the slot may clear it: a stopped session
    // that finishes late must not remove the one started after it (v1 bug).
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    await this._flushProgress().catch(() => {});
    const detail = out.detail || s.endDetail || "";
    if (out.reason === "auth") {
      await this._markDead(s.id, detail);
    } else if (out.reason === "finished" || out.reason === "ended") {
      await this._accountDone(bot, s.id, out.reason, detail);
    } else if (out.reason === "error") {
      this.activity.add({ level: "error", kind: "session", accountId: s.id, botId: bot.id, msg: `${s.id} stopped on an error: ${detail}` });
    }
  }

  _onEvent(s, ev) {
    if (this.sessions.get(s.id) !== s) return; // a replaced session's late events
    const v = s.view;
    v.lastEventAt = ev.at;
    const where = { accountId: s.id, botId: s.botId, dropsIdx: ev.dropsIdx || v.dropsIdx || null };
    if (ev.k === "state") {
      const changed = ev.state !== v.state || ev.detail !== v.detail;
      Object.assign(v, {
        state: ev.state,
        detail: ev.detail,
        dropsIdx: ev.dropsIdx ?? null,
        title: ev.title ?? null,
        channel: ev.state === "farming" || ev.state === "starting" ? ev.channel || null : null,
        // Minutes belong to a campaign: when the event carries none, show what
        // this account has on THAT campaign, never the previous one's count.
        minutes: ev.minutes ?? this._minutesOn(s.id, ev.dropsIdx),
        goal: ev.goal ?? null,
        credited: ev.credited ?? null,
      });
      if (changed) {
        this.activity.add({ ...where, level: ev.state === "backoff" || ev.error ? "warn" : "info", kind: "session", msg: `${s.id}: ${ev.detail}` });
      }
    } else if (ev.k === "step") {
      this.activity.add({ ...where, kind: "step", msg: `${s.id} reached the ${ev.step} min step of ${ev.title}` });
      this._inventorySoon(s.id);
    } else if (ev.k === "campaign-done") {
      this.activity.add({ ...where, kind: "done", msg: `${s.id} finished ${ev.title} (${ev.minutes}/${ev.goal} min)` });
      this._inventorySoon(s.id);
    } else if (ev.k === "error") {
      v.state = "error";
      v.detail = ev.msg;
    } else if (ev.k === "end") {
      s.endDetail = ev.detail;
    }
  }

  _minutesOn(id, dropsIdx) {
    const p = dropsIdx ? (this.progress.get(id) || {})[String(dropsIdx)] : null;
    return p ? Number(p.minutes) || 0 : 0;
  }

  // A reward should have landed a little after a step: refresh that inventory.
  _inventorySoon(id) {
    if (!this.autoInventory || this.invTimers.has(id)) return;
    const t = setTimeout(() => {
      this.invTimers.delete(id);
      this.inventory.syncAccount(id).catch(() => {});
    }, INVENTORY_AFTER_STEP_MS);
    if (t.unref) t.unref();
    this.invTimers.set(id, t);
  }

  async _stopSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.view.state = "stopping";
    s.view.detail = "Stopping";
    s.ctrl.abort();
    // Waits are interruptible, so this is normally instant; an in-flight SOOP
    // request can take up to its timeout, and the slot is freed regardless.
    await Promise.race([s.promise, sleep(3000)]);
    if (this.sessions.get(id) === s) this.sessions.delete(id);
    return true;
  }

  // ---- state for the panel ------------------------------------------------

  _viewCtx(accounts) {
    const titles = new Map(this.store.all().map((c) => [String(c.dropsIdx), c.title]));
    const games = new Map(this.store.games().map((g) => [String(g.gameNo), g.name]));
    return {
      sessions: this.sessions,
      accountsById: new Map(accounts.map((a) => [a.loginId, a])),
      progress: this.progress,
      campaignTitle: (d) => titles.get(String(d)) || null,
      gameName: (g) => games.get(String(g)) || "Game #" + g,
    };
  }

  // The §11 Bot shape for one bot (what create / update hand back).
  async _viewBot(bot) {
    return views.botView(bot, this._viewCtx(await this._accounts()));
  }

  async stateView() {
    const accounts = await this._accounts();
    const active = [...this.bots.values()].filter((b) => b.active);
    const botOf = (id) => (active.find((b) => b.accountIds.includes(id)) || {}).id;
    const ctx = this._viewCtx(accounts);
    const bots = [...this.bots.values()]
      .map((b) => views.botView(b, ctx))
      .sort((a, b) => b.active - a.active || new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
    const geo = sharedGeo().peek();
    const egress = views.egressView(getTransport(), (geo && geo.cc) || this.egressCountry);
    const scan = this._scanView();
    const inv = this.inventory.status();
    return {
      now: new Date(this.clock.now()).toISOString(),
      started: this.started,
      egress,
      totals: views.totalsView(accounts, this.sessions, bots),
      accounts: accounts.map((a) =>
        views.accountView(a, { session: this.sessions.get(a.loginId), botId: botOf(a.loginId) }),
      ),
      bots,
      alerts: views.alertsView({ egress, accounts, sessions: this.sessions, scan, inventoryTotals: this.invTotals, now: this.clock.now() }),
      scan,
      inventory: { running: inv.running, done: inv.done, total: inv.total, lastAt: inv.lastAt },
      metrics: this.metrics.view([...this.sessions.values()].filter((s) => s.view.state === "farming").length),
    };
  }
}

Object.assign(SoopFarm.prototype, require("./soop/farmBots"));

module.exports = new SoopFarm();
