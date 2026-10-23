// Singleton orchestrator for the CHZZK drops farm. Public API matches
// docs/CHZZK-FARM.md §10. Owns:
//   - egress health probe (CHZZK_PROXY_URL tunnel + credited country)
//   - campaign discovery (categories/live walk → ChzzkCampaign rows)
//   - per-account login checks (userStatus → status + unusableSince)
//   - codes-collector sweep (claims → GET /coupon-code → encrypted store)
//   - login-alert pass (one Telegram per batch; "accepted again" on recovery)
//   - worker supervisor (one runSession per eligible account)
//
// Never persists or returns cookie/code plaintext. Reads the master switch
// `autoFarm.chzzkFarm` from utils/settings (unset/unreadable = ON);
// `CHZZK_FARM=0` env disables at startup. Egress fails CLOSED: unknown
// country or unreachable tunnel = no logged-in call is sent.

const ChzzkAccount = require("../models/ChzzkAccount");
const ChzzkCampaign = require("../models/ChzzkCampaign");
const ChzzkReward = require("../models/ChzzkReward");
const ChzzkActivity = require("../models/ChzzkActivity");
const { encrypt, decrypt } = require("./secretBox");
const settings = require("./settings");
const telegram = require("./telegram");
const { createActivity } = require("./chzzk/activity");
const {
  parseImport, toHeader, deviceIdOf,
} = require("./chzzk/cookies");
const {
  campaignFromApi, isCampaignFarmable, isFarmableReward,
} = require("./chzzk/normalize");
const { makeClient } = require("./chzzk/client");
const { createCollector } = require("./chzzk/codes");
const { getTransport } = require("./chzzk/http");
const { runSession, AbortError } = require("./chzzk/worker");
const { isAuthError, isEgressError } = require("./chzzk/errors");
const views = require("./chzzk/views");

const DEFAULTS = {
  egressStartMs: 1_000,
  egressIntervalMs: 30 * 60_000,
  discoveryStartMs: 20_000,
  discoveryIntervalMs: 20 * 60_000,
  loginStartMs: 2 * 60_000,
  loginIntervalMs: 6 * 60 * 60_000,
  codesStartMs: 8 * 60_000,
  codesIntervalMs: 3 * 60 * 60_000,
  alertStartMs: 10_000,
  alertIntervalMs: 60_000,
  supervisorIntervalMs: 30_000,
  switchCacheMs: 30_000,
  countriesEnv: "CHZZK_COUNTRIES",
  countriesDefault: "JP,KR,FR", // JP+KR measured 2026-10-23; FR (Contabo) measured same day
  pickStreamMemoMs: 5 * 60_000, // stream list refreshed every 5 min
  pickStreamRetryMs: 60_000,    // ...or after 1 min when every listed stream is off-limits
  streamFanout: 5,              // top N usable streams a campaign spreads across
  streamListSize: 20,           // how many drops lives to ask CHZZK for
  alertWaitMs: 5 * 60_000,
  alertQuietMs: 2 * 60_000,
  alertMaxWaitMs: 15 * 60_000,
  alertRetryMs: 3 * 60_000,
  cookieImportCap: 90 * 1024,
};

const SHORT_HASH = (h) => (h ? String(h).slice(0, 8) : "");

class Farm {
  constructor(deps = {}) {
    this.deps = {
      Account: deps.Account || ChzzkAccount,
      Campaign: deps.Campaign || ChzzkCampaign,
      Reward: deps.Reward || ChzzkReward,
      activity: deps.activity || createActivity({ model: ChzzkActivity }),
      makeClient: deps.makeClient || makeClient,
      runSession: deps.runSession || runSession,
      createCollector: deps.createCollector || createCollector,
      transport: deps.transport || null,
      transportFactory: deps.transportFactory || getTransport,
      settings: deps.settings || settings,
      telegram: deps.telegram || telegram,
      now: deps.now || (() => Date.now()),
      timers: deps.timers || realTimers,
    };
    this.timings = { ...DEFAULTS, ...(deps.timings || {}) };
    this.started = false;
    this.transport = null;
    this.workers = new Map(); // accountId -> { controller, promise, since }
    this.pickMemo = new Map(); // campaignNo -> { pickedAt, streams, cursor }
    this.timerHandles = [];
    this.state = {
      egress: { via: "none", country: "", ok: false, at: 0, error: "" },
    };
    this._switchCache = { on: null, readAt: 0 };
    this.collector = null;
  }

