/* global setInterval */
// The SOOP farm service: many accounts watched from one Node process, a shared
// campaign cache, and "bots" (one campaign + N accounts) that survive a
// restart. Ported from _soop-probe/pool.js and moved onto MongoDB.
//
// Started from server.js after the Mongo connection, following the same pattern
// as utils/autoFarmer.js. The watch sockets themselves are in memory; the account
// rows, remembered campaigns and bot definitions are durable.
const os = require("os");

const SoopAccount = require("../models/SoopAccount");
const SoopCampaign = require("../models/SoopCampaign");
const SoopFarmTask = require("../models/SoopFarmTask");
const { makeClient, parseCookieInput } = require("./soopClient");
const { runSession, stepsOf } = require("./soopWorker");
const { encrypt, decrypt } = require("./secretBox");

const CAMP_TTL_MS = 60000;
const SAMPLE_MS = 5000;
const MAX_SAMPLES = 240; // ~20 min
const LOG_CAP = 120;

function cookieArrayFromDoc(doc) {
  const raw = decrypt(doc.cookies);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error("stored cookie value is not an array");
  return parsed;
}

class SoopFarm {
  constructor() {
    this.started = false;
    this.sessions = new Map(); // loginId -> session
    this.clients = new Map(); // loginId -> client
    this.known = new Map(); // dropsIdx -> campaign record
    this.tasks = new Map(); // taskId -> task row
    this.camp = { at: 0, list: [] };
    this.baselineRss = process.memoryUsage().rss;
    this.peakRss = this.baselineRss;
    this.samples = [];
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = Date.now();
    this.timer = null;
  }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const known = await SoopCampaign.find({}).lean();
      for (const e of known) this.known.set(String(e.dropsIdx), e);
    } catch (err) {
      console.error("[soop] campaign memory load failed:", err.message);
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.sample(), SAMPLE_MS);
      this.timer.unref?.();
    }
    // Resume bots that were running when the process last stopped.
    try {
      const active = await SoopFarmTask.find({ active: true }).lean();
      for (const t of active) {
        const taskId = String(t._id);
        const started = [];
        for (const id of t.accountIds || []) {
          const r = await this.startSession(id, {
            drops: t.dropsIdx,
            target: t.target,
            taskId,
          });
          if (r.ok) started.push(id);
        }
        if (started.length) {
          this.tasks.set(taskId, {
            taskId,
            dropsIdx: String(t.dropsIdx),
            label: t.label || String(t.dropsIdx),
            target: t.target,
            targetMinutes: t.targetMinutes ?? null,
            ids: started,
            startedAt: t.startedAt,
          });
        } else {
          await SoopFarmTask.updateOne(
            { _id: t._id },
            { $set: { active: false, endedAt: new Date() } },
          );
        }
      }
      if (active.length) {
        console.log(`[soop] resumed ${active.length} bot(s)`);
      }
    } catch (err) {
      console.error("[soop] bot resume failed:", err.message);
    }
    console.log("[soop] farm service ready");
  }

  sample() {
    const m = process.memoryUsage();
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const cpuPct =
      Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100 * 10) / 10;
    this.peakRss = Math.max(this.peakRss, m.rss);
    this.samples.push({ t: now, rss: m.rss, cpu: cpuPct });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  // ---- accounts -----------------------------------------------------------

  async loadAccounts() {
    const rows = await SoopAccount.find({}).sort({ createdAt: 1 }).lean();
    return rows.map((a) => ({
      id: a.loginId,
      nick: a.nickname || null,
      country: a.country || null,
      status: a.status,
      lastError: a.lastError || null,
      savedAt: a.createdAt,
      lastCheckedAt: a.lastCheckedAt,
      check: a.check || null,
      sold: !!a.sold,
    }));
  }

  // A client built from a decrypted cookie row, cached for the process lifetime.
  clientFor(id) {
    const cached = this.clients.get(id);
    if (cached) return cached;
    throw new Error("account not loaded: " + id);
  }

  async ensureClient(id) {
    if (this.clients.has(id)) return this.clients.get(id);
    const doc = await SoopAccount.findOne({ loginId: id }).lean();
    if (!doc) throw new Error("unknown account " + id);
    const client = makeClient(cookieArrayFromDoc(doc), id);
    this.clients.set(id, client);
    return client;
  }

  // Import (or replace) an account from a Cookie-Editor export. Returns the
  // login id after proving the session is really logged in.
  async importAccount(cookiesText) {
    const parsed = parseCookieInput(cookiesText);
    const probe = makeClient(parsed, "import");
    const priv =
      (
        await probe.privateInfo().catch((e) => {
          throw new Error("SOOP login check failed: " + e.message);
        })
      ).CHANNEL || {};
    if (priv.IS_LOGIN !== 1) {
      throw new Error("cookie set is not logged in (IS_LOGIN != 1)");
    }
    const id = String(priv.LOGIN_ID || "").trim();
    if (!id) throw new Error("SOOP did not return a login id for this cookie");
    await SoopAccount.findOneAndUpdate(
      { loginId: id },
      {
        $set: {
          nickname: priv.LOGIN_NICK || "",
          country: priv.COUNTRY_CODE || "",
          cookies: encrypt(JSON.stringify(parsed)),
          status: "untested",
          lastError: "",
        },
      },
      { upsert: true },
    );
    this.clients.delete(id);
    await this.checkAccount(id).catch(() => {});
    return {
      id,
      nick: priv.LOGIN_NICK || null,
      country: priv.COUNTRY_CODE || null,
    };
  }

  // Health probe. The drops domain validates separately from the main site, so
  // report a 401 there instead of hiding it.
  async checkAccount(id) {
    const client = await this.ensureClient(id);
    const priv =
      (await client.privateInfo().catch((e) => ({ error: e.message })))
        .CHANNEL || {};
    let missions = [];
    let live = [];
    let dropsError = null;
    try {
      missions = await client.missions();
    } catch (e) {
      dropsError = e.message;
    }
    try {
      live = (await client.campaigns()).filter((e) => e.live);
    } catch (e) {
      dropsError = dropsError || e.message;
    }
    const loggedIn = priv.IS_LOGIN === 1;
    let status = "ok";
    if (!loggedIn) status = "not_logged_in";
    else if (dropsError) status = "drops_rejected";
    const check = {
      at: new Date().toISOString(),
      loggedIn,
      nick: priv.LOGIN_NICK || null,
      country: priv.COUNTRY_CODE || null,
      dropsOk: !dropsError,
      dropsError,
      missions: missions.length,
      liveCampaigns: live.length,
      liveTerm: live
        .filter((e) => e.giveCon === "term")
        .map((e) => ({ dropsIdx: e.dropsIdx, title: e.title })),
    };
    await SoopAccount.updateOne(
      { loginId: id },
      {
        $set: {
          status,
          lastError: dropsError || (loggedIn ? "" : "not logged in"),
          lastCheckedAt: new Date(),
          check,
        },
      },
    );
    return check;
  }

  async deleteAccount(id) {
    this.stop(id, { silent: true });
    this.clients.delete(id);
    await SoopAccount.deleteOne({ loginId: id });
  }

  // ---- campaigns ----------------------------------------------------------

  // The live-campaign list is account-independent, so every account shares one
  // cache. A dead session must not blind everyone: try farming accounts first,
  // then every stored one.
  async campaigns({ force = false } = {}) {
    if (
      !force &&
      Date.now() - this.camp.at < CAMP_TTL_MS &&
      this.camp.list.length
    ) {
      return this.camp.list;
    }
    const ids = [...new Set([...this.sessions.keys(), ...this.clients.keys()])];
    let pool = ids;
    if (!pool.length) {
      const rows = await SoopAccount.find({ sold: { $ne: true } })
        .select("loginId")
        .lean();
      pool = rows.map((r) => r.loginId);
    }
    if (!pool.length) throw new Error("no account available to scan campaigns");

    let lastErr;
    for (const id of pool) {
      try {
        const client = await this.ensureClient(id);
        const list = await client.campaignsAll();
        this.rememberCampaigns(list);
        this.camp = { at: Date.now(), list };
        return list;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  rememberCampaigns(list) {
    const ops = [];
    for (const e of list) {
      const key = String(e.dropsIdx);
      const prev = this.known.get(key);
      if (!prev || e.live || !prev.live) {
        const rec = { ...e, seenAt: new Date() };
        this.known.set(key, rec);
        ops.push({
          updateOne: {
            filter: { dropsIdx: key },
            update: {
              $set: {
                title: e.title || "",
                giveCon: e.giveCon || "",
                cateName: e.cateName || "",
                cateNo: String(e.cateNo || ""),
                live: !!e.live,
                filter: e.filter || "",
                startDate: e.startDate ? new Date(e.startDate) : null,
                endDate: e.endDate ? new Date(e.endDate) : null,
                broadIdList: e.broadIdList || [],
                itemList: e.itemList || [],
                seenAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }
    if (ops.length) {
      SoopCampaign.bulkWrite(ops, { ordered: false }).catch((err) => {
        console.error("[soop] campaign memory save failed:", err.message);
      });
    }
  }

  // A campaign can drop out of SOOP's list mid-broadcast, so keep the last record.
  async resolveCampaign(dropsIdx) {
    const mem = this.known.get(String(dropsIdx));
    if (mem) return mem;
    const doc = await SoopCampaign.findOne({
      dropsIdx: String(dropsIdx),
    }).lean();
    if (doc) this.known.set(String(dropsIdx), doc);
    return doc || null;
  }

  knownCampaigns() {
    return [...this.known.values()];
  }

  // ---- sessions -----------------------------------------------------------

  async startSession(
    id,
    { drops = "auto", target = "all", taskId = null } = {},
  ) {
    if (this.sessions.has(id)) return { ok: false, error: "already farming" };
    const s = {
      id,
      drops,
      target,
      taskId,
      status: "starting",
      minutes: 0,
      targetMinutes: null,
      channel: null,
      title: null,
      steps: null,
      startedAt: new Date().toISOString(),
      log: [],
      lastEventAt: null,
      errors: 0,
      health: {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      },
    };
    this.sessions.set(id, s);
    // The worker needs the client synchronously; make sure it is loaded (and
    // the cookie decrypts) before we hand it the session.
    try {
      await this.ensureClient(id);
    } catch (e) {
      this.sessions.delete(id);
      return { ok: false, error: "cookie: " + e.message };
    }
    const push = (o) => {
      s.log.push(o);
      if (s.log.length > LOG_CAP) s.log.shift();
      s.lastEventAt = o.t;
      if (o.k === "progress") {
        s.status = "farming";
        s.waitState = null;
        s.minutes = o.minutes;
        s.targetMinutes = o.target;
        s.channel = o.channel;
        s.title = o.title;
      } else if (o.k === "campaign") {
        s.title = o.title;
        s.waitState = null;
        s.targetMinutes = o.target;
        s.steps = o.steps;
        s.status = "picking channel";
      } else if (o.k === "status") {
        s.status = o.msg;
      } else if (o.k === "waiting") {
        s.status = o.msg;
        s.waitState = o.state;
        s.title = o.title;
        s.channel = null;
      } else if (o.k === "error") {
        s.errors++;
        s.status = "error: " + o.msg;
      } else if (o.k === "done") {
        s.status = o.reason === "target" ? "done" : o.reason;
        s.minutes = o.minutes ?? s.minutes;
      }
      if (o.k === "done") {
        this.sessions.delete(id);
        this.maybeFinishTask(taskId);
      }
    };
    runSession({
      id,
      getClient: () => this.clientFor(id),
      drops,
      target,
      campaigns: () => this.campaigns(),
      resolveCampaign: (d) => this.resolveCampaign(d),
      onEvent: push,
      health: s.health,
    })
      .catch((e) =>
        push({ id, t: new Date().toISOString(), k: "error", msg: e.message }),
      )
      .finally(() => {
        if (this.sessions.get(id) === s) {
          s.status =
            s.status === "done"
              ? "done"
              : s.health.stopped
                ? "stopped"
                : s.status;
          this.sessions.delete(id);
          this.maybeFinishTask(taskId);
        }
      });
    return { ok: true, id };
  }

  stop(id, { silent = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.status = "stopping";
    s.health.stop();
    this.sessions.delete(id);
    if (!silent) this.maybeFinishTask(s.taskId);
    return true;
  }

  stopAll() {
    return [...this.sessions.keys()].map((id) => this.stop(id));
  }

  // ---- bots ---------------------------------------------------------------

  async startTask({
    dropsIdx,
    ids,
    target = "all",
    label = null,
    targetMinutes = null,
  }) {
    const list = [...new Set(ids || [])];
    if (!dropsIdx) return { ok: false, error: "no campaign chosen" };
    if (!list.length) return { ok: false, error: "no accounts ticked" };
    const existing = await SoopAccount.find({ loginId: { $in: list } })
      .select("loginId")
      .lean();
    const known = new Set(existing.map((a) => a.loginId));
    const wanted = list.filter((id) => known.has(id));
    if (!wanted.length)
      return { ok: false, error: "none of those accounts exist" };

    const doc = await SoopFarmTask.create({
      dropsIdx: String(dropsIdx),
      label: label || String(dropsIdx),
      target,
      targetMinutes: targetMinutes ?? null,
      accountIds: wanted,
      active: true,
      startedAt: new Date(),
    });
    const taskId = String(doc._id);
    const started = [];
    for (const id of wanted) {
      const r = await this.startSession(id, {
        drops: String(dropsIdx),
        target,
        taskId,
      });
      if (r.ok) {
        started.push(id);
      }
    }
    if (!started.length) {
      await SoopFarmTask.updateOne(
        { _id: doc._id },
        { $set: { active: false, endedAt: new Date() } },
      );
      return { ok: false, error: "no accounts could start (already farming?)" };
    }
    this.tasks.set(taskId, {
      taskId,
      dropsIdx: String(dropsIdx),
      label: label || String(dropsIdx),
      target,
      targetMinutes,
      ids: started,
      startedAt: doc.startedAt,
    });
    return { ok: true, taskId, accounts: started, targetMinutes };
  }

  async stopTask(taskId) {
    const t = this.tasks.get(taskId);
    if (t) {
      for (const id of t.ids) this.stop(id, { silent: true });
      this.tasks.delete(taskId);
    }
    const r = await SoopFarmTask.updateOne(
      { _id: taskId },
      { $set: { active: false, endedAt: new Date() } },
    );
    return !!t || r.matchedCount > 0;
  }

  async stopAllTasks() {
    const ids = [...this.tasks.keys()];
    for (const id of ids) await this.stopTask(id);
    return ids;
  }

  // Retire a bot once none of its accounts are still running.
  maybeFinishTask(taskId) {
    if (!taskId) return;
    const t = this.tasks.get(taskId);
    if (!t) return;
    const stillRunning = t.ids.some((id) => this.sessions.has(id));
    if (stillRunning) return;
    this.tasks.delete(taskId);
    SoopFarmTask.updateOne(
      { _id: taskId },
      { $set: { active: false, endedAt: new Date() } },
    ).catch((err) => console.error("[soop] task retire failed:", err.message));
  }

  // ---- views --------------------------------------------------------------

  sessionsView() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      taskId: s.taskId,
      status: s.status,
      waitState: s.waitState || null,
      minutes: s.minutes,
      targetMinutes: s.targetMinutes,
      channel: s.channel,
      title: s.title,
      steps: s.steps,
      startedAt: s.startedAt,
      errors: s.errors,
      drops: s.drops,
      target: s.target,
      log: s.log.slice(-6),
    }));
  }

  tasksView() {
    const byId = new Map(this.sessionsView().map((s) => [s.id, s]));
    return [...this.tasks.values()].map((t) => ({
      taskId: t.taskId,
      dropsIdx: t.dropsIdx,
      label: t.label,
      target: t.target,
      startedAt: t.startedAt,
      targetMinutes: t.targetMinutes,
      accounts: t.ids.map(
        (id) =>
          byId.get(id) || {
            id,
            status: "finished",
            minutes: 0,
            targetMinutes: null,
          },
      ),
    }));
  }

  snapshot() {
    const m = process.memoryUsage();
    const n = this.sessions.size;
    return {
      rssMB: +(m.rss / 1048576).toFixed(1),
      heapMB: +(m.heapUsed / 1048576).toFixed(1),
      baselineMB: +(this.baselineRss / 1048576).toFixed(1),
      peakMB: +(this.peakRss / 1048576).toFixed(1),
      perAccountMB: n
        ? +(Math.max(0, this.peakRss - this.baselineRss) / n / 1048576).toFixed(
            1,
          )
        : null,
      cpuPct: this.samples.length
        ? this.samples[this.samples.length - 1].cpu
        : 0,
      sessions: n,
      sockets: n,
      totalMemMB: +(os.totalmem() / 1048576).toFixed(0),
      freeMemMB: +(os.freemem() / 1048576).toFixed(0),
      samples: this.samples.map((s) => ({
        t: s.t,
        rssMB: +(s.rss / 1048576).toFixed(1),
        cpu: s.cpu,
      })),
    };
  }

  // Campaign rows for the panel: listed events plus remembered-but-delisted ones.
  async campaignRows() {
    const all = await this.campaigns();
    const listed = new Set(all.map((e) => String(e.dropsIdx)));
    const remembered = this.knownCampaigns()
      .filter((e) => !listed.has(String(e.dropsIdx)) && e.giveCon === "term")
      .map((e) => ({
        dropsIdx: e.dropsIdx,
        title: e.title,
        giveCon: e.giveCon,
        cateName: e.cateName,
        categoryWide: !(e.broadIdList || []).length,
        live: false,
        filter: "unlisted",
        unlisted: true,
        startsAt:
          e.endDate && e.endDate < new Date().toISOString()
            ? null
            : e.startDate,
        endsAt: e.endDate || null,
        onAir: (e.broadIdList || [])
          .filter((b) => b.onAir)
          .map((b) => b.userId),
        steps: stepsOf(e),
      }));
    const rows = all
      .map((e) => ({
        dropsIdx: e.dropsIdx,
        title: e.title,
        giveCon: e.giveCon,
        cateName: e.cateName,
        categoryWide: !(e.broadIdList || []).length,
        live: !!e.live,
        filter: e.filter || null,
        startsAt: e.startDate || null,
        endsAt: e.endDate || null,
        onAir: (e.broadIdList || [])
          .filter((b) => b.onAir)
          .map((b) => b.userId),
        steps: stepsOf(e),
      }))
      .concat(remembered);
    // live first, then farmable, then soonest start
    rows.sort(
      (a, b) =>
        b.live - a.live ||
        (b.giveCon === "term") - (a.giveCon === "term") ||
        String(a.startsAt).localeCompare(String(b.startsAt)),
    );
    return rows;
  }
}

module.exports = new SoopFarm();
