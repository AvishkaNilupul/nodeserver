// Auto-farm event bundles (utils/autoFarmBundles.js).
//
// The case that forced this module into existence is pinned first: a game
// whose event ran as "Week 1" then "Finals" produced two thin one-wave
// listings, while the only bundling path that existed unioned EVERY campaign
// the game had ever farmed and was then refused by the holdings gate.
//
// Pure only — no Mongo, no network. Everything here runs against
// unclaimedBundles.buildEventCatalog output and plain task objects.
const test = require("node:test");
const assert = require("node:assert");

const { buildEventCatalog } = require("../utils/unclaimedBundles");
const {
  bundleSetName,
  bundleTitleFor,
  classificationFor,
  placeTask,
  planEventBundles,
  planForTask,
  signatureOf,
  tidyEventName,
  waveLabels,
  waveStarted,
} = require("../utils/autoFarmBundles");

const GAME = "Overwatch 2";
const DAY = 86400000;
const NOW = Date.parse("2026-09-08T00:00:00Z");

function campaign(id, name, { start = -10, end = -1 } = {}) {
  return {
    campaignId: id,
    name,
    game: GAME,
    startAt: new Date(NOW + start * DAY),
    endAt: new Date(NOW + end * DAY),
  };
}

function manifest(id, name, drops) {
  return {
    campaignId: id,
    name,
    game: GAME,
    drops: drops.map((n) => ({
      name: n,
      itemKey: n.toLowerCase() + "|overwatch 2",
    })),
  };
}

function task(id, campaignId, campaignName, extra = {}) {
  return {
    _id: id,
    game: GAME,
    campaignId,
    campaignName,
    status: "active",
    assignedAccounts: ["acct-" + id + "-a", "acct-" + id + "-b"],
    listing: { setId: "" },
    ...extra,
  };
}

// Week 1 grants a Tier Skip and an Icon; Finals grants the Tier Skip again
// plus a Spray. An account that farmed both holds TWO tier skips.
const CAMPAIGNS = [
  campaign("c1", "CAH Championship Week 1", { start: -20, end: -12 }),
  campaign("c2", "CAH Championship Finals", { start: -11, end: -2 }),
];
const MANIFESTS = [
  manifest("c1", "CAH Championship Week 1", ["Tier Skip", "Pachimonarch Icon"]),
  manifest("c2", "CAH Championship Finals", ["Tier Skip", "Victory Spray"]),
];
const CATALOG = buildEventCatalog(CAMPAIGNS, MANIFESTS);

function plansFor(tasks, opts = {}) {
  return planEventBundles({
    game: GAME,
    tasks,
    catalog: CATALOG,
    now: NOW,
    ...opts,
  });
}

/* ------------------------- the regression case --------------------------- */

test("two farmed waves of one event become ONE complete bundle", () => {
  const plans = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ]);
  assert.equal(plans.length, 1);
  const plan = plans[0];
  assert.equal(plan.eventName, "CAH Championship");
  assert.equal(plan.wavesHeld, 2);
  assert.equal(plan.wavesTotal, 2);
  assert.equal(plan.full, true, "both started waves are held");
  assert.deepEqual(plan.labels, ["Week 1", "Finals"]);
  assert.deepEqual(plan.campaignIds, ["c1", "c2"]);
  // Four accounts across the two waves, deduped and lowercased.
  assert.equal(plan.logins.length, 4);
  assert.ok(plan.logins.every((l) => l === l.toLowerCase()));
});

test("a duplicate item across waves is promised as TWO copies", () => {
  const plan = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ])[0];
  const byKey = new Map(plan.items.map((i) => [i.itemKey, i]));
  assert.equal(byKey.size, 3, "Tier Skip + Icon + Spray");
  assert.equal(
    byKey.get("tier skip|overwatch 2").qty,
    2,
    "granted by Week 1 AND Finals — the holdings gate must demand both",
  );
  assert.equal(byKey.get("pachimonarch icon|overwatch 2").qty, 1);
  assert.equal(plan.totalQty, 4);
});

/* ------------------------------ the guards ------------------------------- */

test("a single-wave event is not a bundle — that IS the solo listing", () => {
  assert.deepEqual(plansFor([task("t1", "c1", "CAH Championship Week 1")]), []);
});

test("holding some of an event's waves is a PARTIAL bundle, never 'complete'", () => {
  const campaigns = [
    ...CAMPAIGNS,
    campaign("c3", "CAH Championship Week 2", { start: -18, end: -13 }),
  ];
  const manifests = [
    ...MANIFESTS,
    manifest("c3", "CAH Championship Week 2", ["Gold Weapon"]),
  ];
  const plans = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
    ],
    catalog: buildEventCatalog(campaigns, manifests),
    now: NOW,
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].wavesHeld, 2);
  assert.equal(plans[0].wavesTotal, 3, "Week 2 ran and we did not farm it");
  assert.equal(plans[0].full, false);
});

