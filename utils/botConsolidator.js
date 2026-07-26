// Repack auto-farm bot containers on a host.
//
// WHY THIS EXISTS
// A TwitchDropsBot container costs a fixed ~130 MB of .NET runtime baseline
// before it holds a single account, and only ~1.2 MB per account after that
// (measured on the Pi: 10 accounts ≈ 144 MB, 200 accounts ≈ 362 MB). The
// auto-farmer creates one container per `accountsPerBot` accounts, so a small
// accountsPerBot multiplies that baseline: 140 accounts spread over 14
// containers cost ~2.0 GB, while the same 140 accounts in one container cost
// ~300 MB. Nothing is wrong with the farming — it is pure per-container
// overhead. This module packs existing containers back together.
//
// INVARIANTS THAT KEEP THE REST OF THE SYSTEM WORKING
//   * TwitchUsers entries move VERBATIM. Every account carries its own
//     FavouriteGames (that is how one container farms several games at once)
//     and its own Enabled flag (accounts whose campaign ended are switched off,
//     not removed). Rewriting either would change what the bot actually farms —
//     which is why botFactory.addAccountsToBot, whose whole job is to stamp a
//     single game onto fresh pool accounts, is deliberately NOT used here.
//   * BotAccount.container/configFile follow the move, so the Bots page, the
//     Drops Archive and the sell flow keep resolving an account to a real bot.
//   * AutoFarmTask.bots is rebuilt from where each task's accounts actually
//     ended up, so completeEndedTasks() still finds the container holding them.
//     That is what makes it spare co-tenants and trim only its own accounts'
//     FavouriteGames when one campaign ends (the sharedKeys branch in
//     utils/autoFarmer.js) instead of deleting a container others still need.
//   * Only containers that auto-farm tasks own are read or written. Manual bots
//     are never touched.
//
// The drained container's config is renamed to <file>.done-<ts> rather than
// deleted (botFactory.deleteBot), so every account token that was in it stays
// on disk as an automatic rollback artifact.
const hosts = require("./botHosts");
const botFactory = require("./botFactory");
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");

function usersOf(data) {
  return data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
}

// Seats an account actually occupies. Disabled accounts stay in the config (the
// token must survive for resale/inventory) but cost no runtime, so they don't
// count against capacity — same rule botFactory.usedSeats applies.
function enabledCount(users) {
  return users.filter((u) => u && u.Enabled !== false).length;
}

function secretOf(u) {
  return String((u && u.ClientSecret) || "").trim();
}

// Every container an ACTIVE auto-farm task owns on this host, with its config
// contents. Containers whose config is unreadable are reported and then left
// strictly alone — a container we cannot read is one we must not drain.
async function collectAutoContainers(host) {
  const rows = await AutoFarmTask.find({ status: "active" }, { bots: 1 }).lean();
  const seen = new Set();
  const out = [];
  const unreadable = [];
  for (const t of rows) {
    for (const b of t.bots || []) {
      if (b.host !== host.id) continue;
      const key = b.container;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        const data = JSON.parse(await hosts.readFile(host, b.file));
        const users = usersOf(data);
        out.push({
          file: b.file,
          container: b.container,
          data,
          users,
          enabled: enabledCount(users),
          total: users.length,
        });
      } catch (e) {
        unreadable.push({
          container: b.container,
          file: b.file,
          error: e.message || String(e),
        });
      }
    }
  }
  return { containers: out, unreadable };
}

