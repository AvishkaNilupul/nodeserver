// Discord admin intake and operator-assisted reward claims.
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const { createHash } = require("crypto");
const { requireSuperadmin } = require("../middleware/auth");
const { decrypt } = require("../utils/secretBox");
const DiscordTestAccount = require("../models/DiscordTestAccount");
const DiscordRewardCode = require("../models/DiscordRewardCode");
const { createRewardReader, canClaim, codeReward } = require("../utils/discordFarm/questRewards");
const http = require("../utils/discordFarm/discordHttp");
const farmer = require("../utils/discordFarm/discordQuestFarmer");
const { probeAccount } = require("../utils/discordFarm/discordAccountProbe");

function sessionForAccount(acc, claim = false) {
  const { RES_HOST, RES_PORT, RES_USER, RES_PASS } = process.env;
  const proxy = RES_HOST && RES_PORT ? {
    host: RES_HOST, port: Number(RES_PORT),
    user: (RES_USER || "") + "-session-dc" + String(acc.userId).slice(-10),
    pass: RES_PASS || "", type: "http",
  } : null;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
  const locale = acc.probes?.[acc.probes.length - 1]?.identity?.locale || "en-US";
  return {
    token: decrypt(acc.credentials?.token), host: null,
    proxy: claim && process.env.DISCORD_FARM_NO_PROXY_FOR_CLAIM !== "0" ? null : proxy,
    fingerprint: { ua, xsp: http.buildSuperProperties({ userAgent: ua, locale }), locale, timezone: "Asia/Tokyo" },
  };
}

function routingHash(session) {
  return createHash("sha256").update(JSON.stringify([session.proxy, session.token, session.fingerprint])).digest("hex");
}

function summary(a) {
  return {
    _id: String(a._id), userId: a.userId, email: a.credentials?.email,
    username: a.probes?.[a.probes.length - 1]?.identity?.username,
    state: a.state, role: a.role, seller: a.purchasedFrom?.seller,
    pricePaidUSD: a.pricePaidUSD, totals: a.totals || {}, createdAt: a.createdAt,
    questLog: a.questLog || [],
  };
}

