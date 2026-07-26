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
    started,
    startError,
  };
}

// ADD accounts to an existing bot config (used when topping up a reused bot).
async function addAccountsToBot(host, file, poolAccounts, game) {
  const raw = await hosts.readFile(host, file);
  const data = JSON.parse(raw);
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  const existing = Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
  const have = new Set(
    existing
      .map((u) => String((u && u.ClientSecret) || "").trim())
      .filter(Boolean),
  );
  const favouriteGames = [game].filter(Boolean);
  const fresh = poolAccounts
    .map((a) => poolAccountToUser(a, favouriteGames))
    .filter((u) => u && !have.has(u.ClientSecret));
  if (!fresh.length) return { added: 0, logins: [] };
  data.TwitchSettings.TwitchUsers = existing.concat(fresh);
  await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
  await upsertBotAccounts(fresh, host, file);
  return { added: fresh.length, logins: fresh.map((u) => u.Login) };
}

// START / STOP a container (docker start/stop — compose service already exists).
async function startContainer(host, container) {
  return hosts.dockerContainer(host, "start", container);
}
async function stopContainer(host, container) {
  return hosts.dockerContainer(host, "stop", container);
}

module.exports = {
  createBot,
  addAccountsToBot,
  startContainer,
  stopContainer,
  containerForFile,
  findNextSlot,
  addServiceToComposeText,
  poolAccountToUser,
};
