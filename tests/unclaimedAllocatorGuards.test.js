// The no-claim fleet sizer feeds only bots that can farm, and only games with a
// running drop campaign (owner, 2026-09-28 — review "sell more" item 6).
//
// Before: every bot of a game with room was a top-up target, emptiest first,
// so on 2026-09-27 seven fresh pool accounts went into CoD bot 10 — a bot with
// no container, stopped by the operator, for a game with no campaign.
//
// Host/Mongo-free: the demand snapshot, the fleet and the campaign catalog are
// stubbed via Module._load; the REAL allocator plan runs.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

function withAllocator({ rows, bots, markers = "", campaigns = [], campaignError = null }) {
  const bucket = (g) => {
    const s = String(g || "").toLowerCase();
    if (s.includes("call of duty")) return "call of duty";
    if (s.includes("rainbow")) return "rainbow six";
    if (s.includes("overwatch")) return "overwatch";
    return "";
  };
  const shell = [];
  const fleet = {
    MAX_PER_BOT: 70,
    BOTS_DIR: "/home/ubuntu/twitchbot-noclaim/bots",
    containerFor: (id) => "noclaim-bot-" + id,
    readFleet: async () => ({ provisioning: false, imageBuilt: true, bots: JSON.parse(JSON.stringify(bots)) }),
    spendable: async () => ({ ready: 500, reserve: 20, spendable: 480 }),
    sh: async (script) => {
      shell.push(script);
      return markers;
    },
  };
  const stubs = new Map([
    [require.resolve("../utils/farmDemand"), { unclaimedDemandSnapshot: async () => JSON.parse(JSON.stringify(rows)), bucketFor: bucket }],
    [require.resolve("../utils/noclaimFleet"), fleet],
    [
      require.resolve("../models/TwitchCampaign"),
      {
        find: () => ({
          lean: async () => {
            if (campaignError) throw campaignError;
            return campaigns;
          },
        }),
      },
    ],
    [require.resolve("../utils/systemLog"), { logEvent: () => {} }],
    [require.resolve("../utils/telegram"), { sendTelegram: async () => {} }],
  ]);
  const path = require.resolve("../utils/unclaimedAllocator");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  delete require.cache[path];
  const allocator = require("../utils/unclaimedAllocator");
  const restore = () => {
    Module._load = origLoad;
    delete require.cache[path];
  };
  return { allocator, restore, shell };
}

const row = (key, label, target, perWeek) => ({
  key,
  label,
  target,
  onHand: 0,
  stock: { inFlight: 0 },
  sales: { count: 5, perWeek, priced: 5 },
  daysOfCover: 3,
  weight: perWeek,
  need: 0,
  spare: 0,
});
const bot = (id, game, accounts, containerState = "running") => ({
  id,
  game,
  accounts,
  containerState,
  running: containerState === "running",
});

test("plan: top-ups go only to bots that can farm; a dark game is never grown", async () => {
  const h = withAllocator({
    rows: [row("rainbow six", "Rainbow Six Siege", 120, 25), row("call of duty", "Call of Duty", 10, 1)],
    bots: [
      bot("18", "Rainbow Six Siege", 34),
      bot("21", "Rainbow Six Siege", 20),
      bot("25", "Rainbow Six Siege", 5, "exited"),
      bot("10", "Call of Duty: Black Ops 7", 10, "none"),
      bot("22", "Call of Duty: Black Ops 7", 3, "exited"),
    ],
    markers: "21 personal\n22 off\n",
    campaigns: [{ game: "Tom Clancy's Rainbow Six Siege" }],
  });
  try {
    const p = await h.allocator.plan({ days: 30 });
    assert.strictEqual(p.fleetKnown, true, p.fleetError);
    const r6 = p.games.find((g) => g.key === "rainbow six");
    const cod = p.games.find((g) => g.key === "call of duty");
    assert.deepStrictEqual(
      r6.fleet.roomBots.map((b) => b.id).sort(),
      ["18", "25"],
      "not the personal bot 21; a parked (exited) bot with a container still farms when started",
    );
    assert.strictEqual(r6.fleet.assigned, 59, "every account still counts toward what the game has");
    assert.ok(r6.fleetNeed > 0);
    assert.strictEqual(cod.fleetNeed, 0, "no campaign — no growth, not even a new bot");
    assert.deepStrictEqual(cod.fleet.roomBots, [], "bot 10 (no container) and bot 22 (stopped) are never fed");
    assert.ok(cod.notes.some((n) => /no active drop campaign/.test(n)));
    const out = await h.allocator.apply({ plan: p, dryRun: true });
    const codRes = out.results.find((r) => r.key === "call of duty");
    assert.strictEqual(codRes.want, 0);
    assert.strictEqual(codRes.plannedCreate, undefined);
  } finally {
    h.restore();
  }
});

test("plan: an unreadable campaign list or marker read withholds growth", async () => {
  const base = {
    rows: [row("rainbow six", "Rainbow Six Siege", 120, 25)],
    bots: [bot("18", "Rainbow Six Siege", 34)],
    campaigns: [{ game: "Rainbow Six Siege" }],
  };
  const h1 = withAllocator({ ...base, campaignError: new Error("mongo down") });
  try {
    const p = await h1.allocator.plan({ days: 30 });
    const r6 = p.games[0];
    assert.strictEqual(r6.fleetNeed, 0);
    assert.ok(r6.notes.some((n) => /campaign list unreadable/.test(n)));
  } finally {
    h1.restore();
  }
  const h2 = withAllocator(base);
  try {
    // The marker read fails: the fleet is treated as unknown, and nothing grows.
    const fleet = require("../utils/noclaimFleet");
    fleet.sh = async () => {
      throw new Error("ssh timeout");
    };
    const p = await h2.allocator.plan({ days: 30 });
    assert.strictEqual(p.fleetKnown, false);
    assert.strictEqual(p.games[0].fleetNeed, 0);
  } finally {
    h2.restore();
  }
});
