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
const { isBlocked, isOperatorHolder } = require("./renters");
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
    // Co-tenants that already carry their own games, or that inherit a
    // non-empty root, are left untouched — the flag never starves them.
    //
    // ONLY when this call is what flips the switch on. With the switch already
    // on, a blank co-tenant is not in wander mode — and pinning it anyway is how
    // one renter's games change (or the next rent-farm sale) re-gamed accounts
    // that were never theirs (2026-10-01 review).
    const rootGames = Array.isArray(data.FavouriteGames)
      ? data.FavouriteGames.filter(Boolean)
      : [];
    const wasOn = data.TwitchSettings.OnlyFavouriteGames === true;
    if (!rootGames.length && !wasOn) {
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
// host cannot say whether it is running, or when restarts are disabled on this
// server (a reload that never happened must not be reported as done).
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
  const r = await cfg().restartConfigContainer(host, file);
  if (r && r.restarted === false) {
    const e = new Error("Container restarts are disabled on this server — " + file + " was not reloaded");
    e.code = "disabled";
    throw e;
  }
  return true;
}

// ---- owed reloads (models/PendingReload) ----------------------------------
function pendingReload() {
  return require("../models/PendingReload");
}
async function markReloadOwed(host, file, reason) {
  await pendingReload()
    .updateOne(
      { host: host.id, file },
      { $setOnInsert: { host: host.id, file, since: new Date() }, $set: { reason: String(reason || "").slice(0, 200) } },
      { upsert: true },
    )
    .catch((e) => console.error("[renterBotOps] mark reload owed:", e.message));
}
async function clearReloadOwed(host, file) {
  await pendingReload()
    .deleteOne({ host: host.id, file })
    .catch((e) => console.error("[renterBotOps] clear reload owed:", e.message));
}
async function isReloadOwed(host, file) {
  const row = await pendingReload().findOne({ host: host.id, file }, { _id: 1 }).lean().catch(() => null);
  return !!row;
}

// Where each of `secrets` really is on `host`: Map<file, Set<secret>>, from ONE
// batched read of every config there. Pointers go stale (a stack moved, a
// consolidation, an old manual copy), so a stop looks where the accounts
// really are, not only where the ledger says. A config that cannot be read or
// parsed FAILS the call (a secret in it could survive a "successful" stop);
// only a file that is simply gone is skipped.
async function locateSecrets(host, secrets) {
  const out = new Map();
  if (!secrets.length) return out;
  const want = new Set(secrets);
  const files = (await hosts.readdir(host, { retries: 1 })).filter((f) =>
    CONFIG_RE.test(f),
  );
  if (!files.length) return out;
  const read = await hosts.readFiles(host, files);
  for (const f of files) {
    const r = read[f];
    if (!r || !r.ok) {
      if (r && /not found/i.test(String(r.error || ""))) continue;
      throw new Error("Could not read " + host.id + "/" + f + ": " + ((r && r.error) || "no answer"));
    }
    let data;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new Error("Unparseable config " + host.id + "/" + f);
    }
    for (const u of configUsers(data)) {
      if (u && typeof u === "object" && want.has(u.ClientSecret)) {
        if (!out.has(f)) out.set(f, new Set());
        out.get(f).add(u.ClientSecret);
      }
    }
  }
  return out;
}

// Every config file on `host` that holds any of `secrets` (see locateSecrets).
async function filesHoldingSecrets(host, secrets) {
  return [...(await locateSecrets(host, secrets)).keys()];
}

