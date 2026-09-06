const test = require("node:test");
const assert = require("node:assert/strict");

// Pure helpers behind the public bulk catalog (docs/CATALOG-V2-CONTRACT.md §3).
const {
  MARKETPLACE_LABELS,
  PRIVATE_KEYS,
  signatureFor,
  deriveTitle,
  dedupeListings,
  unclaimedSummary,
  buyLinksFor,
  scheduleEta,
  assertPublicShape,
} = require("../utils/catalogPublic");

const HOUR = 60 * 60000;
const DAY = 24 * HOUR;

function row(
  id,
  {
    sourceType = "autofarm_event",
    sourceEventKey = "",
    stock = 1,
    category = "Rocket League",
    items = [{ itemKey: "reward|rocket league", qty: 1 }],
    createdAt,
    updatedAt,
    ...rest
  } = {},
) {
  return {
    set: { _id: id, sourceType, sourceEventKey, items, createdAt, updatedAt },
    stock,
    category,
    ...rest,
  };
}

test("public vocabulary matches the frozen contract", () => {
  assert.deepEqual(MARKETPLACE_LABELS, {
    gameflip: "Gameflip",
    eldorado: "Eldorado.gg",
    ggsel: "GGSel",
    digiseller: "Plati",
    zeusx: "ZeusX",
    funpay: "FunPay",
    epicnpc: "EpicNPC",
    g2g: "G2G",
    z2u: "Z2U",
  });
  for (const key of [
    "login",
    "loginLower",
    "password",
    "credPassword",
    "clientSecret",
    "twitchId",
    "botId",
    "container",
    "configFile",
    "accountScopeLogins",
    "accountScopeIds",
  ]) {
    assert.ok(PRIVATE_KEYS.includes(key), `PRIVATE_KEYS lacks ${key}`);
  }
});

test("signature sorts itemKey×qty pairs, skips keyless items and defaults qty to 1", () => {
  assert.equal(
    signatureFor({
      items: [
        { itemKey: "b", qty: 2 },
        { itemKey: "a" },
        { name: "no key", qty: 9 },
        { itemKey: "c", qty: 0 },
        { itemKey: "d", qty: "3" },
        { itemKey: "e", qty: "lots" },
      ],
    }),
    "ax1|bx2|cx1|dx3|ex1",
  );
  assert.equal(signatureFor({ items: [] }), "");
  assert.equal(signatureFor({}), "");
});

test("signature is independent of item order", () => {
  const forward = signatureFor({
    items: [
      { itemKey: "skin|game", qty: 1 },
      { itemKey: "emote|game", qty: 3 },
    ],
  });
  const backward = signatureFor({
    items: [
      { itemKey: "emote|game", qty: 3 },
      { itemKey: "skin|game", qty: 1 },
    ],
  });
  assert.equal(forward, backward);
  assert.equal(forward, "emote|gamex3|skin|gamex1");
});

test("title rule 1: a non-empty publicTitle wins over every other rule", () => {
  assert.equal(
    deriveTitle({
      set: {
        publicTitle: "  Hand-written title  ",
        sourceType: "autofarm_event",
        sourceEventName: "Summer Event",
        name: "Rocket League — Summer Event",
        items: [{ itemKey: "a" }],
      },
      category: "Rocket League",
      kind: "unclaimed",
      eventLabel: "Wave 1",
    }),
    "Hand-written title",
  );
  const long = "x".repeat(200);
  const out = deriveTitle({
    set: { publicTitle: long },
    category: "Game",
    kind: "bundle",
  });
  assert.ok(out.length <= 140, `title is ${out.length} chars`);
  assert.ok(out.length > 0);
  assert.ok(long.startsWith(out));
});

test("title rule 1 ignores a whitespace-only publicTitle", () => {
  assert.equal(
    deriveTitle({
      set: { publicTitle: "   ", name: "Fallback name" },
      category: "Warframe",
      kind: "bundle",
    }),
    "Fallback name",
  );
});

test("title rule 2: unclaimed sets name the event or count their drops", () => {
  const set = {
    items: [{ itemKey: "a" }, { itemKey: "b" }, { itemKey: "c" }],
    name: "ignored",
    sourceType: "autofarm_event",
    sourceEventName: "ignored too",
  };
  assert.equal(
    deriveTitle({
      set,
      category: "Overwatch 2",
      kind: "unclaimed",
      eventLabel: "OWCS Finals",
    }),
    "Overwatch 2 — OWCS Finals (unclaimed drops)",
  );
  assert.equal(
    deriveTitle({ set, category: "Overwatch 2", kind: "unclaimed" }),
    "Overwatch 2 — 3 unclaimed drops",
  );
  assert.equal(
    deriveTitle({
      set: { items: [{ itemKey: "a" }] },
      category: "Overwatch 2",
      kind: "unclaimed",
      eventLabel: "",
    }),
    "Overwatch 2 — 1 unclaimed drop",
  );
  assert.equal(
    deriveTitle({ set: {}, category: "Overwatch 2", kind: "unclaimed" }),
    "Overwatch 2 — 0 unclaimed drops",
  );
});