function createRouter(deps = {}) {
  const Model = deps.Model || DiscordTestAccount;
  const Code = deps.Code || DiscordRewardCode;
  const request = deps.request || http.discordRequest;
  const reader = createRewardReader(request);
  const catalog = deps.catalog || (deps.list ? deps.list : reader.catalog);
  const getRewardCode = deps.rewardCode || reader.rewardCode;
  const list = deps.list || farmer.listLiveQuests;
  const probe = deps.probe || probeAccount;
  const enroll = deps.enroll || farmer.enrollQuest;
  const complete = deps.complete || farmer.completeTask;
  const router = express.Router();
  const active = new Set();
  // Challenge state stays with the authenticated browser session. Never accept
  // client-supplied traffic metadata or allow a solve to cross account/quest.
  const challengeTtl = 5 * 60 * 1000;
  router.use("/admin/discord-farm", requireSuperadmin, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.param("accountId", (req, res, next, id) => {
    if (!mongoose.isObjectIdOrHexString(id)) return res.status(400).json({ error: "invalid account id" });
    next();
  });
  router.param("questId", (req, res, next, id) => {
    if (!/^\d{1,25}$/.test(id)) return res.status(400).json({ error: "invalid quest id" });
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch { res.status(502).json({ error: "Discord operation failed; refresh and retry" }); }
  };
  const accountAction = (fn) => wrap(async (req, res) => {
    const id = req.params.accountId;
    if (active.has(id)) return res.status(409).json({ error: "account operation already running" });
    active.add(id);
    try {
      const acc = await Model.findById(id);
      if (!acc) return res.status(404).json({ error: "account not found" });
      if (!decrypt(acc.credentials?.token)) return res.status(409).json({ error: "re-import the account token" });
      await fn(req, res, acc);
    } finally { active.delete(id); }
  });
  const saveClaim = async (acc, q, data) => {
    const claimedAt = data?.claimed_at || q.userStatus?.claimed_at;
    if (!claimedAt || !Number.isFinite(Date.parse(claimedAt))) throw new Error("Claim has not been confirmed");
    acc.recordQuestResult({
      questId: q.id, questName: q.name, rewardName: q.rewards?.[0]?.messages?.name,
      rewardType: q.rewards?.[0]?.type,
      completedAt: data?.completed_at || q.userStatus?.completed_at,
      claimedAt,
      orbsClaimed: data?.orb_quantity_claimed ?? q.userStatus?.orb_quantity_claimed,
      ok: true, finishedAt: new Date(),
    });
    await acc.save();
  };
  const collectCode = async (acc, q, session) => {
    if (!q.userStatus?.claimed_at || !codeReward(q)) return null;
    const value = await getRewardCode(session, q.id);
    if (value.user_id !== acc.userId || value.quest_id !== q.id) throw new Error("Reward code identity mismatch");
    const reward = codeReward(q, value.tier);
    if (!reward) throw new Error("Reward tier does not issue a code");
    const fields = DiscordRewardCode.codeFields(value.code);
    // $setOnInsert preserves the first issued key and its provenance. Unique
    // indexes also prevent a key from becoming two stock units across accounts.
    await Code.updateOne({ accountId: acc._id, questId: q.id, platform: value.platform, codeHash: fields.codeHash }, {
      $setOnInsert: { ...fields, accountId: acc._id, userId: acc.userId, questId: q.id,
        platform: value.platform, questName: q.name, game: q.game, rewardName: reward.messages?.name,
        claimedAt: value.claimed_at, retrievedAt: new Date(), expiresAt: reward.expires_at || null,
        redemptionUrl: reward.redemption_link || null },
    }, { upsert: true, runValidators: true });
    return { questId: q.id, stored: true };
  };
  const finishClaim = async (acc, q, data, session) => {
    // A 200 may contain partial entitlement errors. Confirm claimed_at rather
    // than inventing a successful timestamp. A later sync recovers a claim
    // accepted by Discord even if this process stopped before persistence.
    let confirmed = { ...q, userStatus: { ...q.userStatus, ...data } };
    if (!confirmed.userStatus?.claimed_at) {
      confirmed = (await catalog(session, { history: true })).find((x) => x.id === q.id);
    }
    if (!confirmed?.userStatus?.claimed_at) throw new Error("Claim has not been confirmed");
    await saveClaim(acc, confirmed, confirmed.userStatus);
    try {
      return { codeStored: Boolean(await collectCode(acc, confirmed, session)) };
    } catch {
      return { codeStored: false, codeError: "Reward claimed; code collection failed. Use Sync rewards to retry." };
    }
  };
  const claimRequest = (session, questId, metadata, captcha) => request(session.host, {
    method: "POST", path: "/api/v9/quests/" + questId + "/claim-reward",
    headers: { ...farmer.discordHeaders(session), ...(captcha ? {
      "X-Captcha-Key": captcha.key,
      ...(captcha.rqtoken ? { "X-Captcha-Rqtoken": captcha.rqtoken } : {}),
      ...(captcha.sessionId ? { "X-Captcha-Session-Id": captcha.sessionId } : {}),
    } : {}) },
    body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: metadata || null },
    proxy: session.proxy,
  });

  router.get("/admin/discord-farm", (req, res) => {
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://*.hcaptcha.com https://hcaptcha.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com https://hcaptcha.com; img-src 'self' data: https:; connect-src 'self' https://*.hcaptcha.com https://hcaptcha.com; frame-src https://*.hcaptcha.com https://hcaptcha.com; object-src 'none'; base-uri 'self'; form-action 'self'");
    res.sendFile(path.join(__dirname, "..", "public", "discord-farm.html"));
  });
  router.get("/admin/discord-farm/accounts", wrap(async (req, res) => {
    const accounts = await Model.find({}).lean();
    res.json({ accounts: accounts.map(summary) });
  }));
  router.get("/admin/discord-farm/codes", wrap(async (req, res) => {
    const codes = await Code.find({}).sort({ claimedAt: -1 }).lean();
    res.json({ codes: codes.map((c) => ({ _id: String(c._id), accountId: String(c.accountId),
      questId: c.questId, questName: c.questName, game: c.game, rewardName: c.rewardName,
      platform: c.platform, claimedAt: c.claimedAt, retrievedAt: c.retrievedAt,
      expiresAt: c.expiresAt, redemptionUrl: c.redemptionUrl })) });
  }));
  router.get("/admin/discord-farm/codes/:codeId", wrap(async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.codeId)) return res.status(400).json({ error: "invalid code id" });
    const code = await Code.findById(req.params.codeId).select("+code").lean();
    if (!code) return res.status(404).json({ error: "code not found" });
    const plain = decrypt(code.code);
    if (!plain) return res.status(409).json({ error: "code could not be decrypted" });
    res.json({ code: plain });
  }));
  router.post("/admin/discord-farm/ingest", wrap(async (req, res) => {
    const body = req.body || {};
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const parts = token.split(".");
    const userId = Buffer.from(parts[0] || "", "base64").toString("utf8");
    if (parts.length !== 3 || !/^\d{15,25}$/.test(userId) || !parts.every((p) => /^[\w-]+$/.test(p))) {
      return res.status(400).json({ error: "valid Discord session token is required" });
    }
    const price = body.pricePaidUSD;
    if (price != null && price !== "" && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
      return res.status(400).json({ error: "price must be a non-negative number" });
    }
    for (const field of ["email", "password", "inboxUrl", "seller", "marketplace", "offerId", "offerUrl"]) {
      if (body[field] != null && (typeof body[field] !== "string" || body[field].length > 2048)) {
        return res.status(400).json({ error: "invalid " + field });
      }
    }
    const key = "ingest:" + userId;
    if (active.has(key)) return res.status(409).json({ error: "account intake already running" });
    active.add(key);
    try {
      const doc = await Model.findOne({ userId }) || new Model({ userId });
      // Validate before replacing a working stored credential.
      const result = await probe(sessionForAccount({ userId, credentials: { token }, probes: [] }));
      if (result.identity?.id !== userId) return res.status(400).json({ error: "token identity could not be verified" });
      for (const field of ["email", "password", "inboxUrl"]) {
        if (body[field]) doc.set("credentials." + field, body[field]);
      }
      doc.set("credentials.token", token);
      doc.set("credentials.tokenAcquiredAt", new Date());
      for (const field of ["seller", "marketplace", "offerId", "offerUrl"]) {
        if (body[field]) doc.set("purchasedFrom." + field, body[field]);
      }
      if (price != null && price !== "") doc.pricePaidUSD = Number(price);
      doc.applyProbe(result);
      await doc.save();
      res.json({ ok: true, accountId: String(doc._id), userId, state: doc.state });
    } finally { active.delete(key); }
  }));
  router.post("/admin/discord-farm/probe/:accountId", accountAction(async (req, res, acc) => {
    acc.applyProbe(await probe(sessionForAccount(acc)));
    await acc.save();
    res.json({ ok: true, account: summary(acc) });
  }));
  router.post("/admin/discord-farm/sync/:accountId", accountAction(async (req, res, acc) => {
    const session = sessionForAccount(acc, true), stored = [], errors = [];
    const quests = await catalog(session, { history: true });
    for (const q of quests) {
      if (!q.userStatus?.claimed_at) continue;
      const existing = acc.questLog.find((entry) => entry.questId === q.id);
      if (!existing?.claimedAt) await saveClaim(acc, q, q.userStatus);
      if (!codeReward(q)) continue;
      try { stored.push(await collectCode(acc, q, session)); }
      catch { errors.push({ questId: q.id, error: "code collection failed; retry Sync rewards" }); }
    }
    res.json({ ok: true, stored, errors });
  }));
  router.get("/admin/discord-farm/queue", wrap(async (req, res) => {
    const accounts = await Model.find({ "credentials.token": { $exists: true, $ne: "" }, role: { $ne: "retired" } }).lean();
    const queue = [], errors = [];
    for (const acc of accounts) {
      try {
        const quests = await catalog(sessionForAccount(acc, true));
        for (const q of quests) {
          if (!canClaim(q)) continue;
          queue.push({ accountId: String(acc._id), accountLabel: summary(acc).username || acc.credentials?.email || acc.userId,
            questId: q.id, questName: q.name, reward: q.rewards?.[0]?.messages?.name,
            rewardType: q.rewards?.[0]?.type, expiresAt: q.expiresAt, claimExpiresAt: q.claimExpiresAt });
        }
      } catch { errors.push({ accountId: String(acc._id), error: "quest lookup failed" }); }
    }
    res.json({ queue, errors });
  }));
  router.post("/admin/discord-farm/complete-pending/:accountId", accountAction(async (req, res, acc) => {
    const session = sessionForAccount(acc), done = [], errors = [];
    for (const q of await list(session)) {
      const tasks = q.taskConfig?.tasks || {};
      if (Object.keys(tasks).length && !tasks.WATCH_VIDEO && !tasks.WATCH_VIDEO_ON_MOBILE) continue;
      if (q.userStatus?.completed_at) continue;
      try {
        await enroll(session, q.id);
        const updated = (await list(session)).find((x) => x.id === q.id);
        if (!updated) throw new Error("quest disappeared after enrollment");
        const available = updated.taskConfig?.tasks || {};
        if (!available.WATCH_VIDEO && !available.WATCH_VIDEO_ON_MOBILE) continue;
        // Restrict dispatch to the video variant even for mixed task configs.
        const videoTasks = Object.fromEntries(Object.entries(available).filter(([key]) => key === "WATCH_VIDEO" || key === "WATCH_VIDEO_ON_MOBILE"));
        const result = await complete(session, q.id, { ...updated.taskConfig, tasks: videoTasks });
        done.push({ questId: q.id, status: result?.completed_at ? "completed" : "pending" });
      } catch { errors.push({ questId: q.id, error: "quest completion failed" }); }
    }
    res.json({ ok: true, completed: done, errors });
  }));
  router.post("/admin/discord-farm/trigger-captcha/:accountId/:questId", accountAction(async (req, res, acc) => {
    delete req.session.discordClaim;
    const session = sessionForAccount(acc, true);
    const q = (await catalog(session)).find((x) => x.id === req.params.questId);
    if (!q) return res.status(404).json({ error: "quest not visible on claim connection" });
    if (q.userStatus?.claimed_at) {
      const result = await finishClaim(acc, q, q.userStatus, session);
      return res.json({ ok: true, alreadyClaimed: true, ...result });
    }
    if (!q.userStatus?.completed_at) return res.status(409).json({ error: "quest is not complete" });
    if (!canClaim(q)) return res.status(409).json({ error: "quest claim period has ended" });
    const metadata = q.userStatus.traffic_metadata_sealed;
    const r = await claimRequest(session, q.id, metadata);
    if (r.status === 200) {
      const result = await finishClaim(acc, q, r.data, session);
      return res.json({ ok: true, alreadyClaimed: true, ...result });
    }
    if (r.status !== 400 || !r.data?.captcha_sitekey) return res.status(502).json({ error: "Discord did not return a claim challenge", httpStatus: r.status });
    req.session.discordClaim = { accountId: String(acc._id), quest: q, metadata,
      rqtoken: r.data.captcha_rqtoken, sessionId: r.data.captcha_session_id, at: Date.now(), routingHash: routingHash(session) };
    res.json({ ok: true, sitekey: r.data.captcha_sitekey, rqdata: r.data.captcha_rqdata });
  }));
  router.post("/admin/discord-farm/claim/:accountId/:questId", accountAction(async (req, res, acc) => {
    const c = req.session.discordClaim;
    if (!c || c.accountId !== String(acc._id) || c.quest.id !== req.params.questId || Date.now() - c.at > challengeTtl) {
      return res.status(409).json({ error: "challenge missing or expired; reopen Claim" });
    }
    const key = req.body?.captchaKey;
    if (typeof key !== "string" || !key.trim() || key.length > 32000) return res.status(400).json({ error: "captchaKey is required" });
    delete req.session.discordClaim; // single use, including rejected tokens
    const session = sessionForAccount(acc, true);
    if (routingHash(session) !== c.routingHash) return res.status(409).json({ error: "claim connection changed; reopen Claim" });
    const r = await claimRequest(session, c.quest.id, c.metadata, { key, rqtoken: c.rqtoken, sessionId: c.sessionId });
    if (r.status !== 200) return res.status(502).json({ error: "Discord rejected the claim; reopen Claim for a fresh challenge", httpStatus: r.status });
    const result = await finishClaim(acc, c.quest, r.data, session);
    res.json({ ok: true, ...result });
  }));
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
