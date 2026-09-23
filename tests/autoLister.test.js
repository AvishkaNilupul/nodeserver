// Unit tests for the auto-lister's pure logic: house-style titles and
// descriptions, market-research pricing, and post-event bundle stacking.
const test = require("node:test");
const assert = require("node:assert");
const {
  buildTitle,
  buildDescription,
  derivePrice,
  stackItems,
  chooseStackItems,
  postEventPrice,
  computeSplit,
  isAutoOwned,
  normLabel,
  looksLikeTitlePlaceholder,
  resolveCampaignItems,
  filterVerifiedHolders,
  withReservationRollback,
} = require("../utils/autoLister");
// The stock side's key builder — the campaign side must produce identical keys.
const { itemKeyFor } = require("../utils/twitchInventory");

const items = [
  { itemKey: "a|g", name: "Heidel Chest", game: "Black Desert", qty: 1 },
  { itemKey: "b|g", name: "Shiny Golden Seal", game: "Black Desert", qty: 1 },
  { itemKey: "c|g", name: "Cron Stone x100", game: "Black Desert", qty: 1 },
];

test("title follows house style with item names and count", () => {
  const t = buildTitle({
    game: "Black Desert",
    items,
    campaignName: "Heidel Ball",
  });
  assert.ok(t.startsWith("Black Desert Twitch Drops (3 Items)"));
  assert.ok(t.includes("Heidel Chest + Shiny Golden Seal"));
  assert.ok(t.includes("+1 more"));
  assert.ok(t.length <= 120);
});

test("a post-event title is not flagged as ended", () => {
  const t = buildTitle({
    game: "Rust",
    items: items.slice(0, 1),
    postEvent: true,
  });
  assert.ok(t.startsWith("Rust Twitch Drops (1 Item)"));
  assert.doesNotMatch(t, /EVENT ENDED/);
});

test("title never exceeds Gameflip's 120-char limit", () => {
  const long = Array.from({ length: 8 }, (_, i) => ({
    itemKey: "k" + i,
    name: "An Extremely Long Legendary Item Name Number " + i,
    game: "Some Very Long Game Name Here",
  }));
  const t = buildTitle({ game: "Some Very Long Game Name Here", items: long });
  assert.ok(t.length <= 120);
});

test("description lists every item and the house sections", () => {
  const d = buildDescription({
    game: "Black Desert",
    items,
    campaignName: "Heidel Ball",
  });
  for (const i of items) assert.ok(d.includes(i.name));
  assert.ok(d.includes("Includes:"));
  assert.ok(d.includes("check the item list carefully"));
  assert.ok(d.includes("within the first hour"));
  assert.ok(!d.includes("unobtainable"));
  assert.ok(!d.includes("EVENT IS OVER"));
});

test("post-event description leads with scarcity and drops the countdown", () => {
  const d = buildDescription({
    game: "Rust",
    items,
    campaignName: "Twitch Rivals",
    postEvent: true,
  });
  assert.ok(d.startsWith("THE Twitch Rivals DROP EVENT IS OVER"));
  assert.ok(d.includes("no longer be earned"));
  assert.ok(d.includes("still redeem"));
  assert.ok(!d.includes("unobtainable"));
});

// Automatic repricing is only ever allowed to move the auto-farmer's OWN
// prices. Listings the owner made by hand are their own stock at their own
// price, and the post-event markup must not touch them even when they sit on a
// drop set the auto-farmer also uses.
test("only an explicitly auto listing may be repriced", () => {
  assert.strictEqual(isAutoOwned({ origin: "auto", price: 2 }), true);
  assert.strictEqual(isAutoOwned({ origin: "manual", price: 2 }), false);
});

test("a listing with no origin is treated as the owner's, not repriced", () => {
  // Rows that predate the field, and anything the migration missed: unknown
  // ownership must fail closed, or a backfill gap silently reprices real stock.
  assert.strictEqual(isAutoOwned({ price: 2 }), false);
  assert.strictEqual(isAutoOwned({ origin: "" }), false);
  assert.strictEqual(isAutoOwned({ origin: undefined }), false);
  assert.strictEqual(isAutoOwned(null), false);
  assert.strictEqual(isAutoOwned(undefined), false);
});

// autoDeliver is set on hand-made auto-delivery listings too, so it can never
// stand in for ownership — the whole reason `origin` had to be added.
test("auto-delivery does not by itself make a listing repriceable", () => {
  assert.strictEqual(
    isAutoOwned({ origin: "manual", autoDeliver: true, qtyTarget: 5 }),
    false,
  );
});