test("a wave that has not started yet does not block 'complete'", () => {
  const campaigns = [
    ...CAMPAIGNS,
    campaign("c4", "CAH Championship Week 9", { start: +5, end: +12 }),
  ];
  const plans = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
    ],
    catalog: buildEventCatalog(campaigns, [
      ...MANIFESTS,
      manifest("c4", "CAH Championship Week 9", ["Future Skin"]),
    ]),
    now: NOW,
  });
  assert.equal(plans[0].wavesTotal, 2, "an unstarted wave is not a hole");
  assert.equal(plans[0].full, true);
});

test("a wave whose items cannot be resolved is left out AND blocks 'complete'", () => {
  // c5 is in the catalog with no manifest and its task never published a set,
  // so its contents are unknown. Advertising COMPLETE here would promise
  // contents no account is verified to hold.
  const campaigns = [...CAMPAIGNS, campaign("c5", "CAH Championship Week 3")];
  const plans = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
      task("t5", "c5", "CAH Championship Week 3"),
    ],
    catalog: buildEventCatalog(campaigns, MANIFESTS),
    now: NOW,
  });
  assert.equal(plans[0].wavesHeld, 2);
  assert.equal(plans[0].wavesUnresolved, 1);
  assert.equal(plans[0].full, false);
  assert.equal(
    plans[0].logins.length,
    4,
    "the unresolved wave's accounts are not part of the bundle either",
  );
});

test("tasks with no stock are ignored", () => {
  const plans = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals", { status: "skipped" }),
  ]);
  assert.deepEqual(plans, [], "a skipped task released its accounts");

  const empty = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals", { assignedAccounts: [] }),
  ]);
  assert.deepEqual(empty, []);
});

test("a completed or stopped task still carries its farmed stock", () => {
  const plans = plansFor([
    task("t1", "c1", "CAH Championship Week 1", { status: "completed" }),
    task("t2", "c2", "CAH Championship Finals", { status: "stopped" }),
  ]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].wavesHeld, 2);
});

test("two events of the same game stay two bundles", () => {
  const campaigns = [
    ...CAMPAIGNS,
    campaign("d1", "OWCS MSC Day 1", { start: -40, end: -35 }),
    campaign("d2", "OWCS MSC Day 2", { start: -34, end: -30 }),
  ];
  const manifests = [
    ...MANIFESTS,
    manifest("d1", "OWCS MSC Day 1", ["MSC Icon"]),
    manifest("d2", "OWCS MSC Day 2", ["MSC Spray"]),
  ];
  const plans = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
      task("t3", "d1", "OWCS MSC Day 1"),
      task("t4", "d2", "OWCS MSC Day 2"),
    ],
    catalog: buildEventCatalog(campaigns, manifests),
    now: NOW,
  });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.eventName).sort(), [
    "CAH Championship",
    "OWCS MSC",
  ]);
});

/* ---------------------------- wave placement ----------------------------- */

test("a campaign the catalog has never seen is still placed, by its own name", () => {
  // An old task whose TwitchCampaign row aged out of the 120-day window. Its
  // wave must not be lost, or a long event silently drops its early weeks.
  const plans = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t9", "gone-from-catalog", "CAH Championship Week 4"),
    task("t2", "c2", "CAH Championship Finals"),
  ]);
  assert.equal(plans.length, 1);
  assert.equal(
    plans[0].wavesHeld,
    2,
    "the unknown wave has no item source, so it is not advertised",
  );
  assert.equal(plans[0].wavesUnresolved, 1);
  assert.equal(plans[0].full, false);
});

test("an unknown campaign uses its published set as the item source", () => {
  const withSet = task("t9", "gone", "CAH Championship Week 4", {
    listing: { setId: "507f1f77bcf86cd799439011" },
  });
  const plans = planEventBundles({
    game: GAME,
    tasks: [task("t1", "c1", "CAH Championship Week 1"), withSet],
    catalog: CATALOG,
    setsById: new Map([
      [
        "507f1f77bcf86cd799439011",
        {
          items: [
            {
              itemKey: "gold weapon|overwatch 2",
              name: "Gold Weapon",
              qty: 1,
              image: "x.png",
            },
          ],
        },
      ],
    ]),
    now: NOW,
  });
  assert.equal(plans.length, 1);
  assert.ok(
    plans[0].items.some((i) => i.itemKey === "gold weapon|overwatch 2"),
    "the set's items are the strongest source — they carry images and real qty",
  );
  assert.equal(
    plans[0].waves.find((w) => w.campaignId === "gone").source,
    "listing",
  );
});

