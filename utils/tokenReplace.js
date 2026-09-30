// Replace an account's dead Twitch token everywhere the system keeps it.
//
// WHY THIS EXISTS
//
// A re-minted token had no way in. The pool importer only FILLS IN values that
// are missing (it never overwrites a stored token) and skips any account a bot
// already uses, the bot configs hold their own copy of the token, and renter
// rows hold a third. So an account whose password still worked but whose token
// died — a paying rent-farm buyer's account included — could not be repaired
// without hand-editing configs and rows (2026-09-29: cgasc993ux, Eldorado order
// e328ee9d, sat unfarmed for days on a dead token).
//
// The operator pastes freshly minted tokens (the token fetcher's JSON, or
// `login:token` lines) into the Account pool page. Every token is PROVEN before
// anything is written:
//   * it logs in as exactly that account (Inventory's currentUser login/id);
//   * it passes the integrity gate the bots' own drops query sits behind, and
//     actually sees campaigns (a restricted token sees none).
// Then, for that account only: every bot config it appears in (regular hosts
// via writeFileAtomic, no-claim bots via the fleet's own `cat > tmp && mv`,
// each under the same per-file lock every other config writer takes), its pool
// row (re-queued for the normal pool check), its bot-archive, renter and
// supplier rows. A RUNNING bot whose config changed is restarted — a bot reads
// its config only at start. One SystemEvent per account; the token itself is
// never logged or returned.
//
// Refused with nothing written: a token for a different account, one that
// fails integrity or sees no campaigns, one already stored on another account,
// or an account enabled in two bots at once (the single-home guard on the next
// write would silently move it — fix placement first).
const TOKEN_RE = /^[a-z0-9]{20,40}$/i;
const LOGIN_RE = /^[A-Za-z0-9_]{2,40}$/;
const MAX_PER_CALL = 25;

const lc = (s) => String(s || "").trim().toLowerCase();
const exactRx = (s) => new RegExp("^" + String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
const usersOf = (cfg) => {
  const list = cfg && cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers;
  return Array.isArray(list) ? list : [];
};

// Every top-level JSON object in a blob of text — one array, several arrays
// pasted back to back, JSON lines, or a mix. Brace-matched outside strings.
function extractJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          out.push(null);
        }
        start = -1;
      }
    }
  }
  return out;
}

// Normalise whatever was pasted into [{ login, token, uniqueId, twitchId }].
// `bad` never echoes a token — only the login (or a line number) and why.
function parseReplacements(input) {
  const entries = [];
  const bad = [];
  const add = (o, where) => {
    if (!o || typeof o !== "object") {
      bad.push({ where, reason: "not readable" });
      return;
    }
    const login = String(o.Login || o.login || o.username || "").trim();
    const token = String(o.ClientSecret || o.clientSecret || o.token || "").trim().replace(/^oauth:/i, "");
    const uniqueId = String(o.UniqueId || o.uniqueId || "").trim();
    const idRaw = o.Id != null ? o.Id : o.twitchId;
    const twitchId = idRaw != null ? String(idRaw).trim() : "";
    if (!LOGIN_RE.test(login)) return bad.push({ where, login, reason: "no valid login" });
    if (!TOKEN_RE.test(token)) return bad.push({ where, login, reason: "no valid token" });
    if (o.integrityOk === false) return bad.push({ where, login, reason: "the fetcher marked this token as failing integrity" });
    entries.push({ login, token, uniqueId, twitchId: /^\d+$/.test(twitchId) ? twitchId : "" });
  };
  if (Array.isArray(input)) input.forEach((o, i) => add(o, "item " + (i + 1)));
  else if (input && typeof input === "object") add(input, "item 1");
  else {
    const text = String(input || "").trim();
    const objs = text.includes("{") ? extractJsonObjects(text) : [];
    if (objs.length) objs.forEach((o, i) => add(o, "object " + (i + 1)));
    else {
      text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;
        let parts = line.split(":").map((s) => s.trim());
        // "login:oauth:token" — keep the oauth: prefix with its token.
        if (parts[1] && parts[1].toLowerCase() === "oauth") parts = [parts[0], parts[1] + ":" + parts[2], ...parts.slice(3)];
        const [login, token, uniqueId, twitchId] = parts;
        add({ Login: login, ClientSecret: token, UniqueId: uniqueId, Id: twitchId }, "line " + (i + 1));
      });
    }
  }
  // Same account twice: the later one wins (the newest mint).
  const byLogin = new Map();
  for (const e of entries) byLogin.set(lc(e.login), e);
  return { entries: [...byLogin.values()], bad };
}

