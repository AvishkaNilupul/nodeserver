const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const {
  createController,
  derivePolicy,
  identityFor,
  matchesUser,
  MAX_SALE_AGE_MS,
} = require("../utils/skinAccountFarm");

const NOW = new Date("2026-11-15T05:00:00.000Z");
const clone = (value) => structuredClone(value);
const query = (value) => ({
  lean: async () => clone(value),
  limit() {
    return this;
  },
});
const fixture = () => ({
  _id: "product",
  botAccountId: "bot",
  epicAccountId: "epic",
  twitchLogin: "owned",
  twitchId: "123",
  gameKey: "rocket-league",
  gameName: "Rocket League",
  holdTag: "owner:held",
  heldAt: NOW,
  state: "listed",
  ownershipStatus: "owned",
  lastSaleCheckAt: NOW,
  link: { status: "verified", twitchId: "123" },
  farm: { enabled: true, allowed: true },
});
const entry = (extra = {}) => ({
  ClientSecret: "private-test-token",
  Login: "owned",
  Id: "123",
  Enabled: true,
  FavouriteGames: ["Rocket League", "Other"],
  ...extra,
});
const config = (users) => ({
  TwitchSettings: {
    OnlyFavouriteGames: true,
    ClaimDrops: true,
    TwitchUsers: users,
  },
  FavouriteGames: ["Other"],
});

function rig(options = {}) {
  const row = { ...fixture(), ...options.skin };
  row.farm = { ...fixture().farm, ...options.skin?.farm };
  const primary = {
    _id: "bot",
    login: "owned",
    twitchId: "123",
    clientSecret: "private-test-token",
    uniqueId: "unique",
    soldAt: NOW,
    soldToUsername: "owner:held",
    lastScanStatus: "ok",
    host: "local",
    configFile: "config_01.json",
    ...options.primary,
  };
  const aliases = [primary, ...(options.aliases || [])];
  const files = new Map(
    Object.entries(
      options.files || {
        "local|config_01.json": config([
          entry(),
          entry({ ClientSecret: "other", Login: "other", Id: "999" }),
        ]),
      },
    ),
  );
  const states = new Map([
    ...(options.states || [["local|twitchbotx1", "running"]]),
  ]);
  const calls = [];
  const apply = (update) => {
    for (const [path, value] of Object.entries(update.$set || {})) {
      const keys = path.split(".");
      let target = row;
      for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      target[keys.at(-1)] = clone(value);
    }
  };
  const models = {
    SkinAccount: {
      findById: () => query(row),
      find: () => query(options.multiple ? [row, row] : [row]),
      updateOne: async (filter, update) => {
        apply(update);
        calls.push(["persist", clone(update)]);
        return { matchedCount: 1 };
      },
    },
    BotAccount: {
      findById: () => query(primary),
      find: () => query(aliases),
      updateOne: async (...args) => calls.push(["mirror", ...args]),
      updateMany: async (...args) => calls.push(["mirrors", ...args]),
    },
    RenterAccount: { findOne: () => query(options.renter || null) },
    AutoFarmTask: { findOne: () => query(options.task || null) },
    DropLog: { findOne: () => query(options.conflictingDrop || null) },
    AvailableAccount: {
      find: () =>
        query(
          options.pool || [
            {
              status: "claimed",
              manualSold: true,
              claimedNote: "owner:held",
              soldGames: [],
            },
          ],
        ),
    },
    RenterBotStack: { find: () => query(options.stacks || []) },
  };
  const hosts = {
    resolveHost: (host) => ({ id: host, runtime: "docker" }),
    readFile: async (host, file) => {
      const cfg = files.get(`${host.id}|${file}`);
      if (!cfg) throw new Error("missing");
      return JSON.stringify(cfg);
    },
    saveSnapshot: async () => {},
    writeFileAtomic: async (host, file, text) => {
      files.set(`${host.id}|${file}`, JSON.parse(text));
      calls.push(["write", `${host.id}|${file}`]);
    },
    withContainerLock: async (host, container, fn) => fn(),
    dockerPs: async (host) =>
      Object.fromEntries(
        [...states]
          .filter(([key]) => key.startsWith(host.id + "|"))
          .map(([key, state]) => [key.split("|")[1], { state }]),
      ),
    dockerContainer: async (host, action, container) => {
      calls.push([action, `${host.id}|${container}`]);
      if (options.onStart) await options.onStart(row, action);
      states.set(
        `${host.id}|${container}`,
        action === "stop" ? "exited" : "running",
      );
    },
    composeUp: async (host, container) => {
      calls.push(["start", `${host.id}|${container}`]);
      if (options.onStart) await options.onStart(row, "start");
      states.set(`${host.id}|${container}`, "running");
    },
    restoreRestartPolicy: async () => {},
  };
  const fleet = {
    readManagedHomes: async () => ({
      homes: [...files].map(([key, cfg]) => ({
        host: key.split("|")[0],
        file: key.split("|")[1],
        cfg: clone(cfg),
      })),
      unreadable: options.unreadable || [],
    }),
    readNoclaimHomes: async () => {
      if (options.noClaimError) throw new Error("No-claim host unavailable");
      return new Map(options.noClaim || []);
    },
  };
  let failReload = !!options.failReload;
  const control = {
    reloadConfig: async (host, file, container) => {
      calls.push(["reload", `${host.id}|${file}`]);
      if (failReload) return { done: false };
      const enabled = files
        .get(`${host.id}|${file}`)
        ?.TwitchSettings.TwitchUsers.some((user) => user.Enabled !== false);
      states.set(`${host.id}|${container}`, enabled ? "running" : "exited");
      return { done: true };
    },
  };
  const factory = {
    createBot: async (host, accounts, game, opts) => {
      assert.equal(opts.startRunning, false);
      calls.push(["create", host.id]);
      const file = "config_99.json";
      const template = config([
        entry({ FavouriteGames: [game], UniqueId: "unique" }),
      ]);
      if (options.factoryClaimDrops !== undefined)
        template.TwitchSettings.ClaimDrops = options.factoryClaimDrops;
      files.set(`${host.id}|${file}`, template);
      states.set(`${host.id}|twitchbotx99`, "exited");
      return { host: host.id, file, container: "twitchbotx99" };
    },
  };
  const controller = createController({
    models,
    hosts,
    fleet,
    control,
    factory,
    waker: { readRegistry: async () => options.parked || {} },
    now: () => NOW,
    withFileLock: async (host, file, fn) => fn(),
  });
  return {
    controller,
    row,
    primary,
    calls,
    files,
    states,
    retryReload: () => {
      failReload = false;
    },
    models,
  };
}

