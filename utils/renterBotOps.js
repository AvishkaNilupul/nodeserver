// Shared-bot operations for the renting system. A bot config used to be rented
// to exactly ONE renter, so "stop the renter's farming" meant "stop the
// container". Configs can now be SHARED by several renters (fewer containers =
// less RAM), which makes every container-level action renter-scoped:
//
//   - stopping one renter's farming on a shared bot pulls THEIR accounts out of
//     the config and restarts the container, leaving the other renters farming;
//   - starting it re-adds their accounts and makes sure the container runs;
//   - a games change is applied to their accounts only, never the whole config.
//
// "Who else is on this bot" is decided from the CONFIG FILE, never from which
// renters happen to be assigned to it (2026-10-01). The rent-farm holder
// (operator-selffarm) leaves its paid buyers behind in every stack it fills and
// then points itself at the next one, so a direct renter could look "alone" on
// contabo/config_03 while 49 paying buyers sat in the same file — and its lease
// end would have `docker stop`-ped all of them. So:
//
//   - a stop (the renter's own button, the operator's, suspend, lease end) only
//     ever pulls THIS renter's accounts out of the files they are in; the
//     container is stopped only when the file is then empty, and then with its
//     restart policy cleared, so neither a reboot nor a stray `docker restart`
//     brings an expired renter back (the wasd defect);
//   - a games change writes the whole config only when every account in the
//     file is this renter's; otherwise it touches their accounts alone;
//   - a start re-adds only the accounts that live on the renter's own bot, and
//     never past the stack's capacity.
//
// The pure config-JSON transforms live at the top (exported for tests); the
// IO/orchestration functions below them are what the routes and sweeps call.
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const hosts = require("./botHosts");
const { isBlocked } = require("./renters");
const { withFileLock } = require("./fileLock");
const { CONFIG_RE } = require("./fleetIntegrity");
const { findStack, assertCapacity } = require("./renterBotStacks");

// ---------------------------------------------------------------------------
// Pure config transforms (parsed config JSON in, mutated in place)
// ---------------------------------------------------------------------------

function configUsers(data) {
  if (!data.TwitchSettings || typeof data.TwitchSettings !== "object") {
    data.TwitchSettings = {};
  }
  if (!Array.isArray(data.TwitchSettings.TwitchUsers)) {
    data.TwitchSettings.TwitchUsers = [];
  }
  return data.TwitchSettings.TwitchUsers;
}

// Remove every account whose ClientSecret is in `secrets`. Returns how many
// entries were removed.
function removeUsersBySecret(data, secrets) {
  const set = new Set(secrets);
  const users = configUsers(data);
  const kept = users.filter(
    (u) => !(u && typeof u === "object" && set.has(u.ClientSecret)),
  );
  const removed = users.length - kept.length;
  data.TwitchSettings.TwitchUsers = kept;
  return removed;
}

// Add TwitchUsers entries, skipping any ClientSecret already present (so a
// re-add after an unsuspend can never duplicate an account that was left in
// place). Returns how many were actually added.
function addUsersDedupe(data, entries) {
  const users = configUsers(data);
  const present = new Set(
    users.filter((u) => u && typeof u === "object").map((u) => u.ClientSecret),
  );
  let added = 0;
  for (const e of entries) {
    if (!e || !e.ClientSecret || present.has(e.ClientSecret)) continue;
    users.push(e);
    present.add(e.ClientSecret);
    added += 1;
  }
  return added;
}

