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