test("policy: an owned verified product exempts only its selected game and always holds future drops", () => {
  const policy = derivePolicy(fixture(), NOW);
  assert.equal(policy.allowed, true);
  assert.equal(policy.allowedGame, "rocket league");
  assert.equal(policy.holdFields.soldToUsername, "owner:held");
  assert.equal(policy.suppressSaleSignal, true);
  const sold = derivePolicy(
    { ...fixture(), ownershipStatus: "sold", soldAt: NOW },
    NOW,
  );
  assert.equal(sold.allowed, false);
  assert.ok(
    sold.holdFields.soldAt,
    "Sold accounts' later rewards never return to stock",
  );
  assert.equal(sold.suppressSaleSignal, false);
});

test("policy fails closed on stale/unknown stock, broken links, paused farming and attention", () => {
  for (const delta of [
    { lastSaleCheckAt: new Date(+NOW - MAX_SALE_AGE_MS - 1) },
    { lastSaleCheckAt: null },
    { ownershipStatus: "quarantined" },
    { state: "attention" },
    { state: "preparing" },
    { farm: { enabled: true, allowed: false } },
    { farm: { enabled: false, allowed: true } },
    { link: { status: "pending" } },
    { link: { status: "verified", twitchId: "wrong" } },
    { gameKey: "other" },
  ])
    assert.equal(
      derivePolicy({ ...fixture(), ...delta }, NOW).allowed,
      false,
      JSON.stringify(delta),
    );
});

test("physical matching catches rotated tokens, login case aliases and stable Twitch IDs", () => {
  const identity = identityFor(fixture(), [
    { login: "OLDNAME", twitchId: "123", clientSecret: "old-token" },
  ]);
  assert.ok(
    matchesUser(
      entry({ ClientSecret: "new", Login: "OWNED", Id: "" }),
      identity,
    ),
  );
  assert.ok(
    matchesUser(
      entry({ ClientSecret: "new", Login: "renamed", Id: "123" }),
      identity,
    ),
  );
  assert.ok(
    matchesUser(
      entry({ ClientSecret: "old-token", Login: "", Id: "" }),
      identity,
    ),
  );
  assert.equal(
    matchesUser(
      entry({ ClientSecret: "other", Login: "other", Id: "999" }),
      identity,
    ),
    false,
  );
});

