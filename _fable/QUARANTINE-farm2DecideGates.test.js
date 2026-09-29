// Coverage for the missing downstream gates in utils/farm2/steps/decide.js.
//
// The first trial of the lane engine reached decisions without the six gates
// the legacy engine enforces AFTER sellability passes: time window, reuse-only,
// coverage, pool depletion, capacity, and host offline. This test harness
// pins the two properties for each gate:
//   1. it fires when the condition is met (the gate blocks the lane)
//   2. it does NOT fire when the condition is not met (no false positives)
//
// Shadow mode is used for all tests so the decide harness can be exercised
// without side effects (no pool claiming, no host writes).
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmLane = require("../models/FarmLane");
const FarmJob = require("../models/FarmJob");
const TwitchCampaign = require("../models/TwitchCampaign");
const DropLog = require("../models/DropLog");
const AvailableAccount = require("../models/AvailableAccount");
const AutoFarmTask = require("../models/AutoFarmTask");
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const settings = require("../utils/settings");
const decide = require("../utils/farm2/steps/decide");

let mem;
let campaignCounter = 0;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2decidegates"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function setup(game) {
  const gameKey = settings.normGameName(game);
  // Clean up existing data for this game
  await Promise.all([
    TwitchCampaign.deleteMany({ game }),
    DropLog.deleteMany({ game }),
    AutoFarmTask.deleteMany({ game }),
    MarketResearchSnapshot.deleteMany({ gameKey }),
    AvailableAccount.deleteMany({ gameKey }),
  ]);
}

function uniqueCampaignId() {
  return `c${Date.now()}-${campaignCounter++}`;
}

const AF = {
  maxPerGame: 30,
  probeSize: 5,
  probeColdStart: false,
  probeMaxSellers: 1,
  probeMaxGames: 8,
  probeCooldownDays: 90,
  perMarketStock: 3,
  minHoursLeft: 12,
  platiCategoryId: "",
  farm2Enabled: true,
  farmHost: "server",
  accountsPerBot: 70,
  maxAutoBots: 5,
  consolidate: true,
  poolReserve: 10,
};

/* ==================== skip_reuse_only gate ==================== */

test("skip_reuse_only fires when game is reuse-only and no reuse available", async () => {
  const game = "Reuse Only Game";
  await setup(game);

  // Mark this game as reuse-only
  const origIsReuse = settings.isReuseOnlyGame;
  settings.isReuseOnlyGame = (g) => g === game;

  try {
    // Create research so sellability passes
    await MarketResearchSnapshot.create({
      game,
      gameKey: game.toLowerCase(),
      demandScore: 50,
      checkedAt: new Date(),
    });

    // Create campaign with enough time left
    const campaign = await TwitchCampaign.create({
      campaignId: uniqueCampaignId(),
      game,
      name: "Test Campaign",
      active: true,
      status: "ACTIVE",
      endAt: new Date(Date.now() + 48 * 3600000),
    });

    // Create pool accounts so skip_no_accounts doesn't fire first
    for (let i = 0; i < 20; i++) {
      await AvailableAccount.create({
        username: `pool_${i}`,
        usernameLower: `pool_${i}`,
        status: "available",
      });
    }

    const verdict = await decide.decideCampaign({
      campaign,
      lane: { game, gameKey: game.toLowerCase() },
      cycle: null,
      af: AF,
      shadow: true,
      hostCache: new Map(),
    });

    // With no reuse available and game marked reuse-only, should skip
    assert.equal(
      verdict.decision,
      "skip_reuse_only",
      `Expected skip_reuse_only, got ${verdict.decision}`,
    );
    assert.equal(verdict.wouldFarm, false);
    assert.ok(verdict.reason.includes("Reuse-only"), "Reason should mention reuse-only");
  } finally {
    settings.isReuseOnlyGame = origIsReuse;
  }
});

