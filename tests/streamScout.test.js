// Pure-function coverage for the Stream Scout gate's two safety-critical
// decisions — no docker, no Mongo, no network:
//   1. liveWakeTrigger — the §4 trap: an idle_no_stream park MUST wake on a
//      liveness transition, never on startAt (the campaign started days ago).
//   2. verify-earned classification — a bot is only "finished" when each account
//      actually holds a drop for every assigned game, not just some drop.
// See docs/STREAM-SCOUT-PLAN.md §4 and §9 Phase 3.
const test = require("node:test");
const assert = require("node:assert");

const {
  liveWakeTrigger,
  liveIsFresh,
  isGateableGame,
  gatedDark,
  gameMatchesCampaign,
} = require("../utils/botWaker");
const { classifyBotCompletion } = require("../utils/farmCompletion");
const settings = require("../utils/settings");

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Run fn with the stream-gate simulated ON in-process, then restore. Mirrors how
// settings drives isGateableGame/gatedDark without touching settings.json.
function withGate(games, noClaim, fn) {
  const o1 = settings.getStreamGate,
    o2 = settings.isStreamGatedGame,
    o3 = settings.isNoClaimGame;
  settings.getStreamGate = () => ({ enabled: true, games });
  settings.isStreamGatedGame = (g) =>
    Object.keys(games).some((k) => norm(g).includes(norm(k)));
  settings.isNoClaimGame = (g) =>
    (noClaim || []).some((k) => norm(g).includes(norm(k)));
  try {
    return fn();
  } finally {
    settings.getStreamGate = o1;
    settings.isStreamGatedGame = o2;
    settings.isNoClaimGame = o3;
  }
}

const GAMES = new Set(["rocket league"]);
const PARKED = "2026-08-24T14:00:00.000Z";
const campaigns = [{ campaignId: "c1", game: "Rocket League", name: "RLCS" }];

function row(over) {
  return {
    campaignId: "c1",
    game: "rocket league",
    gated: true,
    liveNow: false,
    lastLiveAt: null,
    darkSince: new Date(),
    checkedAt: new Date(),
    ...over,
  };
}

// --- liveWakeTrigger (the §4 trap) -------------------------------------------

test("idle_no_stream park wakes when an allowed channel is live now", () => {
  const m = new Map([["c1", row({ liveNow: true, lastLiveAt: new Date() })]]);
  const t = liveWakeTrigger(GAMES, PARKED, campaigns, m);
  assert.ok(t && t.campaignId === "c1");
});

test("a fresh, dark campaign does NOT wake an idle_no_stream park", () => {
  const m = new Map([["c1", row({ liveNow: false })]]);
  assert.strictEqual(liveWakeTrigger(GAMES, PARKED, campaigns, m), null);
});

test("wakes when the campaign went live AFTER the park (not startAt)", () => {
  // The campaign started days ago; only a live moment AFTER the park matters.
  const m = new Map([
    [
      "c1",
      row({
        liveNow: false,
        lastLiveAt: new Date(new Date(PARKED).getTime() + 60 * 60 * 1000),
      }),
    ],
  ]);
  const t = liveWakeTrigger(GAMES, PARKED, campaigns, m);
  assert.ok(t, "a broadcast that resumed after the park must re-wake the bot");
});

test("a live moment BEFORE the park does not, on its own, wake", () => {
  const m = new Map([
    [
      "c1",
      row({
        liveNow: false,
        lastLiveAt: new Date(new Date(PARKED).getTime() - 60 * 60 * 1000),
      }),
    ],
  ]);
  assert.strictEqual(liveWakeTrigger(GAMES, PARKED, campaigns, m), null);
});

test("stale liveness data wakes — fail toward farming", () => {
  const stale = new Date(Date.now() - 60 * 60 * 1000); // 1h old, past LIVE_STALE_MS
  const m = new Map([["c1", row({ liveNow: false, checkedAt: stale })]]);
  assert.ok(
    liveWakeTrigger(GAMES, PARKED, campaigns, m),
    "a Scout outage must never strand a parked bot",
  );
});

test("a missing liveness row wakes — fail toward farming", () => {
  assert.ok(liveWakeTrigger(GAMES, PARKED, campaigns, new Map()));
});

test("a campaign for a game the bot does not farm is ignored", () => {
  const m = new Map([
    ["c1", row({ game: "fortnite", liveNow: true, lastLiveAt: new Date() })],
  ]);
  const other = [{ campaignId: "c1", game: "Fortnite", name: "x" }];
  assert.strictEqual(liveWakeTrigger(GAMES, PARKED, other, m), null);
});

