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
    TwitchUsers: (Array.isArray(account) ? account : [account]).map(a => ({ Login: a.username, Id: String(a.twitchId), ClientSecret: a.clientSecret,
      Enabled: true, FavouriteGames: ["Grand Theft Auto VI"] })),
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
    unclaimedDropCount: { $not: { $gt: 0 } },
    "soldGames.0": { $exists: false }, usernameLower: { $nin: ledger.logins },
    _id: { $nin: ledger.poolIds } }, reserveFilter] };
}
const MAX_BOTS = 10, MAX_ACCOUNTS = 101, MAX_PER_BOT = 20;
const rejectedIds = new Set();
function members(bot) {
  return bot.accounts?.length ? bot.accounts : [{ poolAccountId: bot.poolAccountId,
    viewer: bot.viewer, twitchId: bot.twitchId, currentMinutes: bot.currentMinutes,
    requiredMinutes: bot.requiredMinutes }];
}
function checkCapacity(data) {
  if (!Number.isFinite(data.availableMb) || !Number.isFinite(data.load) || !Number.isFinite(data.cpus))
    throw new Error("Cannot verify reward host capacity.");
  if (data.availableMb < 7168 || data.load > data.cpus * 1.5)
    throw new Error("Reward host needs more free capacity before another bot can start.");
}
async function assertCapacity() {
  const r = await hosts.runShell(host(), `# reward-capacity
python3 - <<'PY'
import json,os
m={a.split(':')[0]:int(a.split()[1]) for a in open('/proc/meminfo') if a.startswith(('MemAvailable:','MemTotal:'))}
print(json.dumps({'availableMb':m['MemAvailable']/1024,'load':os.getloadavg()[0],'cpus':os.cpu_count()}))
PY`, { timeout: 15000 });
  checkCapacity(JSON.parse(r.stdout));
}
async function validateAccount(account) {
  const verified = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: "OAuth " + account.clientSecret }, signal: AbortSignal.timeout(15000) });
  const identity = verified.ok && await verified.json();
  if (!identity || String(identity.user_id) !== String(account.twitchId) ||
      String(identity.login).toLowerCase() !== account.username.toLowerCase()) throw new Error("Account identity mismatch.");
  // Stored counts can lag. Never borrow an account with earned-unclaimed inventory.
  const inv = await require("./twitchInventory").fetchInventory(account.clientSecret, { host: host() });
  if ((inv.twitchId && String(inv.twitchId) !== String(account.twitchId)) ||
      (inv.login && String(inv.login).toLowerCase() !== account.username.toLowerCase()) ||
      inv.inProgress.some(d => !d.claimed && d.required > 0 && d.current >= d.required))
    throw new Error("Account inventory needs review.");
}
async function create(adminId, { count = 1 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PER_BOT) throw new Error("Choose 1–20 accounts per bot.");
  if (Date.now() >= END) throw new Error("The GTA VI viewing window has ended.");
  return withFileLock("twitch-rewards", "create", async () => {
    const existing = await Bot.find({}).lean();
    if (existing.length >= MAX_BOTS || existing.reduce((n, b) => n + members(b).length, 0) + count > MAX_ACCOUNTS)
      throw new Error("The dedicated Rewards farm has reached its account or bot limit.");
    const h = host();
    await assertCapacity();
    await hosts.runShell(h, "docker image inspect " + hosts.shq(IMAGE) + " >/dev/null", { timeout: 15000 });
    const fence = require("./fleetIntegrity");
    const a = await fence.claimFence("managed"), b = await fence.claimFence("noclaim");
    const guard = require("./pristineReserve");
    const id = new mongoose.Types.ObjectId(), note = "twitch-reward-farm:" + id, p = paths(id);
    const ledger = await require("./noclaimFleet").committedLedgers();
    const renterTokens = await require("../models/RenterAccount").distinct("clientSecret", {});
    const resellerTokens = await require("../models/ResellerAccount").distinct("clientSecret",
      { showcaseOnly: { $ne: true }, resellerStatus: { $ne: "returned" } });
    const taskLogins = await require("../models/AutoFarmTask").distinct("assignedAccounts",
      { status: { $in: ["active", "planned"] }, dryRun: { $ne: true } });
    const heldIds = existing.flatMap(b => members(b).map(m => String(m.poolAccountId)));
    const heldTokens = await Pool.distinct("clientSecret", { _id: { $in: heldIds } });
    const heldTwitchIds = new Set(existing.flatMap(b => members(b).map(m => String(m.twitchId))));
    const excluded = new Set([...a.exclude, ...b.exclude, ...heldTokens, ...renterTokens, ...resellerTokens]);
    const accounts = [];
    let validatingId = "";
    try {
      while (accounts.length < count) {
        const ids = [...ledger.poolIds, ...heldIds, ...rejectedIds, ...accounts.map(a => String(a._id))];
        const q = claimQuery([...excluded], await guard.farmClaimFilter(),
          { logins: [...ledger.logins, ...taskLogins.map(l => String(l).toLowerCase())], poolIds: ids });
        q.$and[0].twitchId.$nin = [...heldTwitchIds];
        // Reuse idle claimed-only accounts before drawing on pristine order supply.
        const account = await Pool.findOneAndUpdate(q,
          { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
          { returnDocument: "after", sort: { dropCount: -1, lastCheckAt: -1 }, lean: true });
        if (!account) throw new Error("Not enough eligible idle accounts above the protected reserve.");
        guard.noteClaimed(account);
        accounts.push(account); excluded.add(account.clientSecret); heldTwitchIds.add(String(account.twitchId));
        if (guard.isPristine(account)) {
          const reserve = (await guard.farmGuard()).reserve;
          const remaining = await Pool.countDocuments({ status: "available", clientSecret: { $gt: "" },
            manualSold: { $ne: true }, unclaimedDropCount: { $not: { $gt: 0 } }, ...guard.PRISTINE_CONDITIONS });
          if (remaining < reserve) throw new Error("Not enough eligible idle accounts above the protected reserve.");
        }
        validatingId = String(account._id);
        await validateAccount(account);
        validatingId = "";
        await recordPoolUsage(account._id, { event: "claimed", actor: "twitch-reward-farm", game: "Grand Theft Auto VI", note });
      }
      const entries = accounts.map(a => ({ poolAccountId: a._id, viewer: a.username.toLowerCase(), twitchId: String(a.twitchId) }));
      await Bot.create({ _id: id, adminId, ...entries[0], accounts: entries, desired: "stopped" });
      const config = JSON.stringify(workerConfig(accounts));
      const script = hosts.guardedWriteScript(p.dir + "/Configuration/config.json", Buffer.byteLength(config),
        { mode: "600", mkdirs: [p.dir + "/Configuration", p.dir + "/logs"] });
      await hosts.runShell(h, script, { input: config, timeout: 25000 });
      await hosts.runShell(h, "docker create --name " + hosts.shq(p.container) +
        " --restart unless-stopped --user 0:0 --memory 1024m --cpus 1 -e INSIDE_DOCKER=true -v " +
        hosts.shq(p.dir + "/Configuration") + ":/app/Configuration -v " + hosts.shq(p.dir + "/logs") +
        ":/app/logs " + hosts.shq(IMAGE) + " >/dev/null", { timeout: 25000 });
      for (const entry of entries) await Roster.updateOne({ adminId, viewer: entry.viewer },
        { $setOnInsert: { adminId, viewer: entry.viewer } }, { upsert: true });
      await Bot.updateOne({ _id: id }, { $set: { state: "stopped" } });
      return String(id);
    } catch (error) {
      // A rejected identity must not be selected again by a later batch in this process.
      if (validatingId) rejectedIds.add(validatingId);
      let absent = false;
      try {
        const r = await hosts.runShell(h, "if docker container inspect " + hosts.shq(p.container) +
          " >/dev/null 2>&1; then echo PRESENT; else docker info >/dev/null 2>&1 && echo ABSENT; fi", { timeout: 15000 });
        absent = r.stdout.trim() === "ABSENT";
      } catch { /* retain claims when the container state is unknown */ }
      if (absent) {
        try {
          await hosts.runShell(h, "rm -f " + hosts.shq(p.dir + "/Configuration/config.json"), { timeout: 15000 });
          await Bot.deleteOne({ _id: id });
          for (const account of accounts) {
            await Pool.updateOne({ _id: account._id, status: "claimed", claimedNote: note },
              { $set: { status: "available", claimedAt: null, claimedNote: "" } });
            await recordPoolUsage(account._id, { event: "returned", actor: "twitch-reward-farm", note: "Reward bot creation failed before startup." });
          }
        } catch { absent = false; }
      }
      await Bot.updateOne({ _id: id }, { $set: { state: "error", error: absent ? "Creation failed; accounts returned." : "Creation failed; claims retained for review." } });
      throw new Error("Reward bot creation failed: " + (/eligible idle/.test(error.message) ? error.message : "check account or host status before retrying."));
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
      await assertCapacity();
      if (await Pool.countDocuments({ _id: { $in: members(bot).map(m => m.poolAccountId) }, status: "claimed", claimedNote: "twitch-reward-farm:" + id }) !== members(bot).length)
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
function isGtaReceipt(receipt) {
  return receipt.CampaignId === GTA_ID ||
    /(?:gta\s*(?:vi|6)|grand\s*theft\s*auto\s*(?:vi|6))/i.test(String(receipt.CampaignName || "") + " " + String(receipt.RewardName || ""));
}
async function importCode(bot, receipt) {
  if (String(receipt.AccountId) !== bot.twitchId || String(receipt.Login).toLowerCase() !== bot.viewer)
    throw new Error("Code receipt account mismatch.");
  if (!isGtaReceipt(receipt))
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
function accountActivity(bot, lines) {
  return members(bot).map(member => ({ ...member,
    ...parseActivity(String(lines).split("\n").filter(line =>
      line.toLowerCase().includes("[twitchuser - " + member.viewer.toLowerCase() + "]")).join("\n")) }));
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
        const logs = live ? await hosts.dockerLogs(host(), p.container, { tail: Math.max(100, members(bot).length * 15), since: "3m" }) : "";
        const raw = typeof logs === "string" ? logs : logs.stdout || "";
        const activity = parseActivity(raw);
        const accounts = accountActivity(bot, raw);
        if (accounts.length > 1) {
          activity.currentMinutes = accounts.every(a => a.currentMinutes != null)
            ? Math.min(...accounts.map(a => a.currentMinutes)) : null;
          activity.requiredMinutes = accounts.find(a => a.requiredMinutes != null)?.requiredMinutes ?? null;
        }
        await Bot.updateOne({ _id: bot._id }, { $set: { state: live ? "running" : "stopped", ...activity,
          ...(bot.accounts?.length ? { accounts } : {}), checkedAt: new Date(), error: "" } });
        // stdout is an internal SSH transport, never an HTTP response or log.
        if (live) {
          const exported = await hosts.runShell(host(), "docker exec -e TWITCH_REWARD_CODE_KEY_FILE=/app/Configuration/reward-code.key " +
            hosts.shq(p.container) + " dotnet TwitchDropsBot.Console.dll reward-codes export /app/Configuration/reward-codes", { timeout: 20000 });
          const rows = JSON.parse(exported.stdout);
          if (!Array.isArray(rows) || rows.length > 200) throw new Error("Invalid receipt export.");
          for (const receipt of rows) {
            const member = members(bot).find(a => String(a.twitchId) === String(receipt.AccountId));
            if (!member) throw new Error("Receipt account is not assigned to this bot.");
            if (!isGtaReceipt(receipt)) continue; // retain unrelated historical codes in the encrypted outbox
            await importCode({ ...bot, viewer: member.viewer, twitchId: member.twitchId }, receipt);
          }
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
  const bots = await Bot.find({ adminId }, { poolAccountId: 0, "accounts.poolAccountId": 0, __v: 0 }).sort({ createdAt: -1 }).lean();
  return { bots, campaign: "GTA VI", endsAt: new Date(END), maxBots: MAX_BOTS, maxAccounts: MAX_ACCOUNTS, totalAccounts: bots.reduce((n,b) => n + members(b).length, 0) };
}
module.exports = { create, action, start, runOnce, status, workerConfig, claimQuery, parseActivity, accountActivity, importCode, isGtaReceipt, members, checkCapacity, IMAGE, BASE, HOST };