// Decide which containers survive and what moves where. Fullest containers win
// target status so the plan does the fewest possible moves.
function buildPlan(containers, capacity) {
  const totalEnabled = containers.reduce((s, c) => s + c.enabled, 0);
  const totalUsers = containers.reduce((s, c) => s + c.total, 0);
  const needed = Math.max(1, Math.ceil(totalEnabled / capacity));

  const sorted = containers.slice().sort((a, b) => b.enabled - a.enabled);
  const targets = sorted.slice(0, needed).map((c) => ({
    ...c,
    incoming: [],
    free: Math.max(0, capacity - c.enabled),
  }));
  const donors = sorted.slice(needed);

  const moves = [];
  const stranded = [];
  for (const d of donors) {
    // Move the whole container in one piece where it fits, so a task's accounts
    // stay together and its bots array stays short. Fall back to splitting only
    // when no single target has room.
    const held = d.users.slice();
    let cursor = 0;
    while (cursor < held.length) {
      const remainingEnabled = enabledCount(held.slice(cursor));
      const t =
        targets.find((x) => x.free >= remainingEnabled) ||
        targets.filter((x) => x.free > 0).sort((a, b) => b.free - a.free)[0];
      if (!t) {
        stranded.push(...held.slice(cursor));
        break;
      }
      // Take as many entries as fit, counting only enabled ones against seats.
      const batch = [];
      let seats = 0;
      while (cursor < held.length) {
        const u = held[cursor];
        const cost = u && u.Enabled !== false ? 1 : 0;
        if (cost && seats + cost > t.free) break;
        batch.push(u);
        seats += cost;
        cursor++;
      }
      if (!batch.length) break; // no room anywhere; guarded by `stranded`
      t.incoming.push(...batch);
      t.free -= seats;
      moves.push({
        from: d.container,
        fromFile: d.file,
        to: t.container,
        toFile: t.file,
        accounts: batch.length,
        seats,
      });
    }
  }

  const retire = donors.map((d) => ({
    container: d.container,
    file: d.file,
    accounts: d.total,
  }));

  // ~130 MB fixed .NET baseline per container + ~1.2 MB per enabled account.
  const estBefore = containers.reduce((s, c) => s + 130 + c.enabled * 1.2, 0);
  const estAfter = targets.reduce(
    (s, t) => s + 130 + (capacity - t.free) * 1.2,
    0,
  );

  return {
    capacity,
    totalUsers,
    totalEnabled,
    before: { containers: containers.length, estMB: Math.round(estBefore) },
    after: { containers: targets.length, estMB: Math.round(estAfter) },
    savingMB: Math.round(estBefore - estAfter),
    targets: targets.map((t) => ({
      container: t.container,
      file: t.file,
      had: t.enabled,
      receiving: t.incoming.length,
      willHold: t.enabled + enabledCount(t.incoming),
    })),
    retire,
    moves,
    stranded: stranded.length,
    _targets: targets, // internal: carries the actual user objects
  };
}

// Rebuild every active task's bots array from where its accounts actually live
// now. Deriving it from BotAccount rather than patching the old entries means
// the result is correct even when one task's accounts were split across two
// targets, and it repairs any pre-existing drift for free.
async function reconcileTaskBots(host) {
  const tasks = await AutoFarmTask.find(
    { status: "active" },
    { assignedAccounts: 1, bots: 1 },
  ).lean();
  let updated = 0;
  for (const t of tasks) {
    const logins = (t.assignedAccounts || []).map((u) =>
      String(u).toLowerCase(),
    );
    if (!logins.length) continue;
    const accts = await BotAccount.find(
      { login: { $in: logins } },
      { container: 1, configFile: 1, host: 1 },
    ).lean();
    const keep = (t.bots || []).filter((b) => b.host !== host.id);
    const seen = new Set();
    const mine = [];
    for (const a of accts) {
      if (!a.container || !a.configFile) continue;
      if ((a.host || host.id) !== host.id) continue;
      const k = a.container;
      if (seen.has(k)) continue;
      seen.add(k);
      mine.push({
        host: host.id,
        file: a.configFile,
        container: a.container,
        reused: true,
        shared: true,
      });
    }
    if (!mine.length) continue;
    const next = keep.concat(mine);
    const before = JSON.stringify(
      (t.bots || []).map((b) => b.host + "|" + b.container).sort(),
    );
    const after = JSON.stringify(
      next.map((b) => b.host + "|" + b.container).sort(),
    );
    if (before === after) continue;
    await AutoFarmTask.updateOne({ _id: t._id }, { $set: { bots: next } });
    updated++;
  }
  return updated;
}

// Produce the plan without touching anything.
async function plan(hostId, opts = {}) {
  const host = hosts.resolveHost(hostId);
  if (!host) throw new Error("Unknown host: " + hostId);
  const capacity = Math.max(1, Number(opts.capacity) || 70);
  const { containers, unreadable } = await collectAutoContainers(host);
  if (!containers.length) {
    return { host: host.id, capacity, empty: true, unreadable, moves: [] };
  }
  const p = buildPlan(containers, capacity);
  delete p._targets;
  return { host: host.id, unreadable, ...p };
}