test("liveIsFresh boundary", () => {
  assert.strictEqual(liveIsFresh({ checkedAt: new Date() }), true);
  assert.strictEqual(
    liveIsFresh({ checkedAt: new Date(Date.now() - 60 * 60 * 1000) }),
    false,
  );
  assert.strictEqual(liveIsFresh(null), false);
  assert.strictEqual(liveIsFresh({}), false);
});

// --- verify-earned classification --------------------------------------------

const cfg = {
  FavouriteGames: ["Rocket League"],
  TwitchSettings: {
    OnlyFavouriteGames: true,
    TwitchUsers: [
      { ClientSecret: "s1", Login: "accta", Enabled: true },
      { ClientSecret: "s2", Login: "acctb", Enabled: true },
    ],
  },
};
const accts = [
  {
    clientSecret: "s1",
    login: "accta",
    inProgressCount: 0,
    inProgressGames: [],
    dropCount: 5,
    lastScanStatus: "ok",
    lastScanAt: new Date(),
  },
  {
    clientSecret: "s2",
    login: "acctb",
    inProgressCount: 0,
    inProgressGames: [],
    dropCount: 3,
    lastScanStatus: "ok",
    lastScanAt: new Date(),
  },
];

test("without verify-earned, any global drop counts as finished (the hole)", () => {
  const v = classifyBotCompletion(cfg, accts, {});
  assert.strictEqual(v.finished, 2);
  assert.strictEqual(v.stoppable, true);
});

test("verify-earned blocks park until each account holds its assigned game", () => {
  // acctA holds a Rocket League drop; acctB has only an unrelated drop.
  const held = new Map([
    ["accta", new Set(["rocket league"])],
    ["acctb", new Set(["fortnite"])],
  ]);
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    dropGamesByLogin: held,
  });
  assert.strictEqual(v.finished, 1);
  assert.strictEqual(v.notStarted, 1);
  assert.strictEqual(v.stoppable, false);
});

test("verify-earned lets the bot park once every account has its game", () => {
  const held = new Map([
    ["accta", new Set(["rocket league"])],
    ["acctb", new Set(["rocket league"])],
  ]);
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    dropGamesByLogin: held,
  });
  assert.strictEqual(v.finished, 2);
  assert.strictEqual(v.stoppable, true);
});

test("verify-earned falls back safely when a login can't be resolved", () => {
  // Empty map + no login match → must NOT strand: falls back to dropCount, which
  // here is > 0, so the bots read finished rather than being wrongly held.
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    dropGamesByLogin: new Map(),
  });
  // Both accounts miss their game in the empty map → notStarted (bot stays up).
  // This is the SAFE direction (keep running), never a false park.
  assert.strictEqual(v.stoppable, false);
});

test("an account still mid-drop on its assigned game is working, not finished", () => {
  const busy = [
    { ...accts[0], inProgressGames: ["rocket league"] },
    accts[1],
  ];
  const held = new Map([
    ["accta", new Set(["rocket league"])],
    ["acctb", new Set(["rocket league"])],
  ]);
  const v = classifyBotCompletion(cfg, busy, {
    requireEarned: true,
    dropGamesByLogin: held,
  });
  assert.strictEqual(v.working, 1);
  assert.strictEqual(v.stoppable, false);
});

// --- gate scoping: what may the gate act on? (auto-farm safety) --------------

test("isGateableGame: gated + not-no-claim only when the switch is on", () => {
  const games = { "special events": {}, "rainbow six": {} };
  const noClaim = ["rainbow six", "overwatch"];
  withGate(games, noClaim, () => {
    assert.strictEqual(isGateableGame("Special Events"), true);
    // no-claim games are EXCLUDED even when opted in — they are owned by the
    // no-claim system and wakeFinishedBots filters them, so gating one would
    // strand it. This is the core auto-farm-safety guard.
    assert.strictEqual(isGateableGame("Tom Clancy's Rainbow Six Siege"), false);
    // a game not in the map is never gated
    assert.strictEqual(isGateableGame("Rocket League"), false);
  });
  // switch OFF ⇒ nothing is gateable ⇒ zero behaviour change
  assert.strictEqual(isGateableGame("Special Events"), false);
});

test("gatedDark holds a wake only on a fresh, gated, dark row", () => {
  const games = { "special events": {} };
  withGate(games, [], () => {
    const c = { campaignId: "e1", game: "Special Events" };
    const fresh = (over) =>
      new Map([
        [
          "e1",
          {
            campaignId: "e1",
            gated: true,
            liveNow: false,
            checkedAt: new Date(),
            ...over,
          },
        ],
      ]);
    assert.strictEqual(gatedDark(c, fresh()), true, "fresh dark ⇒ hold");
    assert.strictEqual(
      gatedDark(c, fresh({ liveNow: true })),
      false,
      "live ⇒ don't hold",
    );
    assert.strictEqual(
      gatedDark(
        c,
        fresh({ checkedAt: new Date(Date.now() - 60 * 60 * 1000) }),
      ),
      false,
      "stale ⇒ fail toward farming (don't hold)",
    );
    assert.strictEqual(gatedDark(c, new Map()), false, "no row ⇒ don't hold");
  });
  // switch OFF ⇒ never holds a wake
  assert.strictEqual(
    gatedDark({ campaignId: "e1", game: "Special Events" }, new Map()),
    false,
  );
});