test("price anchors on sold prices and undercuts live competition", () => {
  const research = {
    markets: {
      gameflip: { soldRecent: 5, avgSoldPrice: 4.0, lowest: 3.0 },
      ggsel: { lowest: 5.0 },
      plati: { lowest: 6.0 },
    },
  };
  // Undercut the $3.00 live Gameflip rival by 5% -> 2.85 -> $2.75, which is
  // still under the $4.00 buyers actually paid.
  assert.strictEqual(derivePrice(research), 2.75);
});

// The bug this guards: GGSel and Plati are ruble-denominated marketplaces. On
// prod, ggsel.lowest was $0.38 and plati.lowest $1.28 (Plati's ~100 RUB floor)
// while the cheapest live GAMEFLIP rival for the same game was $1.20. Taking
// Math.min across all three let a ruble floor price a USD listing, undercut it,
// and hit Gameflip's $0.75 clamp — so Rocket League, with 20 verified sales
// averaging $7.93, was listed at $0.75.
test("a cheap ruble-market floor never drags down a Gameflip price", () => {
  const rocketLeague = {
    markets: {
      gameflip: { soldRecent: 20, avgSoldPrice: 7.93, lowest: 1.2 },
      ggsel: { lowest: 0.38 },
      plati: { lowest: 1.28 },
    },
  };
  // $1.20 rival -> undercut to $1.14 -> the first quarter strictly below the
  // rival, so we are actually the cheapest rather than $0.05 above it.
  assert.strictEqual(derivePrice(rocketLeague), 1.0);
});

// Rounding to the nearest quarter used to undo the undercut: a $1.20 rival
// produced $1.14, which round25 lifted to $1.25 — above the listing we meant
// to beat. Whenever there is live competition we must land strictly under it.
test("the price always lands strictly below a live rival", () => {
  for (const rival of [1.2, 1.5, 2.0, 3.1, 4.99]) {
    const p = derivePrice({
      markets: { gameflip: { soldRecent: 10, avgSoldPrice: 9, lowest: rival } },
    });
    assert.ok(p < rival, `priced ${p} is not below rival ${rival}`);
    assert.ok(p >= 0.75, `priced ${p} is below the platform floor`);
  }
});

// A thin sample can be a multi-account bundle rather than our single-account
// product: Hunt: Showdown shows $28.20 over 5 sales while its cheapest live
// listing is $0.75. The anchor must not run away with that.
test("a thin or outlier sold-price sample never inflates the price", () => {
  const thin = {
    markets: { gameflip: { soldRecent: 2, avgSoldPrice: 50, lowest: 2.0 } },
  };
  // 2 sales is below MIN_SOLD_SAMPLES, so the anchor is ignored entirely and
  // the live $2.00 rival prices it — landing at the quarter below.
  assert.strictEqual(derivePrice(thin), 1.75);

  const outlier = {
    markets: { gameflip: { soldRecent: 5, avgSoldPrice: 28.2, lowest: 0.75 } },
  };
  // Enough samples, but the live rival is cheaper, so we still undercut it.
  assert.strictEqual(derivePrice(outlier), 0.75);

  const noRival = {
    markets: { gameflip: { soldRecent: 5, avgSoldPrice: 28.2, lowest: 0 } },
  };
  // No competition at all: the anchor stands, but capped at MAX_ANCHOR_USD.
  assert.strictEqual(derivePrice(noRival), 10);
});

test("price falls back to cheapest competitor when nothing sold", () => {
  const research = {
    markets: { plati: { lowest: 2.0 }, ggsel: { lowest: 4.0 } },
  };
  assert.strictEqual(derivePrice(research), 2.0);
});

test("unknown market probes at $1 and floor is $0.75", () => {
  assert.strictEqual(derivePrice(null), 1.0);
  const cheap = { markets: { gameflip: { avgSoldPrice: 0.3, lowest: 0.2 } } };
  assert.strictEqual(derivePrice(cheap), 0.75);
});

test("post-event multiplier applies the scarcity markup", () => {
  const research = {
    markets: { gameflip: { avgSoldPrice: 2.0, lowest: 2.0 } },
  };
  assert.ok(
    derivePrice(research, { postEventMultiplier: 1.5 }) > derivePrice(research),
  );
});

test("stacking unions items across sets without duplicates", () => {
  const sets = [
    { items: [items[0], items[1]] },
    { items: [items[1], items[2]] },
  ];
  const merged = stackItems(sets);
  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(merged.map((i) => i.itemKey).sort(), [
    "a|g",
    "b|g",
    "c|g",
  ]);
});