// Execute the plan.
//
// Ordering matters. Donors are STOPPED before their accounts are written into a
// target, so an account is never enabled in two running containers at once —
// the same Twitch account watching twice looks like abuse and would risk the
// account. The donor's config is only renamed away at the very end, once its
// accounts are safely persisted somewhere else.
async function consolidate(hostId, opts = {}) {
  const host = hosts.resolveHost(hostId);
  if (!host) throw new Error("Unknown host: " + hostId);
  const capacity = Math.max(1, Number(opts.capacity) || 70);
  const log = typeof opts.progress === "function" ? opts.progress : () => {};

  const { containers, unreadable } = await collectAutoContainers(host);
  if (containers.length < 2) {
    return { host: host.id, skipped: "nothing to consolidate", unreadable };
  }
  const p = buildPlan(containers, capacity);
  if (!p.moves.length) {
    return { host: host.id, skipped: "already packed", unreadable, plan: p };
  }
  if (p.stranded) {
    throw new Error(
      "Refusing to run: " +
        p.stranded +
        " account(s) would not fit at capacity " +
        capacity +
        ". Raise capacity and retry.",
    );
  }

  const targets = p._targets;
  const donorList = p.retire;

  // 1) Stop donors first — no account may run in two containers at once.
  for (const d of donorList) {
    log("Stopping " + d.container + "…");
    await botFactory.stopContainer(host, d.container).catch(() => {});
  }

  // 2) Write merged configs, dropping any duplicate ClientSecret.
  const moved = [];
  for (const t of targets) {
    if (!t.incoming.length) continue;
    const have = new Set(usersOf(t.data).map(secretOf).filter(Boolean));
    const fresh = [];
    for (const u of t.incoming) {
      const s = secretOf(u);
      if (!s || have.has(s)) continue;
      have.add(s);
      fresh.push(u);
    }
    if (!fresh.length) continue;
    if (!t.data.TwitchSettings || typeof t.data.TwitchSettings !== "object") {
      t.data.TwitchSettings = {};
    }
    t.data.TwitchSettings.TwitchUsers = usersOf(t.data).concat(fresh);
    log("Writing " + t.file + " (+" + fresh.length + " accounts)…");
    await hosts.writeFileAtomic(
      host,
      t.file,
      JSON.stringify(t.data, null, 2),
    );
    for (const u of fresh) moved.push({ user: u, file: t.file });
  }

  // 3) Point BotAccount at the new home. Keyed on clientSecret, which is the
  //    real identity of an account (a login can legitimately map to several).
  if (moved.length) {
    const ops = moved.map(({ user, file }) => ({
      updateOne: {
        filter: { clientSecret: secretOf(user) },
        update: {
          $set: {
            configFile: file,
            container: botFactory.containerForFile(file),
            host: host.id,
          },
        },
      },
    }));
    await BotAccount.bulkWrite(ops, { ordered: false });
    log("Repointed " + moved.length + " BotAccount record(s).");
  }

  // 4) Rebuild task→container pointers from the accounts' new locations.
  const tasksUpdated = await reconcileTaskBots(host);
  log("Updated " + tasksUpdated + " auto-farm task(s).");

  // 5) Restart targets once so TwitchDropsBot reloads the merged config.
  for (const t of targets) {
    if (!t.incoming.length) continue;
    log("Restarting " + t.container + "…");
    await hosts.dockerContainer(host, "restart", t.container).catch(() => {});
  }

  // 6) Retire the drained containers (config renamed, never deleted).
  const retired = [];
  for (const d of donorList) {
    log("Retiring " + d.container + "…");
    const steps = await botFactory
      .deleteBot(host, d.file, d.container)
      .catch((e) => "failed: " + e.message);
    retired.push({ container: d.container, steps });
  }

  delete p._targets;
  return {
    host: host.id,
    unreadable,
    plan: p,
    movedAccounts: moved.length,
    tasksUpdated,
    retired,
  };
}

module.exports = { plan, consolidate, buildPlan, enabledCount };
