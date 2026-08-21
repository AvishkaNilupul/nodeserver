// Programmatic bot creation for the auto-farmer. Mirrors the exact sequence of
// the manual POST /bot-configs/create flow (config file first, BotAccount
// mirror, compose service registration with rollback, then container start)
// while staying fully independent of routes/botConfigRoutes.js — the manual
// flow is owner-only and must never be affected by auto-farm changes.
const crypto = require("crypto");

const hosts = require("./botHosts");
const BotAccount = require("../models/BotAccount");
const {
  fillBotPasswordsFromPool,
  markDeployedPoolAccountsClaimed,
} = require("./poolPasswords");

const DEFAULT_IMAGE = "avishkarex/twitchbot:latest";
const FILE_RE = /^config(_\d{1,3})?\.json$/;

// config.json -> twitchbot ; config_02.json -> twitchbotx2
function containerForFile(file) {
  const m = file.match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  if (file === "config.json") return "twitchbot";
  return null;
}

// Given the list of files in a host dir, work out the next free bot slot.
function findNextSlot(files) {
  let max = 0;
  for (const f of files) {
    if (f === "config.json") {
      if (max < 1) max = 1;
      continue;
    }
    const m = f.match(/^config_0*(\d+)\.json$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const index = max + 1;
  return {
    index,
    file: "config_" + String(index).padStart(2, "0") + ".json",
    container: "twitchbotx" + index,
  };
}

function pickDefaultTemplate(files) {
  if (files.includes("config.json")) return "config.json";
  const cfgs = files.filter((f) => FILE_RE.test(f)).sort();
  return cfgs[0] || null;
}

// Same compose-service shape the manual create flow emits (image inherited
// from an existing service, stdout log caps, config + logs volumes).
function addServiceToComposeText(raw, container, file) {
  const yaml = require("js-yaml");
  const doc = yaml.load(raw) || {};
  if (!doc.services || typeof doc.services !== "object") doc.services = {};
  if (doc.services[container]) return { exists: true, text: raw };

  let image = DEFAULT_IMAGE;
  for (const key of Object.keys(doc.services)) {
    const svc = doc.services[key];
    if (svc && typeof svc.image === "string" && svc.image) {
      image = svc.image;
      break;
    }
  }

  doc.services[container] = {
    image,
    container_name: container,
    restart: "always",
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
    volumes: ["./" + file + ":/app/config.json", "./logs:/app/logs"],
  };

  return {
    exists: false,
    text: yaml.dump(doc, { lineWidth: -1, noRefs: true }),
  };
}

// Inverse of addServiceToComposeText — drop one service, leave the rest.
function removeServiceFromComposeText(raw, container) {
  const yaml = require("js-yaml");
  const doc = yaml.load(raw) || {};
  if (
    !doc.services ||
    typeof doc.services !== "object" ||
    !doc.services[container]
  ) {
    return { existed: false, text: raw };
  }
  delete doc.services[container];
  return {
    existed: true,
    text: yaml.dump(doc, { lineWidth: -1, noRefs: true }),
  };
}

// Seats a bot config actually occupies: enabled TwitchUsers entries.
// Disabled accounts (e.g. sold, or switched off after their game ended)
// don't burn RAM in TwitchDropsBot, so their seats are reusable.
function usedSeats(data) {
  const users =
    data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
      ? data.TwitchSettings.TwitchUsers
      : [];
  return users.filter((u) => u && u.Enabled !== false).length;
}

// Turn a pool account row (models/AvailableAccount) into a TwitchUsers entry.
function poolAccountToUser(acc, favouriteGames) {
  const token = String(acc.clientSecret || "").trim();
  if (!token) return null;
  return {
    ClientSecret: token,
    UniqueId: acc.uniqueId || crypto.randomBytes(16).toString("hex"),
    Login: acc.username || "",
    Id: acc.twitchId == null ? "" : String(acc.twitchId),
    Enabled: true,
    FavouriteGames: Array.isArray(favouriteGames) ? favouriteGames.slice() : [],
  };
}

// Mirror deployed accounts into BotAccount + pool bookkeeping — the same
// side effects as the manual flow's upsertBotAccounts.
async function upsertBotAccounts(accounts, host, file) {
  if (!accounts.length) return;
  const ops = accounts.map((u) => ({
    updateOne: {
      filter: { clientSecret: u.ClientSecret },
      update: {
        $set: {
          login: u.Login || "",
          twitchId: u.Id == null ? "" : String(u.Id),
          uniqueId: u.UniqueId || "",
          configFile: file,
          container: containerForFile(file),
          host: host.id,
          enabled: u.Enabled !== false,
        },
      },
      upsert: true,
    },
  }));
  await BotAccount.bulkWrite(ops, { ordered: false }).catch(() => {});
  await fillBotPasswordsFromPool(accounts.map((u) => u.Login)).catch(() => {});
  await markDeployedPoolAccountsClaimed(
    accounts.map((u) => u.Login),
    "auto-farm: deployed to " + containerForFile(file) + " [" + host.id + "]",
  ).catch(() => {});
}

// CREATE one bot on `host` holding `poolAccounts`, farming `game`.
// Follows the manual flow's ordering exactly. Throws on failure (after
// rolling back the config file if the compose edit failed).
async function createBot(host, poolAccounts, game, opts = {}) {
  const startRunning = opts.startRunning !== false;

  const files = await hosts.readdir(host); // throws { unreachable } if host is down
  const composeFile = await hosts.composeName(host);
  if (!composeFile && host.runtime !== "native") {
    throw new Error("No docker compose file found in " + host.dir);
  }

  const slot = findNextSlot(files);
  if (await hosts.exists(host, slot.file)) {
    throw new Error("Target config already exists: " + slot.file);
  }

  const templateName = pickDefaultTemplate(files);
  if (!templateName)
    throw new Error("No template config available to clone from");
  let data;
  try {
    data = JSON.parse(await hosts.readFile(host, templateName));
  } catch {
    throw new Error("Template " + templateName + " is not readable/valid JSON");
  }

  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  const favouriteGames = [game].filter(Boolean);
  const users = poolAccounts
    .map((a) => poolAccountToUser(a, favouriteGames))
    .filter(Boolean);
  if (!users.length) throw new Error("No usable accounts (missing tokens)");
  data.TwitchSettings.TwitchUsers = users;
  // Auto-bots farm exactly one game: pin it so the container never wanders
  // off to farm something we didn't budget accounts for.
  data.TwitchSettings.OnlyFavouriteGames = true;
  if (data.KickSettings && typeof data.KickSettings === "object") {
    data.KickSettings.KickUsers = [];
  }

  await hosts.writeFileAtomic(host, slot.file, JSON.stringify(data, null, 2));
  await upsertBotAccounts(users, host, slot.file);

  try {
    if (composeFile) {
      const raw = await hosts.composeRead(host, composeFile);
      const edited = addServiceToComposeText(raw, slot.container, slot.file);
      if (!edited.exists)
        await hosts.composeWrite(host, composeFile, edited.text);
    }
  } catch (e) {
    // Roll back the config so a failed compose edit leaves no orphan behind.
    try {
      await hosts.rename(
        host,
        slot.file,
        slot.file + ".rollback-" + Date.now(),
      );
    } catch {
      /* ignore */
    }
    throw new Error("Failed to update compose file: " + e.message);
  }

  let started = false;
  let startError = "";
  if (startRunning && users.length) {
    try {
      await hosts.composeUp(host, slot.container);
      started = true;
    } catch (e) {
      startError = e.message || "start failed";
    }
  }

  return {
    host: host.id,
    file: slot.file,
    container: slot.container,
    accountCount: users.length,
    logins: users.map((u) => u.Login),
    config: data,
    started,
    startError,
  };
}

// ADD accounts to an existing bot config (used when topping up a reused bot).
//
// An account already in this config is MERGED, not skipped: `game` is unioned
// into its per-account FavouriteGames (that list is exactly the mechanism that
// lets one container farm several games at once). Returning it as "not added"
// used to be actively harmful — utils/autoFarmer.fillExistingBots left such an
// account in its `remaining` list, which fell through to createBot and paid
// ~130 MB for a brand-new container holding an account that was already
// running. Repeated every tick, that is how one Twitch account ended up
// enabled in 30 containers at once on the Pi, which is both wasted RAM and the
// concurrent-watching pattern that risks the account.
//
// `logins` therefore reports everything that is now farming `game` here,
// merged or fresh, so callers can treat all of it as placed.
async function addAccountsToBot(host, file, poolAccounts, game) {
  const raw = await hosts.readFile(host, file);
  const data = JSON.parse(raw);
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  const existing = Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
  const bySecret = new Map();
  for (const u of existing) {
    const s = String((u && u.ClientSecret) || "").trim();
    if (s) bySecret.set(s, u);
  }

  const favouriteGames = [game].filter(Boolean);
  const wanted = String(game || "")
    .trim()
    .toLowerCase();
  const fresh = [];
  const merged = [];
  for (const acc of poolAccounts) {
    const u = poolAccountToUser(acc, favouriteGames);
    if (!u) continue;
    const prior = bySecret.get(u.ClientSecret);
    if (!prior) {
      fresh.push(u);
      bySecret.set(u.ClientSecret, u); // guard against dupes within one batch
      continue;
    }
    // Already here. Union the game in, and re-enable if it had been retired —
    // this account is being deployed onto this game again.
    const own = Array.isArray(prior.FavouriteGames) ? prior.FavouriteGames : [];
    let touched = false;
    if (wanted && !own.some((g) => String(g).trim().toLowerCase() === wanted)) {
      prior.FavouriteGames = own.concat(favouriteGames);
      touched = true;
    }
    if (prior.Enabled === false) {
      prior.Enabled = true;
      touched = true;
    }
    merged.push({ user: prior, login: prior.Login || u.Login || "", touched });
  }

  const changed = fresh.length || merged.some((m) => m.touched);
  if (changed) {
    data.TwitchSettings.TwitchUsers = existing.concat(fresh);
    await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
    await upsertBotAccounts(
      fresh.concat(merged.map((m) => m.user)),
      host,
      file,
    );
  }
  return {
    added: fresh.length,
    merged: merged.length,
    changed: !!changed,
    data,
    logins: fresh
      .map((u) => u.Login)
      .concat(merged.map((m) => m.login))
      .filter(Boolean),
  };
}

// START / STOP a container (docker start/stop — compose service already exists).
async function startContainer(host, container) {
  return hosts.dockerContainer(host, "start", container);
}
async function stopContainer(host, container) {
  return hosts.dockerContainer(host, "stop", container);
}

// DELETE a finished auto-bot: force-remove the container, drop its compose
// service, and RENAME the config to <file>.done-<ts> — never delete it, the
// account tokens inside must survive for the next event. Best-effort per
// step: a half-deleted bot is still better than a running one, and every
// step's outcome is reported for the audit trail.
async function deleteBot(host, file, container) {
  const steps = [];
  try {
    await hosts.dockerContainer(host, "rm", container);
    steps.push("container removed");
  } catch (e) {
    steps.push("container rm failed: " + (e.message || e));
  }
  try {
    const composeFile = await hosts.composeName(host);
    if (composeFile) {
      const raw = await hosts.composeRead(host, composeFile);
      const edited = removeServiceFromComposeText(raw, container);
      if (edited.existed) {
        await hosts.composeWrite(host, composeFile, edited.text);
        steps.push("compose service removed");
      }
    }
  } catch (e) {
    steps.push("compose edit failed: " + (e.message || e));
  }
  try {
    await hosts.rename(host, file, file + ".done-" + Date.now());
    steps.push("config renamed");
  } catch (e) {
    steps.push("config rename failed: " + (e.message || e));
  }
  // The BotAccount rows are a mirror of the config; with the config gone the
  // accounts are no longer deployed. A mirror left enabled=true makes the
  // recycler treat pool accounts as "still farming" forever (never recycled)
  // and makes seat/coverage math count ghosts.
  try {
    const BotAccount = require("../models/BotAccount");
    await BotAccount.updateMany(
      { host: host.id, configFile: file, enabled: true },
      { $set: { enabled: false } },
    );
    steps.push("mirror disabled");
  } catch (e) {
    steps.push("mirror disable failed: " + (e.message || e));
  }
  return steps.join(", ");
}

module.exports = {
  createBot,
  addAccountsToBot,
  startContainer,
  stopContainer,
  deleteBot,
  containerForFile,
  findNextSlot,
  addServiceToComposeText,
  removeServiceFromComposeText,
  usedSeats,
  poolAccountToUser,
};