// Set FavouriteGames on ONLY the accounts whose ClientSecret is in `secrets`.
// A non-empty list switches the global OnlyFavouriteGames on so it is honoured;
// because that switch is global, any wander-mode co-tenant (empty own + empty
// root) is first pinned to the armed list so it isn't starved to zero games.
// Returns how many of the targeted accounts were updated.
function setUsersGamesBySecret(data, secrets, list) {
  const set = new Set(secrets);
  const users = configUsers(data);
  let updated = 0;
  for (const u of users) {
    if (u && typeof u === "object" && set.has(u.ClientSecret)) {
      u.FavouriteGames = list.slice();
      updated += 1;
    }
  }
  if (list.length && updated) {
    // OnlyFavouriteGames is a GLOBAL switch, but we only armed A's accounts. A
    // co-tenant in wander mode — empty own favourites AND an empty config root,
    // i.e. currently farming everything because the flag was off — would drop
    // to ZERO games the instant we turn the flag on: nothing to inherit, so
    // gamesForUser() returns []. Pin those accounts to the list we're arming so
    // they keep farming SOMETHING (their own renter can re-arm to override).
    // This mirrors the whole-config path, which also stamps the list onto every
    // account. Co-tenants that already carry their own games, or that inherit a
    // non-empty root, are left untouched — the flag never starves them.
    const rootGames = Array.isArray(data.FavouriteGames)
      ? data.FavouriteGames.filter(Boolean)
      : [];
    if (!rootGames.length) {
      for (const u of users) {
        if (!u || typeof u !== "object" || set.has(u.ClientSecret)) continue;
        const own = Array.isArray(u.FavouriteGames)
          ? u.FavouriteGames.filter(Boolean)
          : [];
        if (!own.length) u.FavouriteGames = list.slice();
      }
    }
    data.TwitchSettings.OnlyFavouriteGames = true;
  }
  return updated;
}

// Whole-config games write: the root list, the global switch and every account.
// Only safe when every account in the file belongs to the renter asking for it
// (see applyRenterGames). Mirrors botConfigRoutes' _setConfigGamesUnlocked so
// the Bots page shows the renter's games as the config's "Farming" line.
function setWholeConfigGames(data, list) {
  data.FavouriteGames = list.slice();
  const users = configUsers(data);
  data.TwitchSettings.OnlyFavouriteGames = list.length > 0;
  for (const u of users) {
    if (u && typeof u === "object") u.FavouriteGames = list.slice();
  }
  return users.length;
}

// True when the file has accounts and every one of them is in `secrets`.
function allUsersIn(data, secrets) {
  const set = new Set(secrets);
  const users = configUsers(data).filter((u) => u && typeof u === "object");
  return users.length > 0 && users.every((u) => set.has(u.ClientSecret));
}

// ---------------------------------------------------------------------------
// Sharing queries
// ---------------------------------------------------------------------------

function hostIdOf(value) {
  const h = hosts.resolveHost(value || "");
  return h ? h.id : String(value || "local");
}

// Every OTHER renter on the same config: assigned to it, OR holding enabled
// accounts in it. The second half is what the old query missed — the rent-farm
// holder's buyers stay in a stack long after the holder points elsewhere.
// `activeOnly` filters to renters that are neither suspended nor past their
// lease. Display-only now: stop/games decide from the file itself.
async function otherSharers(renter, { activeOnly = false } = {}) {
  if (!renter.botFile) return [];
  const assigned = await Renter.find({
    _id: { $ne: renter._id },
    botHost: renter.botHost || "",
    botFile: renter.botFile,
  });
  const seen = new Set(assigned.map((r) => String(r._id)));
  let occupantIds = [];
  try {
    occupantIds = await RenterAccount.distinct("renter", {
      renter: { $ne: renter._id },
      host: hostIdOf(renter.botHost),
      configFile: renter.botFile,
      enabled: true,
    });
  } catch {
    occupantIds = [];
  }
  const missing = occupantIds.map(String).filter((id) => !seen.has(id));
  const occupants = missing.length
    ? await Renter.find({ _id: { $in: missing } })
    : [];
  const rows = assigned.concat(occupants);
  return activeOnly ? rows.filter((r) => !isBlocked(r)) : rows;
}