test("title rule 3: catalog profiles and event-less sets keep their own name", () => {
  assert.equal(
    deriveTitle({
      set: {
        sourceType: "catalog_profile",
        name: "Warframe starter pack",
        sourceEventName: "Some Event",
      },
      category: "Warframe",
      kind: "bundle",
    }),
    "Warframe starter pack",
  );
  assert.equal(
    deriveTitle({
      set: { name: "Manual bundle" },
      category: "Warframe",
      kind: "bundle",
    }),
    "Manual bundle",
  );
  assert.equal(
    deriveTitle({
      set: { name: "Manual bundle", sourceEventName: "" },
      category: "Warframe",
      kind: "bundle",
    }),
    "Manual bundle",
  );
});

test("title rule 4: event titles never repeat the game name twice", () => {
  const set = (sourceEventName) => ({
    sourceType: "autofarm_event",
    sourceEventName,
    name: "Plants on Fire — Plants on Fire",
  });
  assert.equal(
    deriveTitle({
      set: set("Plants on Fire"),
      category: "Plants on Fire",
      kind: "bundle",
    }),
    "Plants on Fire Twitch Drops",
  );
  assert.equal(
    deriveTitle({
      set: set("plants ON fire"),
      category: "Plants on Fire",
      kind: "bundle",
    }),
    "Plants on Fire Twitch Drops",
  );
  assert.equal(
    deriveTitle({
      set: set("Rocket League Summer Event"),
      category: "Rocket League",
      kind: "bundle",
    }),
    "Rocket League Summer Event",
  );
  assert.equal(
    deriveTitle({
      set: set("  Summer Event  "),
      category: "Rocket League",
      kind: "preorder",
    }),
    "Rocket League — Summer Event",
  );
});

