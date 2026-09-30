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

// Restart a config's container ONLY if it is running AND its config still has
// accounts. `docker restart` on a stopped container STARTS it — which is how a
// stopped, expired renter came back to life whenever something else on its
// stack was restarted. Decided under the file lock, re-reading the file, so a
// concurrent stop that just emptied it cannot be undone by a restart; an EMPTY
// file whose container runs is stopped for good instead (restart policy "no":
// an accountless bot spins in a login-retry loop).
// Returns true when restarted, false when it was not running. Throws when the
// host cannot say whether it is running, or when restarts are disabled on this
// server (a reload that never happened must not be reported as done).
async function restartIfRunning(host, file) {
  const container = cfg().containerForFile(file);
  if (!container) return false;
  return withFileLock(host, file, async () => {
    let users = null;
    try {
      users = configUsers(JSON.parse(await hosts.readFile(host, file))).length;
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
      return false; // no file, nothing to reload
    }
    const running = await containerRunning(host, container);
    if (running === null) {
      const e = new Error("Could not read container state on " + host.id);
      e.unreachable = true;
      throw e;
    }
    if (!running) return false;
    if (users === 0) {
      // Stopped for good. Either step failing is thrown, so the caller keeps
      // the reload owed: a failed policy clear is recorded as such (the
      // sweeper re-applies it even once the bot is stopped — a reboot would
      // otherwise start this accountless bot).
      let policyErr = null;
      await hosts.setRestartPolicy(host, container, "no").catch((e) => {
        policyErr = e;
      });
      if (policyErr) await markReloadOwed(host, file, "restart-policy");
      await hosts.dockerContainer(host, "stop", container);
      if (policyErr) throw policyErr;
      return false;
    }
    const r = await cfg().restartConfigContainer(host, file);
    if (r && r.restarted === false) {
      const e = new Error("Container restarts are disabled on this server — " + file + " was not reloaded");
      e.code = "disabled";
      throw e;
    }
    return true;
  });
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

// Retry every owed reload, whoever recorded it (a stop, a lapsed window, a
// start that failed after writing) — not only when something happens to touch
// the same file again. Each is settled like any other: reloaded if running,
// a file left empty stopped with restart policy "no". A reload that stays owed
// past PAGE_AFTER_MS pages once, then at most every REPAGE_MS. Run from the
// renter expiry tick (every 5 min); entries younger than `minAgeMs` are left
// to the operation that is still settling them.
const OWED_PAGE_AFTER_MS = 30 * 60 * 1000;
const OWED_REPAGE_MS = 6 * 60 * 60 * 1000;
async function sweepPendingReloads({ minAgeMs = 2 * 60 * 1000, notify = true } = {}) {
  const now = Date.now();
  const rows = await pendingReload()
    .find({ since: { $lte: new Date(now - minAgeMs) } })
    .sort({ since: 1 })
    .limit(50)
    .lean();
  const out = { settled: 0, failed: 0, paged: 0 };
  for (const row of rows) {
    const host = hosts.resolveHost(row.host);
    let err = "";
    if (!host) {
      err = "unknown host '" + row.host + "'";
    } else {
      try {
        // restartIfRunning also stops a running bot whose file is empty, so a
        // failed restart-policy clear ("restart-policy") is settled the same way.
        const container = cfg().containerForFile(row.file);
        if (/restart-policy/.test(row.reason || "") && container) {
          await hosts.setRestartPolicy(host, container, "no");
        }
        await restartIfRunning(host, row.file);
        await clearReloadOwed(host, row.file);
        out.settled++;
        continue;
      } catch (e) {
        err = String((e && e.message) || e).slice(0, 200);
      }
    }
    out.failed++;
    const pageDue =
      now - new Date(row.since).getTime() >= OWED_PAGE_AFTER_MS &&
      (!row.alertedAt || now - new Date(row.alertedAt).getTime() >= OWED_REPAGE_MS);
    await pendingReload()
      .updateOne(
        { _id: row._id },
        { $inc: { attempts: 1 }, $set: { lastError: err, ...(pageDue && notify ? { alertedAt: new Date() } : {}) } },
      )
      .catch(() => {});
    if (pageDue && notify) {
      out.paged++;
      await require("./telegram")
        .sendTelegram(
          "🚨 Bot " + row.host + "/" + row.file + " still has to reload (" + (row.reason || "accounts removed") +
            ") and cannot: " + err + ". Until it does, accounts taken out of its config keep " +
            "farming (bots read their config only at startup). Retrying every 5 min.",
        )
        .catch(() => {});
    }
  }
  return out;
}

// The config files on `host` that must be readable for a stop / locate to be
// trusted: every registered rental stack there. Any other operator config
// that cannot be read is skipped with a warning (one corrupt operator config
// must not block every renter on the host).
async function stackFilesOn(hostId) {
  try {
    const rows = await require("../models/RenterBotStack")
      .find({ host: hostId, enabled: true }, { file: 1 })
      .lean();
    return rows.map((r) => r.file);
  } catch {
    return [];
  }
}

// Slots in `file` held for accounts that belong there but are not in it right
// now: an ACTIVE direct renter's enabled, live rows recorded in the file whose
// token is not physically present (the renter pressed Stop, or a stop is
// half-done). Another renter's add, or a sale, must not fill them — that
// renter's next Start would fail "stack full". The rent-farm holder's rows
// reserve nothing (a buyer not in its file has lapsed or moved), nor do a
// blocked (suspended / expired) renter's, nor lapsed windows. `except` is the
// renter whose own accounts are being put back (its reservation is what it is
// using). The same rule as the stack pickers (renterAdminRoutes
// rentalStackOptions). Fail-open: a failed read reserves nothing.
async function reservedSlots(hostId, file, presentSecrets, { except = null } = {}) {
  try {
    const hid = hostIdOf(hostId);
    const rows = await RenterAccount.find(
      {
        enabled: true,
        farmEndedAt: null,
        configFile: file,
        host: hid === "local" ? { $in: ["local", "", null] } : hid,
      },
      { renter: 1, clientSecret: 1, farmUntil: 1 },
    ).lean();
    const now = Date.now();
    const present = presentSecrets instanceof Set ? presentSecrets : new Set(presentSecrets || []);
    const candidates = rows.filter(
      (r) =>
        r.clientSecret &&
        !present.has(r.clientSecret) &&
        String(r.renter) !== String(except || "") &&
        !(r.farmUntil && new Date(r.farmUntil).getTime() <= now),
    );
    if (!candidates.length) return 0;
    const owners = await Renter.find(
      { _id: { $in: [...new Set(candidates.map((r) => String(r.renter)))] } },
      { username: 1, usernameLower: 1, status: 1, accessEnd: 1 },
    ).lean();
    const reserving = new Set(
      owners.filter((o) => !isOperatorHolder(o) && !isBlocked(o)).map((o) => String(o._id)),
    );
    return candidates.filter((r) => reserving.has(String(r.renter))).length;
  } catch (e) {
    console.error("[renterBotOps] reserved slots of " + file + " (counting none):", e.message);
    return 0;
  }
}

// Where each of `secrets` really is on `host`: Map<file, Set<secret>>, from ONE
// batched read of every config there. Pointers go stale (a stack moved, a
// consolidation, an old manual copy), so a stop looks where the accounts
// really are, not only where the ledger says.
//   - a registered rental stack, or a file in `mustRead`, that cannot be read
//     or parsed is a PROBLEM (a secret in it could survive a "successful"
//     stop). The remote batch reports any unreadable file as "Not found", so
//     for a file readdir just listed that counts as unreadable too;
//   - any other unreadable config (an operator's own bot) is skipped with a
//     warning: one corrupt operator file must not block every renter's stop
//     on the host;
//   - a secret found in a config this server cannot edit (a name validFile
//     rejects, e.g. config_03-backup.json) is logged and left alone: no bot
//     reads such a file (containers map only config_NN.json / config.json),
//     so it is not farming from there.
// Problems THROW, unless the caller passes a `problems` array to collect them
// in — a stop does, so it can pull what it can reach first and fail after.
async function locateSecrets(host, secrets, { mustRead = [], problems = null } = {}) {
  const out = new Map();
  if (!secrets.length) return out;
  const want = new Set(secrets);
  const must = new Set([...(await stackFilesOn(host.id)), ...mustRead]);
  const files = (await hosts.readdir(host, { retries: 1 })).filter((f) =>
    CONFIG_RE.test(f),
  );
  if (!files.length) return out;
  const read = await hosts.readFiles(host, files);
  const problem = (msg) => {
    if (!problems) throw new Error(msg);
    problems.push(msg);
  };
  for (const f of files) {
    const r = read[f];
    let data = null;
    if (r && r.ok) {
      try {
        data = JSON.parse(r.text);
      } catch {
        data = null;
      }
    }
    if (!data) {
      if (must.has(f)) {
        problem("Could not read " + host.id + "/" + f + ": " + ((r && r.error) || "unparseable"));
      } else {
        console.warn("[renterBotOps] skipped unreadable config " + host.id + "/" + f);
      }
      continue;
    }
    for (const u of configUsers(data)) {
      if (u && typeof u === "object" && want.has(u.ClientSecret)) {
        if (!cfg().validFile(f)) {
          console.warn(
            "[renterBotOps] an account sits in " + host.id + "/" + f +
              " (not a bot's config — nothing reads it); left alone",
          );
          continue;
        }
        if (!out.has(f)) out.set(f, new Set());
        out.get(f).add(u.ClientSecret);
      }
    }
  }
  return out;
}

// Every config file on `host` that holds any of `secrets` (see locateSecrets).
async function filesHoldingSecrets(host, secrets, opts) {
  return [...(await locateSecrets(host, secrets, opts)).keys()];
}

// Pull `secrets` out of ONE file, under its lock, and settle the container in
// the SAME critical section when that left the file empty: stopped, restart
// policy "no", so nothing brings an empty (or expired) bot back. Deciding
// "empty" inside the lock is what stops a sale that lands a buyer in the gap
// from being killed by a stop decided on stale data. A file that still holds
// accounts is marked "reload owed" when anything was removed (settle below
// does the reload, outside the lock; the owed-reload sweeper retries it).
// Remembers each removed account's own games so a later start can put them
// back exactly.
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
        try {
          await hosts.setRestartPolicy(host, container, "no");
        } catch (e) {
          // A reboot would start this accountless bot (login-retry loop): the
          // owed-reload sweeper retries the policy until it sticks.
          console.error("[renterBotOps] could not clear restart policy of " + container + ":", e.message);
          await markReloadOwed(host, file, "restart-policy");
        }
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
// stays owed and the error propagates (the caller retries; so does the
// owed-reload sweeper).
async function settleAfterDetach(host, file, det) {
  if (det.missing) return "missing";
  if (det.stopped) {
    if (!(await isReloadOwedFor(host, file, "restart-policy"))) await clearReloadOwed(host, file);
    return "stopped";
  }
  const owed = det.removed > 0 || (await isReloadOwed(host, file));
  if (!owed) return "unchanged";
  const restarted = await restartIfRunning(host, file); // throws => stays owed
  await clearReloadOwed(host, file);
  return restarted ? "restarted" : "left-stopped";
}
async function isReloadOwedFor(host, file, reason) {
  const row = await pendingReload().findOne({ host: host.id, file }, { reason: 1 }).lean().catch(() => null);
  return !!(row && new RegExp(reason).test(row.reason || ""));
}

// Stop ONE renter's farming: pull THEIR accounts out of every config they are
// in on the hosts involved (their own bot's host plus every host their ledger
// rows name) — found by one batched read per host, so a stale pointer cannot
// hide one — then settle each file (see settleAfterDetach). Never stops a
// container that still holds anyone else; never starts one. Each pulled
// account's own games are saved as soon as its file is done.
// Whatever can be done IS done; then it throws (the caller retries) if any of
// it could not be verified (an unreadable stack, a ledger row on an unknown
// host): a stop that cannot be verified is not reported as done.
// Returns { mode: "stopped" | "detached", removed, files: [...] }.
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
  // Files an earlier, failed attempt pulled from: re-checked (their reload may
  // still be owed) although the accounts are no longer found there.
  const owedEarlier = new Map(); // hostId -> Set(file)
  const fresh = await Renter.findById(renter._id, { stopOwedFiles: 1 }).lean().catch(() => null);
  const earlierList = (fresh && fresh.stopOwedFiles) || renter.stopOwedFiles || [];
  for (const k of earlierList) {
    const i = String(k).indexOf("/");
    if (i <= 0) continue;
    const hid = k.slice(0, i);
    if (!owedEarlier.has(hid)) owedEarlier.set(hid, new Set());
    owedEarlier.get(hid).add(k.slice(i + 1));
    if (!hostIds.includes(hid)) hostIds.push(hid);
  }
  const files = [];
  const problems = []; // what could not be located (strings)
  const errors = []; // what failed while pulling / reloading (Errors)
  let removedTotal = 0;
  let stoppedAny = false;
  for (const hid of hostIds) {
    const h = hid === host.id ? host : hosts.resolveHost(hid);
    if (!h) {
      problems.push("accounts on unknown bot host '" + hid + "'");
      files.push({ host: hid, file: null, error: "unknown host" });
      for (const f of owedEarlier.get(hid) || []) files.push({ host: hid, file: f, error: "unknown host" });
      continue;
    }
    const recorded = rows
      .filter((r) => r.configFile && hostIdOf(r.host) === h.id)
      .map((r) => r.configFile);
    let located;
    try {
      // Unreadable files are collected, not thrown: every file that CAN be
      // read is still pulled below, and the stop fails afterwards.
      located = await locateSecrets(h, secrets, { mustRead: recorded, problems });
    } catch (e) {
      // readdir / the batched read itself failed: nothing on this host is known.
      problems.push(h.id + ": " + String((e && e.message) || e));
      for (const f of owedEarlier.get(h.id) || []) files.push({ host: h.id, file: f, error: "host not read" });
      continue;
    }
    const targets = new Set(located.keys());
    if (h.id === host.id && renter.botFile) targets.add(renter.botFile);
    for (const f of recorded) targets.add(f);
    for (const f of owedEarlier.get(h.id) || []) targets.add(f);
    for (const file of targets) {
      if (!cfg().validFile(file)) continue;
      // One file failing (unreadable, SSH drop, a reload that cannot happen)
      // must not leave the renter's accounts in the files after it.
      let det;
      try {
        det = await detachFromFile(h, file, secrets);
      } catch (e) {
        errors.push(e);
        files.push({ host: h.id, file, error: String((e && e.message) || e).slice(0, 200) });
        continue;
      }
      if (det.missing) {
        files.push({ host: h.id, file, missing: true });
        continue;
      }
      await saveGames(renter, det.games);
      removedTotal += det.removed;
      let action;
      try {
        action = await settleAfterDetach(h, file, det);
      } catch (e) {
        errors.push(e); // the reload stays owed (PendingReload) and is retried
        action = "reload-owed";
      }
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
  const owedNow = files.filter((f) => f.file && (f.error || f.action === "reload-owed")).map((f) => f.host + "/" + f.file);
  if (owedNow.length) {
    await Renter.updateOne({ _id: renter._id }, { $set: { stopOwedFiles: owedNow } }).catch(() => {});
  } else if (earlierList.length) {
    await Renter.updateOne({ _id: renter._id }, { $unset: { stopOwedFiles: "" } }).catch(() => {});
  }
  if (problems.length || errors.length) {
    const msgs = [...problems, ...errors.map((x) => String((x && x.message) || x))];
    const e = new Error(
      "Renter " + renter.username + ": " + msgs.join("; ") + " — cannot verify every account was pulled",
    );
    // Keep a failure's code (e.g. "disabled": container restarts are off here)
    // for the callers that word their answer by it.
    const coded = errors.find((x) => x && x.code);
    if (coded) e.code = coded.code;
    if (errors.some((x) => x && x.unreachable)) e.unreachable = true;
    e.partial = { removed: removedTotal, files };
    throw e;
  }
  return { mode: stoppedAny ? "stopped" : "detached", removed: removedTotal, files };
}

// Keep each pulled account's own games for the next start — and FORGET a
// saved list when the account had none, so an older one cannot come back.
// Best effort: the stop itself has happened and must not be reported failed.
async function saveGames(renter, games) {
  if (!games || !games.size) return;
  const ops = [...games.entries()].map(([secret, g]) => ({
    updateOne: {
      filter: { renter: renter._id, clientSecret: secret },
      update: g.length ? { $set: { favouriteGames: g } } : { $unset: { favouriteGames: "" } },
    },
  }));
  await RenterAccount.bulkWrite(ops, { ordered: false }).catch((e) =>
    console.error("[renterBotOps] save games on stop:", e.message),
  );
}

// Start ONE renter's farming: put back each of THEIR enabled, live accounts
// that is on no config of the host, into the file its ledger row names (or
// the renter's own bot when it names none, or names a file that no longer
// exists), as many as each stack's capacity allows, then make sure the
// renter's bot is running (and reload any other file that got accounts back).
//   - an account already in some config on the host is NOT re-added (it would
//     farm in two bots); its ledger row is pointed at where it really is;
//   - a window that already lapsed is never put back (that is renewal's job);
//   - only rows actually put back are re-pointed;
//   - capacity is per file and partial: what does not fit is reported, and the
//     call only fails when NOTHING could be put back;
//   - every file written is recorded as owing a reload BEFORE any container
//     call, and the renter's stop stamp is cleared as soon as accounts are
//     back in a config — so a container call that fails afterwards is retried
//     by the owed-reload sweeper, and the lease-end sweep still covers them.
// Returns { added, skipped, running: true }.
async function startRenterFarming(renter, host) {
  const home = renter.botFile;
  // The rent-farm holder's accounts are paid buyers, each placed per order:
  // a start on its behalf (a manual add onto its stack) only ever touches its
  // CURRENT stack's own rows — it never re-homes or restores the rest.
  const holder = isOperatorHolder(renter);
  const now = Date.now();
  const rows = (
    await RenterAccount.find({ renter: renter._id, enabled: true, farmEndedAt: null }).lean()
  ).filter((a) =>
    a.clientSecret &&
    !(a.farmUntil && new Date(a.farmUntil).getTime() <= now) &&
    (holder
      ? a.configFile === home && hostIdOf(a.host) === host.id
      : !a.configFile || hostIdOf(a.host) === host.id),
  );
  let added = 0;
  const skipped = [];
  const touched = new Set();
  const placedIn = new Map(); // secret -> file it already farms in (not re-added)
  if (rows.length) {
    const recorded = rows.map((a) => a.configFile).filter(Boolean);
    const located = await locateSecrets(host, rows.map((a) => a.clientSecret), { mustRead: recorded });
    const where = placedIn;
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
          // Other renters' reserved slots count as used: filling them would
          // make THEIR next Start fail.
          const reserved = await reservedSlots(host.id, file, present, { except: renter._id });
          const used = users.length + reserved;
          const room = Math.max(0, Number(stack.capacity) - used);
          for (const a of fresh.slice(room)) {
            skipped.push({
              login: a.login || "",
              file,
              reason:
                "stack " + file + " is full (" + users.length + "/" + stack.capacity +
                (reserved ? ", " + reserved + " held for a stopped renter" : "") + ")",
            });
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
        await markReloadOwed(host, file, "accounts added");
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
    if (added) {
      // Farming again the moment the accounts are in a config: the lease-end
      // sweep must see this renter, whatever the container calls below do.
      await Renter.updateOne({ _id: renter._id }, { $set: { botStoppedAt: null, botStopReason: "" } }).catch(() => {});
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
  // Any OTHER file that got accounts back is reloaded if running (it keeps
  // whatever state it was in otherwise — a shared bot someone stopped is not
  // ours to start). Done FIRST, so a failure to start the renter's own bot
  // below cannot leave them unreloaded; one that fails here stays owed and
  // the owed-reload sweeper retries it.
  for (const f of touched) {
    if (f === home) continue;
    try {
      await restartIfRunning(host, f);
      await clearReloadOwed(host, f);
    } catch (e) {
      console.error("[renterBotOps] reload " + f + " after start (stays owed):", e.message);
    }
  }
  // The renter's own bot must be running — unless it holds no accounts at all
  // while theirs farm in other files (moved there): an empty bot only spins in
  // a login-retry loop, and "no accounts" would fail a start that did its job.
  let homeCount = null;
  try {
    homeCount = configUsers(JSON.parse(await hosts.readFile(host, home))).length;
  } catch {
    homeCount = null; // let startConfigContainer report it
  }
  const elsewhere =
    [...touched].some((f) => f !== home) || [...placedIn.values()].some((f) => f !== home);
  if (homeCount === 0 && elsewhere) {
    return { added, skipped, running: true, homeEmpty: true };
  }
  let homeState = "unknown";
  try {
    const states = await hosts.dockerPs(host);
    const st = states[cfg().containerForFile(home)];
    homeState = st && /^running/i.test(st.state || "") ? "running" : "stopped";
  } catch {
    homeState = "unknown";
  }
  await cfg().startConfigContainer(host, home);
  if (touched.has(home)) {
    // A bot that was stopped just started on the new config. One that was
    // already running must be restarted to read it (`compose up -d` leaves a
    // running container alone). When its state could not be read, the owed
    // mark stays: the sweeper reloads it if it runs.
    if (homeState === "stopped") {
      await clearReloadOwed(host, home);
    } else if (homeState === "running") {
      try {
        const r = await cfg().restartConfigContainer(host, home);
        if (!(r && r.restarted === false)) await clearReloadOwed(host, home);
      } catch (e) {
        console.error("[renterBotOps] reload " + home + " after start (stays owed):", e.message);
      }
    }
  }
  return { added, skipped, running: true };
}

// Apply a games list for ONE renter, in every file their accounts are
// recorded in on the renter's host (their own bot, plus any file an account
// was moved to). Decided per file under its lock from what is really in it:
// when every account there is this renter's, the whole config is written
// (root list + switch, shows as "Farming" in the Bots UI); otherwise only
// their accounts change. Per-account games saved by an earlier stop are
// forgotten, so the next start uses THIS list.
// Returns { scope: "config" | "own-accounts", games } (scope of the own bot).
async function applyRenterGames(renter, host, games) {
  if (!cfg().validFile(renter.botFile)) throw new Error("Invalid config file");
  const list = cfg()
    .parseGamesList(games)
    .slice(0, 50)
    .map((g) => g.slice(0, 100));
  const rows = await RenterAccount.find(
    { renter: renter._id, enabled: true },
    { clientSecret: 1, host: 1, configFile: 1 },
  ).lean();
  const secrets = rows.map((r) => r.clientSecret).filter(Boolean);
  const files = new Set([renter.botFile]);
  for (const r of rows) {
    if (r.configFile && hostIdOf(r.host) === host.id && cfg().validFile(r.configFile)) files.add(r.configFile);
  }
  let scope = "own-accounts";
  const others = []; // other files written: their bots must reload to apply it
  for (const file of files) {
    await withFileLock(host, file, async () => {
      let data;
      try {
        data = JSON.parse(await hosts.readFile(host, file));
      } catch (e) {
        if (e && e.code === "ENOENT" && file !== renter.botFile) return;
        throw e;
      }
      if (file === renter.botFile) {
        if (allUsersIn(data, secrets)) {
          scope = "config";
          setWholeConfigGames(data, list);
        } else {
          setUsersGamesBySecret(data, secrets, list);
        }
      } else {
        // Any other file is shared or someone else's: only this renter's own
        // accounts change, and only when they are really in it.
        const mine = new Set(secrets);
        if (!configUsers(data).some((u) => u && typeof u === "object" && mine.has(u.ClientSecret))) return;
        setUsersGamesBySecret(data, secrets, list);
        others.push(file);
      }
      await hosts.writeFileAtomic(host, file, JSON.stringify(data, null, 2));
      if (file !== renter.botFile) await markReloadOwed(host, file, "games changed");
    });
  }
  // The renter's own bot is reloaded by the caller (as before); the others
  // here, if running. One that cannot be stays owed for the sweeper.
  for (const file of others) {
    try {
      await restartIfRunning(host, file);
      await clearReloadOwed(host, file);
    } catch (e) {
      console.error("[renterBotOps] reload " + file + " after games change (stays owed):", e.message);
    }
  }
  await RenterAccount.updateMany(
    { renter: renter._id, favouriteGames: { $exists: true } },
    { $unset: { favouriteGames: "" } },
  ).catch((e) => console.error("[renterBotOps] forget saved games:", e.message));
  return { scope, games: list, otherFiles: others };
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
  clearReloadOwed,
  isReloadOwed,
  sweepPendingReloads,
  reservedSlots,
};
