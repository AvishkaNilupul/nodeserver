// One account, one bot — across EVERY bot system (owner, 2026-09-28).
//
// dupeGuard keeps an account in one regular config per host, and nothing more:
// it never looks at another host's configs, and never at the no-claim farm's
// own tree. So a login can farm in a regular (or renter) bot and a no-claim
// bot at the same time — 32 accounts sat in two bots at once for 54 hours from
// 2026-09-25, which is how the auto-farm ended up claiming drops that were on
// sale unclaimed. Every other system trusts the pool row; only the config
// files say where an account really farms.
//
// This reads every config file on every host (one batched read per host) plus
// every no-claim bot config, and reports each ClientSecret that is ENABLED in
// more than one of them. Read-only: it never edits a config — which copy is
// the wrong one is a decision for a person.
const hosts = require("./botHosts");

// The regular bot configs in a host's bot dir (config.json, config_14.json,
// config_rent-3.json ...), the same shape dupeGuard and the Bots page read.
const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;

function usersOf(cfg) {
  const list = cfg && cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers;
  return Array.isArray(list) ? list : [];
}

// A user entry farms unless it is explicitly switched off.
function enabled(u) {
  return !!(u && u.ClientSecret) && u.Enabled !== false && u.enabled !== false;
}

// Pure: homes = [{ where, cfg }] -> the ClientSecrets enabled in 2+ of them.
// A secret listed twice in ONE config is that config's own problem (dupeGuard
// territory) and is counted once here.
function findCollisions(homes) {
  const bySecret = new Map();
  for (const h of homes || []) {
    for (const u of usersOf(h.cfg)) {
      if (!enabled(u)) continue;
      const s = String(u.ClientSecret);
      if (!bySecret.has(s)) bySecret.set(s, { login: String(u.Login || ""), where: new Set() });
      bySecret.get(s).where.add(h.where);
    }
  }
  const out = [];
  let accounts = 0;
  for (const [secret, e] of bySecret) {
    accounts++;
    if (e.where.size < 2) continue;
    out.push({
      login: e.login,
      // Enough to find it again, never the credential itself.
      secretTail: "…" + secret.slice(-4),
      homes: [...e.where].sort(),
    });
  }
  out.sort((a, b) => b.homes.length - a.homes.length || a.login.localeCompare(b.login));
  return { accounts, collisions: out };
}

// Read every regular config on every host. `unreadable` lists what could not
// be read (an account in such a config may collide too, so a clean result with
// unreadable configs is not proof); `blindHosts` / `blindFiles` say the same
// thing in a shape the claim fence can look up.
async function readManagedHomes() {
  const homes = [];
  const unreadable = [];
  const blindHosts = [];
  const blindFiles = [];
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    if (!host) continue;
    let files;
    try {
      files = (await hosts.readdir(host, { retries: 1 })).filter((f) => CONFIG_RE.test(f));
    } catch (e) {
      unreadable.push(h.id + ": " + String((e && e.message) || e).slice(0, 120));
      blindHosts.push(h.id);
      continue;
    }
    let read = {};
    try {
      read = await hosts.readFiles(host, files);
    } catch (e) {
      unreadable.push(h.id + ": " + String((e && e.message) || e).slice(0, 120));
      blindHosts.push(h.id);
      continue;
    }
    for (const f of files) {
      const r = read[f];
      let cfg = null;
      if (r && r.ok && r.text) {
        try {
          cfg = JSON.parse(r.text);
        } catch {
          cfg = null;
        }
      }
      if (!cfg) {
        unreadable.push(h.id + "/" + f);
        blindFiles.push({ host: h.id, file: f });
        continue;
      }
      homes.push({ where: h.id + "/" + f, host: h.id, file: f, cfg });
    }
  }
  return { homes, unreadable, blindHosts, blindFiles };
}

// Read every config, the no-claim tree included.
async function readAllHomes() {
  const { homes, unreadable } = await readManagedHomes();
  try {
    const nc = await require("./unclaimedAutoList").readNoClaimConfigs();
    if (!nc.length) unreadable.push("no-claim: no configs listed");
    for (const c of nc) {
      if (!c.cfg) {
        unreadable.push("no-claim bot " + c.id);
        continue;
      }
      homes.push({ where: "no-claim bot " + c.id, cfg: c.cfg });
    }
  } catch (e) {
    unreadable.push("no-claim: " + String((e && e.message) || e).slice(0, 120));
  }
  return { homes, unreadable };
}

async function oneAccountOneBot() {
  const { homes, unreadable } = await readAllHomes();
  const { accounts, collisions } = findCollisions(homes);
  return { at: new Date(), configs: homes.length, accounts, collisions, unreadable };
}