test("dedupe picks the event mirror over stack, orphan, profile and manual rows regardless of stock", () => {
  const out = dedupeListings([
    row("orphan", { sourceEventKey: "autofarm:set:orphan", stock: 50 }),
    row("event", { sourceEventKey: "autofarm:campaign-1", stock: 5 }),
    row("stack", { sourceEventKey: "autofarm-stack:stack-1", stock: 10 }),
    row("profile", { sourceType: "catalog_profile", stock: 70 }),
    row(42, { sourceType: "manual", stock: 90 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].set._id, "event");
  assert.equal(out[0].stock, 90);
  assert.deepEqual([...out[0].mergedIds].sort(), [
    "42",
    "orphan",
    "profile",
    "stack",
  ]);
  assert.equal(out[0].mergedCount, 4);
});

test("dedupe rank ladder: stack beats orphan, orphan beats profile, profile beats manual", () => {
  const pairs = [
    [
      row("orphan", { sourceEventKey: "autofarm:set:orphan", stock: 9 }),
      row("stack", { sourceEventKey: "autofarm-stack:stack-1", stock: 1 }),
      "stack",
    ],
    [
      row("profile", { sourceType: "catalog_profile", stock: 9 }),
      row("orphan", { sourceEventKey: "autofarm:set:orphan", stock: 1 }),
      "orphan",
    ],
    [
      row("manual", { sourceType: "manual", stock: 9 }),
      row("profile", { sourceType: "catalog_profile", stock: 1 }),
      "profile",
    ],
  ];
  for (const [loser, winner, expected] of pairs) {
    const out = dedupeListings([loser, winner]);
    assert.equal(out.length, 1);
    assert.equal(out[0].set._id, expected);
    assert.deepEqual(out[0].mergedIds, [String(loser.set._id)]);
  }
});

test("dedupe tie-breaks equal ranks by higher stock, then newer createdAt", () => {
  const older = new Date("2026-09-01T00:00:00.000Z");
  const newer = new Date("2026-09-05T00:00:00.000Z");
  let out = dedupeListings([
    row("o-small", {
      sourceEventKey: "autofarm:set:o-small",
      stock: 3,
      createdAt: newer,
    }),
    row("o-big", {
      sourceEventKey: "autofarm:set:o-big",
      stock: 9,
      createdAt: older,
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].set._id, "o-big");
  out = dedupeListings([
    row("o-old", {
      sourceEventKey: "autofarm:set:o-old",
      stock: 9,
      createdAt: older,
    }),
    row("o-new", {
      sourceEventKey: "autofarm:set:o-new",
      stock: 9,
      createdAt: newer,
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].set._id, "o-new");
});

test("dedupe stockMode maxes by default and sums on request", () => {
  const rows = [
    row("a", { sourceEventKey: "autofarm:campaign-1", stock: 5 }),
    row("b", { sourceEventKey: "autofarm:set:b", stock: 50 }),
    row("c", { sourceEventKey: "autofarm:set:c", stock: 10 }),
  ];
  assert.equal(dedupeListings(rows)[0].stock, 50);
  assert.equal(dedupeListings(rows, { stockMode: "max" })[0].stock, 50);
  assert.equal(dedupeListings(rows, { stockMode: "sum" })[0].stock, 65);
});

test("dedupe groups by lowercased category and never groups empty signatures", () => {
  const out = dedupeListings([
    row("rl-1", {
      sourceEventKey: "autofarm:campaign-1",
      category: "Rocket League",
    }),
    row("rl-2", {
      sourceEventKey: "autofarm:set:rl-2",
      category: "rocket league",
    }),
    row("wf", { sourceEventKey: "autofarm:set:wf", category: "Warframe" }),
    row("empty-1", { sourceEventKey: "autofarm:set:empty-1", items: [] }),
    row("empty-2", {
      sourceEventKey: "autofarm:set:empty-2",
      items: [{ name: "keyless" }],
    }),
  ]);
  assert.deepEqual(
    out.map((r) => r.set._id),
    ["rl-1", "wf", "empty-1", "empty-2"],
  );
  assert.deepEqual(out[0].mergedIds, ["rl-2"]);
  assert.equal(out[0].mergedCount, 1);
  for (const r of out.slice(1)) {
    assert.equal(r.mergedCount || 0, 0);
  }
});

test("dedupe output follows the first appearance of each group, not the representative's position", () => {
  const out = dedupeListings([
    row("a-manual", {
      sourceType: "manual",
      category: "A",
      items: [{ itemKey: "a" }],
    }),
    row("b-1", {
      sourceEventKey: "autofarm:campaign-b",
      category: "B",
      items: [{ itemKey: "b" }],
    }),
    row("a-event", {
      sourceEventKey: "autofarm:campaign-a",
      category: "A",
      items: [{ itemKey: "a" }],
    }),
  ]);
  assert.deepEqual(
    out.map((r) => r.set._id),
    ["a-event", "b-1"],
  );
});

test("dedupe output is a copy carrying mergedIds, updatedAt and isNewAny", () => {
  const now = Date.parse("2026-09-07T12:00:00.000Z");
  const rows = [
    row("event", {
      sourceEventKey: "autofarm:campaign-1",
      stock: 2,
      createdAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - 3 * DAY),
      extra: "keep",
    }),
    row("orphan", {
      sourceEventKey: "autofarm:set:orphan",
      stock: 8,
      createdAt: new Date(now - HOUR),
      updatedAt: new Date(now - 30 * 60000),
    }),
  ];
  const [out] = dedupeListings(rows, { stockMode: "max", now });
  assert.notEqual(out, rows[0]);
  assert.equal(rows[0].mergedIds, undefined);
  assert.equal(out.set, rows[0].set);
  assert.equal(out.extra, "keep");
  assert.equal(out.stock, 8);
  assert.deepEqual(out.mergedIds, ["orphan"]);
  assert.equal(out.mergedCount, 1);
  assert.equal(new Date(out.updatedAt).getTime(), now - 30 * 60000);
  assert.equal(out.isNewAny, true);
  const [stale] = dedupeListings(rows, { now: now + 3 * DAY });
  assert.equal(stale.isNewAny, false);
});

test("dedupe leaves singletons intact with empty merge metadata", () => {
  const [out] = dedupeListings([
    row("solo", {
      sourceEventKey: "autofarm:campaign-1",
      stock: 4,
      createdAt: new Date(),
    }),
  ]);
  assert.equal(out.set._id, "solo");
  assert.equal(out.stock, 4);
  assert.deepEqual(out.mergedIds, []);
  assert.equal(out.mergedCount, 0);
  assert.equal(out.isNewAny, true);
  assert.deepEqual(dedupeListings([]), []);
});

test("unclaimed summary counts listed rows, held rows only with drops, and ranks campaigns", () => {
  const ledgers = [
    {
      status: "listed",
      drops: [{ campaign: "Wave 2" }],
      bundleLabel: "Wave 2",
    },
    {
      status: "listed",
      drops: [{ campaign: "Wave 2" }],
      bundleLabel: "Wave 2",
    },
    { status: "listed", drops: [{ campaign: "Beta" }], bundleLabel: "" },
    { status: "listed", drops: [], bundleLabel: "" },
    { status: "skipped", drops: [{ campaign: "Alpha" }], bundleLabel: "" },
    { status: "skipped", drops: [{ campaign: "" }], bundleLabel: "" },
    { status: "skipped", drops: [], bundleLabel: "" },
    { status: "skipped", bundleLabel: "" },
  ];
  const summary = unclaimedSummary({
    set: { sourceEventName: "Set event" },
    ledgers,
  });
  assert.equal(summary.listed, 4);
  assert.equal(summary.held, 2);
  assert.equal(summary.stock, 6);
  assert.deepEqual(summary.campaigns, [
    { name: "Wave 2", count: 2 },
    { name: "Alpha", count: 1 },
    { name: "Beta", count: 1 },
  ]);
  assert.equal(summary.eventLabel, "Wave 2");
});

test("unclaimed summary label precedence: bundleLabel, then set event name, then top campaign, else empty", () => {
  const drops = [{ campaign: "Camp A" }];
  assert.equal(
    unclaimedSummary({
      set: { sourceEventName: "Set event" },
      ledgers: [{ status: "listed", drops, bundleLabel: "Label" }],
    }).eventLabel,
    "Label",
  );
  assert.equal(
    unclaimedSummary({
      set: { sourceEventName: "Set event" },
      ledgers: [{ status: "listed", drops, bundleLabel: "" }],
    }).eventLabel,
    "Set event",
  );
  assert.equal(
    unclaimedSummary({
      set: {},
      ledgers: [{ status: "listed", drops }],
    }).eventLabel,
    "Camp A",
  );
  assert.equal(
    unclaimedSummary({
      set: {},
      ledgers: [{ status: "listed", drops: [] }],
    }).eventLabel,
    "",
  );
  const empty = unclaimedSummary({ set: {}, ledgers: [] });
  assert.equal(empty.stock, 0);
  assert.equal(empty.listed, 0);
  assert.equal(empty.held, 0);
  assert.equal(empty.eventLabel, "");
  assert.deepEqual(empty.campaigns, []);
});

test("buy links keep only active http(s) rows, one per marketplace at its lowest price", () => {
  const links = buyLinksFor([
    {
      marketplace: "gameflip",
      status: "active",
      url: "https://gameflip.com/a",
      price: 3,
    },
    {
      marketplace: "gameflip",
      status: "active",
      url: "https://gameflip.com/c",
      price: 2,
    },
    {
      marketplace: "gameflip",
      status: "active",
      url: "https://gameflip.com/b",
      price: 2.5,
    },
    {
      marketplace: "ggsel",
      status: "paused",
      url: "https://ggsel.net/x",
      price: 0.5,
    },
    {
      marketplace: "digiseller",
      status: "active",
      url: "ftp://plati.market/x",
      price: 0.9,
    },
    { marketplace: "zeusx", status: "active", url: "", price: 1 },
    {
      marketplace: "eldorado",
      status: "active",
      url: "HTTPS://www.eldorado.gg/x",
      price: 4,
    },
    {
      marketplace: "kinguin",
      status: "active",
      url: "http://kinguin.net/x",
      price: 1.5,
    },
  ]);
  assert.deepEqual(
    links.map((l) => [l.marketplace, l.label, l.url, l.price]),
    [
      ["kinguin", "Kinguin", "http://kinguin.net/x", 1.5],
      ["gameflip", "Gameflip", "https://gameflip.com/c", 2],
      ["eldorado", "Eldorado.gg", "HTTPS://www.eldorado.gg/x", 4],
    ],
  );
});

test("buy links sort by price ascending with unpriced rows last and cap at five", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((m, i) => ({
    marketplace: m,
    status: "active",
    url: `https://${m}.test/1`,
    price: 7 - i,
  }));
  rows.push({
    marketplace: "zero",
    status: "active",
    url: "https://zero.test/1",
    price: 0,
  });
  const links = buyLinksFor(rows);
  assert.equal(links.length, 5);
  assert.deepEqual(
    links.map((l) => l.price),
    [1, 2, 3, 4, 5],
  );
  const few = buyLinksFor([
    {
      marketplace: "zero",
      status: "active",
      url: "https://zero.test/1",
      price: 0,
    },
    {
      marketplace: "gameflip",
      status: "active",
      url: "https://g.test/1",
      price: 2.5,
    },
    {
      marketplace: "ggsel",
      status: "active",
      url: "https://gg.test/1",
      price: 1.9,
    },
  ]);
  assert.deepEqual(
    few.map((l) => [l.marketplace, l.price]),
    [
      ["ggsel", 1.9],
      ["gameflip", 2.5],
      ["zero", 0],
    ],
  );
  assert.deepEqual(buyLinksFor([]), []);
});

test("schedule ETA projects readiness from farm start and top-tier watch minutes", () => {
  const start = new Date("2026-09-07T00:00:00.000Z");
  assert.deepEqual(
    scheduleEta({
      farmStartedAt: start,
      requiredWatchMinutes: 240,
      now: start.getTime() + 60 * 60000,
    }),
    {
      etaSource: "schedule",
      overdue: false,
      readyInMinutes: 180,
      progressPercent: 25,
    },
  );
  const rounded = scheduleEta({
    farmStartedAt: start.toISOString(),
    requiredWatchMinutes: 240,
    now: start.getTime() + 90.4 * 60000,
  });
  assert.equal(rounded.etaSource, "schedule");
  assert.equal(rounded.overdue, false);
  assert.equal(rounded.readyInMinutes, 150);
  assert.equal(rounded.progressPercent, 38);
});

test("schedule ETA saturates at zero minutes and 100% until twice the requirement, then reports overdue", () => {
  const start = new Date("2026-09-07T00:00:00.000Z");
  const at = (minutes) => start.getTime() + minutes * 60000;
  assert.deepEqual(
    scheduleEta({
      farmStartedAt: start,
      requiredWatchMinutes: 240,
      now: at(300),
    }),
    {
      etaSource: "schedule",
      overdue: false,
      readyInMinutes: 0,
      progressPercent: 100,
    },
  );
  assert.deepEqual(
    scheduleEta({
      farmStartedAt: start,
      requiredWatchMinutes: 240,
      now: at(480),
    }),
    {
      etaSource: "schedule",
      overdue: false,
      readyInMinutes: 0,
      progressPercent: 100,
    },
  );
  const late = scheduleEta({
    farmStartedAt: start,
    requiredWatchMinutes: 240,
    now: at(481),
  });
  assert.deepEqual(late, {
    etaSource: "schedule",
    overdue: true,
    progressPercent: 100,
  });
  assert.equal(Object.hasOwn(late, "readyInMinutes"), false);
});

test("schedule ETA is null without a valid start or a positive requirement", () => {
  assert.equal(
    scheduleEta({ farmStartedAt: new Date(), requiredWatchMinutes: 0 }),
    null,
  );
  assert.equal(
    scheduleEta({ farmStartedAt: new Date(), requiredWatchMinutes: -1 }),
    null,
  );
  assert.equal(
    scheduleEta({ farmStartedAt: new Date(), requiredWatchMinutes: undefined }),
    null,
  );
  assert.equal(
    scheduleEta({ farmStartedAt: null, requiredWatchMinutes: 240 }),
    null,
  );
  assert.equal(scheduleEta({ requiredWatchMinutes: 240 }), null);
  assert.equal(
    scheduleEta({ farmStartedAt: "not a date", requiredWatchMinutes: 240 }),
    null,
  );
});

test("public shape guard throws on the first private key anywhere in the payload", () => {
  assert.throws(
    () =>
      assertPublicShape({
        listings: [
          { title: "ok", items: [{ name: "x", login: "secret-login" }] },
        ],
      }),
    /public payload leaks login/,
  );
  assert.throws(
    () => assertPublicShape([{ nested: { deeper: { clientSecret: "x" } } }]),
    /public payload leaks clientSecret/,
  );
  assert.throws(
    () => assertPublicShape({ accountScopeLogins: [] }),
    /public payload leaks accountScopeLogins/,
  );
});

test("public shape guard accepts clean payloads and matches keys exactly", () => {
  assert.doesNotThrow(() =>
    assertPublicShape({
      listings: [
        {
          title: "login",
          loginCount: 3,
          createdAt: new Date(),
          tags: ["password"],
          nested: null,
        },
      ],
      meta: { buildMs: 1 },
    }),
  );
  assert.doesNotThrow(() => assertPublicShape(null));
  assert.doesNotThrow(() => assertPublicShape("login"));
  assert.doesNotThrow(() => assertPublicShape([]));
});