  // Idempotent. Timers unref so the process can exit cleanly in tests.
  start() {
    if (this.started) return;
    this.started = true;
    this.transport = this.deps.transport || this.deps.transportFactory();
    this.collector = this.deps.createCollector({
      Account: this.deps.Account,
      Reward: this.deps.Reward,
      activity: this.deps.activity,
      clientFor: (acc) => this._clientFor(acc),
    });
    this._schedule("egress", this.timings.egressStartMs, this.timings.egressIntervalMs, () => this._checkEgress());
    this._schedule("discovery", this.timings.discoveryStartMs, this.timings.discoveryIntervalMs, () => this.refreshCampaigns().catch(() => {}));
    this._schedule("login", this.timings.loginStartMs, this.timings.loginIntervalMs, () => this.checkAccounts().catch(() => {}));
    this._schedule("codes", this.timings.codesStartMs, this.timings.codesIntervalMs, () => this._codesSweep());
    this._schedule("alert", this.timings.alertStartMs, this.timings.alertIntervalMs, () => this._alertPass());
    this._schedule("supervisor", this.timings.supervisorIntervalMs, this.timings.supervisorIntervalMs, () => this._supervise());
  }

  async stop() {
    for (const h of this.timerHandles) try { this.deps.timers.clear(h); } catch (_e) {}
    this.timerHandles = [];
    const promises = [];
    for (const [, w] of this.workers) {
      try { w.controller.abort(); } catch (_e) {}
      promises.push(w.promise.catch(() => {}));
    }
    this.workers.clear();
    await Promise.all(promises);
    this.started = false;
  }

  // ========== Switch ==========

  _readSwitch() {
    const t = this.deps.now();
    if (process.env.CHZZK_FARM === "0") return false;
    if (this._switchCache.on !== null && t - this._switchCache.readAt < this.timings.switchCacheMs) {
      return this._switchCache.on;
    }
    let on = true;
    try {
      const af = this.deps.settings.getAutoFarm();
      if (af && typeof af.chzzkFarm === "boolean") on = af.chzzkFarm;
    } catch (_e) { on = true; }
    this._switchCache = { on, readAt: t };
    return on;
  }

  async setSwitch(on, actor) {
    const next = !!on;
    try {
      await this.deps.settings.setAutoFarm({ chzzkFarm: next }, { actor: actor || "system" });
      this._switchCache = { on: next, readAt: this.deps.now() };
    } catch (e) {
      this.deps.activity.add({ level: "error", kind: "switch", msg: `switch write failed: ${short(e)}` });
    }
    return { on: next };
  }

  // ========== Egress ==========

  async _checkEgress() {
    const client = this.deps.makeClient({ cookies: null, deviceId: "", transport: this.transport });
    let via = "none";
    try { via = this.transport.describe(); } catch (_e) {}
    const countriesAllowed = String(process.env[this.timings.countriesEnv] || this.timings.countriesDefault)
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

    try {
      if (!this.transport.ready) {
        this._setEgress({ via, country: "", ok: false, error: "transport not ready" });
        return;
      }
      const country = await client.egressCountry();
      const ok = !!(country && countriesAllowed.includes(country.toUpperCase()));
      this._setEgress({
        via, country: country || "",
        ok,
        error: ok ? "" : country ? `country ${country} not credited` : "ipinfo unreachable",
      });
    } catch (e) {
      this._setEgress({ via, country: "", ok: false, error: short(e) });
    }
  }

  _setEgress(next) {
    const prev = this.state.egress;
    this.state.egress = { ...prev, ...next, at: this.deps.now() };
    if (prev.ok !== next.ok) {
      this.deps.activity.add({
        level: next.ok ? "info" : "warn",
        kind: "egress",
        msg: next.ok ? `Egress ok (${next.country} via ${next.via})` : `Egress not ok: ${next.error}`,
      });
    }
  }

  // ========== Clients ==========

  _clientFor(accountDoc) {
    let cookies = [];
    try { cookies = JSON.parse(decrypt(accountDoc.cookies)); }
    catch (_e) { cookies = []; }
    const deviceId = accountDoc.deviceId || deviceIdOf(cookies) || "";
    return this.deps.makeClient({ cookies, deviceId, transport: this.transport });
  }

  // ========== Account import / check ==========

  async importAccounts(text) {
    if (typeof text !== "string") return [];
    if (text.length > this.timings.cookieImportCap) {
      return [{ ok: false, error: "import too large" }];
    }
    const { jars, errors, infos = [] } = parseImport(text);
    const results = [];
    for (const err of errors) results.push({ ok: false, error: err });
    for (let i = 0; i < jars.length; i++) {
      const r = await this._importOne(jars[i], infos[i]);
      results.push(r);
    }
    return results;
  }

