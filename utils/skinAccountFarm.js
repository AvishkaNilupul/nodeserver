// Farming for an owned, reserved whole-game account. This deliberately never
// creates an AutoFarmTask or RenterAccount: neither owns this product's lifetime.
const MAX_SALE_AGE_MS = 15 * 60 * 1000;
const { isDeepStrictEqual } = require("node:util");
const norm = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const id = (value) => String(value || "");
const escaped = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const usersOf = (cfg) =>
  Array.isArray(cfg?.TwitchSettings?.TwitchUsers)
    ? cfg.TwitchSettings.TwitchUsers
    : [];
const homeKey = (home) => `${home.host}|${home.file}`;
const containerFor = (file) =>
  file === "config.json"
    ? "twitchbot"
    : /^config_0*(\d+)\.json$/.test(file)
      ? "twitchbotx" + Number(file.match(/\d+/)[0])
      : "";

class FarmLocationError extends Error {
  constructor(message, unreadableHomes = false) {
    super(message);
    this.unreadableHomes = unreadableHomes;
  }
}

function checkFarmLocations(audit, protectedKeys) {
  if (audit.matches.some((home) => protectedKeys.has(homeKey(home))))
    throw new FarmLocationError("A matching account belongs to a rental stack");
  if (audit.unreadable?.length)
    throw new FarmLocationError(
      "Cannot verify ownership while a farm location is unreadable",
      true,
    );
}

function derivePolicy(skin, now = new Date()) {
  if (!skin)
    return {
      enrolled: false,
      allowed: false,
      suppressSaleSignal: false,
      holdFields: null,
      reason: "Not enrolled",
    };
  const holdTag = String(skin.holdTag || `skin-account:${skin._id}`);
  const heldAt = skin.heldAt || skin.createdAt || now;
  let reason = "";
  if (
    skin.gameKey !== "rocket-league" ||
    norm(skin.gameName) !== "rocket league"
  )
    reason = "This game is not supported by the skin-account farm";
  else if (skin.soldAt || skin.ownershipStatus !== "owned")
    reason = "Account is sold or ownership is uncertain";
  else if (!["ready", "listed", "paused"].includes(skin.state))
    reason = "Account needs attention or preparation";
  else if (!skin.farm?.enabled) reason = "Farming is switched off";
  else if (!skin.farm?.allowed)
    reason = "Sale and ownership checks have not allowed farming";
  else if (skin.link?.status !== "verified")
    reason = "The Epic and Twitch link is not verified";
  else if (skin.link?.twitchId && id(skin.link.twitchId) !== id(skin.twitchId))
    reason = "Verified Twitch identity does not match";
  else if (["listed", "paused"].includes(skin.state)) {
    const checked = new Date(skin.lastSaleCheckAt || 0).getTime();
    if (
      !Number.isFinite(checked) ||
      checked > +new Date(now) + 60000 ||
      +new Date(now) - checked > MAX_SALE_AGE_MS
    ) {
      reason = "Marketplace ownership check is stale";
    }
  }
  return {
    skin,
    enrolled: true,
    allowed: !reason,
    reason,
    allowedGame: norm(skin.gameName),
    suppressSaleSignal: skin.ownershipStatus !== "sold" && !skin.soldAt,
    // Used in the SAME upsert that creates a drop. A later stamp leaves a
    // window in which another seller can reserve the newly inserted reward.
    holdFields: {
      soldAt: heldAt,
      soldToUsername: holdTag,
      soldSetId: `skin-account:${skin._id}`,
    },
  };
}

function identityFor(skin, accounts = []) {
  return {
    logins: new Set(
      [skin.twitchLogin, ...accounts.map((a) => a.login)]
        .map(norm)
        .filter(Boolean),
    ),
    twitchIds: new Set(
      [skin.twitchId, ...accounts.map((a) => a.twitchId)]
        .map(id)
        .filter(Boolean),
    ),
    secrets: new Set(accounts.map((a) => a.clientSecret).filter(Boolean)),
  };
}

function matchesUser(user, identity) {
  return (
    !!user &&
    (identity.secrets.has(user.ClientSecret) ||
      identity.logins.has(norm(user.Login)) ||
      identity.twitchIds.has(id(user.Id || user.TwitchId)))
  );
}

