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
// A renter alone on a config keeps the old behaviour (whole-container
// start/stop, whole-config games) so nothing changes for existing setups.
//
// The pure config-JSON transforms live at the top (exported for tests); the
// IO/orchestration functions below them are what the routes and sweeps call.
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const hosts = require("./botHosts");
const { isBlocked } = require("./renters");
const { withFileLock } = require("./fileLock");

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

// ---------------------------------------------------------------------------
// Sharing queries
// ---------------------------------------------------------------------------

// Every OTHER renter assigned to the same config. `activeOnly` filters to
// renters that are neither suspended nor past their lease — the ones whose
// farming a container stop would actually hurt.
async function otherSharers(renter, { activeOnly = false } = {}) {
  if (!renter.botFile) return [];
  const rows = await Renter.find({
    _id: { $ne: renter._id },
    botHost: renter.botHost || "",
    botFile: renter.botFile,
  });
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

// Stop ONE renter's farming. Alone on the config -> stop the container (old
// behaviour). Shared with other active renters -> pull only their accounts out
// of the config and restart it so the others keep farming.
// Returns { mode: "stopped" | "detached", removed }.
async function stopRenterFarming(renter, host) {
  const others = await otherSharers(renter, { activeOnly: true });
  if (!others.length) {
    await cfg().stopConfigContainer(host, renter.botFile);
    return { mode: "stopped", removed: 0 };
  }
  const secrets = await renterSecrets(renter._id);
  let removed = 0;
  if (secrets.length) {
    // Lock the read→mutate→write so a co-tenant armed on the same shared config
    // at the same instant can't clobber this removal (or vice versa). Container
    // ops stay OUTSIDE the lock — they don't touch the config file.
    removed = await withFileLock(host, renter.botFile, async () => {
      const data = JSON.parse(await hosts.readFile(host, renter.botFile));
      const n = removeUsersBySecret(data, secrets);
      if (n) {
        await hosts.writeFileAtomic(
          host,
          renter.botFile,
          JSON.stringify(data, null, 2),
        );
      }
      return n;
    });
    if (removed) {
      await cfg()
        .restartConfigContainer(host, renter.botFile)
        .catch(() => {});
    }
  }
  return { mode: "detached", removed };
}

// Start ONE renter's farming: put any of their enabled accounts that are
// missing back into the config (they are pulled on suspend/expiry when the bot
// is shared), then make sure the container is running. Games for re-added
// accounts follow the renter's own farmGames when set, else the config's.
// Returns { added, running: true }.
async function startRenterFarming(renter, host) {
  const rows = await RenterAccount.find({
    renter: renter._id,
    enabled: true,
  }).lean();
  let added = 0;
  if (rows.length) {
    // Lock the read→mutate→write: two renters re-armed on one shared config at
    // once must not lose each other's re-added accounts.
    added = await withFileLock(host, renter.botFile, async () => {
      const data = JSON.parse(await hosts.readFile(host, renter.botFile));
      const games =
        Array.isArray(renter.farmGames) && renter.farmGames.length
          ? renter.farmGames
          : Array.isArray(data.FavouriteGames)
            ? data.FavouriteGames.filter(Boolean)
            : [];
      const n = addUsersDedupe(
        data,
        rows.map((a) => ({
          ClientSecret: a.clientSecret,
          UniqueId: a.uniqueId || "",
          Login: a.login || "",
          Id: a.twitchId || "",
          Enabled: true,
          FavouriteGames: games.slice(),
        })),
      );
      if (n) {
        await hosts.writeFileAtomic(
          host,
          renter.botFile,
          JSON.stringify(data, null, 2),
        );
      }
      return n;
    });
    if (added) {
      await RenterAccount.updateMany(
        { renter: renter._id, enabled: true },
        { $set: { configFile: renter.botFile, host: host.id } },
      ).catch(() => {});
    }
  }
  // A start on an already-running container is a no-op, so note whether it was
  // running first: accounts re-added to a live bot need a restart to load.
  let wasRunning = false;
  try {
    const states = await hosts.dockerPs(host);
    const st = states[cfg().containerForFile(renter.botFile)];
    wasRunning = !!(st && /^running/i.test(st.state || ""));
  } catch {
    wasRunning = false;
  }
  await cfg().startConfigContainer(host, renter.botFile);
  if (added && wasRunning) {
    await cfg()
      .restartConfigContainer(host, renter.botFile)
      .catch(() => {});
  }
  return { added, running: true };
}

// Apply a games list for ONE renter. Alone on the config -> whole-config write
// (old behaviour, shows as "Farming" in the Bots UI). Shared -> scoped to their
// accounts only, so one renter can never overwrite another's games.
// Returns { scope: "config" | "own-accounts", games }.
async function applyRenterGames(renter, host, games) {
  const others = await otherSharers(renter, { activeOnly: true });
  if (!others.length) {
    // Alone on the config: the public setConfigGames takes the file lock itself.
    // This branch holds NO lock, so that single acquisition can't self-deadlock
    // (the per-file lock is non-reentrant).
    const list = await cfg().setConfigGames(host, renter.botFile, games);
    return { scope: "config", games: list };
  }
  const list = (Array.isArray(games) ? games : String(games || "").split(","))
    .map((g) => String(g).trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((g) => g.slice(0, 100));
  const secrets = await renterSecrets(renter._id);
  // Shared config: scope the write to this renter's accounts, under the file
  // lock so a co-tenant's simultaneous games change can't clobber it.
  await withFileLock(host, renter.botFile, async () => {
    const data = JSON.parse(await hosts.readFile(host, renter.botFile));
    setUsersGamesBySecret(data, secrets, list);
    await hosts.writeFileAtomic(
      host,
      renter.botFile,
      JSON.stringify(data, null, 2),
    );
  });
  return { scope: "own-accounts", games: list };
}

module.exports = {
  // pure (tested)
  removeUsersBySecret,
  addUsersDedupe,
  setUsersGamesBySecret,
  // queries
  otherSharers,
  renterSecrets,
  // ops
  stopRenterFarming,
  startRenterFarming,
  applyRenterGames,
};