  async _importOne(jar, info) {
    const deviceId = deviceIdOf(jar) || "";
    const client = this.deps.makeClient({ cookies: jar, deviceId, transport: this.transport });
    let who;
    try {
      who = await client.userStatus();
    } catch (e) {
      if (isAuthError(e)) return { ok: false, error: "Jar is logged out" };
      if (isEgressError(e)) return { ok: false, error: `Egress: ${short(e)}` };
      return { ok: false, error: short(e) };
    }
    if (!who || !who.userIdHash) return { ok: false, error: "No userIdHash in getUserStatus" };
    const nickname = String(who.nickname || "").slice(0, 120);
    const penalties = Array.isArray(who.penalties) ? who.penalties.length : 0;
    const cookiesEnc = encrypt(JSON.stringify(jar));
    const now = this.deps.now();

    const prev = await this.deps.Account.findOne({ userIdHash: who.userIdHash }).lean();
    const created = !prev;
    // Clear only `unusableSince` here — leaving `unusableAlertAt` for the
    // alert pass to flip into "accepted again" and clear in one shot. See
    // `_checkOne` for the same reasoning.
    await this.deps.Account.updateOne(
      { userIdHash: who.userIdHash },
      {
        $set: {
          userIdHash: who.userIdHash,
          nickname,
          cookies: cookiesEnc,
          cookieAt: new Date(now),
          deviceId,
          status: "ok",
          lastError: "",
          lastCheckedAt: new Date(now),
          penalties,
          unusableSince: null,
          cookieKind: (info && info.kind) || "unknown",
          cookieExpiresAt: (info && info.expiresAt) || null,
        },
      },
      { upsert: true }
    );
    const saved = await this.deps.Account.findOne({ userIdHash: who.userIdHash }).select("_id").lean();
    this.deps.activity.add({
      level: "info", kind: "import",
      accountId: saved ? String(saved._id) : who.userIdHash,
      msg: created
        ? `Imported "${nickname}" (${SHORT_HASH(who.userIdHash)})`
        : `Re-imported "${nickname}" (${SHORT_HASH(who.userIdHash)})`,
    });
    return {
      ok: true, created, nickname, userIdHash8: SHORT_HASH(who.userIdHash),
      cookieKind: (info && info.kind) || "unknown",
      cookieExpiresAt: (info && info.expiresAt) || null,
    };
  }

  async checkAccounts(ids = []) {
    const q = Array.isArray(ids) && ids.length
      ? { _id: { $in: ids } }
      : { sold: { $ne: true } };
    const rows = await this.deps.Account.find(q).lean();
    for (const row of rows) {
      await this._checkOne(row).catch(() => {});
    }
    return { total: rows.length };
  }

  async _checkOne(row) {
    const client = this._clientFor(row);
    let status = row.status || "untested";
    let lastError = "";
    try {
      const who = await client.userStatus();
      if (who && who.loggedIn !== false) status = "ok";
      else { status = "not_logged_in"; lastError = "loggedIn:false"; }
    } catch (e) {
      if (isAuthError(e)) { status = "not_logged_in"; lastError = short(e); }
      else if (isEgressError(e)) { lastError = short(e); /* leave status */ }
      else { lastError = short(e); }
    }
    const update = {
      status,
      lastError,
      lastCheckedAt: new Date(this.deps.now()),
    };
    if (status === "ok") {
      // Clear the "first-seen-down" stamp; leave `unusableAlertAt` for the
      // alert pass to notice (so it can send "accepted again" and only then
      // clear the stamp). If we cleared both here the recovery message would
      // never fire — _alertPass has no other hook into "this one is back".
      update.unusableSince = null;
    } else if (!row.unusableSince) {
      update.unusableSince = new Date(this.deps.now());
    }
    await this.deps.Account.updateOne({ _id: row._id }, { $set: update });
  }

  async updateAccount(id, patch = {}) {
    const set = {};
    if (typeof patch.sold === "boolean") set.sold = patch.sold;
    if (typeof patch.paused === "boolean") set.paused = patch.paused;
    if (typeof patch.note === "string") set.note = String(patch.note).slice(0, 500);
    if (!Object.keys(set).length) return false;
    const r = await this.deps.Account.updateOne({ _id: id }, { $set: set });
    return !!r && (r.matchedCount || r.n || 0) > 0;
  }