function identityQuery(identity, { pool = false } = {}) {
  const clauses = [];
  if (identity.secrets.size)
    clauses.push({ clientSecret: { $in: [...identity.secrets] } });
  if (identity.twitchIds.size)
    clauses.push({ twitchId: { $in: [...identity.twitchIds] } });
  if (identity.logins.size)
    clauses.push({
      [pool ? "usernameLower" : "login"]: {
        $in: [...identity.logins].map((login) =>
          pool ? login : new RegExp(`^${escaped(login)}$`, "i"),
        ),
      },
    });
  return { $or: clauses.length ? clauses : [{ _id: null }] };
}

function createController(overrides = {}) {
  const locks = new Map();
  let loaded;
  function deps() {
    if (!loaded)
      loaded = {
        models: overrides.models || {
          SkinAccount: require("../models/SkinAccount"),
          BotAccount: require("../models/BotAccount"),
          AvailableAccount: require("../models/AvailableAccount"),
          DropLog: require("../models/DropLog"),
          RenterAccount: require("../models/RenterAccount"),
          RenterBotStack: require("../models/RenterBotStack"),
          AutoFarmTask: require("../models/AutoFarmTask"),
        },
        hosts: overrides.hosts || require("./botHosts"),
        fleet: overrides.fleet || require("./fleetIntegrity"),
        factory: overrides.factory || require("./botFactory"),
        control: overrides.control || require("./farmControl"),
        waker: overrides.waker || require("./botWaker"),
        withFileLock:
          overrides.withFileLock || require("./fileLock").withFileLock,
        now: overrides.now || (() => new Date()),
      };
    return loaded;
  }
  function locked(skin, fn) {
    const key = id(skin._id);
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }
  async function refresh(skin) {
    const row = await deps().models.SkinAccount.findById(skin._id).lean();
    if (!row)
      throw new Error("Skin account no longer exists; farming cannot start");
    return row;
  }
  async function observed(skin, fields) {
    const values = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [`farm.${key}`, value]),
    );
    values["farm.lastCheckedAt"] = deps().now();
    await deps().models.SkinAccount.updateOne(
      { _id: skin._id },
      { $set: values },
    );
    skin.farm = { ...skin.farm, ...fields };
  }
  async function policyForAccount(account) {
    const clauses = [{ botAccountId: account._id }];
    if (account.login)
      clauses.push({
        twitchLogin: new RegExp(`^${escaped(norm(account.login))}$`, "i"),
      });
    if (account.twitchId) clauses.push({ twitchId: id(account.twitchId) });
    const rows = await deps()
      .models.SkinAccount.find({ $or: clauses })
      .limit(2)
      .lean();
    if (rows.length > 1)
      throw new Error("Multiple skin products claim this Twitch identity");
    return derivePolicy(rows[0], deps().now());
  }
  async function accountsFor(skin) {
    const { models } = deps();
    const primary = await models.BotAccount.findById(skin.botAccountId).lean();
    if (!primary) throw new Error("The reserved Twitch account is missing");
    const identity = identityFor(skin, [primary]);
    const rows = await models.BotAccount.find(identityQuery(identity)).lean();
    return { primary, rows, identity: identityFor(skin, [primary, ...rows]) };
  }
  async function managedAudit(identity) {
    const read = await deps().fleet.readManagedHomes();
    const matches = read.homes.filter((home) =>
      usersOf(home.cfg).some((u) => matchesUser(u, identity)),
    );
    return { ...read, matches };
  }
  async function rentalKeys() {
    const rows = await deps()
      .models.RenterBotStack.find({}, { host: 1, file: 1 })
      .lean();
    return new Set(rows.map(homeKey));
  }
  function uniqueHomes(homes) {
    return [
      ...new Map(
        homes
          .filter((h) => h.host && h.file)
          .map((h) => [
            homeKey(h),
            {
              host: h.host,
              file: h.file,
              container: h.container || containerFor(h.file),
            },
          ]),
      ).values(),
    ];
  }
  // Remember a reload BEFORE removing an entry. Otherwise a process restart
  // after the edit loses the only evidence that the old bot still has it loaded.
  async function retire(skin, identity, homes, protectedKeys = new Set()) {
    const { hosts, control, withFileLock, models } = deps();
    const todo = uniqueHomes(homes);
    const owed = [];
    const errors = [];
    await observed(skin, {
      owedHomes: todo,
      needsReload: !!todo.length,
      status: "stopping",
    });
    for (const home of todo) {
      if (protectedKeys.has(homeKey(home))) {
        owed.push(home);
        errors.push("A matching account belongs to a rental stack");
        continue;
      }
      const host = hosts.resolveHost(home.host);
      if (!host || !home.container) {
        owed.push(home);
        errors.push("A previous farm location cannot be controlled");
        continue;
      }
      try {
        await withFileLock(host, home.file, async () => {
          const raw = await hosts.readFile(host, home.file);
          const cfg = JSON.parse(raw);
          let changed = false;
          for (const user of usersOf(cfg)) {
            if (!matchesUser(user, identity)) continue;
            if (user.Enabled !== false || (user.FavouriteGames || []).length)
              changed = true;
            user.Enabled = false;
            user.FavouriteGames = [];
          }
          if (changed) {
            await hosts.saveSnapshot(home.host, home.file, raw);
            await hosts.writeFileAtomic(
              host,
              home.file,
              JSON.stringify(cfg, null, 2),
              { prev: raw },
            );
          }
        });
        await models.BotAccount.updateMany(
          {
            ...identityQuery(identity),
            host: home.host,
            configFile: home.file,
          },
          { $set: { enabled: false } },
        );
        const result = await control.reloadConfig(
          host,
          home.file,
          home.container,
        );
        if (!result.done) throw new Error("The previous farm has not reloaded");
      } catch {
        owed.push(home);
        errors.push("A previous farm could not be stopped or verified");
      }
    }
    await observed(skin, { owedHomes: owed, needsReload: !!owed.length });
    return { owed, errors };
  }
  async function stopInternal(skin, reason) {
    let identity = identityFor(skin);
    const errors = [];
    try {
      identity = (await accountsFor(skin)).identity;
    } catch {
      errors.push("Twitch identity lookup failed");
    }
    let audit = { matches: [], unreadable: [] };
    let protectedKeys = new Set();
    try {
      audit = await managedAudit(identity);
    } catch {
      errors.push("Farm locations could not be read");
    }
    try {
      protectedKeys = await rentalKeys();
    } catch {
      // Do not touch any unknown tenant's config on an ownership lookup failure.
      protectedKeys = new Set(audit.matches.map(homeKey));
      errors.push("Rental ownership could not be checked");
    }
    try {
      const renter = await deps()
        .models.RenterAccount.findOne(identityQuery(identity), {
          host: 1,
          configFile: 1,
        })
        .lean();
      if (renter) {
        // A tenant row can predate the stack registry. Its own file is still
        // a protected boundary; an unplaced tenant requires manual review.
        if (renter.configFile)
          protectedKeys.add(
            homeKey({ host: renter.host || "local", file: renter.configFile }),
          );
        else for (const home of audit.matches) protectedKeys.add(homeKey(home));
        errors.push("This Twitch identity is assigned to a renter");
      }
    } catch {
      for (const home of audit.matches) protectedKeys.add(homeKey(home));
      errors.push("Rental account ownership could not be checked");
    }
    const known =
      skin.farm?.configFile &&
      (skin.farm?.needsReload || skin.farm?.status !== "stopped")
        ? [
            {
              host: skin.farm.host,
              file: skin.farm.configFile,
              container: skin.farm.container,
            },
          ]
        : [];
    // Once a stop was verified, disabled historical copies need no further
    // reload. Restarting their co-tenants on every scanner visit is harmful.
    const matches = audit.matches.filter(
      (home) =>
        !skin.farm?.lastCheckedAt ||
        usersOf(home.cfg).some(
          (user) => matchesUser(user, identity) && user.Enabled !== false,
        ),
    );
    const result = await retire(
      skin,
      identity,
      [...matches, ...known, ...(skin.farm?.owedHomes || [])],
      protectedKeys,
    );
    errors.push(...result.errors);
    if (audit.unreadable?.length)
      errors.push("Some farm locations are unreadable");
    const status = errors.length ? "attention" : "stopped";
    await observed(skin, {
      status,
      needsReload: !!errors.length,
      lastError: errors[0] || "",
    });
    return {
      ok: !errors.length,
      stopped: !errors.length,
      status,
      reason,
      errors,
    };
  }
  async function stopFarm(skin, reason = "Farming stopped") {
    return locked(skin, async () => {
      let current = skin;
      try {
        current = await refresh(skin);
      } catch {
        /* stopping is still required */
      }
      try {
        return await stopInternal(current, reason);
      } catch (error) {
        await emergencyStopKnown(current);
        throw error; // No durable proof: never report a complete global stop.
      }
    });
  }
  // Mongo can fail while a sale/scan is already stopping this product. The
  // persisted dedicated home remains a usable stop target, even when we
  // cannot write reload debt. Touch it only if it contains this identity alone.
  async function emergencyStopKnown(skin) {
    const { hosts, control, withFileLock } = deps();
    const farm = skin.farm || {};
    const host = farm.host && hosts.resolveHost(farm.host);
    const container = farm.container || containerFor(farm.configFile || "");
    if (!host || !farm.configFile || !container) return false;
    try {
      const identity = identityFor(skin);
      await withFileLock(host, farm.configFile, async () => {
        const raw = await hosts.readFile(host, farm.configFile);
        const cfg = JSON.parse(raw);
        if (
          !usersOf(cfg).length ||
          usersOf(cfg).some((user) => !matchesUser(user, identity))
        ) {
          throw new Error("The known home is not an isolated skin farm");
        }
        for (const user of usersOf(cfg)) {
          user.Enabled = false;
          user.FavouriteGames = [];
        }
        await hosts.writeFileAtomic(
          host,
          farm.configFile,
          JSON.stringify(cfg, null, 2),
          { prev: raw },
        );
      });
      return (
        (await control.reloadConfig(host, farm.configFile, container)).done ===
        true
      );
    } catch {
      return false;
    }
  }
  async function checkOwnership(
    skin,
    accountData,
    { requireHold = true, requireScan = true } = {},
  ) {
    const { models, fleet } = deps();
    const { primary, rows, identity } = accountData;
    if (
      !primary.clientSecret ||
      (requireScan && primary.lastScanStatus !== "ok")
    )
      throw new Error(
        "Twitch authentication needs a successful inventory check",
      );
    if (
      norm(primary.login) !== norm(skin.twitchLogin) ||
      (skin.twitchId && id(primary.twitchId) !== id(skin.twitchId))
    ) {
      throw new Error("The reserved Twitch identity changed");
    }
    if (
      (requireHold && !skin.holdTag) ||
      rows.some((row) => row.soldAt && row.soldToUsername !== skin.holdTag)
    ) {
      throw new Error(
        "A Twitch identity has a conflicting sale or reservation",
      );
    }
    const [renter, task, conflictingDrop, pool] = await Promise.all([
      models.RenterAccount.findOne(identityQuery(identity)).lean(),
      models.AutoFarmTask.findOne({
        status: { $in: ["planned", "active"] },
        assignedAccounts: {
          $in: [...identity.logins].map(
            (login) => new RegExp(`^${escaped(login)}$`, "i"),
          ),
        },
      }).lean(),
      models.DropLog.findOne({
        account: { $in: rows.map((row) => row._id) },
        soldAt: { $ne: null },
        soldToUsername: { $ne: skin.holdTag },
      }).lean(),
      models.AvailableAccount.find(
        identityQuery(identity, { pool: true }),
      ).lean(),
    ]);
    if (renter) throw new Error("This Twitch identity is assigned to a renter");
    if (task)
      throw new Error(
        "This Twitch identity is assigned to another auto-farm task",
      );
    if (conflictingDrop)
      throw new Error("This Twitch identity has rewards reserved elsewhere");
    const ownHold = (row) =>
      row.status === "claimed" &&
      row.manualSold &&
      row.claimedNote === skin.holdTag;
    if (
      (requireHold && !pool.length) ||
      pool.some(
        (row) =>
          row.soldGames?.length ||
          (requireHold
            ? !ownHold(row)
            : (row.status !== "available" || row.manualSold) && !ownHold(row)),
      )
    ) {
      throw new Error(
        "The whole Twitch account is not exclusively held for this product",
      );
    }
    let noClaim;
    try {
      noClaim = await fleet.readNoclaimHomes();
    } catch {
      throw new FarmLocationError(
        "Cannot verify ownership while the no-claim farm is unreadable",
        true,
      );
    }
    for (const [secret, home] of noClaim) {
      if (
        identity.secrets.has(secret) ||
        identity.logins.has(norm(home.login)) ||
        identity.twitchIds.has(id(home.twitchId))
      ) {
        throw new Error("This Twitch identity belongs to a no-claim farm");
      }
    }
  }
  // Enrollment calls this before reserving anything. It accepts either clean
  // available stock or this product's existing owner hold, never another
  // tenant, task, listing, sold account, or an unreadable physical location.
  async function validateOwnership(skin, opts = {}) {
    try {
      const accountData = await accountsFor(skin);
      await checkOwnership(skin, accountData, {
        requireHold: false,
        requireScan: false,
        ...opts,
      });
      const audit = await managedAudit(accountData.identity);
      checkFarmLocations(audit, await rentalKeys());
      return {
        ok: true,
        homes: audit.matches.map((home) => ({
          host: home.host,
          file: home.file,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        unreadableHomes:
          error instanceof FarmLocationError && error.unreadableHomes,
        reason: error.message || "Twitch ownership could not be verified",
      };
    }
  }
  async function reconcileInternal(input, opts) {
    const { hosts, factory, withFileLock, models, waker } = deps();
    let skin = await refresh(input);
    let policy = derivePolicy(skin, deps().now());
    if (!policy.allowed) return stopInternal(skin, policy.reason);
    const accountData = await accountsFor(skin);
    const { primary, identity } = accountData;
    await checkOwnership(skin, accountData);
    let audit = await managedAudit(identity);
    const protectedKeys = await rentalKeys();
    checkFarmLocations(audit, protectedKeys);
    let home = skin.farm?.configFile
      ? {
          host: skin.farm.host,
          file: skin.farm.configFile,
          container: skin.farm.container || containerFor(skin.farm.configFile),
        }
      : null;
    const targetOwedReload =
      !!home &&
      (skin.farm?.owedHomes || []).some(
        (candidate) => homeKey(candidate) === homeKey(home),
      );
    if (home) {
      const existing = audit.homes.find(
        (candidate) => homeKey(candidate) === homeKey(home),
      );
      if (
        !existing ||
        !home.container ||
        protectedKeys.has(homeKey(home)) ||
        usersOf(existing.cfg).some((user) => !matchesUser(user, identity))
      ) {
        throw new Error(
          "The saved skin farm is missing or contains another account",
        );
      }
    }
    const priorHomes = [
      ...audit.matches.filter(
        (candidate) =>
          !skin.farm?.lastCheckedAt ||
          usersOf(candidate.cfg).some(
            (user) => matchesUser(user, identity) && user.Enabled !== false,
          ),
      ),
      ...(skin.farm?.owedHomes || []),
    ].filter((candidate) => !home || homeKey(candidate) !== homeKey(home));
    const retired = await retire(skin, identity, priorHomes, protectedKeys);
    if (retired.owed.length)
      throw new Error(
        "The previous farm must stop before this account starts elsewhere",
      );
    if (!home) {
      const host = hosts.resolveHost(
        opts.host || skin.farm?.host || primary.host || "local",
      );
      if (!host) throw new Error("The selected farm host is unavailable");
      policy = derivePolicy(await refresh(skin), deps().now());
      if (!policy.allowed) return stopInternal(skin, policy.reason);
      const created = await factory.createBot(
        host,
        [
          {
            clientSecret: primary.clientSecret,
            uniqueId: primary.uniqueId,
            username: skin.twitchLogin,
            twitchId: skin.twitchId,
          },
        ],
        skin.gameName,
        { startRunning: false },
      );
      home = {
        host: created.host,
        file: created.file,
        container: created.container,
      };
      // Retain this location locally even if persisting it fails, so the
      // failure handler can turn its enabled config off before returning.
      skin.farm = {
        ...skin.farm,
        host: home.host,
        configFile: home.file,
        container: home.container,
      };
      input.farm = { ...input.farm, ...skin.farm };
      await observed(skin, {
        host: home.host,
        configFile: home.file,
        container: home.container,
      });
    }
    const host = hosts.resolveHost(home.host);
    if (!host) throw new Error("The saved farm host is unavailable");
    skin = await refresh(skin);
    policy = derivePolicy(skin, deps().now());
    if (!policy.allowed) return stopInternal(skin, policy.reason);
    await observed(skin, {
      owedHomes: [home],
      needsReload: true,
      status: "starting",
    });
    const changed = await withFileLock(host, home.file, async () => {
      const raw = await hosts.readFile(host, home.file);
      const cfg = JSON.parse(raw);
      if (usersOf(cfg).some((user) => !matchesUser(user, identity)))
        throw new Error("Another account entered the saved skin farm");
      cfg.TwitchSettings = cfg.TwitchSettings || {};
      cfg.TwitchSettings.OnlyFavouriteGames = true;
      cfg.TwitchSettings.ClaimDrops = true;
      cfg.FavouriteGames = [skin.gameName];
      cfg.TwitchSettings.TwitchUsers = [
        {
          ClientSecret: primary.clientSecret,
          UniqueId: primary.uniqueId,
          Login: skin.twitchLogin,
          Id: skin.twitchId,
          Enabled: true,
          FavouriteGames: [skin.gameName],
        },
      ];
      if (cfg.KickSettings) cfg.KickSettings.KickUsers = [];
      const text = JSON.stringify(cfg, null, 2);
      if (isDeepStrictEqual(JSON.parse(raw), cfg)) return false;
      await hosts.saveSnapshot(home.host, home.file, raw);
      await hosts.writeFileAtomic(host, home.file, text, { prev: raw });
      return true;
    });
    // Atomic-write hooks can reject an enabled entry (e.g. no-claim fence).
    // Check the actual written files, not the desired JSON or BotAccount mirror.
    audit = await managedAudit(identity);
    checkFarmLocations(audit, await rentalKeys());
    const active = audit.matches.filter((candidate) =>
      usersOf(candidate.cfg).some(
        (user) => matchesUser(user, identity) && user.Enabled !== false,
      ),
    );
    if (
      active.length !== 1 ||
      homeKey(active[0]) !== homeKey(home) ||
      usersOf(active[0].cfg).filter(
        (user) => matchesUser(user, identity) && user.Enabled !== false,
      ).length !== 1
    ) {
      throw new Error(
        "The Twitch account does not have exactly one enabled farm home",
      );
    }
    await checkOwnership(skin, accountData);
    let status;
    await hosts.withContainerLock(host, home.container, async () => {
      const current = await refresh(skin);
      const allowed = derivePolicy(current, deps().now());
      if (!allowed.allowed) throw new Error(allowed.reason);
      const states = await hosts.dockerPs(host);
      const running = states[home.container]?.state === "running";
      const registry = await waker.readRegistry({ strict: true });
      const parked = registry[`${home.host}|${home.container}`];
      if (
        !running &&
        parked &&
        !changed &&
        !targetOwedReload &&
        !opts.forceStart
      ) {
        status = "waiting";
        return;
      }
      if (running && (changed || targetOwedReload))
        await hosts.dockerContainer(host, "restart", home.container, {
          notAStart: true,
        });
      else if (!running) {
        if (host.runtime === "native")
          await hosts.dockerContainer(host, "start", home.container);
        else await hosts.composeUp(host, home.container);
      }
      await hosts.restoreRestartPolicy(host, home.container);
      if ((await hosts.dockerPs(host))[home.container]?.state !== "running")
        throw new Error("The farm did not start");
      status = "farming";
    });
    if (!derivePolicy(await refresh(skin), deps().now()).allowed)
      return stopInternal(
        skin,
        "Ownership changed while the farm was starting",
      );
    await models.BotAccount.updateOne(
      { _id: primary._id },
      {
        $set: {
          host: home.host,
          configFile: home.file,
          container: home.container,
          enabled: true,
        },
      },
    );
    await observed(skin, {
      status,
      owedHomes: [],
      needsReload: false,
      lastError: "",
    });
    return {
      ok: true,
      status,
      host: home.host,
      configFile: home.file,
      container: home.container,
    };
  }
  async function reconcileFarm(skin, opts = {}) {
    return locked(skin, async () => {
      try {
        return await reconcileInternal(skin, opts);
      } catch (error) {
        const message = error.message || "Skin-account farming failed";
        let current = skin;
        try {
          current = await refresh(skin);
          // A provision may have succeeded immediately before its DB write
          // failed. Keep that otherwise unrecorded location in the stop plan.
          if (!current.farm?.configFile && skin.farm?.configFile)
            current.farm = {
              ...current.farm,
              host: skin.farm.host,
              configFile: skin.farm.configFile,
              container: skin.farm.container,
            };
        } catch {
          /* use the known identity and location to stop */
        }
        let stopped;
        try {
          stopped = await stopInternal(current, message);
        } catch {
          await emergencyStopKnown(current);
          stopped = { ok: false };
        }
        await observed(current, {
          status: "attention",
          lastError: message,
          needsReload: !stopped.ok,
        });
        return {
          ok: false,
          status: "attention",
          reason: message,
          locationFailure: error instanceof FarmLocationError,
          unreadableHomes:
            error instanceof FarmLocationError && error.unreadableHomes,
          stopped: !!stopped.ok,
        };
      }
    });
  }
  return { policyForAccount, reconcileFarm, stopFarm, validateOwnership };
}

const controller = createController();
module.exports = {
  ...controller,
  derivePolicy,
  identityFor,
  matchesUser,
  createController,
  MAX_SALE_AGE_MS,
};