test("placeTask prefers the catalog and falls back to parsing the name", () => {
  const index = require("../utils/autoFarmBundles").indexCatalog(CATALOG);
  const known = placeTask(task("t1", "c1", "CAH Championship Week 1"), index);
  assert.equal(known.known, true);
  assert.equal(known.eventName, "CAH Championship");
  assert.equal(known.wave.waveLabel, "Week 1");

  const unknown = placeTask(
    task("tx", "zzz", "CAH Championship Week 7"),
    index,
  );
  assert.equal(unknown.known, false);
  assert.equal(unknown.eventName, "CAH Championship");
  assert.equal(unknown.wave.order, 7);
  assert.equal(
    unknown.eventKey,
    known.eventKey,
    "both must land on the SAME event or the bundle splits in two",
  );
});

test("waveStarted treats unknown dates as started, not as a hole", () => {
  assert.equal(waveStarted({}, NOW), true);
  assert.equal(waveStarted({ startAt: new Date(NOW - DAY) }, NOW), true);
  assert.equal(waveStarted({ startAt: new Date(NOW + DAY) }, NOW), false);
  assert.equal(
    waveStarted(
      { startAt: new Date(NOW + DAY), endAt: new Date(NOW - DAY) },
      NOW,
    ),
    true,
    "an ended wave ran, whatever its start says",
  );
});

/* ------------------------------ presentation ----------------------------- */

test("a complete bundle is titled as one, with its waves and item count", () => {
  const plan = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ])[0];
  const title = bundleTitleFor(plan);
  assert.ok(title.includes("CAH Championship"), title);
  assert.ok(title.includes("COMPLETE BUNDLE"), title);
  assert.ok(title.includes("Week 1 + Finals"), title);
  assert.ok(title.includes("4 Items"), title);
  assert.ok(title.length <= 120, "Gameflip's hard title limit");
});

test("a partial bundle never claims to be complete", () => {
  const campaigns = [
    ...CAMPAIGNS,
    campaign("c3", "CAH Championship Week 2", { start: -18, end: -13 }),
  ];
  const plan = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
    ],
    catalog: buildEventCatalog(campaigns, [
      ...MANIFESTS,
      manifest("c3", "CAH Championship Week 2", ["Gold Weapon"]),
    ]),
    now: NOW,
  })[0];
  const title = bundleTitleFor(plan);
  assert.ok(!title.includes("COMPLETE"), title);
  assert.ok(title.includes("CAH Championship"), title);
});

test("the classification describes the event honestly", () => {
  const plan = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ])[0];
  const cls = classificationFor(plan);
  assert.equal(cls.event.name, "CAH Championship");
  assert.equal(cls.full, true);
  assert.deepEqual(cls.heldLabels, ["Week 1", "Finals"]);
  assert.match(cls.bundleLabel, /\(complete\)$/);
  assert.equal(
    cls.events.length,
    1,
    "one event — the multi-event title path must not engage",
  );
});

test("the set name says which waves it covers", () => {
  const plan = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ])[0];
  assert.equal(
    bundleSetName(plan),
    "Overwatch 2 — CAH Championship complete event bundle (2 waves)",
  );
});

/* ------------------------------- plumbing -------------------------------- */

test("planForTask finds a task's bundle by id and by campaign", () => {
  const plans = plansFor([
    task("t1", "c1", "CAH Championship Week 1"),
    task("t2", "c2", "CAH Championship Finals"),
  ]);
  assert.ok(planForTask({ _id: "t1", campaignId: "c1" }, plans));
  assert.ok(planForTask({ _id: "other", campaignId: "c2" }, plans));
  assert.equal(planForTask({ _id: "nope", campaignId: "nope" }, plans), null);
});

test("the signature is order-independent and qty-aware", () => {
  const a = signatureOf([
    { itemKey: "b|g", qty: 1 },
    { itemKey: "a|g", qty: 2 },
  ]);
  const b = signatureOf([
    { itemKey: "a|g", qty: 2 },
    { itemKey: "b|g", qty: 1 },
  ]);
  assert.equal(a, b);
  assert.notEqual(
    a,
    signatureOf([
      { itemKey: "a|g", qty: 1 },
      { itemKey: "b|g", qty: 1 },
    ]),
  );
});