  // "Farm again": forget one campaign's progress on one login. The running
  // worker is stopped so the supervisor starts a fresh one (≤ 30 s) that
  // re-checks the campaign against CHZZK's own lists.
  async resetProgress(id, campaignNo) {
    const no = Number(campaignNo);
    if (!Number.isFinite(no) || no <= 0) return false;
    const r = await this.deps.Account.updateOne({ _id: id }, { $unset: { [`progress.${no}`]: "" } });
    const ok = !!r && (r.matchedCount || r.n || 0) > 0;
    if (!ok) return false;
    const w = this.workers.get(String(id));
    if (w) { try { w.controller.abort(); } catch (_e) {} this.workers.delete(String(id)); }
    this.deps.activity.add({ level: "info", kind: "farm", accountId: String(id), campaignNo: no, msg: `Progress on campaign #${no} cleared by hand — it will be checked again` });
    return true;
  }

  async deleteAccounts(ids) {
    if (!Array.isArray(ids) || !ids.length) return { deleted: 0, keptCodes: 0 };
    const idSet = ids.map(String);
    // Keep Reward rows that hold a code; drop codeless rows along with the account.
    const keptCodes = await this.deps.Reward.countDocuments({ accountId: { $in: idSet }, hasCode: true });
    await this.deps.Reward.deleteMany({ accountId: { $in: idSet }, hasCode: { $ne: true } });
    const del = await this.deps.Account.deleteMany({ _id: { $in: idSet } });
    for (const id of idSet) {
      const w = this.workers.get(String(id));
      if (w) { try { w.controller.abort(); } catch (_e) {} this.workers.delete(String(id)); }
    }
    return { deleted: del.deletedCount || 0, keptCodes };
  }

  // ========== Campaigns ==========

  async campaignsView() {
    const [list, accounts, earned] = await Promise.all([
      this.deps.Campaign.find({}).lean(),
      this._accountViews(),
      this.deps.Reward.aggregate([{ $group: { _id: "$rewardNo", claimed: { $sum: 1 } } }]),
    ]);
    const now = this.deps.now();
    const earnedByReward = new Map(earned.map((r) => [r._id, r.claimed]));
    const campaigns = list
      .map((c) => views.campaignView(c, { earnedByReward, accounts, now }))
      .sort((a, b) => Number(b.farmable) - Number(a.farmable) || (+new Date(a.endAt || 0)) - (+new Date(b.endAt || 0)));
    return { campaigns };
  }

  async refreshCampaigns() {
    if (!this.state.egress.ok) return { found: 0, updated: 0, skipped: "egress" };
    const client = this.deps.makeClient({ cookies: null, deviceId: "", transport: this.transport });
    let found = 0, updated = 0;
    let next = null, pages = 0;
    const seenCampaigns = new Set();
    try {
      do {
        const page = await client.categoriesLive(next);
        pages++;
        for (const row of page.rows || []) {
          const nos = Array.isArray(row.dropsCampaignNos) ? row.dropsCampaignNos : [];
          for (const no of nos) {
            if (seenCampaigns.has(no)) continue;
            seenCampaigns.add(no);
            found++;
            try {
              const content = await client.campaign(no);
              const camp = campaignFromApi(content || {});
              await this._upsertCampaign(camp, "scan");
              updated++;
            } catch (_e) { /* skip */ }
          }
        }
        next = page.next || null;
      } while (next && pages < 40);
    } catch (e) {
      this.deps.activity.add({ level: "warn", kind: "discovery", msg: `Discovery stopped: ${short(e)}` });
    }
    return { found, updated };
  }