// The renter's enabled account tokens (what "their accounts" means in a config).
async function renterSecrets(renterId) {
  const rows = await RenterAccount.find(
    { renter: renterId, enabled: true },
    { clientSecret: 1 },
  ).lean();
  return rows.map((r) => r.clientSecret).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Renter-scoped farming control
// ---------------------------------------------------------------------------

// Lazily required to avoid a require cycle at module load (botConfigRoutes is a
// route module; this util is also used by sweeps that load before routes).
function cfg() {
  return require("../routes/botConfigRoutes");
}

// Container state for one name: true (running) / false (exists, not running,
// or absent) / null (could not ask the host).
async function containerRunning(host, container) {
  let states;
  try {
    states = await hosts.dockerPs(host);
  } catch {
    return null;
  }
  const st = states && states[container];
  return !!(st && /^running/i.test(String(st.state || "")));
}

// Restart a config's container ONLY if it is running. `docker restart` on a
// stopped container STARTS it — which is how a stopped, expired renter came
// back to life whenever something else on its stack was restarted.
// Returns true when restarted, false when it was not running. Throws when the
// host cannot say whether it is running (the caller retries).
async function restartIfRunning(host, file) {
  const container = cfg().containerForFile(file);
  if (!container) return false;
  const running = await containerRunning(host, container);
  if (running === null) {
    const e = new Error("Could not read container state on " + host.id);
    e.unreachable = true;
    throw e;
  }
  if (!running) return false;
  await cfg().restartConfigContainer(host, file);
  return true;
}

// Every config file on `host` that holds any of `secrets`, from ONE batched
// read. Pointers go stale (a stack moved, a consolidation, an old manual copy),
// so a stop looks where the accounts really are, not only where the ledger says.
// `required` files must be readable; any other unreadable file is skipped.
async function filesHoldingSecrets(host, secrets, required = []) {
  if (!secrets.length) return [];
  const want = new Set(secrets);
  const files = (await hosts.readdir(host, { retries: 1 })).filter((f) =>
    CONFIG_RE.test(f),
  );
  if (!files.length) return [];
  const read = await hosts.readFiles(host, files);
  const out = [];
  for (const f of files) {
    const r = read[f];
    let data = null;
    if (r && r.ok && r.text) {
      try {
        data = JSON.parse(r.text);
      } catch {
        data = null;
      }
    }
    if (!data) {
      if (required.includes(f) && !(r && /not found/i.test(String(r.error || "")))) {
        throw new Error("Could not read " + host.id + "/" + f);
      }
      continue;
    }
    if (configUsers(data).some((u) => u && typeof u === "object" && want.has(u.ClientSecret))) {
      out.push(f);
    }
  }
  return out;
}

// Pull `secrets` out of ONE file under its lock. Remembers each removed
// account's own games so a later start can put them back exactly.
// Returns { removed, remaining, games: Map<secret, string[]>, missing }.
async function detachFromFile(host, file, secrets) {
  return withFileLock(host, file, async () => {
    let data;
    try {
      data = JSON.parse(await hosts.readFile(host, file));
    } catch (e) {
      if (e && e.code === "ENOENT") {
        return { removed: 0, remaining: null, games: new Map(), missing: true };
      }
      throw e;
    }
    const set = new Set(secrets);
    const games = new Map();
    for (const u of configUsers(data)) {
      if (u && typeof u === "object" && set.has(u.ClientSecret)) {
        games.set(
          u.ClientSecret,
          Array.isArray(u.FavouriteGames) ? u.FavouriteGames.filter(Boolean) : [],
        );
      }
    }
    const removed = removeUsersBySecret(data, secrets);
    if (removed) {
      await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
    }
    return {
      removed,
      remaining: configUsers(data).length,
      games,
      missing: false,
    };
  });
}

// After a detach: an EMPTY file's container is stopped with its restart policy
// cleared ("no"), so nothing brings an empty or expired bot back; a file others
// still farm in is reloaded — but only if it is running. `reloadOwed` forces
// the reload even when nothing was removed this time: a previous attempt may
// have removed the accounts and then failed to restart.
async function settleAfterDetach(host, file, det, { reloadOwed = false } = {}) {
  const container = cfg().containerForFile(file);
  if (!container) return "no-container";
  if (det.remaining === 0) {
    await hosts.setRestartPolicy(host, container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", container);
    } catch (e) {
      if (!/no such container/i.test(String((e && e.message) || ""))) throw e;
    }
    return "stopped";
  }
  if (det.removed > 0 || reloadOwed) {
    return (await restartIfRunning(host, file)) ? "restarted" : "left-stopped";
  }
  return "unchanged";
}

// Stop ONE renter's farming: pull THEIR accounts out of every file they are in
// (their own bot, every file their ledger rows name, and any other config on
// those hosts that still carries them), then settle each container (see
// settleAfterDetach). Never stops a container that still holds anyone else.
// Returns { mode: "stopped" | "detached", removed, files: [...] } — "stopped"
// when at least one file ended up empty and its container was stopped.
async function stopRenterFarming(renter, host) {
  const rows = await RenterAccount.find(
    { renter: renter._id, enabled: true },
    { clientSecret: 1, host: 1, configFile: 1 },
  ).lean();
  const secrets = rows.map((r) => r.clientSecret).filter(Boolean);
  const hostIds = [host.id];
  for (const r of rows) {
    const hid = hostIdOf(r.host);
    if (r.configFile && !hostIds.includes(hid)) hostIds.push(hid);
  }
  const files = [];
  let removedTotal = 0;
  let stoppedAny = false;
  const savedGames = new Map();
  for (const hid of hostIds) {
    const h = hid === host.id ? host : hosts.resolveHost(hid);
    if (!h) {
      files.push({ host: hid, file: null, error: "unknown host" });
      continue;
    }
    // Files the ledger says this renter farms in (reload owed if they did).
    const recorded = new Set(
      rows
        .filter((r) => r.configFile && hostIdOf(r.host) === h.id)
        .map((r) => r.configFile),
    );
    const expected = new Set(recorded);
    if (h.id === host.id && renter.botFile) expected.add(renter.botFile);
    const found = await filesHoldingSecrets(h, secrets, [...expected]);
    const targets = [...new Set([...expected, ...found])];
    for (const file of targets) {
      if (!cfg().validFile(file)) continue;
      const det = await detachFromFile(h, file, secrets);
      if (det.missing) {
        files.push({ host: h.id, file, missing: true });
        continue;
      }
      for (const [s, g] of det.games) savedGames.set(s, g);
      removedTotal += det.removed;
      const action = await settleAfterDetach(h, file, det, {
        reloadOwed: recorded.has(file),
      });
      if (action === "stopped") stoppedAny = true;
      files.push({
        host: h.id,
        file,
        removed: det.removed,
        remaining: det.remaining,
        action,
      });
    }
  }
  // Keep each account's own games for the next start (best effort — the stop
  // itself has already happened and must not be reported as failed).
  if (savedGames.size) {
    const ops = [...savedGames.entries()]
      .filter(([, g]) => g.length)
      .map(([secret, g]) => ({
        updateOne: {
          filter: { renter: renter._id, clientSecret: secret },
          update: { $set: { favouriteGames: g } },
        },
      }));
    if (ops.length) {
      await RenterAccount.bulkWrite(ops, { ordered: false }).catch((e) =>
        console.error("[renterBotOps] save games on stop:", e.message),
      );
    }
  }
  return { mode: stoppedAny ? "stopped" : "detached", removed: removedTotal, files };
}

// Start ONE renter's farming: put back any of THEIR accounts that belong on
// their own bot (ledger row pointing at renter.botFile, or never placed) and
// are missing from it, within the stack's capacity, then make sure the
// container is running. An account the ledger places in ANOTHER file is left
// alone — re-adding it here would farm it in two bots (and, for the rent-farm
// holder, used to copy every paid buyer into one config).
// Returns { added, running: true }.
async function startRenterFarming(renter, host) {
  const rows = await RenterAccount.find({
    renter: renter._id,
    enabled: true,
  }).lean();
  const home = renter.botFile;
  const mine = rows.filter(
    (a) =>
      a.clientSecret &&
      (!a.configFile || (a.configFile === home && hostIdOf(a.host) === host.id)),
  );
  let added = 0;
  const addedSecrets = [];
  if (mine.length) {
    const stack = await findStack(host.id, home);
    // Lock the read→mutate→write: two renters re-armed on one shared config at
    // once must not lose each other's re-added accounts.
    added = await withFileLock(host, home, async () => {
      const data = JSON.parse(await hosts.readFile(host, home));
      const users = configUsers(data);
      const present = new Set(
        users.filter((u) => u && typeof u === "object").map((u) => u.ClientSecret),
      );
      const missing = mine.filter((a) => !present.has(a.clientSecret));
      if (!missing.length) return 0;
      if (stack) assertCapacity(users.length, missing.length, stack.capacity);
      const rootGames = Array.isArray(data.FavouriteGames)
        ? data.FavouriteGames.filter(Boolean)
        : [];
      const renterGames =
        Array.isArray(renter.farmGames) && renter.farmGames.length
          ? renter.farmGames
          : rootGames;
      const n = addUsersDedupe(
        data,
        missing.map((a) => {
          const own = Array.isArray(a.favouriteGames)
            ? a.favouriteGames.filter(Boolean)
            : [];
          return {
            ClientSecret: a.clientSecret,
            UniqueId: a.uniqueId || "",
            Login: a.login || "",
            Id: a.twitchId || "",
            Enabled: true,
            FavouriteGames: (own.length ? own : renterGames).slice(),
          };
        }),
      );
      if (n) {
        await hosts.writeFileAtomic(host, home, JSON.stringify(data, null, 2));
        for (const a of missing) addedSecrets.push(a.clientSecret);
      }
      return n;
    });
    if (added) {
      // Repoint ONLY what was just put back, never the renter's whole ledger.
      await RenterAccount.updateMany(
        { renter: renter._id, clientSecret: { $in: addedSecrets } },
        { $set: { configFile: home, host: host.id } },
      ).catch(() => {});
    }
  }
  // A start on an already-running container is a no-op, so note whether it was
  // running first: accounts re-added to a live bot need a restart to load.
  let wasRunning = false;
  try {
    const states = await hosts.dockerPs(host);
    const st = states[cfg().containerForFile(home)];
    wasRunning = !!(st && /^running/i.test(st.state || ""));
  } catch {
    wasRunning = false;
  }
  await cfg().startConfigContainer(host, home);
  if (added && wasRunning) {
    await cfg()
      .restartConfigContainer(host, home)
      .catch(() => {});
  }
  return { added, running: true };
}

// Apply a games list for ONE renter. Decided under the file lock from what is
// really in the file: when every account there is this renter's, the whole
// config is written (root list + switch, shows as "Farming" in the Bots UI);
// otherwise only their accounts change, so nobody else is ever re-gamed.
// Returns { scope: "config" | "own-accounts", games }.
async function applyRenterGames(renter, host, games) {
  if (!cfg().validFile(renter.botFile)) throw new Error("Invalid config file");
  const list = cfg()
    .parseGamesList(games)
    .slice(0, 50)
    .map((g) => g.slice(0, 100));
  const secrets = await renterSecrets(renter._id);
  let scope = "own-accounts";
  await withFileLock(host, renter.botFile, async () => {
    const data = JSON.parse(await hosts.readFile(host, renter.botFile));
    if (allUsersIn(data, secrets)) {
      scope = "config";
      setWholeConfigGames(data, list);
    } else {
      setUsersGamesBySecret(data, secrets, list);
    }
    await hosts.writeFileAtomic(
      host,
      renter.botFile,
      JSON.stringify(data, null, 2),
    );
  });
  return { scope, games: list };
}

module.exports = {
  // pure (tested)
  removeUsersBySecret,
  addUsersDedupe,
  setUsersGamesBySecret,
  setWholeConfigGames,
  allUsersIn,
  // queries
  otherSharers,
  renterSecrets,
  // ops
  stopRenterFarming,
  startRenterFarming,
  applyRenterGames,
  restartIfRunning,
  filesHoldingSecrets,
  detachFromFile,
  settleAfterDetach,
};
