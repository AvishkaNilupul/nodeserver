// Pure-function coverage for the wake/park helpers: container->config mapping
// and the "what does this bot farm" resolution that decides whether a live
// campaign is relevant to a stopped container. No docker, no Mongo.
const test = require("node:test");
const assert = require("node:assert");

const {
  fileForContainer,
  gamesOf,
  wakeTrigger,
  wakeCandidates,
  gatedDark,
} = require("../utils/botWaker");

const PARKED = "2026-07-28T14:00:00.000Z";
const games = new Set(["delta force", "fortnite"]);

test("a campaign that began after we parked the bot wakes it", () => {
  const t = wakeTrigger(games, PARKED, [
    {
      game: "Delta Force",
      name: "New Season",
      startAt: "2026-07-29T09:00:00.000Z",
    },
  ]);
  assert.ok(t);
  assert.strictEqual(t.name, "New Season");
});

test("a campaign that was already running when we parked does NOT wake it", () => {
  // This is the whole point of parking: those drops are already farmed.
  const t = wakeTrigger(games, PARKED, [
    {
      game: "Delta Force",
      name: "Old Season",
      startAt: "2026-07-26T09:00:00.000Z",
    },
  ]);
  assert.strictEqual(t, null);
});

test("a new campaign for a game the bot does not farm is ignored", () => {
  const t = wakeTrigger(games, PARKED, [
    {
      game: "Sea of Thieves",
      name: "Not Ours",
      startAt: "2026-07-29T09:00:00.000Z",
    },
  ]);
  assert.strictEqual(t, null);
});

test("game matching is case and whitespace insensitive", () => {
  const t = wakeTrigger(games, PARKED, [
    {
      game: "  DELTA force ",
      name: "Casing",
      startAt: "2026-07-29T09:00:00.000Z",
    },
  ]);
  assert.ok(t);
});

test("a live campaign with no startAt wakes rather than being assumed old", () => {
  // Missing timing on a game we farm must fail towards waking: a needless wake
  // costs RAM, a missed one costs drops that are never farmed.
  const t = wakeTrigger(games, PARKED, [
    { game: "Fortnite", name: "Undated", startAt: null },
  ]);
  assert.ok(t);
});

test("no campaigns, or none matching, yields no wake", () => {
  assert.strictEqual(wakeTrigger(games, PARKED, []), null);
  assert.strictEqual(wakeTrigger(games, PARKED, undefined), null);
  assert.strictEqual(
    wakeTrigger(new Set(), PARKED, [
      { game: "Delta Force", startAt: "2026-07-29T09:00:00.000Z" },
    ]),
    null,
  );
});

test("container name maps back to its config file", () => {
  assert.strictEqual(fileForContainer("twitchbot"), "config.json");
  assert.strictEqual(fileForContainer("twitchbotx2"), "config_02.json");
  assert.strictEqual(fileForContainer("twitchbotx18"), "config_18.json");
  assert.strictEqual(fileForContainer("twitchbotx104"), "config_104.json");
});

test("names that are not managed bots are refused", () => {
  assert.strictEqual(fileForContainer("mongo"), null);
  assert.strictEqual(fileForContainer("twitchbotx"), null);
  assert.strictEqual(fileForContainer(""), null);
  assert.strictEqual(fileForContainer(null), null);
});

test("an empty per-account list inherits the config-level games", () => {
  const games = gamesOf({
    FavouriteGames: ["Delta Force"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: true, FavouriteGames: [] },
        { ClientSecret: "b", Enabled: true },
      ],
    },
  });
  assert.deepStrictEqual([...games], ["delta force"]);
});

test("per-account games win over the config-level list, and all are unioned", () => {
  const games = gamesOf({
    FavouriteGames: ["Fortnite"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: true, FavouriteGames: ["Rust"] },
        { ClientSecret: "b", Enabled: true, FavouriteGames: ["The Quinfall"] },
        { ClientSecret: "c", Enabled: true, FavouriteGames: [] }, // inherits
      ],
    },
  });
  assert.deepStrictEqual([...games].sort(), [
    "fortnite",
    "rust",
    "the quinfall",
  ]);
});

test("disabled accounts contribute nothing — a retired account must not wake a bot", () => {
  const games = gamesOf({
    FavouriteGames: ["Fortnite"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: false, FavouriteGames: ["Rust"] },
        { ClientSecret: "b", Enabled: false },
      ],
    },
  });
  assert.strictEqual(games.size, 0);
});