  async addCampaign(no) {
    const n = Number(no);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "bad campaignNo" };
    if (!this.state.egress.ok) return { ok: false, error: "egress not ready" };
    const client = this.deps.makeClient({ cookies: null, deviceId: "", transport: this.transport });
    try {
      const content = await client.campaign(n);
      const camp = campaignFromApi(content || {});
      await this._upsertCampaign(camp, "manual");
      return { ok: true, campaign: camp };
    } catch (e) {
      return { ok: false, error: short(e) };
    }
  }

  async _upsertCampaign(camp, source) {
    const now = this.deps.now();
    const prev = await this.deps.Campaign.findOne({ campaignNo: camp.campaignNo }).lean();
    const set = {
      campaignNo: camp.campaignNo,
      title: camp.title,
      categoryType: camp.categoryType,
      categoryId: camp.categoryId,
      categoryValue: camp.categoryValue,
      imageUrl: camp.imageUrl,
      state: camp.state,
      startAt: camp.startAt,
      endAt: camp.endAt,
      needsLink: !!camp.needsLink,
      guide: camp.guide,
      rewards: camp.rewards,
      refreshedAt: new Date(now),
      lastSeenAt: new Date(now),
    };
    if (!prev) {
      set.enabled = true;
      set.source = source || "scan";
    } else if (source === "manual" && prev.source !== "manual") {
      set.source = "manual";
    }
    await this.deps.Campaign.updateOne({ campaignNo: camp.campaignNo }, { $set: set }, { upsert: true });
  }

  async setCampaignEnabled(no, on) {
    const r = await this.deps.Campaign.updateOne({ campaignNo: Number(no) }, { $set: { enabled: !!on } });
    return !!r && (r.matchedCount || r.n || 0) > 0;
  }

  // ========== Rewards / codes ==========

  async rewardsView({ accountId, campaignNo } = {}) {
    const q = {};
    if (accountId) q.accountId = String(accountId);
    if (campaignNo != null) q.campaignNo = Number(campaignNo);
    const [rows, accs, camps] = await Promise.all([
      this.deps.Reward.find(q).select("-codeEnc").sort({ earnedAt: -1 }).limit(500).lean(),
      this.deps.Account.find({}).select("_id nickname").lean(),
      this.deps.Campaign.find({}).select("campaignNo title categoryValue").lean(),
    ]);
    const accountsById = new Map(accs.map((a) => [String(a._id), a]));
    const campaignsByNo = new Map(camps.map((c) => [Number(c.campaignNo), c]));
    return { rewards: rows.map((r) => views.rewardView(r, { accountsById, campaignsByNo })) };
  }

  // Codes on hand, one line per reward kind. Never reads codeEnc.
  async stockView() {
    const [rows, camps] = await Promise.all([
      this.deps.Reward.find({}).select("campaignNo rewardNo title rewardType categoryId campaignTitle state hasCode earnedAt codeEndAt revealedAt").lean(),
      this.deps.Campaign.find({}).select("campaignNo title categoryValue").lean(),
    ]);
    const campaignsByNo = new Map(camps.map((c) => [Number(c.campaignNo), c]));
    return views.stockView(rows, { campaignsByNo, now: this.deps.now() });
  }

  async revealCode(rewardId, who) {
    return this.collector ? this.collector.reveal(rewardId, who || "unknown") : null;
  }

  async collectNow(ids) {
    const list = Array.isArray(ids) && ids.length
      ? ids.map(String)
      : await this._eligibleAccountIds();
    this.collector && this.collector.sweep(list).catch(() => {});
    return { queued: list.length };
  }

  // ========== Codes sweep ==========

  async _codesSweep() {
    if (!this.state.egress.ok || !this.collector) return;
    const ids = await this._eligibleAccountIds();
    this.collector.sweep(ids).catch(() => {});
  }

  async _eligibleAccountIds() {
    const rows = await this.deps.Account.find({
      sold: { $ne: true },
      paused: { $ne: true },
      status: { $in: ["ok", "untested"] },
    }).select("_id").lean();
    return rows.map((r) => String(r._id));
  }

  // ========== Supervisor + workers ==========

  async _supervise() {
    if (!this._readSwitch() || !this.state.egress.ok) {
      for (const [, w] of this.workers) try { w.controller.abort(); } catch (_e) {}
      this.workers.clear();
      return;
    }
    const live = await this.deps.Account.find({
      sold: { $ne: true },
      paused: { $ne: true },
      status: { $in: ["ok", "untested"] },
    }).lean();
    const alive = new Set(live.map((a) => String(a._id)));
    for (const [id, w] of this.workers) {
      if (!alive.has(id)) { try { w.controller.abort(); } catch (_e) {} this.workers.delete(id); }
    }
    for (const acc of live) {
      const id = String(acc._id);
      if (this.workers.has(id)) continue;
      this._spawnWorker(acc);
    }
  }

  _spawnWorker(accountDoc) {
    const id = String(accountDoc._id);
    const controller = new AbortController();
    // Seed the per-session "done" set from the account's persisted progress so
    // the worker's pickCampaign skips campaigns we already finished. Only a
    // VERIFIED mark counts: v1 (before 2026-10-23 PM) wrote done:true for
    // campaigns that had never been credited, so those are re-checked.
    const doneSet = new Set();
    const progress = accountDoc.progress || {};
    for (const [no, p] of Object.entries(progress)) {
      if (p && p.done && p.verified) doneSet.add(Number(no));
    }
    const campaignsStore = this._campaignsStoreFor(id, doneSet);
    const client = this._clientFor(accountDoc);
    const since = this.deps.now();
    const current = { state: "waiting", campaignNo: 0, title: "", channelId: "", channelName: "", since, minutes: 0, note: "spawning" };

    const promise = this.deps.runSession({
      account: accountDoc,
      client,
      campaigns: campaignsStore,
      pickStream: (camp, acc, opts) => this._pickStream(camp, acc, opts),
      onEvent: (view) => this._onWorkerEvent(id, view),
      onProgress: (p) => this._onWorkerProgress(id, p),
      onEarned: () => this._onWorkerEarned(id),
      onLog: (e) => this._onWorkerLog(id, e),
      signal: controller.signal,
    }).then((res) => {
      if (res && res.reason === "auth") {
        this.deps.Account.updateOne({ _id: id }, { $set: { status: "not_logged_in", lastError: "worker:auth", unusableSince: this.deps.now() } }).catch(() => {});
      }
    }).catch((e) => {
      if (!(e instanceof AbortError)) {
        this.deps.activity.add({ level: "error", kind: "worker", accountId: id, msg: `worker crashed: ${short(e)}` });
      }
    }).finally(() => {
      this.workers.delete(id);
    });

    this.workers.set(id, { controller, promise, since, current, doneSet });
  }

  _onWorkerEvent(id, view) {
    const w = this.workers.get(id);
    if (!w) return;
    w.current = view;
    this.deps.Account.updateOne({ _id: id }, { $set: { current: view, lastHeartbeatAt: new Date(this.deps.now()) } }).catch(() => {});
  }

  // One write per progress read. Dotted fields, so a verified mark written by
  // markFarmed is never replaced by a later read of the same campaign.
  _onWorkerProgress(id, p) {
    const no = Number(p && p.campaignNo);
    if (!no) return;
    const key = `progress.${no}`;
    const set = {
      [`${key}.minutes`]: Number(p.minutes) || 0,
      [`${key}.at`]: new Date(this.deps.now()),
      [`${key}.next`]: p.next == null ? null : Number(p.next),
      [`${key}.rewards`]: p.states && typeof p.states === "object" ? p.states : {},
    };
    if (!p.done) set[`${key}.done`] = false;
    this.deps.Account.updateOne({ _id: id }, { $set: set }).catch(() => {});
  }

  _onWorkerLog(id, e) {
    if (!e || !e.msg) return;
    this.deps.activity.add({
      level: e.level || "info",
      kind: e.kind || "worker",
      accountId: String(id),
      campaignNo: e.campaignNo,
      msg: String(e.msg).slice(0, 400),
    });
  }

  _onWorkerEarned(id) {
    if (!this.collector) return;
    this.collector.collect(id, { reason: "worker" }).catch(() => {});
  }

  _campaignsStoreFor(accountId, doneSet = new Set()) {
    return {
      list: async () => {
        const rows = await this.deps.Campaign.find({ enabled: { $ne: false } }).lean();
        return rows.map((c) => ({
          campaignNo: c.campaignNo,
          title: c.title,
          categoryType: c.categoryType,
          categoryId: c.categoryId,
          state: c.state,
          startAt: c.startAt,
          endAt: c.endAt,
          needsLink: !!c.needsLink,
          enabled: c.enabled !== false,
          rewards: (c.rewards || []).map((r) => ({ ...r })),
        }));
      },
      campaign: async (no) => {
        const c = await this.deps.Campaign.findOne({ campaignNo: Number(no) }).lean();
        if (!c) return null;
        return {
          campaignNo: c.campaignNo,
          title: c.title,
          endAt: c.endAt,
          needsLink: !!c.needsLink,
          enabled: c.enabled !== false,
          rewards: (c.rewards || []).map((r) => ({ ...r })),
        };
      },
      isDone: (_accId, no) => doneSet.has(Number(no)),
      // The worker calls this only once progress.js has seen every code
      // reward earned in CHZZK's own lists, so the mark is "verified".
      markFarmed: (accId, no, info = {}) => {
        doneSet.add(Number(no));
        const key = `progress.${Number(no)}`;
        const at = new Date(this.deps.now());
        const set = { [`${key}.done`]: true, [`${key}.verified`]: true, [`${key}.doneAt`]: at, [`${key}.at`]: at, [`${key}.next`]: null };
        if (typeof info.minutes === "number") set[`${key}.minutes`] = info.minutes;
        if (info.states && typeof info.states === "object") set[`${key}.rewards`] = info.states;
        this.deps.Account.updateOne({ _id: String(accId) }, { $set: set }).catch(() => {});
      },
    };
  }

  // Shared pick-stream memo: streams by viewers, cursor rotates per campaign
  // so several accounts spread across the top N instead of piling on #1.
  // `avoid` = channelIds the asking worker has resting (a stream that ended
  // or did not credit). When nothing listed is usable the list is read again
  // (at most once a minute): a stream ending must not rest the campaign
  // while other streams carry it (seen 2026-10-23 on Overwatch).
  async _pickStream(camp, account, { avoid } = {}) {
    const id = camp.campaignNo;
    const now = this.deps.now();
    const skip = avoid instanceof Set ? avoid : new Set(avoid || []);
    let memo = this.pickMemo.get(id);
    const refetch = async () => {
      memo = { pickedAt: this.deps.now(), streams: await this._fetchTopStreams(camp), cursor: 0 };
      this.pickMemo.set(id, memo);
    };
    if (!memo || now - memo.pickedAt >= this.timings.pickStreamMemoMs) await refetch();
    let usable = memo.streams.filter((s) => !skip.has(s.channelId));
    if (!usable.length && now - memo.pickedAt >= this.timings.pickStreamRetryMs) {
      await refetch();
      usable = memo.streams.filter((s) => !skip.has(s.channelId));
    }
    if (!usable.length) return null;
    const n = Math.min(this.timings.streamFanout, usable.length);
    const pick = usable[memo.cursor % n];
    memo.cursor = (memo.cursor + 1) % this.timings.streamFanout;
    return pick;
  }

  async _fetchTopStreams(camp) {
    const client = this.deps.makeClient({ cookies: null, deviceId: "", transport: this.transport });
    try {
      const list = await client.dropsLives(camp.categoryType, camp.categoryId, camp.campaignNo, { size: this.timings.streamListSize });
      return (list || []).filter((l) => !l.adult && !l.paid && !l.watchParty);
    } catch (_e) { return []; }
  }

  // ========== Login alerts (Telegram) ==========

  async _alertPass() {
    const unusable = await this.deps.Account.find({
      sold: { $ne: true },
      status: { $in: ["not_logged_in"] },
    }).lean();
    const now = this.deps.now();
    const batch = [];
    for (const row of unusable) {
      const since = row.unusableSince ? +new Date(row.unusableSince) : now;
      const age = now - since;
      if (!row.unusableAlertAt && age >= this.timings.alertWaitMs) batch.push(row);
      else if (row.unusableAlertAt && now - +new Date(row.unusableAlertAt) >= this.timings.alertRetryMs && age >= this.timings.alertWaitMs) batch.push(row);
    }
    if (batch.length) {
      const quietAll = batch.every((r) => now - (+new Date(r.unusableSince || now)) >= this.timings.alertQuietMs);
      const maxWaitHit = batch.some((r) => now - (+new Date(r.unusableSince || now)) >= this.timings.alertMaxWaitMs);
      if (quietAll || maxWaitHit) {
        const names = batch.map((r) => `${r.nickname || SHORT_HASH(r.userIdHash)}`).join(", ");
        const text = `CHZZK logins down (${batch.length}): ${names}`;
        try {
          await this.deps.telegram.sendTelegram(text);
          const ids = batch.map((r) => r._id);
          await this.deps.Account.updateMany({ _id: { $in: ids } }, { $set: { unusableAlertAt: new Date(now) } });
          this.deps.activity.add({ level: "warn", kind: "alert", msg: text });
        } catch (_e) { /* swallow — retry next pass */ }
      }
    }

    // Recovery: any account whose unusableAlertAt was stamped but is now ok →
    // send "accepted again" when NO account is still unusable, then clear the stamp.
    const stillDown = await this.deps.Account.countDocuments({
      sold: { $ne: true }, status: "not_logged_in",
    });
    if (!stillDown) {
      const stamped = await this.deps.Account.find({ unusableAlertAt: { $ne: null } }).lean();
      if (stamped.length) {
        try {
          await this.deps.telegram.sendTelegram(`CHZZK logins accepted again (${stamped.length})`);
          const ids = stamped.map((r) => r._id);
          await this.deps.Account.updateMany(
            { _id: { $in: ids } },
            { $set: { unusableSince: null, unusableAlertAt: null } }
          );
          this.deps.activity.add({ level: "info", kind: "alert", msg: `CHZZK logins accepted again (${stamped.length})` });
        } catch (_e) { /* retry next pass */ }
      }
    }
  }

  // ========== Activity view ==========

  async activityView({ limit = 100, accountId } = {}) {
    const entries = await this.deps.activity.list({ limit: Math.min(500, Math.max(1, limit)), accountId });
    return { entries };
  }

  // ========== Totals / state view ==========

  async _accountViews() {
    const [accounts, grouped] = await Promise.all([
      this.deps.Account.find({}).select("-cookies").lean(),
      this.deps.Reward.aggregate([
        { $match: { hasCode: true } },
        { $group: { _id: "$accountId", n: { $sum: 1 } } },
      ]),
    ]);
    const codesByAcc = new Map(grouped.map((r) => [String(r._id), r.n]));
    const ctx = { switchOn: this._readSwitch(), egressOk: !!this.state.egress.ok, now: this.deps.now() };
    return accounts.map((a) => views.accountView(a, {
      ...ctx,
      worker: this.workers.get(String(a._id)) || null,
      codes: codesByAcc.get(String(a._id)) || 0,
    }));
  }

  async stateView() {
    const now = this.deps.now();
    const DAY = 24 * 3600_000;
    const [list, campRows, codes, fresh, today, waiting, expiringSoon] = await Promise.all([
      this._accountViews(),
      this.deps.Campaign.find({}).select("-guide").lean(),
      this.deps.Reward.countDocuments({ hasCode: true }),
      this.deps.Reward.countDocuments({ hasCode: true, revealedAt: null }),
      this.deps.Reward.countDocuments({ hasCode: true, codeAt: { $gte: new Date(now - DAY) } }),
      this.deps.Reward.countDocuments({ hasCode: { $ne: true }, state: "earned", tries: { $gt: 0 } }),
      this.deps.Reward.countDocuments({ hasCode: true, revealedAt: null, codeEndAt: { $gt: new Date(now), $lt: new Date(now + 7 * DAY) } }),
    ]);
    const campaigns = campRows.map((c) => views.campaignView(c, { earnedByReward: null, accounts: list, now }));
    const switchOn = this._readSwitch();
    const totals = {
      accounts: list.length,
      ok: list.filter((a) => a.status === "ok").length,
      loggedOut: list.filter((a) => a.status === "not_logged_in").length,
      untested: list.filter((a) => a.status === "untested").length,
      paused: list.filter((a) => a.paused).length,
      sold: list.filter((a) => a.sold).length,
      running: list.filter((a) => a.running).length,
      watching: list.filter((a) => a.current && a.current.state === "watching").length,
      codes,
      codesFresh: fresh,
      codesToday: today,
      codesWaiting: waiting,
      campaigns: campRows.length,
      farmable: campaigns.filter((c) => c.farmable).length,
    };
    return {
      now: new Date(now),
      started: !!this.started,
      switch: { on: switchOn },
      egress: this.state.egress,
      totals,
      alerts: views.alerts({ switchOn, egress: this.state.egress, accounts: list, campaigns, counts: { waiting, expiringSoon }, now }),
      collector: { pending: this.collector && this.collector.pending ? this.collector.pending() : 0 },
      accounts: list,
    };
  }

  // ========== Internal helpers ==========

  _schedule(name, startMs, intervalMs, fn) {
    const run = () => {
      try {
        const r = fn();
        if (r && typeof r.then === "function") r.catch((e) => this.deps.activity.add({ level: "error", kind: name, msg: short(e) }));
      } catch (e) { this.deps.activity.add({ level: "error", kind: name, msg: short(e) }); }
    };
    const first = this.deps.timers.set(() => {
      run();
      const h = this.deps.timers.interval(run, intervalMs);
      this.timerHandles.push(h);
    }, startMs);
    this.timerHandles.push(first);
  }
}

function short(e) {
  if (!e) return "";
  const m = (e && (e.code ? `${e.code}: ` : "")) + (e.message || String(e));
  return m.length > 200 ? m.slice(0, 200) : m;
}

const realTimers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  interval: (fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
  clear: (h) => { if (!h) return; try { clearTimeout(h); } catch (_e) {} try { clearInterval(h); } catch (_e) {} },
};

// Singleton — matches the SOOP farm's export shape.
const farm = new Farm();
module.exports = farm;
module.exports.Farm = Farm;
module.exports.DEFAULTS = DEFAULTS;