test("moves only the held identity, reloads its former home before starting, and pins Rocket League", async () => {
  const r = rig();
  const result = await r.controller.reconcileFarm(r.row);
  assert.equal(result.ok, true);
  assert.equal(result.status, "farming");
  assert.equal(
    r.files.get("local|config_01.json").TwitchSettings.TwitchUsers[0].Enabled,
    false,
  );
  assert.equal(
    r.files.get("local|config_01.json").TwitchSettings.TwitchUsers[1].Enabled,
    true,
  );
  const own = r.files.get("local|config_99.json");
  assert.deepEqual(own.FavouriteGames, ["Rocket League"]);
  assert.deepEqual(own.TwitchSettings.TwitchUsers[0].FavouriteGames, [
    "Rocket League",
  ]);
  assert.equal(own.TwitchSettings.OnlyFavouriteGames, true);
  assert.ok(
    r.calls.findIndex(([event]) => event === "reload") <
      r.calls.findIndex(([event]) => event === "start"),
  );
  const creates = r.calls.filter(([event]) => event === "create").length;
  const starts = r.calls.filter(
    ([event]) => event === "start" || event === "restart",
  ).length;
  await r.controller.reconcileFarm(r.row);
  assert.equal(
    r.calls.filter(([event]) => event === "create").length,
    creates,
    "Retry does not provision a duplicate",
  );
  assert.equal(
    r.calls.filter(([event]) => event === "start" || event === "restart")
      .length,
    starts,
    "Unchanged farm does not restart",
  );
});

test("new and existing skin farms enable drop claims before their next start or reload", async () => {
  for (const existing of [false, true]) {
    const initial = config([
      entry({ FavouriteGames: ["Rocket League"], UniqueId: "unique" }),
    ]);
    initial.FavouriteGames = ["Rocket League"];
    initial.TwitchSettings.ClaimDrops = false;
    let observedStart = false;
    const r = rig({
      factoryClaimDrops: false,
      ...(existing
        ? {
            files: { "local|config_99.json": initial },
            states: [["local|twitchbotx99", "running"]],
            skin: {
              farm: {
                host: "local",
                configFile: "config_99.json",
                container: "twitchbotx99",
                status: "farming",
              },
            },
          }
        : {}),
      onStart: async (_row, action) => {
        assert.equal(action, existing ? "restart" : "start");
        assert.equal(
          r.files.get("local|config_99.json").TwitchSettings.ClaimDrops,
          true,
          "The persisted config must claim rewards before the bot reads it",
        );
        observedStart = true;
      },
    });
    assert.equal((await r.controller.reconcileFarm(r.row)).ok, true);
    assert.equal(observedStart, true);
    observedStart = false;
    assert.equal((await r.controller.reconcileFarm(r.row)).ok, true);
    assert.equal(
      observedStart,
      false,
      "A settled claim setting does not restart again",
    );
  }
});

test("failed old-home reload blocks start and remains durable after the entry is disabled", async () => {
  const r = rig({ failReload: true });
  const result = await r.controller.reconcileFarm(clone(r.row));
  assert.equal(result.ok, false);
  assert.equal(
    r.calls.some(([event]) => event === "start" || event === "create"),
    false,
  );
  assert.ok(
    r.row.farm.owedHomes.some((home) => home.file === "config_01.json"),
  );
  assert.equal(r.row.farm.needsReload, true);
  r.retryReload();
  assert.equal((await r.controller.reconcileFarm(clone(r.row))).ok, true);
  assert.deepEqual(r.row.farm.owedHomes, []);
});