test("games are normalised so campaign matching is case/space insensitive", () => {
  const games = gamesOf({
    FavouriteGames: [],
    TwitchSettings: {
      TwitchUsers: [
        {
          ClientSecret: "a",
          Enabled: true,
          FavouriteGames: ["  Sea Of THIEVES  "],
        },
      ],
    },
  });
  assert.ok(games.has("sea of thieves"));
});

test("a config with no users yields no games rather than throwing", () => {
  assert.strictEqual(gamesOf({}).size, 0);
  assert.strictEqual(gamesOf({ TwitchSettings: {} }).size, 0);
});

// ---- the park guard ----
//
// stopFinishedBots runs the SAME wakeTrigger test before parking, against the
// oldest scan the "finished" verdict rests on. Without it a bot can be parked
// into a hole it never climbs out of: the verdict says finished, a campaign for
// one of its games is already live, and wakeTrigger will not fire for a campaign
// that started before the park — so those drops are never farmed at all.
const SCANNED = "2026-07-29T06:00:00.000Z";

test("a campaign newer than the scan blocks the park", () => {
  const blocked = wakeTrigger(games, SCANNED, [
    {
      game: "Delta Force",
      name: "Started after we last looked",
      startAt: "2026-07-29T08:00:00.000Z",
    },
  ]);
  assert.ok(blocked, "the verdict predates this campaign — do not park");
});

test("a campaign older than the scan does not block the park", () => {
  // The scan already saw whatever this campaign gave the accounts, and it
  // reported them finished. Parking is safe.
  const blocked = wakeTrigger(games, SCANNED, [
    {
      game: "Delta Force",
      name: "Already counted",
      startAt: "2026-07-28T08:00:00.000Z",
    },
  ]);
  assert.strictEqual(blocked, null);
});

test("a campaign for someone else's game never blocks the park", () => {
  const blocked = wakeTrigger(games, SCANNED, [
    {
      game: "Overwatch",
      name: "Not ours",
      startAt: "2026-07-29T08:00:00.000Z",
    },
  ]);
  assert.strictEqual(blocked, null);
});

test("no scan evidence at all blocks the park", () => {
  // oldestScanAt is null when nothing was scanned, which wakeTrigger reads as
  // epoch 0 — every live campaign then looks newer, so nothing gets parked.
  const blocked = wakeTrigger(games, null, [
    { game: "Fortnite", name: "Any", startAt: "2020-01-01T00:00:00.000Z" },
  ]);
  assert.ok(blocked);
});

/* ---- park-grace: don't park into a just-started (esports/broadcast) campaign ---- */

const GRACE_48H = 48 * 60 * 60 * 1000;

test("park grace keeps a bot up for a campaign that started just before the scan", () => {
  // The OWCS MSC Day 2 case: campaign started 25 min BEFORE the scan behind the
  // "finished" verdict, but its broadcast drops land afterwards. With graceMs,
  // wakeTrigger must return the campaign (block the park).
  const scan = "2026-07-30T10:10:35.000Z";
  const t = wakeTrigger(
    new Set(["overwatch"]),
    scan,
    [
      {
        game: "Overwatch",
        name: "OWCS MSC Day 2",
        startAt: "2026-07-30T09:45:00.000Z",
      },
    ],
    GRACE_48H,
  );
  assert.ok(t, "should block park for a campaign within the grace window");
  assert.strictEqual(t.name, "OWCS MSC Day 2");
});

test("park grace still lets a long seasonal campaign park (RAM reclaimed)", () => {
  // OW S3 Midseason started weeks before the scan — outside 48h — so parking is
  // allowed even with the grace on.
  const scan = "2026-07-30T10:10:35.000Z";
  const t = wakeTrigger(
    new Set(["overwatch"]),
    scan,
    [
      {
        game: "Overwatch",
        name: "OW 2026 S3 Midseason",
        startAt: "2026-07-14T18:00:00.000Z",
      },
    ],
    GRACE_48H,
  );
  assert.strictEqual(t, null, "a weeks-old campaign should not block parking");
});

test("grace defaults to 0 so waking behaviour is unchanged", () => {
  // Without graceMs, a campaign that started before the park must NOT wake.
  const t = wakeTrigger(games, PARKED, [
    {
      game: "Delta Force",
      name: "Old Season",
      startAt: "2026-07-26T09:00:00.000Z",
    },
  ]);
  assert.strictEqual(t, null);
});