test("plans are ordered complete-first, then by wave count", () => {
  const campaigns = [
    ...CAMPAIGNS,
    campaign("e1", "EWC 2026 DAY 1", { start: -50, end: -45 }),
    campaign("e2", "EWC 2026 DAY 2", { start: -44, end: -40 }),
    campaign("e3", "EWC 2026 DAY 3", { start: -39, end: -35 }),
  ];
  const manifests = [
    ...MANIFESTS,
    manifest("e1", "EWC 2026 DAY 1", ["EWC Icon"]),
    manifest("e2", "EWC 2026 DAY 2", ["EWC Spray"]),
    manifest("e3", "EWC 2026 DAY 3", ["EWC Charm"]),
  ];
  const plans = planEventBundles({
    game: GAME,
    tasks: [
      task("t1", "c1", "CAH Championship Week 1"),
      task("t2", "c2", "CAH Championship Finals"),
      task("t3", "e1", "EWC 2026 DAY 1"),
      task("t4", "e2", "EWC 2026 DAY 2"),
    ],
    catalog: buildEventCatalog(campaigns, manifests),
    now: NOW,
  });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].eventName, "CAH Championship", "complete comes first");
  assert.equal(plans[0].full, true);
  assert.equal(plans[1].full, false);
});

/* ------------------- defects the live 2026-09-08 data found -------------- */

test("unmarked waves do not all become 'Main'", () => {
  // Black Desert's "New Class: Agent" ran six campaigns, none carrying a wave
  // marker. Labelling each of them "Main" produced the title
  // "… New Class: Agent Main + Main + Main + Main + Main + Main (12 Items)".
  assert.deepEqual(waveLabels([{}, {}, {}]), ["", "", ""]);
  // The rule still holds where it was meant to: ONE unmarked wave beside
  // marked siblings is the event's main wave.
  assert.deepEqual(waveLabels([{ waveLabel: "" }, { waveLabel: "Week 1" }]), [
    "Main",
    "Week 1",
  ]);
  assert.deepEqual(
    waveLabels([{ waveLabel: "" }, { waveLabel: "" }, { waveLabel: "Week 1" }]),
    ["", "", "Week 1"],
  );
});

test("a bundle of unmarked waves is titled by its contents, not by 'Main'", () => {
  const campaigns = [
    campaign("q1", "August Drops", { start: -30, end: -25 }),
    campaign("q2", "August Drops", { start: -24, end: -20 }),
  ];
  // Two same-named campaigns: one event, two waves, and the account that
  // farmed both holds two copies.
  const plans = planEventBundles({
    game: GAME,
    tasks: [task("t1", "q1", "August Drops"), task("t2", "q2", "August Drops")],
    catalog: buildEventCatalog(campaigns, [
      manifest("q1", "August Drops", ["Reward Chest"]),
      manifest("q2", "August Drops", ["Reward Chest"]),
    ]),
    now: NOW,
  });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].labels, []);
  assert.equal(plans[0].items[0].qty, 2);
  const title = bundleTitleFor(plans[0]);
  assert.ok(!title.includes("Main"), title);
  assert.ok(title.includes("August Drops"), title);
});

test("an event name left with an unclosed bracket is tidied for display", () => {
  // parseWave strips a terminal wave marker AND the bracket around it, so
  // "Hunt 1896 (Week 2, Pt. 1)" leaves the event named "Hunt 1896 (Week 2,".
  assert.equal(tidyEventName("Hunt 1896 (Week 2,"), "Hunt 1896");
  assert.equal(tidyEventName("EWC 2026 —"), "EWC 2026");
  // Balanced brackets are content, not damage.
  assert.equal(tidyEventName("Ignite (Season 1)"), "Ignite (Season 1)");
  assert.equal(tidyEventName("CAH Championship"), "CAH Championship");
  // Never returns empty: a name that is nothing but punctuation stays as-is.
  assert.equal(tidyEventName("("), "(");
});

test("an 'event' that is only the game's own name makes no event claim", () => {
  // Halo: Campaign Evolved ran three identically-named campaigns. Grouping
  // them is right — three copies — but "Halo: Campaign Evolved COMPLETE
  // BUNDLE" says the game twice and claims an event that never existed.
  const campaigns = [
    campaign("h1", GAME, { start: -30, end: -25 }),
    campaign("h2", GAME, { start: -24, end: -20 }),
  ];
  const plan = planEventBundles({
    game: GAME,
    tasks: [task("t1", "h1", GAME), task("t2", "h2", GAME)],
    catalog: buildEventCatalog(campaigns, [
      manifest("h1", GAME, ["Wolf Emblem"]),
      manifest("h2", GAME, ["Wolf Emblem"]),
    ]),
    now: NOW,
  })[0];
  assert.equal(plan.full, true, "the plan itself is still a complete bundle");
  assert.equal(classificationFor(plan).event, null);
  const title = bundleTitleFor(plan);
  assert.ok(!title.includes("COMPLETE BUNDLE"), title);
  assert.ok(title.includes("2× Wolf Emblem"), title);
  assert.equal(
    (title.match(/Overwatch 2/g) || []).length,
    1,
    "the game's name appears once, not twice",
  );
});