test("skip_reuse_only does NOT fire when reuse-only game is not marked as such", async () => {
  const game = "Normal Game Not Reuse Only";
  await setup(game);

  // Ensure game is NOT marked as reuse-only
  const origIsReuse = settings.isReuseOnlyGame;
  settings.isReuseOnlyGame = () => false;

  try {
    // Create research so sellability passes
    await MarketResearchSnapshot.create({
      game,
      gameKey: game.toLowerCase(),
      demandScore: 50,
      checkedAt: new Date(),
    });

    // Create campaign with enough time left
    const campaign = await TwitchCampaign.create({
      campaignId: uniqueCampaignId(),
      game,
      name: "Test Campaign",
      active: true,
      status: "ACTIVE",
      endAt: new Date(Date.now() + 48 * 3600000),
    });

    // Create pool accounts so skip_no_accounts doesn't fire
    for (let i = 0; i < 20; i++) {
      await AvailableAccount.create({
        login: `pool_${i}`,
        gameKey: game.toLowerCase(),
        status: "available",
      });
    }

    const verdict = await decide.decideCampaign({
      campaign,
      lane: { game, gameKey: game.toLowerCase() },
      cycle: null,
      af: AF,
      shadow: true,
      hostCache: new Map(),
    });

    // Should not skip as reuse-only
    assert.notEqual(verdict.decision, "skip_reuse_only");
    assert.ok(
      verdict.decision === "farm" || verdict.decision === "probe",
      `Expected farm or probe, got ${verdict.decision}`,
    );
  } finally {
    settings.isReuseOnlyGame = origIsReuse;
  }
});

/* ==================== skip_ends_soon gate ==================== */

test("skip_ends_soon fires when campaign ends within minHoursLeft and no reuse", async () => {
  const game = "Short Campaign Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign that ends in 6 hours (< 12h minimum)
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Short Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 6 * 3600000),
  });

  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  assert.equal(
    verdict.decision,
    "skip_ends_soon",
    `Expected skip_ends_soon, got ${verdict.decision}`,
  );
  assert.equal(verdict.wouldFarm, false);
  assert.ok(verdict.reason.includes("Campaign ends"), "Reason should mention campaign end time");
});

test("skip_ends_soon does NOT fire when campaign has > minHoursLeft remaining", async () => {
  const game = "Long Campaign Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign that ends in 24 hours (> 12h minimum)
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Long Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 24 * 3600000),
  });

  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  assert.notEqual(verdict.decision, "skip_ends_soon");
  assert.ok(verdict.decision === "farm" || verdict.decision === "probe");
});

/* ==================== skip_already_covered gate ==================== */

test("skip_already_covered fires when unsold archive holders >= wanted accounts", async () => {
  const game = "Covered Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create unsold drop log entries (archive holders)
  const logins = ["user1", "user2", "user3"];
  for (const login of logins) {
    await DropLog.create({
      game,
      login,
      connected: false, // Not connected = unsold
      soldAt: null, // Not sold
      items: [{ name: "Item", qty: 1 }],
    });
  }

  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  // Should skip because coverage >= target
  assert.equal(
    verdict.decision,
    "skip_already_covered",
    `Expected skip_already_covered, got ${verdict.decision}`,
  );
  assert.equal(verdict.wouldFarm, false);
});