test("concurrent reconciliation of stale input snapshots provisions only one farm", async () => {
  const r = rig();
  const input = clone(r.row);
  const results = await Promise.all([
    r.controller.reconcileFarm(clone(input)),
    r.controller.reconcileFarm(clone(input)),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(r.calls.filter(([event]) => event === "create").length, 1);
  assert.equal(r.calls.filter(([event]) => event === "start").length, 1);
});

test("a sold product disables the physical account and cannot be woken through enabled games", async () => {
  const r = rig({ skin: { ownershipStatus: "sold", soldAt: NOW } });
  assert.equal((await r.controller.reconcileFarm(r.row)).stopped, true);
  assert.equal(
    r.calls.some(([event]) => event === "start" || event === "create"),
    false,
  );
  assert.equal(
    r.files.get("local|config_01.json").TwitchSettings.TwitchUsers[0].Enabled,
    false,
  );
  const reloads = r.calls.filter(([event]) => event === "reload").length;
  await r.controller.stopFarm(r.row, "Sold");
  assert.equal(
    r.calls.filter(([event]) => event === "reload").length,
    reloads,
    "Repeated stop leaves co-tenants alone",
  );
});

test("sale during start is followed by a verified stop before returning", async () => {
  const r = rig({
    onStart: async (row) => {
      row.ownershipStatus = "sold";
      row.soldAt = NOW;
      row.farm.allowed = false;
    },
  });
  const result = await r.controller.reconcileFarm(r.row);
  assert.equal(result.stopped, true);
  assert.equal(r.states.get("local|twitchbotx99"), "exited");
  assert.equal(
    r.files.get("local|config_99.json").TwitchSettings.TwitchUsers[0].Enabled,
    false,
  );
});

test("cross-host aliases are disabled and reloaded before the one selected farm starts", async () => {
  const r = rig({
    files: {
      "local|config_01.json": config([entry()]),
      "remote|config_02.json": config([
        entry({ ClientSecret: "rotated", Login: "renamed" }),
      ]),
    },
    states: [
      ["local|twitchbotx1", "running"],
      ["remote|twitchbotx2", "running"],
    ],
  });
  assert.equal((await r.controller.reconcileFarm(r.row)).ok, true);
  assert.equal(
    r.files.get("remote|config_02.json").TwitchSettings.TwitchUsers[0].Enabled,
    false,
  );
  const start = r.calls.findIndex(([event]) => event === "start");
  assert.ok(
    r.calls.findIndex(
      ([event, home]) => event === "reload" && home === "remote|config_02.json",
    ) < start,
  );
});

test("uncertain hosts, no-claim ownership, task assignment and buyer reservations refuse starting", async () => {
  for (const options of [
    { unreadable: ["remote/config_01.json"] },
    { noClaim: [["other-token", { login: "OWNED" }]] },
    { noClaimError: true },
    { noClaim: [["rotated", { login: "renamed", twitchId: "123" }]] },
    { renter: { _id: "renter" } },
    { task: { _id: "task" } },
    { primary: { soldToUsername: "buyer" } },
    { conflictingDrop: { _id: "drop" } },
    { pool: [{ status: "available", manualSold: false }] },
  ]) {
    const r = rig(options);
    assert.equal((await r.controller.reconcileFarm(r.row)).ok, false);
    assert.equal(
      r.calls.some(([event]) => event === "start" || event === "create"),
      false,
    );
  }
});

test("rental-stack conflicts never alter the renter's config", async () => {
  const r = rig({ stacks: [{ host: "local", file: "config_01.json" }] });
  assert.equal((await r.controller.reconcileFarm(r.row)).ok, false);
  assert.equal(
    r.files.get("local|config_01.json").TwitchSettings.TwitchUsers[0].Enabled,
    true,
  );
  assert.equal(
    r.calls.some(([event]) => event === "write" || event === "reload"),
    false,
  );
});

test("a parked unchanged skin farm stays waiting for the campaign waker", async () => {
  const cfg = config([
    entry({ UniqueId: "unique", FavouriteGames: ["Rocket League"] }),
  ]);
  cfg.FavouriteGames = ["Rocket League"];
  const r = rig({
    skin: {
      farm: {
        host: "local",
        configFile: "config_01.json",
        container: "twitchbotx1",
        lastCheckedAt: NOW,
      },
    },
    files: { "local|config_01.json": cfg },
    states: [["local|twitchbotx1", "exited"]],
    parked: { "local|twitchbotx1": { reason: "idle_no_campaign" } },
  });
  assert.equal((await r.controller.reconcileFarm(r.row)).status, "waiting");
  assert.equal(
    r.calls.some(([event]) => event === "start"),
    false,
  );
});

test("policy lookup refuses duplicate product identities", async () => {
  const r = rig({ multiple: true });
  await assert.rejects(
    r.controller.policyForAccount(r.primary),
    /Multiple skin products/,
  );
});

test("read-only enrollment preflight accepts fresh stock without inventing a hold", async () => {
  const r = rig({
    primary: { soldAt: null, soldToUsername: "" },
    pool: [{ status: "available", manualSold: false, soldGames: [] }],
  });
  const before = clone(r.row);
  assert.equal((await r.controller.validateOwnership(r.row)).ok, true);
  assert.deepEqual(r.row, before);
  assert.equal(r.calls.length, 0);
});

test("read-only enrollment preflight blocks buyer, no-claim, tenant and inaccessible-host conflicts", async () => {
  for (const options of [
    { primary: { soldToUsername: "buyer" } },
    { renter: { _id: "renter" } },
    { noClaim: [["rotated", { login: "renamed", twitchId: "123" }]] },
    { unreadable: ["remote/config_02.json"] },
    { task: { _id: "active-task" } },
  ]) {
    const r = rig(options);
    assert.equal((await r.controller.validateOwnership(r.row)).ok, false);
    assert.equal(
      r.calls.length,
      0,
      "Preflight must never stop/move/reserve an account",
    );
  }
});

test("failed persistence still stops the known isolated farm, without claiming global success", async () => {
  const r = rig({
    skin: {
      farm: {
        host: "local",
        configFile: "config_01.json",
        container: "twitchbotx1",
      },
    },
    files: { "local|config_01.json": config([entry()]) },
  });
  r.models.SkinAccount.updateOne = async () => {
    throw new Error("Database unavailable");
  };
  await assert.rejects(
    r.controller.stopFarm(r.row, "Sold"),
    /Database unavailable/,
  );
  assert.equal(
    r.files.get("local|config_01.json").TwitchSettings.TwitchUsers[0].Enabled,
    false,
  );
  assert.equal(r.states.get("local|twitchbotx1"), "exited");
});

test("failed persistence cannot trigger emergency stop of a shared or unknown tenant config", async () => {
  const r = rig({
    skin: {
      farm: {
        host: "local",
        configFile: "config_01.json",
        container: "twitchbotx1",
      },
    },
  });
  r.models.SkinAccount.updateOne = async () => {
    throw new Error("Database unavailable");
  };
  await assert.rejects(
    r.controller.stopFarm(r.row, "Sold"),
    /Database unavailable/,
  );
  assert.equal(
    r.calls.some(([event]) => event === "write" || event === "reload"),
    false,
  );
});

function scannerRig(options = {}) {
  const writes = [],
    signals = [],
    stoppedGames = [],
    stoppedProducts = [];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (/[/\\]dropScanner\.js$/.test(parent?.filename || "")) {
      if (request === "../models/DropLog")
        return {
          find: () =>
            query([{ benefitId: "newly-connected", connected: false }]),
          updateOne: async (...args) => {
            writes.push(args);
            return { upsertedCount: 1 };
          },
          distinct: async () => ["Rocket League", "Other"],
          countDocuments: async () => 2,
        };
      if (request === "../models/SaleSignal")
        return { updateOne: async (...args) => signals.push(args) };
      if (request === "./imageCache") return { cacheImage: async () => "" };
      if (request === "./twitchInventory")
        return {
          itemKeyFor: (name, game) => `${name}|${game}`,
          isPendingDrop: () => false,
          fetchInventory: async () => {
            if (options.fetchError) throw options.fetchError;
            return {
              twitchId: options.twitchId || "123",
              login: "owned",
              inProgress: [],
              drops: [
                {
                  benefitId: "newly-connected",
                  name: "Reward",
                  game: "Rocket League",
                  connected: true,
                },
                {
                  benefitId: "other",
                  name: "Other reward",
                  game: "Other",
                  connected: true,
                },
              ],
            };
          },
        };
      if (request === "./skinAccountFarm")
        return {
          policyForAccount:
            options.policy || (async () => derivePolicy(fixture(), NOW)),
          stopFarm: async (skin, reason) =>
            stoppedProducts.push({ skin, reason }),
        };
      if (request === "./farmControl")
        return {
          stopFarmingGame: async (account, game) => {
            stoppedGames.push(game);
            return { changed: false };
          },
        };
      if (request === "./marketClaimTags") return { MARKET_CLAIM_TAGS: [] };
      return {};
    }
    return original.call(this, request, parent, isMain);
  };
  const filename = require.resolve("../utils/dropScanner");
  delete require.cache[filename];
  try {
    return {
      scanner: require(filename),
      writes,
      signals,
      stoppedGames,
      stoppedProducts,
    };
  } finally {
    Module._load = original;
    delete require.cache[filename];
  }
}

test("scanner reserves new product rewards in the insert itself and does not invent an owner-link sale", async () => {
  const { scanner, writes, signals } = scannerRig();
  await scanner.upsertDrops(
    "bot",
    "BotAccount",
    "owned",
    [
      {
        benefitId: "newly-connected",
        name: "Reward",
        game: "Rocket League",
        connected: true,
      },
    ],
    derivePolicy(fixture(), NOW),
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].$setOnInsert.soldToUsername, "owner:held");
  assert.ok(writes[0][1].$setOnInsert.soldAt);
  assert.equal(signals.length, 0);
  assert.equal(
    writes[0][1].$set.soldToUsername,
    undefined,
    "Existing sold tags must never be overwritten",
  );
});