// onCampaignEnded's stacking gate (the re-verify fix). The old code grew the
// advertised bundle to the sibling union UNCONDITIONALLY. Delivery — for the
// live row AND every backlog relist (claimAccountForSet -> availableAccountsForSet)
// — only ever resolves accounts holding EVERY item in the set, so growing past
// what any account holds makes the live row over-promise and every relist find
// no holder and stall. chooseStackItems is that decision, isolated and pure.
const backed = [items[0]]; // what the live row is already verified/reserved for
const union = [items[0], items[1], items[2]]; // the bigger sibling union

test("stacking gate GROWS to the union when a verified holder exists", () => {
  const { items: chosen, stackSkipped } = chooseStackItems(backed, union, 1);
  assert.strictEqual(chosen, union);
  assert.strictEqual(stackSkipped, "");
});

test("stacking gate does NOT grow when no account holds the full union", () => {
  // The bug's core: 0 holders must keep the already-backed items, never
  // advertise contents nothing backs.
  const { items: chosen, stackSkipped } = chooseStackItems(backed, union, 0);
  assert.strictEqual(chosen, backed);
  assert.match(stackSkipped, /kept 1 backed item\(s\) instead of advertising 3/);
});

test("stacking gate is a no-op when there's nothing extra to stack", () => {
  // No siblings (stacked == current) — never re-lists the same bundle, and
  // never flags a skip because nothing was withheld.
  const { items: chosen, stackSkipped } = chooseStackItems(union, union, 0);
  assert.strictEqual(chosen, union);
  assert.strictEqual(stackSkipped, "");
});

test("stacking gate keeps current when the union is somehow smaller", () => {
  // Defensive: a shrunk union is never grown into, holders or not.
  const { items: chosen, stackSkipped } = chooseStackItems(union, backed, 5);
  assert.strictEqual(chosen, union);
  assert.strictEqual(stackSkipped, "");
});

test("stacking gate tolerates null/empty inputs without throwing", () => {
  assert.deepStrictEqual(chooseStackItems(null, null, 0), {
    items: [],
    stackSkipped: "",
  });
  const grown = chooseStackItems(null, union, 2);
  assert.strictEqual(grown.items, union);
});

test("post-event price is +50% on the listing's own price", () => {
  assert.strictEqual(postEventPrice(1.75), 2.75); // 2.625 -> nearest 0.25
  assert.strictEqual(postEventPrice(1.5), 2.25);
  assert.strictEqual(postEventPrice(0.75), 1.25); // 1.125 -> 1.25
  assert.strictEqual(postEventPrice(0), 1.5); // no base -> $1 x 1.5
  assert.ok(postEventPrice(0.1) >= 0.75); // never under Gameflip's floor
});

// The formula this replaced summed every past campaign price for the game and
// marked THAT up. Because the item union de-duplicates while a sum does not,
// price grew with campaign count even when the bundle didn't — The Quinfall
// stacked to one item and priced at $12.50 — and each sibling's already-marked-up
// price compounded the markup again. Applying it to the listing's own price is
// bounded by construction: the result is always exactly 1.5x, never a multiple
// of how many campaigns a game happens to have run.
test("the markup cannot compound across repeated campaigns", () => {
  let p = 1.0;
  for (let i = 0; i < 4; i++) p = postEventPrice(p);
  // Four ended campaigns: 1.5x each time, not 1.5x a growing sum.
  assert.ok(p <= 1.0 * Math.pow(1.5, 4) + 0.25, "stays on the 1.5x curve");
  // And one campaign's markup never depends on its siblings.
  assert.strictEqual(postEventPrice(2.0), 3.0);
});

test("hold-back split lists half now (rounded up), holds the rest", () => {
  assert.deepStrictEqual(computeSplit(6), { listNow: 3, holdBack: 3 });
  assert.deepStrictEqual(computeSplit(5), { listNow: 3, holdBack: 2 });
  assert.deepStrictEqual(computeSplit(3), { listNow: 2, holdBack: 1 });
  assert.deepStrictEqual(computeSplit(2), { listNow: 1, holdBack: 1 });
});

test("hold-back split never holds when there is only one account", () => {
  assert.deepStrictEqual(computeSplit(1), { listNow: 1, holdBack: 0 });
  assert.deepStrictEqual(computeSplit(0), { listNow: 0, holdBack: 0 });
});

/* ------------ placeholder guard: don't build a set from a title ---------- */