test("skip_already_covered does NOT fire when uncovered accounts needed", async () => {
  const game = "Uncovered Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create pool account (so skip_no_accounts doesn't fire)
  for (let i = 0; i < 20; i++) {
    await AvailableAccount.create({
      login: `pool_user_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  // Create NO archive holders (nothing is covered)
  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  assert.notEqual(verdict.decision, "skip_already_covered");
  assert.equal(verdict.wouldFarm, true);
});

/* ==================== skip_no_accounts gate ==================== */

test("skip_no_accounts fires when pool is depleted below reserve", async () => {
  const game = "Empty Pool Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create NO pool accounts (pool is empty)
  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  // With empty pool, should skip
  assert.equal(
    verdict.decision,
    "skip_no_accounts",
    `Expected skip_no_accounts, got ${verdict.decision}`,
  );
  assert.equal(verdict.wouldFarm, false);
});

test("skip_no_accounts does NOT fire when sufficient pool accounts exist", async () => {
  const game = "Pool Has Accounts";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create plenty of pool accounts
  for (let i = 0; i < 30; i++) {
    await AvailableAccount.create({
      login: `available_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  assert.notEqual(verdict.decision, "skip_no_accounts");
  assert.ok(verdict.wouldFarm);
});

/* ==================== skip_no_capacity gate ==================== */

test("skip_no_capacity fires when all bot slots and seats are full", async () => {
  const game = "Full Capacity Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create pool accounts so that gate doesn't fire
  for (let i = 0; i < 20; i++) {
    await AvailableAccount.create({
      login: `pool_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  // Create active bots to consume all capacity
  // maxAutoBots = 5, accountsPerBot = 70, so total capacity = 5 * 70 = 350
  // Fill capacity with existing tasks
  for (let i = 0; i < AF.maxAutoBots; i++) {
    await AutoFarmTask.create({
      game: "Other Game " + i,
      status: "active",
      bots: [
        {
          host: "server",
          container: `bot_${i}`,
          file: `config_${i}.json`,
        },
      ],
      assignedAccounts: Array.from({ length: AF.accountsPerBot }, (_, j) => `acct_${i}_${j}`),
    });
  }

  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  // Should skip due to no capacity
  assert.equal(
    verdict.decision,
    "skip_no_capacity",
    `Expected skip_no_capacity, got ${verdict.decision}`,
  );
  assert.equal(verdict.wouldFarm, false);
});

test("skip_no_capacity does NOT fire when capacity is available", async () => {
  const game = "Capacity Available Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create pool accounts
  for (let i = 0; i < 20; i++) {
    await AvailableAccount.create({
      login: `pool_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  // Don't fill capacity - leave it free
  const verdict = await decide.decideCampaign({
    campaign,
    lane: { game, gameKey: game.toLowerCase() },
    cycle: null,
    af: AF,
    shadow: true,
    hostCache: new Map(),
  });

  assert.notEqual(verdict.decision, "skip_no_capacity");
  assert.ok(verdict.wouldFarm);
});

/* ==================== skip_host_offline gate ==================== */

test("skip_host_offline fires when farm host is unreachable", async () => {
  const game = "Offline Host Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create pool accounts so skip_no_accounts doesn't fire
  for (let i = 0; i < 20; i++) {
    await AvailableAccount.create({
      login: `pool_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  // Mock the probeHost function to return false (offline)
  const autoFarmer = require("../utils/autoFarmer");
  const origProbeHost = autoFarmer.probeHost;
  autoFarmer.probeHost = async () => false;

  try {
    const verdict = await decide.decideCampaign({
      campaign,
      lane: { game, gameKey: game.toLowerCase() },
      cycle: null,
      af: AF,
      shadow: true,
      hostCache: new Map(),
    });

    // Should skip due to host being offline
    assert.equal(
      verdict.decision,
      "skip_host_offline",
      `Expected skip_host_offline, got ${verdict.decision}`,
    );
    assert.equal(verdict.wouldFarm, false);
  } finally {
    autoFarmer.probeHost = origProbeHost;
  }
});

test("skip_host_offline does NOT fire when farm host is online", async () => {
  const game = "Online Host Game";
  await setup(game);

  // Create research so sellability passes
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    demandScore: 50,
    checkedAt: new Date(),
  });

  // Create campaign with enough time left
  const campaign = await TwitchCampaign.create({
    campaignId: uniqueCampaignId(),
    game,
    name: "Test Campaign",
    active: true,
    status: "ACTIVE",
    endAt: new Date(Date.now() + 48 * 3600000),
  });

  // Create pool accounts
  for (let i = 0; i < 20; i++) {
    await AvailableAccount.create({
      login: `pool_${i}`,
      gameKey: game.toLowerCase(),
      status: "available",
    });
  }

  // Mock probeHost to return true (online)
  const autoFarmer = require("../utils/autoFarmer");
  const origProbeHost = autoFarmer.probeHost;
  autoFarmer.probeHost = async () => true;

  try {
    const verdict = await decide.decideCampaign({
      campaign,
      lane: { game, gameKey: game.toLowerCase() },
      cycle: null,
      af: AF,
      shadow: true,
      hostCache: new Map(),
    });

    assert.notEqual(verdict.decision, "skip_host_offline");
    assert.ok(verdict.wouldFarm);
  } finally {
    autoFarmer.probeHost = origProbeHost;
  }
});