// ---------------------------------------------------------------------------
// Prevention (2026-10-06)
// ---------------------------------------------------------------------------
// The check above only reports. On 2026-09-21 the auto-farm claimed 68
// accounts that sat in no-claim Overwatch bots — their pool rows had been put
// back as "available" — and its bots claimed their unclaimed Overwatch drops
// for four days. Both farms picked accounts by the pool row alone; the row was
// wrong and nothing asked the config files. From here every door asks them:
//   * guardManagedWrite — utils/botHosts.writeFileAtomic, the one call every
//     regular and renter config write goes through: an entry for an account
//     that sits in a no-claim bot is written switched OFF, whoever asked
//     (every bot there claims drops, and a claimed drop is no-claim stock
//     destroyed);
//   * claimFence("managed") — utils/autoFarmer.claimPoolAccounts never claims
//     an account that sits in a no-claim bot;
//   * claimFence("noclaim") — utils/noclaimFleet never claims, and never
//     writes into a no-claim bot, an account enabled in a regular config.
// Nothing here edits a pool row or takes an account out of a config: which
// copy is the wrong one is still a decision for a person. The guards only
// refuse to make a second home, and say so (SystemEvent + Telegram).

const CACHE_MS = 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
let noclaimCache = null; // { at, homes }
let noclaimFailed = null; // { at, error } — the last read that failed
let managedCache = null; // { at, value }
const lastAlert = new Map(); // key -> ms

const tail = (secret) => "…" + String(secret).slice(-4);

// One read of every no-claim bot config: Map(ClientSecret -> { botId, login,
// game }). Every entry counts, switched on or not — an account listed in a
// no-claim config is that farm's. Throws unless the whole tree was read: the
// trailer proves the output was not cut, and a config that does not parse
// could hold anything. No no-claim host on this install, or no bots directory
// on it, is an empty farm, not a failed read.
async function readNoclaimHomes() {
  const fleet = require("./noclaimFleet");
  const homes = new Map();
  if (!hosts.resolveHost(fleet.HOST_ID)) return homes;
  const dir = hosts.shq(fleet.BOTS_DIR);
  const out = await fleet.sh(
    `if [ ! -d ${dir} ]; then echo "__NODIR__"; fi; n=0; ` +
      `for f in ${dir}/*/Configuration/config.json; do [ -f "$f" ] || continue; ` +
      `n=$((n+1)); echo "__CFG__$f"; cat "$f"; echo; done; echo "__END__$n"`,
    { timeout: 45000 },
  );
  const text = String(out || "");
  const end = text.match(/__END__(\d+)\s*$/);
  if (!end) throw new Error("the no-claim configs were not read to the end");
  const chunks = text.slice(0, end.index).split("__CFG__").slice(1);
  if (chunks.length !== Number(end[1])) throw new Error("the no-claim config read is incomplete");
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const path = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    const m = path.match(/\/([^/]+)\/Configuration\/config\.json$/);
    const botId = m ? m[1] : "?";
    let cfg;
    try {
      cfg = JSON.parse(nl < 0 ? "" : chunk.slice(nl + 1));
    } catch {
      throw new Error("no-claim bot " + botId + "'s config did not parse");
    }
    const games = Array.isArray(cfg && cfg.FavouriteGames) ? cfg.FavouriteGames : [];
    for (const u of usersOf(cfg)) {
      const s = String((u && u.ClientSecret) || "").trim();
      if (!s) continue;
      const own = Array.isArray(u.FavouriteGames) && u.FavouriteGames.length ? u.FavouriteGames : games;
      homes.set(s, { botId, login: String(u.Login || ""), game: String(own[0] || "") });
    }
  }
  return homes;
}

// The no-claim homes, at most `maxAgeMs` old. When the tree cannot be read the
// last good read stands in (configs on a host that is down are not changing);
// with no read ever made, it throws.
async function noclaimHomes({ maxAgeMs = CACHE_MS, allowStale = true } = {}) {
  // maxAgeMs 0 always reads: "within the same millisecond" is not fresh.
  if (noclaimCache && maxAgeMs > 0 && Date.now() - noclaimCache.at <= maxAgeMs) return noclaimCache.homes;
  try {
    // A host that is down is not asked again by every config write behind this
    // one (each would wait out the SSH timeout): the failure stands for as long
    // as a good read would have.
    if (noclaimFailed && maxAgeMs > 0 && Date.now() - noclaimFailed.at <= maxAgeMs) throw noclaimFailed.error;
    const homes = await readNoclaimHomes();
    noclaimCache = { at: Date.now(), homes };
    noclaimFailed = null;
    return homes;
  } catch (e) {
    if (!noclaimFailed || noclaimFailed.error !== e) noclaimFailed = { at: Date.now(), error: e };
    if (allowStale && noclaimCache) {
      console.error(
        "[fleetIntegrity] no-claim configs unreadable (" + ((e && e.message) || e) +
          ") — using the read from " + new Date(noclaimCache.at).toISOString(),
      );
      return noclaimCache.homes;
    }
    throw e;
  }
}