test("scanner preserves ordinary Twitch reward stock and connection sales behavior", async () => {
  const { scanner, writes, signals } = scannerRig();
  await scanner.upsertDrops("ordinary", "BotAccount", "ordinary", [
    {
      benefitId: "newly-connected",
      name: "Reward",
      game: "Rocket League",
      connected: true,
    },
  ]);
  assert.equal(writes[0][1].$setOnInsert.soldAt, undefined);
  assert.equal(signals.length, 1);
});

const scannedAccount = () => ({
  _id: "bot",
  login: "owned",
  twitchId: "123",
  soldAt: NOW,
  soldToUsername: "owner:held",
  lastScanStatus: "ok",
  save: async () => {},
});
const worker = () => ({ host: { transport: "local" }, errors: 0, newDrops: 0 });

test("scanner exempts only the owned product game; other sold games still stop", async () => {
  const r = scannerRig();
  assert.equal(
    (await r.scanner.__test.scanAccount(scannedAccount(), worker())).ok,
    true,
  );
  assert.deepEqual(r.stoppedGames, ["Other"]);
  assert.equal(r.stoppedProducts.length, 0);
});

test("scanner stops the owned product even when inventory fails through an unreachable worker", async () => {
  const failure = Object.assign(new Error("Worker unavailable"), {
    transportFailed: true,
  });
  const r = scannerRig({ fetchError: failure });
  await assert.rejects(
    r.scanner.__test.scanAccount(scannedAccount(), worker()),
    /Worker unavailable/,
  );
  assert.equal(r.stoppedProducts.length, 1);
  assert.equal(r.writes.length, 0);
});