// Set the new token on every TwitchUsers entry of `login` in one config.
// Returns how many entries CHANGED (0 = nothing to write).
function applyToConfig(cfg, login, entry) {
  let changed = 0;
  for (const u of usersOf(cfg)) {
    if (!u || lc(u.Login) !== lc(login)) continue;
    const before = JSON.stringify([u.ClientSecret, u.UniqueId, u.Id]);
    u.ClientSecret = entry.token;
    if (entry.uniqueId) u.UniqueId = entry.uniqueId;
    if (entry.twitchId) u.Id = String(entry.twitchId);
    if (JSON.stringify([u.ClientSecret, u.UniqueId, u.Id]) !== before) changed++;
  }
  return changed;
}

// The container that runs a regular config (botConfigRoutes' naming).
function containerForFile(file) {
  if (file === "config.json") return "twitchbot";
  const m = /^config_(\d+)\.json$/.exec(String(file || ""));
  return m ? "twitchbotx" + Number(m[1]) : null;
}

// Where every login lives, from ONE read of every config on every host plus
// every no-claim bot: login -> [{ kind, hostId, file, id, enabled }].
function indexHomes(homes) {
  const byLogin = new Map();
  for (const h of homes || []) {
    const noclaim = /^no-claim bot (\S+)$/.exec(h.where || "");
    const [hostId, ...rest] = noclaim ? [] : String(h.where || "").split("/");
    for (const u of usersOf(h.cfg)) {
      const k = lc(u && u.Login);
      if (!k) continue;
      if (!byLogin.has(k)) byLogin.set(k, []);
      const list = byLogin.get(k);
      const home = noclaim
        ? { kind: "noclaim", id: noclaim[1], where: h.where }
        : { kind: "bot", hostId, file: rest.join("/"), where: h.where };
      if (!list.some((x) => x.where === home.where)) list.push({ ...home, enabled: false });
      if (u.Enabled !== false) list.find((x) => x.where === home.where).enabled = true;
    }
  }
  return byLogin;
}

// Prove the token before anything is written.
async function verifyToken(entry, deps) {
  let inv;
  try {
    inv = await deps.fetchInventory(entry.token);
  } catch (e) {
    return {
      ok: false,
      reason: e.code === "token_invalid" ? "Twitch rejects this token" : "could not reach Twitch to verify it — try again",
    };
  }
  if (lc(inv.login) !== lc(entry.login)) {
    return { ok: false, reason: "this token belongs to " + (inv.login || "a different account") + ", not " + entry.login };
  }
  if (entry.twitchId && inv.twitchId && String(inv.twitchId) !== String(entry.twitchId)) {
    return { ok: false, reason: "Twitch id " + inv.twitchId + " does not match the pasted id " + entry.twitchId };
  }
  let campaigns;
  try {
    campaigns = await deps.fetchDropCampaigns(entry.token);
  } catch (e) {
    return {
      ok: false,
      reason:
        e.code === "integrity_failed"
          ? "fails Twitch's integrity check — mint it with the bot's device login"
          : e.code === "token_invalid"
            ? "Twitch rejects this token"
            : "could not run the integrity check — try again",
    };
  }
  if (!Array.isArray(campaigns) || !campaigns.length) {
    return { ok: false, reason: "the token sees no drop campaigns (restricted token)" };
  }
  return { ok: true, twitchId: String(inv.twitchId || entry.twitchId || ""), campaigns: campaigns.length };
}

