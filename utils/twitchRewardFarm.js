const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Bot = require("../models/TwitchRewardFarmBot");
const Pool = require("../models/AvailableAccount");
const Roster = require("../models/TwitchRewardAccount");
const Receipt = require("../models/TwitchRewardReceipt");
const hosts = require("./botHosts");
const { withFileLock } = require("./fileLock");
const { encrypt } = require("./secretBox");
const { recordPoolUsage } = require("./poolUsageLog");
const { GTA_ID, GTA_GIVEAWAY } = require("./twitchRewardCampaigns");
const BASE = "/home/ubuntu/twitch-reward-farm";
const IMAGE = "twitch-reward-farm:20261120";
const HOST = "contabo2";
const END = Date.parse("2026-12-01T07:59:59.999Z");
const paths = (id) => {
  if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error("Invalid reward bot ID.");
  return { dir: BASE + "/" + id, container: "twitch-reward-" + id };
};
function host() {
  const h = hosts.resolveHost(HOST);
  if (!h) throw new Error("Reward farm host is unavailable.");
  return h;
}
function workerConfig(account) {
  return { TwitchSettings: {
    TwitchUsers: [{ Login: account.username, Id: String(account.twitchId), ClientSecret: account.clientSecret,
      Enabled: true, FavouriteGames: ["Grand Theft Auto VI"] }],
    OnlyFavouriteGames: true, OnlyConnectedAccounts: false, ClaimDrops: false,
    RewardCampaignsOnly: true, CollectRewardCodes: true,
    RewardCodeDirectory: "/app/Configuration/reward-codes", RewardCodeKeyFile: "/app/Configuration/reward-code.key",
    RewardCampaignTargets: [{ CampaignId: GTA_ID, GameId: "1867279146", GameName: "Grand Theft Auto VI",
      GameSlug: "grand-theft-auto-vi", SessionMinutes: 10,
      WindowStart: "2026-11-18T11:00:00Z", WindowEnd: "2026-12-01T07:59:59.999Z" }],
  }, FavouriteGames: ["Grand Theft Auto VI"], WaitingSeconds: 60, AttemptToWatch: 1, WatchBrowserHeadless: true,
    WebhookURL: "", LogLevel: 0 };
}
function claimQuery(excludedTokens, reserveFilter, ledger = { logins: [], poolIds: [] }) {
  return { $and: [{ status: "available", manualSold: { $ne: true }, lastCheckStatus: "ok",
    clientSecret: { $gt: "", $nin: excludedTokens }, twitchId: { $regex: "^[0-9]+$" },
    dropCount: { $not: { $gt: 0 } }, unclaimedDropCount: { $not: { $gt: 0 } },
    "soldGames.0": { $exists: false }, usernameLower: { $nin: ledger.logins },
    _id: { $nin: ledger.poolIds } }, reserveFilter] };
}
async function create(adminId) {
  if (Date.now() >= END) throw new Error("The GTA VI viewing window has ended.");
  return withFileLock("twitch-rewards", "create", async () => {
    if (await Bot.countDocuments({}) >= 5) throw new Error("This section currently supports five dedicated bots.");
    const h = host();
    await hosts.runShell(h, "docker image inspect " + hosts.shq(IMAGE) + " >/dev/null", { timeout: 15000 });
    const fence = require("./fleetIntegrity");
    const a = await fence.claimFence("managed"), b = await fence.claimFence("noclaim");
    const guard = require("./pristineReserve");
    const id = new mongoose.Types.ObjectId();
    const note = "twitch-reward-farm:" + id;
    const ledger = await require("./noclaimFleet").committedLedgers();
    const account = await Pool.findOneAndUpdate(claimQuery([...new Set([...a.exclude, ...b.exclude])], await guard.farmClaimFilter(), ledger),
      { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
      { returnDocument: "after", sort: { lastCheckAt: -1 }, lean: true });
    if (!account) throw new Error("No unused verified account is available above the pool reserve.");
    guard.noteClaimed(account);
    const p = paths(id);
    try {
      const verified = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: "OAuth " + account.clientSecret }, signal: AbortSignal.timeout(15000) });
      const identity = verified.ok && await verified.json();
      if (!identity || String(identity.user_id) !== String(account.twitchId) ||
          String(identity.login).toLowerCase() !== account.username.toLowerCase()) throw new Error("Account identity mismatch.");
      await Bot.create({ _id: id, adminId, poolAccountId: account._id, viewer: account.username.toLowerCase(),
        twitchId: String(account.twitchId), desired: "stopped" });
      await recordPoolUsage(account._id, { event: "claimed", actor: "twitch-reward-farm", game: "Grand Theft Auto VI", note });
      const config = JSON.stringify(workerConfig(account));
      const script = hosts.guardedWriteScript(p.dir + "/Configuration/config.json", Buffer.byteLength(config),
        { mode: "600", mkdirs: [p.dir + "/Configuration", p.dir + "/logs"] });
      await hosts.runShell(h, script, { input: config, timeout: 25000 });
      await hosts.runShell(h, "docker create --name " + hosts.shq(p.container) +
        " --restart unless-stopped --user 0:0 --memory 768m --cpus 1 -e INSIDE_DOCKER=true -v " +
        hosts.shq(p.dir + "/Configuration") + ":/app/Configuration -v " + hosts.shq(p.dir + "/logs") +
        ":/app/logs " + hosts.shq(IMAGE) + " >/dev/null", { timeout: 25000 });
      await Roster.updateOne({ adminId, viewer: account.username.toLowerCase() },
        { $setOnInsert: { adminId, viewer: account.username.toLowerCase() } }, { upsert: true });
      await Bot.updateOne({ _id: id }, { $set: { state: "stopped" } });
      return String(id);
    } catch (error) {
      // Never return a login to the pool if its container might exist.
      let absent = false;
      try {
        const r = await hosts.runShell(h, "if docker container inspect " + hosts.shq(p.container) +
          " >/dev/null 2>&1; then echo PRESENT; else docker info >/dev/null 2>&1 && echo ABSENT; fi", { timeout: 15000 });
        absent = r.stdout.trim() === "ABSENT";
      } catch { /* keep the reservation */ }
      if (absent) await Pool.updateOne({ _id: account._id, status: "claimed", claimedNote: note },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } });
      await Bot.updateOne({ _id: id }, { $set: { state: "error", error: absent ? "Provisioning failed; account returned." : "Provisioning failed; account remains reserved." } });
      throw new Error("Reward bot provisioning failed. Check this section's status before retrying.");
    }
  });
}
async function action(adminId, id, verb) {
  return withFileLock("twitch-rewards", "bot-" + id, async () => {
    const bot = await Bot.findOne({ _id: id, adminId }).lean();
    if (!bot) throw new Error("Reward bot not found.");
    const p = paths(id);
    if (!["start", "stop"].includes(verb)) throw new Error("Unknown bot action.");
    if (verb === "start") {
      if (Date.now() >= END) throw new Error("The viewing window has ended.");
      if (!await Pool.exists({ _id: bot.poolAccountId, status: "claimed", claimedNote: "twitch-reward-farm:" + id }))
        throw new Error("This bot's account reservation needs review.");
    }
    await hosts.runShell(host(), "docker " + verb + " " + hosts.shq(p.container) + " >/dev/null", { timeout: 30000 });
    await Bot.updateOne({ _id: id, adminId }, { $set: { desired: verb === "start" ? "running" : "stopped",
      state: verb === "start" ? "starting" : "stopped", error: "", ...(verb === "start" ? { startedAt: new Date() } : {}) } });
  });
}
function parseActivity(lines) {
  const accepted = String(lines).split("\n").map(s => s.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter(s => /Watching reward campaign |Reward watch active;|Reward watch progress reported by Twitch:|Saved an encrypted issued-code receipt|Could not collect code reward/.test(s));
  const progress = [...accepted].reverse().find(s => s.includes("Reward watch progress reported by Twitch:"));
  const counters = progress && progress.match(/Twitch: (\d+)\/(\d+) minutes/);
  return { activity: (accepted.at(-1) || "Waiting for a reward watch report.").slice(0, 350),
    currentMinutes: counters ? Number(counters[1]) : null, requiredMinutes: counters ? Number(counters[2]) : null };
}
async function importCode(bot, receipt) {
  if (String(receipt.AccountId) !== bot.twitchId || String(receipt.Login).toLowerCase() !== bot.viewer)
    throw new Error("Code receipt account mismatch.");
  if (receipt.CampaignId !== GTA_ID &&
      !/(?:gta\s*(?:vi|6)|grand\s*theft\s*auto\s*(?:vi|6))/i.test(String(receipt.CampaignName || "") + " " + String(receipt.RewardName || "")))
    throw new Error("Code receipt belongs to another campaign.");
  if (!/^[\x21-\x7e][\x20-\x7e]{2,158}[\x21-\x7e]$/.test(receipt.Code || "")) throw new Error("Invalid code receipt.");
  const key = { adminId: bot.adminId, viewer: bot.viewer, campaignId: GTA_GIVEAWAY.id, reward: GTA_GIVEAWAY.name };
  const fingerprint = crypto.createHmac("sha256", process.env.CRED_SECRET || process.env.SESSION_SECRET)
    .update("twitch-reward-code\0" + receipt.Code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");
  if (await Receipt.exists({ ...key, codeFingerprint: fingerprint })) return;
  try {
    await Receipt.updateOne({ ...key, codeSavedAt: { $exists: false } }, { $setOnInsert: { ...key,
      campaignName: "GTA VI Ultimate Edition giveaway" }, $set: { codeCipher: encrypt(receipt.Code),
      codeFingerprint: fingerprint, codeSavedAt: new Date(), codeVersion: crypto.randomUUID(), platform: "", region: "" } }, { upsert: true });
  } catch (e) {
    if (e.code !== 11000 || !await Receipt.exists({ ...key, codeFingerprint: fingerprint }))
      throw new Error("Code receipt conflicts with an existing saved code.");
  }
}
let running = false, timer;
async function runOnce() {
  if (running || mongoose.connection.readyState !== 1) return;
  running = true;
  try {
    const bots = await Bot.find({}).limit(10).lean();
    for (const bot of bots) {
      const p = paths(bot._id);
      try {
        if (Date.now() >= END && bot.desired === "running") { await action(bot.adminId, String(bot._id), "stop"); continue; }
        const inspected = await hosts.runShell(host(), "docker inspect --format '{{.State.Running}}' " + hosts.shq(p.container), { timeout: 15000 });
        const live = inspected.stdout.trim() === "true";
        const logs = live ? await hosts.dockerLogs(host(), p.container, { tail: 100, since: "3m" }) : "";
        const activity = parseActivity(typeof logs === "string" ? logs : logs.stdout || "");
        await Bot.updateOne({ _id: bot._id }, { $set: { state: live ? "running" : "stopped", ...activity,
          checkedAt: new Date(), error: "" } });
        // stdout is an internal SSH transport, never an HTTP response or log.
        if (live) {
          const exported = await hosts.runShell(host(), "docker exec -e TWITCH_REWARD_CODE_KEY_FILE=/app/Configuration/reward-code.key " +
            hosts.shq(p.container) + " dotnet TwitchDropsBot.Console.dll reward-codes export /app/Configuration/reward-codes", { timeout: 20000 });
          const rows = JSON.parse(exported.stdout);
          if (!Array.isArray(rows) || rows.length > 50) throw new Error("Invalid receipt export.");
          for (const receipt of rows) await importCode(bot, receipt);
        }
      } catch {
        await Bot.updateOne({ _id: bot._id }, { $set: { checkedAt: new Date(), error: "Worker check or code sync failed; account remains reserved." } });
      }
    }
  } finally { running = false; }
}
function start() {
  if (timer) return;
  timer = setInterval(() => runOnce().catch(() => {}), 60000); timer.unref();
}
async function status(adminId) {
  const bots = await Bot.find({ adminId }, { poolAccountId: 0, __v: 0 }).sort({ createdAt: -1 }).lean();
  return { bots, campaign: "GTA VI", endsAt: new Date(END), maxBots: 5 };
}
module.exports = { create, action, start, runOnce, status, workerConfig, claimQuery, parseActivity, importCode, IMAGE, BASE, HOST };