test("park grace still respects the game filter", () => {
  const scan = "2026-07-30T10:10:35.000Z";
  const t = wakeTrigger(
    new Set(["overwatch"]),
    scan,
    [{ game: "Valorant", name: "VCT", startAt: "2026-07-30T09:45:00.000Z" }],
    GRACE_48H,
  );
  assert.strictEqual(
    t,
    null,
    "a grace-window campaign for another game is ignored",
  );
});

// --- Stream-gate follow-up fixes (2026-08-25) --------------------------------

test("wakeCandidates matches labels inclusively (naraka -> NARAKA: BLADEPOINT)", () => {
  const games = new Set(["naraka"]);
  const parkedAt = "2026-08-24T10:00:00Z";
  const campaigns = [
    { campaignId: "nbpl", game: "NARAKA: BLADEPOINT", name: "NBPL", startAt: "2026-08-24T11:00:00Z" },
  ];
  const c = wakeCandidates(games, parkedAt, campaigns, 0);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].campaignId, "nbpl");
});

test("wakeCandidates returns every candidate, not just the first", () => {
  const games = new Set(["rocket league"]);
  const parkedAt = "2026-08-24T10:00:00Z";
  const campaigns = [
    { campaignId: "c1", game: "Rocket League", name: "A", startAt: "2026-08-24T12:00:00Z" },
    { campaignId: "c2", game: "Rocket League", name: "B", startAt: "2026-08-24T11:00:00Z" },
    { campaignId: "c3", game: "Sea of Thieves", name: "C", startAt: "2026-08-24T13:00:00Z" },
  ];
  const c = wakeCandidates(games, parkedAt, campaigns, 0);
  assert.deepStrictEqual(c.map((x) => x.campaignId), ["c1", "c2"]);
});

test("wakeCandidates honours the grace floor", () => {
  const games = new Set(["rocket league"]);
  const parkedAt = "2026-08-24T10:00:00Z";
  const campaigns = [
    { campaignId: "old", game: "Rocket League", name: "Old", startAt: "2026-08-24T09:30:00Z" },
    { campaignId: "new", game: "Rocket League", name: "New", startAt: "2026-08-24T11:00:00Z" },
  ];
  // grace 2h: the campaign that started 30 min BEFORE the park also counts.
  const withGrace = wakeCandidates(games, parkedAt, campaigns, 2 * 60 * 60 * 1000);
  assert.strictEqual(withGrace.length, 2);
  // no grace: only the campaign strictly newer than the park.
  const noGrace = wakeCandidates(games, parkedAt, campaigns, 0);
  assert.deepStrictEqual(noGrace.map((x) => x.campaignId), ["new"]);
});

test("a dark gated candidate does not block a later farmable one", () => {
  const settings = require("../utils/settings");
  const o1 = settings.getStreamGate;
  const o2 = settings.isStreamGatedGame;
  const o3 = settings.isNoClaimGame;
  settings.getStreamGate = () => ({ enabled: true, games: { "rainbow six": {} } });
  settings.isStreamGatedGame = (g) => String(g).toLowerCase().includes("rainbow six");
  settings.isNoClaimGame = () => false;
  try {
    // This is exactly the wakeFinishedBots loop: skip gatedDark candidates,
    // wake on the first farmable one. A mixed bot (gated + ungated game) must
    // not be held by a dark gated campaign while its ungated game has a new
    // campaign.
    const games = new Set(["rainbow six siege", "sea of thieves"]);
    const parkedAt = "2026-08-24T10:00:00Z";
    const campaigns = [
      { campaignId: "r6", game: "Rainbow Six Siege", name: "R6 EWC", startAt: "2026-08-24T11:00:00Z" },
      { campaignId: "sot", game: "Sea of Thieves", name: "SoT", startAt: "2026-08-24T11:30:00Z" },
    ];
    const liveMap = new Map([
      ["r6", { campaignId: "r6", gated: true, liveNow: false, checkedAt: new Date(), lastLiveAt: null }],
    ]);
    const candidates = wakeCandidates(games, parkedAt, campaigns, 0);
    let trigger = null;
    for (const cand of candidates) {
      if (gatedDark(cand, liveMap)) continue;
      trigger = cand;
      break;
    }
    assert.strictEqual(trigger.campaignId, "sot");
  } finally {
    settings.getStreamGate = o1;
    settings.isStreamGatedGame = o2;
    settings.isNoClaimGame = o3;
  }
});