async function writeRegularConfig(home, login, entry, deps) {
  const host = deps.hosts.resolveHost(home.hostId);
  if (!host) throw new Error("host " + home.hostId + " is not configured");
  const changed = await deps.withFileLock(host, home.file, async () => {
    const cfg = JSON.parse(await deps.hosts.readFile(host, home.file));
    const n = applyToConfig(cfg, login, entry);
    if (n) await deps.hosts.writeFileAtomic(host, home.file, JSON.stringify(cfg, null, 2));
    return n;
  });
  let restarted = "";
  if (changed) {
    const container = containerForFile(home.file);
    const ps = await deps.hosts.dockerPs(host).catch(() => ({}));
    if (container && ps[container] && ps[container].state === "running") {
      await deps.hosts.dockerContainer(host, "restart", container);
      restarted = home.hostId + "/" + container;
    } else if (!container) {
      restarted = "(restart the bot for " + home.where + " by hand if it is running)";
    }
  }
  return { changed, restarted };
}

async function writeNoClaimConfig(home, login, entry, deps) {
  const fleet = deps.fleet;
  const shq = deps.hosts.shq;
  const path = fleet.configPath(home.id);
  const changed = await deps.withFileLock(fleet.pi(), path, async () => {
    const cfg = JSON.parse(await fleet.sh(`cat ${shq(path)}`, { timeout: 20000 }));
    const n = applyToConfig(cfg, login, entry);
    if (!n) return 0;
    await fleet.sh(
      `cat > ${shq(path + ".tmp")} && mv ${shq(path + ".tmp")} ${shq(path)} && chmod 600 ${shq(path)}`,
      { timeout: 20000, input: JSON.stringify(cfg, null, 2) },
    );
    const back = JSON.parse(await fleet.sh(`cat ${shq(path)}`, { timeout: 20000 }));
    if (!usersOf(back).some((u) => lc(u.Login) === lc(login) && u.ClientSecret === entry.token)) {
      throw new Error("no-claim bot " + home.id + ": the new token is not in its config after the write");
    }
    return n;
  });
  let restarted = "";
  if (changed) {
    const c = shq(fleet.containerFor(home.id));
    const out = await fleet.sh(
      `if [ "$(docker inspect -f '{{.State.Running}}' ${c} 2>/dev/null)" = "true" ]; then docker restart ${c} >/dev/null 2>&1 && echo restarted; fi; true`,
      { timeout: 60000 },
    );
    if (/restarted/.test(out)) restarted = fleet.containerFor(home.id);
  }
  return { changed, restarted };
}

// Pick the one row to carry the token when a login has several (clientSecret
// is unique on these collections): an enabled one first, then the newest.
function pickRow(rows) {
  const on = rows.filter((r) => r.enabled !== false);
  const pool = on.length ? on : rows;
  return pool.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
}