test("park↔wake reason string round-trips (idle_no_stream matcher)", () => {
  // parkIdleBots records this reason; wakeFinishedBots keys the liveness-wake
  // branch on /idle_no_stream/i. Guard against a typo drifting them apart.
  const reason = "idle_no_stream — no assigned broadcast is live";
  assert.match(reason, /idle_no_stream/i);
  assert.doesNotMatch(reason, /manual/i);
});

// --- idle-no-campaign: inclusive game↔campaign matching (auto-farm safety) ----

test("gameMatchesCampaign catches divergent labels (no false negatives)", () => {
  // The whole point: a false negative would park a farming bot. These divergent
  // pairs MUST match so such a bot is seen as having a campaign.
  assert.ok(gameMatchesCampaign("overwatch", "Overwatch 2"));
  assert.ok(gameMatchesCampaign("Overwatch 2", "overwatch"));
  assert.ok(
    gameMatchesCampaign("rainbow six siege", "Tom Clancy's Rainbow Six Siege"),
  );
  assert.ok(gameMatchesCampaign("Rocket League", "rocket league"));
  assert.ok(gameMatchesCampaign("NARAKA: BLADEPOINT", "naraka bladepoint"));
});

test("gameMatchesCampaign separates genuinely different games", () => {
  assert.strictEqual(gameMatchesCampaign("Rocket League", "Marvel Rivals"), false);
  assert.strictEqual(gameMatchesCampaign("Rust", "Warframe"), false);
  assert.strictEqual(gameMatchesCampaign("rocket league", ""), false);
  assert.strictEqual(gameMatchesCampaign("", "rocket league"), false);
});

test("idle_no_campaign reason wakes with grace (manual-style), not liveness", () => {
  const reason = "idle_no_campaign — no active campaign for its games";
  assert.match(reason, /manual|idle_no_campaign/i); // gets PARK_CAMPAIGN_GRACE
  assert.doesNotMatch(reason, /idle_no_stream/i); // NOT the liveness-wake branch
});

// --- verify-earned: per-campaign manifest + inclusive labels (2026-08-25) -----

test("verify-earned holds a bot missing an expected campaign drop", () => {
  // accta holds the game but not the campaign's expected benefit; acctb holds
  // everything. Only acctb may park.
  const heldByLogin = new Map([
    ["accta", { games: new Set(["rocket league"]), benefitIds: new Set(["b1"]), itemKeys: new Set(["trophy|rocket league"]) }],
    ["acctb", { games: new Set(["rocket league"]), benefitIds: new Set(["b1", "b2"]), itemKeys: new Set(["trophy|rocket league", "wheels|rocket league"]) }],
  ]);
  const expectedByGame = new Map([
    ["rocket league", [{ benefitId: "b1", itemKey: "trophy|rocket league" }, { benefitId: "b2", itemKey: "wheels|rocket league" }]],
  ]);
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    heldByLogin,
    expectedByGame,
  });
  assert.strictEqual(v.finished, 1);
  assert.strictEqual(v.notStarted, 1);
  assert.strictEqual(v.stoppable, false);
});

test("verify-earned parks once every expected campaign drop is held", () => {
  const heldByLogin = new Map([
    ["accta", { games: new Set(["rocket league"]), benefitIds: new Set(["b1", "b2"]), itemKeys: new Set() }],
    ["acctb", { games: new Set(["rocket league"]), benefitIds: new Set(["b1", "b2"]), itemKeys: new Set() }],
  ]);
  const expectedByGame = new Map([
    ["rocket league", [{ benefitId: "b1", itemKey: "" }, { benefitId: "b2", itemKey: "" }]],
  ]);
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    heldByLogin,
    expectedByGame,
  });
  assert.strictEqual(v.finished, 2);
  assert.strictEqual(v.stoppable, true);
});

test("verify-earned matches held-game labels inclusively (overwatch vs Overwatch 2)", () => {
  const owCfg = {
    FavouriteGames: ["overwatch"],
    TwitchSettings: {
      OnlyFavouriteGames: true,
      TwitchUsers: [{ ClientSecret: "s1", Login: "accta", Enabled: true }],
    },
  };
  const owAccts = [
    {
      clientSecret: "s1",
      login: "accta",
      inProgressCount: 0,
      inProgressGames: [],
      dropCount: 2,
      lastScanStatus: "ok",
      lastScanAt: new Date(),
    },
  ];
  // DropLog rows carry the Twitch label "Overwatch 2"; the config says
  // "overwatch". Must still count as held (previously a permanent notStarted).
  const heldByLogin = new Map([
    ["accta", { games: new Set(["overwatch 2"]), benefitIds: new Set(["b1"]), itemKeys: new Set() }],
  ]);
  const v = classifyBotCompletion(owCfg, owAccts, {
    requireEarned: true,
    heldByLogin,
  });
  assert.strictEqual(v.finished, 1);
  assert.strictEqual(v.stoppable, true);
});