// Pure. `text` is a regular config about to be written; every enabled entry
// whose token is in `homes` is switched off. Returns the text unchanged (the
// same string) when there is nothing to hold or it does not parse.
function holdNoclaimEnabled(text, homes) {
  const held = [];
  if (typeof text !== "string" || !homes || !homes.size) return { text, held };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { text, held };
  }
  for (const u of usersOf(data)) {
    if (!enabled(u)) continue;
    const home = homes.get(String(u.ClientSecret).trim());
    if (!home) continue;
    u.Enabled = false;
    if ("enabled" in u) u.enabled = false;
    held.push({ login: String(u.Login || home.login || ""), secretTail: tail(u.ClientSecret), botId: home.botId });
  }
  return held.length ? { text: JSON.stringify(data, null, 2), held } : { text, held };
}

// Say it once an hour per subject: a guard that fires on every tick must not
// bury the log or the phone.
function alertOnce(key, event, telegram) {
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < ALERT_COOLDOWN_MS) return;
  lastAlert.set(key, now);
  try {
    require("./systemLog").logEvent(event);
  } catch (e) {
    console.error("[fleetIntegrity] could not log: " + ((e && e.message) || e));
  }
  if (!telegram) return;
  try {
    Promise.resolve(require("./telegram").sendTelegram(telegram)).catch(() => {});
  } catch {
    /* best effort */
  }
}

// What utils/botHosts.writeFileAtomic writes for (host, file): `text`, with any
// account that sits in a no-claim bot switched off. Never throws and never
// blocks a write: when the no-claim tree cannot be read and never was, the
// text goes out as it came (claimFence is the first line; this is the second).
async function guardManagedWrite(host, file, text) {
  if (!CONFIG_RE.test(String(file || "")) || typeof text !== "string") return text;
  let homes;
  try {
    homes = await noclaimHomes();
  } catch (e) {
    console.error(
      "[fleetIntegrity] " + ((host && host.id) || "?") + "/" + file +
        " written without the no-claim check: " + ((e && e.message) || e),
    );
    return text;
  }
  let r = holdNoclaimEnabled(text, homes);
  if (!r.held.length) return text;
  // The read may be a minute old, and an account taken OUT of its no-claim bot
  // in that minute is free to farm here — ask again before switching it off.
  try {
    r = holdNoclaimEnabled(text, await noclaimHomes({ maxAgeMs: 0, allowStale: false }));
  } catch {
    /* cannot ask again: the cautious answer stands */
  }
  if (!r.held.length) return text;
  const hostId = (host && host.id) || "";
  const names = r.held.map((h) => h.login + " (no-claim bot " + h.botId + ")");
  console.warn(
    "[fleetIntegrity] " + hostId + "/" + file + ": " + r.held.length +
      " account(s) sit in a no-claim bot — written switched off: " + names.join(", "),
  );
  alertOnce(
    "held|" + hostId + "|" + file + "|" + r.held.map((h) => h.secretTail).sort().join(","),
    {
      category: "bots",
      action: "noclaim_account_held",
      severity: "error",
      actor: "system",
      host: hostId,
      count: r.held.length,
      detail:
        r.held.length + " account(s) were about to be switched on in " + hostId + "/" + file +
        " while they sit in a no-claim bot. They were written switched OFF there (one account, " +
        "one bot). The pool row that offered them is wrong: " + names.slice(0, 20).join(", "),
      meta: { file, held: r.held.slice(0, 50) },
    },
    "🚧 One account, one bot: " + r.held.length + " no-claim account(s) were about to be switched on in " +
      hostId + "/" + file + " — written switched off instead. " + names.slice(0, 8).join(", "),
  );
  return r.text;
}

// Every token ENABLED in a regular config, on every host:
// { bySecret: Map(secret -> { host, file, login }), blindHosts, blindFiles }.
async function managedEnabled({ maxAgeMs = CACHE_MS } = {}) {
  if (managedCache && maxAgeMs > 0 && Date.now() - managedCache.at <= maxAgeMs) return managedCache.value;
  const { homes, blindHosts, blindFiles } = await readManagedHomes();
  const bySecret = new Map();
  for (const h of homes) {
    for (const u of usersOf(h.cfg)) {
      if (!enabled(u)) continue;
      bySecret.set(String(u.ClientSecret).trim(), { host: h.host, file: h.file, login: String(u.Login || "") });
    }
  }
  const value = { bySecret, blindHosts, blindFiles };
  managedCache = { at: Date.now(), value };
  return value;
}