async function replaceOne(entry, homesByLogin, { actor = "system", unreadable = [] } = {}, deps) {
  const login = entry.login;
  const out = { login, ok: false, updated: [], restarted: [], notes: [] };

  const v = await verifyToken(entry, deps);
  if (!v.ok) return { ...out, reason: v.reason };
  const twitchId = v.twitchId;
  const e = { ...entry, twitchId };

  // Never put one token on two accounts (clientSecret is the identity key).
  const rx = exactRx(login);
  const clash =
    (await deps.BotAccount.findOne({ clientSecret: e.token, login: { $not: rx } }, { login: 1 }).lean()) ||
    (await deps.RenterAccount.findOne({ clientSecret: e.token, login: { $not: rx } }, { login: 1 }).lean()) ||
    (await deps.AvailableAccount.findOne({ clientSecret: e.token, usernameLower: { $ne: lc(login) } }, { username: 1 }).lean());
  if (clash) return { ...out, reason: "this token is already stored on " + (clash.login || clash.username) };

  const homes = homesByLogin.get(lc(login)) || [];
  const live = homes.filter((h) => h.enabled);
  if (live.length > 1) {
    return { ...out, reason: "enabled in " + live.length + " bots at once (" + live.map((h) => h.where).join(", ") + ") — fix its placement first" };
  }

  // Configs first: a bot must never keep farming on the dead token while the
  // rows already say it is fixed.
  for (const h of homes) {
    const r = h.kind === "noclaim" ? await writeNoClaimConfig(h, login, e, deps) : await writeRegularConfig(h, login, e, deps);
    if (r.changed) out.updated.push(h.where);
    if (r.restarted) out.restarted.push(r.restarted);
  }

  const pool = await deps.AvailableAccount.findOne({ usernameLower: lc(login) }, { _id: 1 }).lean();
  if (pool) {
    const set = { clientSecret: e.token, twitchId, lastCheckStatus: "", lastCheckError: "" };
    if (e.uniqueId) set.uniqueId = e.uniqueId;
    await deps.AvailableAccount.updateOne({ _id: pool._id }, { $set: set });
    out.updated.push("pool row");
    try {
      deps.enqueueCheck([pool._id]);
    } catch {
      out.notes.push("pool check not queued — use Check on the row");
    }
  }

  const bots = await deps.BotAccount.find({ login: rx }, { _id: 1, enabled: 1, updatedAt: 1 }).lean();
  const bot = pickRow(bots);
  if (bot) {
    const set = { clientSecret: e.token, twitchId, lastScanStatus: "pending", lastScanError: "" };
    if (e.uniqueId) set.uniqueId = e.uniqueId;
    await deps.BotAccount.updateOne({ _id: bot._id }, { $set: set });
    out.updated.push("drops-archive row");
    if (bots.length > 1) out.notes.push(bots.length - 1 + " older archive row(s) left on the old token");
  }

  const renters = await deps.RenterAccount.find({ login: rx }, { _id: 1, enabled: 1, updatedAt: 1 }).lean();
  const renter = pickRow(renters);
  if (renter) {
    const set = { clientSecret: e.token, twitchId, lastScanStatus: "pending", lastScanError: "" };
    if (e.uniqueId) set.uniqueId = e.uniqueId;
    await deps.RenterAccount.updateOne({ _id: renter._id }, { $set: set });
    out.updated.push("renter row");
    if (renters.length > 1) out.notes.push(renters.length - 1 + " older renter row(s) left on the old token");
  }

  const sup = await deps.SuppliedAccount.updateMany({ login: rx }, { $set: { clientSecret: e.token } });
  if (sup && sup.modifiedCount) out.updated.push("supplier row");

  if (!out.updated.length) out.notes.push("this login is not stored anywhere — import it first");
  if (unreadable.length) out.notes.push("unreadable right now, not checked: " + unreadable.join(", "));

  deps.logEvent({
    category: "accounts",
    action: "token_replaced",
    actor,
    subject: login,
    detail: (out.updated.join(", ") || "nothing stored") + (out.restarted.length ? "; restarted " + out.restarted.join(", ") : ""),
  });
  return { ...out, ok: out.updated.length > 0, campaigns: v.campaigns };
}

function realDeps() {
  const { withFileLock } = require("./fileLock");
  const { fetchInventory, fetchDropCampaigns } = require("./twitchInventory");
  const accountPoolChecker = require("./accountPoolChecker");
  return {
    hosts: require("./botHosts"),
    fleet: require("./noclaimFleet"),
    withFileLock,
    fetchInventory,
    fetchDropCampaigns,
    readAllHomes: require("./fleetIntegrity").readAllHomes,
    enqueueCheck: (ids) => accountPoolChecker.enqueueIfStarted(ids),
    logEvent: require("./systemLog").logEvent,
    AvailableAccount: require("../models/AvailableAccount"),
    BotAccount: require("../models/BotAccount"),
    RenterAccount: require("../models/RenterAccount"),
    SuppliedAccount: require("../models/SuppliedAccount"),
  };
}

async function replaceTokens(input, { actor = "system" } = {}, deps = realDeps()) {
  const { entries, bad } = parseReplacements(input);
  if (entries.length > MAX_PER_CALL) {
    const e = new Error(entries.length + " accounts in one paste — replace at most " + MAX_PER_CALL + " at a time");
    e.status = 413;
    throw e;
  }
  if (!entries.length) return { results: [], bad, unreadable: [] };
  const { homes, unreadable } = await deps.readAllHomes();
  const byLogin = indexHomes(homes);
  const results = [];
  for (const entry of entries) {
    results.push(
      await replaceOne(entry, byLogin, { actor, unreadable }, deps).catch((err) => ({
        login: entry.login,
        ok: false,
        reason: "failed part-way: " + String((err && err.message) || err).slice(0, 200),
      })),
    );
  }
  return { results, bad, unreadable };
}

module.exports = {
  MAX_PER_CALL,
  extractJsonObjects,
  parseReplacements,
  applyToConfig,
  containerForFile,
  indexHomes,
  verifyToken,
  replaceOne,
  replaceTokens,
};