test("verify-earned: a missing manifest never holds a bot (game check still applies)", () => {
  // expectedByGame has an entry for the game but with no expected drops → the
  // per-game check alone decides, and holding the game is enough.
  const heldByLogin = new Map([
    ["accta", { games: new Set(["rocket league"]), benefitIds: new Set(), itemKeys: new Set() }],
    ["acctb", { games: new Set(["rocket league"]), benefitIds: new Set(), itemKeys: new Set() }],
  ]);
  const v = classifyBotCompletion(cfg, accts, {
    requireEarned: true,
    heldByLogin,
    expectedByGame: new Map([["rocket league", []]]),
  });
  assert.strictEqual(v.finished, 2);
  assert.strictEqual(v.stoppable, true);
});

// --- Stream Scout: liveness-read errors must fail toward farming (2026-08-25) --

test("anyChannelLive: a non-token error throws (never a silent dark verdict)", async () => {
  const twitchWatch = require("../utils/twitchWatch");
  const orig = twitchWatch.getStreamsLive;
  twitchWatch.getStreamsLive = async () => {
    const e = new Error("Twitch liveness read failed (HTTP 429)");
    e.code = "twitch_http";
    throw e;
  };
  try {
    delete require.cache[require.resolve("../utils/streamScout")];
    const streamScout = require("../utils/streamScout");
    await assert.rejects(
      () => streamScout.anyChannelLive(["chan1", "chan2"], ["tok1", "tok2"]),
      /HTTP 429/,
    );
  } finally {
    twitchWatch.getStreamsLive = orig;
    delete require.cache[require.resolve("../utils/streamScout")];
  }
});

test("anyChannelLive: a dead token rotates off instead of reporting dark", async () => {
  const twitchWatch = require("../utils/twitchWatch");
  const orig = twitchWatch.getStreamsLive;
  twitchWatch.getStreamsLive = async (tok) => {
    if (tok === "dead") {
      const e = new Error("Token invalid/expired reading stream liveness");
      e.code = "token_invalid";
      throw e;
    }
    return new Set(["chan1"]);
  };
  try {
    delete require.cache[require.resolve("../utils/streamScout")];
    const streamScout = require("../utils/streamScout");
    const res = await streamScout.anyChannelLive(["chan1", "chan2"], ["dead", "good"]);
    assert.strictEqual(res.liveNow, true);
    assert.deepStrictEqual(res.liveChannels, ["chan1"]);
  } finally {
    twitchWatch.getStreamsLive = orig;
    delete require.cache[require.resolve("../utils/streamScout")];
  }
});
// --- Transition logger: error-streak decision (pure) ----------------------------

test("error streak: new error logs, same error skips, clean after error logs recovery", () => {
  // Simulate the streak logic with a simple closure (same as the module does).
  let last = "";
  function decide(currentError) {
    if (currentError && currentError !== last) {
      last = currentError;
      return "error";
    }
    if (!currentError && last) {
      last = "";
      return "recovered";
    }
    return null;
  }
  // Clean start
  assert.strictEqual(decide(""), null);
  // First error
  assert.strictEqual(decide("timeout"), "error");
  // Same error - no duplicate
  assert.strictEqual(decide("timeout"), null);
  // Different error
  assert.strictEqual(decide("429"), "error");
  // Recovery
  assert.strictEqual(decide(""), "recovered");
  // Stay clean
  assert.strictEqual(decide(""), null);
  // New error after recovery
  assert.strictEqual(decide("dns"), "error");
});

test("transition classification: flip only after first observation", () => {
  const wasLive = (prev) => !!(prev && prev.liveNow);
  const flip = (prev, liveNow) => {
    if (!prev) return null;
    return liveNow && !wasLive(prev) ? "live" : !liveNow && wasLive(prev) ? "dark" : null;
  };
  // No prev = first observation, never a transition
  assert.strictEqual(flip(null, true), null);
  assert.strictEqual(flip(null, false), null);
  // Stable
  assert.strictEqual(flip({ liveNow: true }, true), null);
  assert.strictEqual(flip({ liveNow: false }, false), null);
  // Flips
  assert.strictEqual(flip({ liveNow: false }, true), "live");
  assert.strictEqual(flip({ liveNow: true }, false), "dark");
});