// What the mirror says is enabled where the files could not be read. Only ever
// used to SKIP an account for now — the mirror drifts, so nothing is decided
// on it. Throws when it cannot be asked either.
async function mirrorEnabled(blindHosts, blindFiles) {
  const or = [];
  if (blindHosts.length) or.push({ host: { $in: blindHosts } });
  for (const f of blindFiles) or.push({ host: f.host, configFile: f.file });
  if (!or.length) return [];
  const BotAccount = require("../models/BotAccount");
  const rows = await BotAccount.find({ enabled: true, $or: or }, { clientSecret: 1 }).lean();
  return rows.map((r) => String(r.clientSecret || "").trim()).filter(Boolean);
}

// The tokens a feeder must not claim, whatever the pool rows say.
//   "managed" — asked by the auto-farm: every token in a no-claim bot config.
//   "noclaim" — asked by the no-claim farm: every token enabled in a regular
//               config (`taken`: token -> where), plus, for a host or file that
//               could not be read, what the mirror says is enabled there.
// Throws when the answer is unknown — the no-claim tree unreadable and never
// read, or the no-claim host's own regular configs unreadable. The caller
// then claims nothing: a claim made blind is how the double home began.
async function claimFence(side) {
  if (side === "managed") {
    const homes = await noclaimHomes();
    return { exclude: [...homes.keys()], homes };
  }
  if (side === "noclaim") {
    const m = await managedEnabled();
    const fleet = require("./noclaimFleet");
    if (m.blindHosts.includes(fleet.HOST_ID)) {
      const e = new Error(
        "The regular bot configs on " + fleet.HOST_ID + " could not be read, so which accounts " +
          "already farm there is unknown — claiming nothing for the no-claim farm.",
      );
      e.status = 503;
      throw e;
    }
    const suspects = await mirrorEnabled(m.blindHosts, m.blindFiles);
    return { exclude: [...new Set([...m.bySecret.keys(), ...suspects])], taken: m.bySecret };
  }
  throw new Error("claimFence: unknown side " + side);
}

// A pool row the fence kept a feeder away from is a row that lies. Logged for
// the owner (hourly at most per side); read-only, and never fails a claim.
async function reportFencedRows(side, fence) {
  try {
    if (!fence || !fence.exclude.length) return 0;
    // Already said within the hour: nothing to look up.
    if (Date.now() - (lastAlert.get("fenced|" + side) || 0) < ALERT_COOLDOWN_MS) return 0;
    const AvailableAccount = require("../models/AvailableAccount");
    const rows = await AvailableAccount.find(
      { status: "available", clientSecret: { $in: fence.exclude } },
      { username: 1, clientSecret: 1 },
    )
      .limit(200)
      .lean();
    if (!rows.length) return 0;
    const where = (r) => {
      const s = String(r.clientSecret || "").trim();
      if (side === "managed") {
        const h = fence.homes && fence.homes.get(s);
        return h ? "no-claim bot " + h.botId : "a no-claim bot";
      }
      const t = fence.taken && fence.taken.get(s);
      return t ? t.host + "/" + t.file : "a bot on an unreadable host";
    };
    const names = rows.map((r) => r.username + " (" + where(r) + ")");
    alertOnce(
      "fenced|" + side,
      {
        category: "pool",
        action: "available_but_in_a_bot",
        severity: "warn",
        actor: "system",
        count: rows.length,
        detail:
          rows.length + " pool account(s) read \"available\" while they sit in a bot config — " +
          "not claimed for the " + (side === "managed" ? "auto-farm" : "no-claim farm") +
          ". Their pool rows need putting right: " + names.slice(0, 20).join(", "),
        meta: { side, logins: rows.map((r) => r.username).slice(0, 50) },
      },
      "🚧 One account, one bot: " + rows.length + " pool account(s) read \"available\" but sit in a bot — " +
        "skipped by the " + (side === "managed" ? "auto-farm" : "no-claim farm") + ". " + names.slice(0, 8).join(", "),
    );
    return rows.length;
  } catch (e) {
    console.error("[fleetIntegrity] could not report fenced pool rows: " + ((e && e.message) || e));
    return 0;
  }
}

// A config was just written: the next question must not be answered from the
// read made before it.
function forget(which) {
  if (!which || which === "noclaim") {
    noclaimCache = null;
    noclaimFailed = null;
  }
  if (!which || which === "managed") managedCache = null;
}

function _resetForTests() {
  forget();
  lastAlert.clear();
}

module.exports = {
  CONFIG_RE,
  findCollisions,
  readManagedHomes,
  readAllHomes,
  oneAccountOneBot,
  readNoclaimHomes,
  noclaimHomes,
  holdNoclaimEnabled,
  guardManagedWrite,
  managedEnabled,
  claimFence,
  reportFencedRows,
  forget,
  _resetForTests,
};