// Pull `secrets` out of ONE file, under its lock, and settle the container in
// the SAME critical section when that left the file empty: stopped, restart
// policy "no", so nothing brings an empty (or expired) bot back. Deciding
// "empty" inside the lock is what stops a sale that lands a buyer in the gap
// from being killed by a stop decided on stale data. A file that still holds
// accounts is marked "reload owed" when anything was removed (settle below
// does the reload, outside the lock). Remembers each removed account's own
// games so a later start can put them back exactly.
// Returns { removed, remaining, games: Map<secret,string[]>, missing, stopped }.
async function detachFromFile(host, file, secrets) {
  return withFileLock(host, file, async () => {
    let data;
    try {
      data = JSON.parse(await hosts.readFile(host, file));
    } catch (e) {
      if (e && e.code === "ENOENT") {
        return { removed: 0, remaining: null, games: new Map(), missing: true, stopped: false };
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
    const remaining = configUsers(data).length;
    let stopped = false;
    if (remaining === 0) {
      const container = cfg().containerForFile(file);
      if (container) {
        await hosts.setRestartPolicy(host, container, "no").catch((e) =>
          console.error("[renterBotOps] could not clear restart policy of " + container + ":", e.message),
        );
        try {
          await hosts.dockerContainer(host, "stop", container);
        } catch (e) {
          if (!/no such container/i.test(String((e && e.message) || ""))) throw e;
        }
        stopped = true;
      }
    } else if (removed) {
      await markReloadOwed(host, file, "accounts removed");
    }
    return { removed, remaining, games, missing: false, stopped };
  });
}

// After a detach, reload a file's bot when that is owed — something was just
// removed from it, or a reload failed earlier (PendingReload) — and only if it
// is running (a stopped bot reads the new config whenever it next starts).
// Nothing removed and nothing owed = nothing restarted. A reload that fails
// stays owed and the error propagates (the caller retries).
async function settleAfterDetach(host, file, det) {
  if (det.missing) return "missing";
  if (det.stopped) {
    await clearReloadOwed(host, file);
    return "stopped";
  }
  const owed = det.removed > 0 || (await isReloadOwed(host, file));
  if (!owed) return "unchanged";
  const restarted = await restartIfRunning(host, file); // throws => stays owed
  await clearReloadOwed(host, file);
  return restarted ? "restarted" : "left-stopped";
}

// Stop ONE renter's farming: pull THEIR accounts out of every config they are
// in on the hosts involved (their own bot's host plus every host their ledger
// rows name) — found by one batched read per host, so a stale pointer cannot
// hide one — then settle each file (see settleAfterDetach). Never stops a
// container that still holds anyone else; never starts one.
// Throws (the caller retries) when a host cannot be read or a ledger row names
// an unknown host: a stop that cannot be verified is not reported as done.
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
  const unknown = hostIds.filter((hid) => hid !== host.id && !hosts.resolveHost(hid));
  if (unknown.length) {
    throw new Error(
      "Renter " + renter.username + " has accounts on unknown bot host(s) " + unknown.join(", ") +
        " — cannot verify they were pulled",
    );
  }
  const files = [];
  let removedTotal = 0;
  let stoppedAny = false;
  const savedGames = new Map();
  for (const hid of hostIds) {
    const h = hid === host.id ? host : hosts.resolveHost(hid);
    const located = await locateSecrets(h, secrets);
    const targets = new Set(located.keys());
    if (h.id === host.id && renter.botFile) targets.add(renter.botFile);
    for (const r of rows) if (r.configFile && hostIdOf(r.host) === h.id) targets.add(r.configFile);
    for (const file of targets) {
      if (!cfg().validFile(file)) continue;
      const det = await detachFromFile(h, file, secrets);
      if (det.missing) {
        files.push({ host: h.id, file, missing: true });
        continue;
      }
      for (const [sec, g] of det.games) savedGames.set(sec, g);
      removedTotal += det.removed;
      const action = await settleAfterDetach(h, file, det);
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
  // Keep each pulled account's own games for the next start — and FORGET a
  // saved list when the account had none, so an older one cannot come back.
  // Best effort: the stop itself has happened and must not be reported failed.
  if (savedGames.size) {
    const ops = [...savedGames.entries()].map(([secret, g]) => ({
      updateOne: {
        filter: { renter: renter._id, clientSecret: secret },
        update: g.length ? { $set: { favouriteGames: g } } : { $unset: { favouriteGames: "" } },
      },
    }));
    await RenterAccount.bulkWrite(ops, { ordered: false }).catch((e) =>
      console.error("[renterBotOps] save games on stop:", e.message),
    );
  }
  return { mode: stoppedAny ? "stopped" : "detached", removed: removedTotal, files };
}

// Start ONE renter's farming: put back each of THEIR enabled accounts that is
// on no config of the host, into the file its ledger row names (or the
// renter's own bot when it names none, or names a file that no longer exists),
// as many as each stack's capacity allows, then make sure the renter's bot is
// running (and reload any other file that got accounts back).
//   - an account already in some config on the host is NOT re-added (it would
//     farm in two bots); its ledger row is pointed at where it really is;
//   - only rows actually put back are re-pointed;
//   - capacity is per file and partial: what does not fit is reported, and the
//     call only fails when NOTHING could be put back.
// Returns { added, skipped, running: true }.
async function startRenterFarming(renter, host) {
  const home = renter.botFile;
  // The rent-farm holder's accounts are paid buyers, each placed per order:
  // a start on its behalf (a manual add onto its stack) only ever touches its
  // CURRENT stack's own rows — it never re-homes or restores the rest.
  const holder = isOperatorHolder(renter);
  const rows = (
    await RenterAccount.find({ renter: renter._id, enabled: true }).lean()
  ).filter((a) =>
    a.clientSecret &&
    (holder
      ? a.configFile === home && hostIdOf(a.host) === host.id
      : !a.configFile || hostIdOf(a.host) === host.id),
  );
  let added = 0;
  const skipped = [];
  const touched = new Set();
  if (rows.length) {
    const located = await locateSecrets(host, rows.map((a) => a.clientSecret));
    const where = new Map();
    for (const [f, set] of located) for (const sec of set) if (!where.has(sec)) where.set(sec, f);
    // Already placed somewhere: fix the pointer if it is stale, add nothing.
    for (const a of rows) {
      const f = where.get(a.clientSecret);
      if (f && (a.configFile !== f || hostIdOf(a.host) !== host.id)) {
        await RenterAccount.updateOne(
          { _id: a._id },
          { $set: { configFile: f, host: host.id, container: cfg().containerForFile(f) || "" } },
        ).catch(() => {});
      }
    }
    const missing = rows.filter((a) => !where.has(a.clientSecret));
    const existing = new Set(
      (await hosts.readdir(host, { retries: 1 })).filter((f) => CONFIG_RE.test(f)),
    );
    const byFile = new Map();
    for (const a of missing) {
      const target = a.configFile && (existing.has(a.configFile) || holder) ? a.configFile : home;
      if (!byFile.has(target)) byFile.set(target, []);
      byFile.get(target).push(a);
    }
    for (const [file, accts] of byFile) {
      const stack = await findStack(host.id, file);
      const put = await withFileLock(host, file, async () => {
        const data = JSON.parse(await hosts.readFile(host, file));
        const users = configUsers(data);
        const present = new Set(
          users.filter((u) => u && typeof u === "object").map((u) => u.ClientSecret),
        );
        let fresh = accts.filter((a) => !present.has(a.clientSecret));
        if (stack) {
          const room = Math.max(0, Number(stack.capacity) - users.length);
          for (const a of fresh.slice(room)) {
            skipped.push({ login: a.login || "", file, reason: "stack " + file + " is full (" + users.length + "/" + stack.capacity + ")" });
          }
          fresh = fresh.slice(0, room);
        }
        if (!fresh.length) return [];
        const rootGames = Array.isArray(data.FavouriteGames) ? data.FavouriteGames.filter(Boolean) : [];
        const renterGames =
          Array.isArray(renter.farmGames) && renter.farmGames.length ? renter.farmGames : rootGames;
        addUsersDedupe(
          data,
          fresh.map((a) => {
            const own = Array.isArray(a.favouriteGames) ? a.favouriteGames.filter(Boolean) : [];
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
        await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
        return fresh;
      });
      if (put.length) {
        added += put.length;
        touched.add(file);
        // Repoint ONLY what was just put back, never the renter's whole ledger.
        await RenterAccount.updateMany(
          { renter: renter._id, clientSecret: { $in: put.map((a) => a.clientSecret) } },
          { $set: { configFile: file, host: host.id, container: cfg().containerForFile(file) || "" } },
        ).catch(() => {});
      }
    }
    if (missing.length && !added) {
      const e = new Error(
        skipped.length
          ? "No room to put this renter's accounts back: " + skipped[0].reason + "."
          : "None of this renter's accounts could be put back.",
      );
      e.code = "rental_stack_full";
      throw e;
    }
  }
  // The renter's own bot must be running; any OTHER file that got accounts
  // back is reloaded if running (it keeps whatever state it was in otherwise).
  let wasRunning = false;
  try {
    const states = await hosts.dockerPs(host);
    const st = states[cfg().containerForFile(home)];
    wasRunning = !!(st && /^running/i.test(st.state || ""));
  } catch {
    wasRunning = false;
  }
  await cfg().startConfigContainer(host, home);
  if (touched.has(home) && wasRunning) {
    await cfg().restartConfigContainer(host, home).catch(() => {});
  }
  for (const f of touched) {
    if (f === home) continue;
    await restartIfRunning(host, f).catch((e) =>
      console.error("[renterBotOps] reload " + f + " after start:", e.message),
    );
  }
  return { added, skipped, running: true };
}

// Apply a games list for ONE renter. Decided under the file lock from what is
// really in the file: when every account there is this renter's, the whole
// config is written (root list + switch, shows as "Farming" in the Bots UI);
// otherwise only their accounts change. Any per-account games saved by an
// earlier stop are forgotten, so the next start uses THIS list.
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
  await RenterAccount.updateMany(
    { renter: renter._id, favouriteGames: { $exists: true } },
    { $unset: { favouriteGames: "" } },
  ).catch((e) => console.error("[renterBotOps] forget saved games:", e.message));
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
  locateSecrets,
  filesHoldingSecrets,
  detachFromFile,
  settleAfterDetach,
  markReloadOwed,
  isReloadOwed,
};