test("looksLikeTitlePlaceholder flags the game/campaign title, not real drops", () => {
  const ctx = {
    game: "Assassin's Creed Black Flag Resynced",
    campaignName: "AC Black Flag Resynced",
  };
  assert.strictEqual(
    looksLikeTitlePlaceholder("AC Black Flag Resynced", ctx),
    true,
  );
  assert.strictEqual(
    looksLikeTitlePlaceholder("assassins creed black flag resynced", ctx),
    true,
  );
  assert.strictEqual(looksLikeTitlePlaceholder("Rustborne Swords", ctx), false);
  assert.strictEqual(looksLikeTitlePlaceholder("Cheetah Claw Cat", ctx), false);
  assert.strictEqual(looksLikeTitlePlaceholder("   ", ctx), true);
});

test("resolveCampaignItems drops the AC placeholder and keeps real drops", () => {
  const game = "Assassin's Creed Black Flag Resynced";
  const campaignName = "AC Black Flag Resynced";
  const placeholderOnly = {
    timeBasedDrops: [
      {
        requiredMinutesWatched: 0,
        benefitEdges: [{ benefit: { name: "AC Black Flag Resynced" } }],
      },
    ],
  };
  const r1 = resolveCampaignItems(placeholderOnly, { game, campaignName });
  assert.strictEqual(r1.items.length, 0);
  assert.strictEqual(r1.rawBenefits, 1);

  const real = {
    timeBasedDrops: [
      {
        requiredMinutesWatched: 60,
        benefitEdges: [
          { benefit: { name: "Rustborne Swords", game: { name: game } } },
          { benefit: { name: "Cheetah Claw Cat", game: { name: game } } },
          { benefit: { name: "Rustborne Swords", game: { name: game } } },
        ],
      },
    ],
  };
  const r2 = resolveCampaignItems(real, { game, campaignName });
  assert.strictEqual(r2.items.length, 2);
  assert.deepStrictEqual(r2.items.map((i) => i.name).sort(), [
    "Cheetah Claw Cat",
    "Rustborne Swords",
  ]);
});

// Latent-asymmetry fix: the stock side (twitchInventory.buildDrops) keys drops
// on game.displayName||name; the campaign side used to fetch only game.name and
// key on that. A game whose displayName differs from its name beyond case then
// produced two itemKeys that never matched, so the holdings gate found 0 holders
// and the bundle never listed. Both sides must now yield the SAME key.
test("resolveCampaignItems keys on the game's displayName, matching the stock side", () => {
  const camp = {
    game: { displayName: "PUBG: BATTLEGROUNDS" },
    timeBasedDrops: [
      {
        requiredMinutesWatched: 60,
        benefitEdges: [
          {
            benefit: {
              name: "Golden Kappa",
              game: { name: "pubg", displayName: "PUBG: BATTLEGROUNDS" },
            },
          },
        ],
      },
    ],
  };
  const { items } = resolveCampaignItems(camp, {
    game: "PUBG: BATTLEGROUNDS",
    campaignName: "Season 30",
  });
  assert.strictEqual(items.length, 1);
  // Identical to what twitchInventory would store for the same reward, so the
  // holdings gate matches. Keying on name ("pubg") would NOT equal this.
  assert.strictEqual(
    items[0].itemKey,
    itemKeyFor("Golden Kappa", "PUBG: BATTLEGROUNDS"),
  );
  assert.notStrictEqual(items[0].itemKey, itemKeyFor("Golden Kappa", "pubg"));
  assert.strictEqual(items[0].game, "PUBG: BATTLEGROUNDS");
});

// Fallback chain unchanged when there's no displayName: the benefit game's name
// still keys it, and an absent benefit game falls back to the campaign's game
// then the task game — so nothing that worked before regresses.
test("resolveCampaignItems falls back to name, then campaign game, then task game", () => {
  const camp = {
    game: { displayName: "Campaign Game" },
    timeBasedDrops: [
      {
        requiredMinutesWatched: 60,
        benefitEdges: [
          { benefit: { name: "Has Name", game: { name: "Benefit Game" } } },
          { benefit: { name: "No Game" } },
        ],
      },
    ],
  };
  const { items } = resolveCampaignItems(camp, {
    game: "Task Game",
    campaignName: "C",
  });
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.strictEqual(byName["Has Name"].itemKey, itemKeyFor("Has Name", "Benefit Game"));
  // No benefit game -> the campaign's own game (mirrors stock's c.game fallback).
  assert.strictEqual(byName["No Game"].itemKey, itemKeyFor("No Game", "Campaign Game"));
});