test("scanner rechecks ownership after Twitch responds and stops a product sold in flight", async () => {
  let lookups = 0;
  const r = scannerRig({
    policy: async () =>
      derivePolicy(
        ++lookups === 1
          ? fixture()
          : { ...fixture(), ownershipStatus: "sold", soldAt: NOW },
        NOW,
      ),
  });
  assert.equal(
    (await r.scanner.__test.scanAccount(scannedAccount(), worker())).ok,
    true,
  );
  assert.equal(r.stoppedProducts.length, 1);
  assert.ok(r.stoppedGames.includes("Rocket League"));
  assert.ok(r.writes.every(([, update]) => update.$setOnInsert.soldAt));
});

test("unknown ownership during a scan stops its known product without inserting free stock", async () => {
  let lookups = 0;
  const r = scannerRig({
    policy: async () => {
      if (++lookups > 1) throw new Error("Registry unavailable");
      return derivePolicy(fixture(), NOW);
    },
  });
  await assert.rejects(
    r.scanner.__test.scanAccount(scannedAccount(), worker()),
    /Registry unavailable/,
  );
  assert.equal(r.stoppedProducts.length, 1);
  assert.equal(r.writes.length, 0);
});

test("inventory for the wrong Twitch identity cannot use the farming exemption", async () => {
  const r = scannerRig({ twitchId: "wrong" });
  const account = scannedAccount();
  assert.equal(
    (await r.scanner.__test.scanAccount(account, worker())).ok,
    false,
  );
  assert.equal(r.stoppedProducts.length, 1);
  assert.equal(
    r.writes.length,
    0,
    "Another account's inventory must not contaminate the product archive",
  );
  assert.equal(
    account.twitchId,
    "123",
    "The canonical identity is not silently replaced",
  );
});