/* --------------- holdings gate: only fully-holding accounts -------------- */

const NEED = new Map([
  ["poe nautical|poe", 1],
  ["poe allflame|poe", 1],
]);
const ASSIGNED = new Set(["goodacct", "notmine", "nopass", "shortcopies"]);

function accMap(entries) {
  return new Map(
    entries.map((e) => [e.id, { login: e.login, password: e.password }]),
  );
}

test("verified holder with full bundle + password + assigned is delivered", () => {
  const rows = [
    {
      _id: "1",
      items: [
        { k: "poe nautical|poe", count: 1 },
        { k: "poe allflame|poe", count: 1 },
      ],
    },
  ];
  const out = filterVerifiedHolders(
    rows,
    accMap([{ id: "1", login: "goodacct", password: "pw" }]),
    {
      needByKey: NEED,
      assignedLower: ASSIGNED,
    },
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].login, "goodacct");
  assert.strictEqual(out[0].accountId, "1");
});

test("account NOT in the task's assigned set is rejected (wrong-account bucket)", () => {
  const rows = [
    {
      _id: "2",
      items: [
        { k: "poe nautical|poe", count: 1 },
        { k: "poe allflame|poe", count: 1 },
      ],
    },
  ];
  const out = filterVerifiedHolders(
    rows,
    accMap([{ id: "2", login: "stranger", password: "pw" }]),
    {
      needByKey: NEED,
      assignedLower: ASSIGNED,
    },
  );
  assert.strictEqual(out.length, 0);
});

test("account without a usable password is rejected", () => {
  const rows = [
    {
      _id: "3",
      items: [
        { k: "poe nautical|poe", count: 1 },
        { k: "poe allflame|poe", count: 1 },
      ],
    },
  ];
  const out = filterVerifiedHolders(
    rows,
    accMap([{ id: "3", login: "nopass", password: "" }]),
    {
      needByKey: NEED,
      assignedLower: ASSIGNED,
    },
  );
  assert.strictEqual(out.length, 0);
});

test("insufficient copies of a promised item is rejected (partial bucket)", () => {
  const need2 = new Map([
    ["poe nautical|poe", 2],
    ["poe allflame|poe", 1],
  ]);
  const rows = [
    {
      _id: "4",
      items: [
        { k: "poe nautical|poe", count: 1 },
        { k: "poe allflame|poe", count: 1 },
      ],
    },
  ];
  const out = filterVerifiedHolders(
    rows,
    accMap([{ id: "4", login: "shortcopies", password: "pw" }]),
    {
      needByKey: need2,
      assignedLower: ASSIGNED,
    },
  );
  assert.strictEqual(out.length, 0);
});

test("empty rows (nobody holds the full bundle) => list nothing", () => {
  const out = filterVerifiedHolders([], accMap([]), {
    needByKey: NEED,
    assignedLower: ASSIGNED,
  });
  assert.deepStrictEqual(out, []);
});

/* ------ reserve→publish rollback: release stranded reservations on fail ---- */

test("withReservationRollback returns the publish result on success (no release)", async () => {
  let released = false;
  const set = { _id: "set1" };
  const reserved = [{ accountId: "a1" }];
  const r = await withReservationRollback(
    reserved,
    set,
    async () => ({ externalId: "X", ok: true }),
    {
      release: async () => {
        released = true;
      },
    },
  );
  assert.deepStrictEqual(r, { externalId: "X", ok: true });
  assert.strictEqual(released, false, "must not release when publish succeeds");
});

test("withReservationRollback releases the reservation when publish throws", async () => {
  const calls = [];
  const set = { _id: "set2" };
  const reserved = [{ accountId: "a1" }, { accountId: "a2" }];
  await assert.rejects(
    () =>
      withReservationRollback(
        reserved,
        set,
        async () => {
          throw new Error("gameflip 429");
        },
        {
          release: async (accts, s) => {
            calls.push({ accts, setId: s._id });
          },
        },
      ),
    /gameflip 429/,
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].setId, "set2");
  assert.deepStrictEqual(
    calls[0].accts.map((a) => a.accountId),
    ["a1", "a2"],
  );
});

test("a rollback failure never masks the original publish error", async () => {
  const set = { _id: "set3" };
  await assert.rejects(
    () =>
      withReservationRollback(
        [{ accountId: "a1" }],
        set,
        async () => {
          throw new Error("real: digiseller timeout");
        },
        {
          release: async () => {
            throw new Error("rollback blew up");
          },
        },
      ),
    /real: digiseller timeout/, // the publish error, not the rollback error
  );
});
