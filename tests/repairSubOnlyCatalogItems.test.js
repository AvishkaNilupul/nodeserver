// scripts/repair-sub-only-catalog-items.js — the pure plan.
//
// Storefront cards stamped before the lister skipped subscriber-only drops name
// rewards no farmed account can hold. The plan takes those items off, hides a
// card with nothing earnable left, and must never touch an item an account
// holds: the same reward can be subscriber-only in one campaign and a watch
// drop in another (Predecessor's loot cores, 338 holders on prod).
//
// Pure only — no Mongo. The rows are shaped like prod's on 2026-10-08.
const test = require("node:test");
const assert = require("node:assert/strict");

const { planRepair, subOnlyKeysOf, campaignIdOf } = require("../scripts/repair-sub-only-catalog-items");

const NOW = Date.parse("2026-10-08T16:00:00Z");
const key = (name, game) => name.toLowerCase() + "|" + game.toLowerCase();
const item = (name, game) => ({ itemKey: key(name, game), name, game, image: "", qty: 1 });
const drop = (name, game, requiredSubs, requiredMinutesWatched = 0) => ({ name, itemKey: key(name, game), requiredSubs, requiredMinutesWatched });

function card(campaignId, name, items, over = {}) {
  return {
    _id: "set-" + campaignId,
    name,
    sourceType: "autofarm_event",
    sourceEventKey: "autofarm:" + campaignId,
    items,
    listed: true,
    catalogState: "preorder",
    campaignEndAt: new Date(NOW + 5 * 864e5),
    updatedAt: new Date(NOW - 864e5),
    ...over,
  };
}

const PD = "PAYDAY 3";
const payday = {
  campaignId: "payday",
  watchVersion: 1,
  drops: [drop("Dallas", PD, 1), drop("Chains", PD, 0, 30), drop("Hoxton", PD, 0, 60), drop("Wolf", PD, 0, 90)],
};
const paydayCard = card("payday", "PAYDAY 3 — PAYDAY 3", [item("Dallas", PD), item("Chains", PD), item("Hoxton", PD), item("Wolf", PD)]);

test("a card that mixes earnable items with a subscriber-only one keeps the earnable ones", () => {
  const [p, ...rest] = planRepair({ sets: [paydayCard], manifests: [payday], everHeld: [], now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(p.action, "trim");
  assert.equal(p.basis, "manifest");
  assert.deepEqual(
    p.remove.map((i) => i.name),
    ["Dallas"],
  );
  assert.deepEqual(
    p.keep.map((i) => i.name),
    ["Chains", "Hoxton", "Wolf"],
  );
  assert.equal(p.setId, "set-payday");
  assert.equal(p.campaignId, "payday");
  // The campaign is still running: the card stays where it is, items corrected.
  assert.equal(p.ended, false);
  assert.deepEqual(p.write, { items: p.keep });
});

test("the card of a campaign that has ended is corrected AND taken off the storefront, never put on sale", () => {
  // With "Dallas" gone the card would read as in stock. A repair corrects what
  // a card says; it does not start selling something that was never on sale.
  const over = { ...paydayCard, catalogState: "soldout", campaignEndAt: new Date(NOW - 864e5) };
  const [p] = planRepair({ sets: [over], manifests: [payday], everHeld: [], now: NOW });
  assert.equal(p.action, "trim-hide");
  assert.equal(p.ended, true);
  assert.deepEqual(p.write, { items: p.keep, listed: false });
  assert.equal(p.keep.length, 3);

  // Already hidden: only the items are corrected.
  const [hidden] = planRepair({ sets: [{ ...over, listed: false }], manifests: [payday], everHeld: [], now: NOW });
  assert.equal(hidden.action, "trim");
  assert.deepEqual(hidden.write, { items: hidden.keep });
});

test("Twitch's word on whether a campaign is over beats the date its card was stamped with", () => {
  // A card keeps the end date of the day it was stamped; campaigns get
  // extended. Hiding the card of a campaign that is still running would take a
  // live offer off the storefront.
  const stale = { ...paydayCard, campaignEndAt: new Date(NOW - 864e5) };
  const [running] = planRepair({ sets: [stale], manifests: [payday], everHeld: [], campaignEnded: new Map([["payday", false]]), now: NOW });
  assert.equal(running.ended, false);
  assert.equal(running.action, "trim");
  assert.deepEqual(running.write, { items: running.keep });

  // And the other way round: Twitch says it is over, the card's date does not.
  const [over] = planRepair({ sets: [paydayCard], manifests: [payday], everHeld: [], campaignEnded: new Map([["payday", true]]), now: NOW });
  assert.equal(over.ended, true);
  assert.equal(over.action, "trim-hide");
});

test("a card with nothing earnable is taken off the storefront — or left alone when already hidden", () => {
  const MT = "Metaphor: ReFantazio";
  const RL = "Rocket League";
  const manifests = [
    { campaignId: "badge", watchVersion: 1, drops: [drop("Homo Tenta Badge", MT, 1)] },
    { campaignId: "rl", watchVersion: 1, drops: [drop("Torque TX (Crimson)", RL, 1)] },
  ];
  const plan = planRepair({
    sets: [
      card("badge", "Metaphor: ReFantazio — Homo Tenta Badge", [item("Homo Tenta Badge", MT)]),
      card("rl", "Rocket League — RL Worlds Sub Drops", [item("Torque TX (Crimson)", RL)], { listed: false }),
    ],
    manifests,
    everHeld: [],
    now: NOW,
  });
  assert.deepEqual(
    plan.map((p) => [p.campaignId, p.action, p.keep.length, p.write]),
    [
      ["badge", "unlist", 0, { listed: false }],
      ["rl", "none", 0, null],
    ],
  );
});

test("an item some account holds is never removed, whatever a manifest says", () => {
  const PR = "Predecessor";
  const subDrops = { campaignId: "grizzly", watchVersion: 1, drops: [drop("Ion Loot Core", PR, 2), drop("Quantum Loot Core", PR, 5)] };
  const bloodtide = {
    campaignId: "bloodtide",
    watchVersion: 1,
    drops: [drop("Ion Loot Core", PR, 0, 60), drop("Quantum Loot Core", PR, 0, 360), drop("Valmont Pink Skin Variant", PR, 0, 600)],
  };
  const held = [key("Ion Loot Core", PR), key("Quantum Loot Core", PR)];
  const sets = [
    // A campaign that gives the cores for WATCHING: its own manifest clears it.
    card("bloodtide", "Predecessor — Bloodtide Drops", [item("Ion Loot Core", PR), item("Quantum Loot Core", PR), item("Valmont Pink Skin Variant", PR)], { catalogState: "instock" }),
    // The sub-only campaign's own card: its accounts hold the cores from elsewhere.
    card("grizzly", "Predecessor — Grizzzly's Sub Drops!", [item("Ion Loot Core", PR), item("Quantum Loot Core", PR)]),
    // A card whose campaign's manifest predates the field, and has ended.
    card("aegis", "Predecessor — Aegis of Dawn Drops", [item("Ion Loot Core", PR), item("Quantum Loot Core", PR)], { catalogState: "instock", campaignEndAt: new Date(NOW - 30 * 864e5) }),
  ];
  assert.deepEqual(planRepair({ sets, manifests: [subDrops, bloodtide], everHeld: held, now: NOW }), []);
  // Unheld, the watch campaign's card is still left alone: its own manifest says earnable.
  const unheld = planRepair({ sets: [sets[0]], manifests: [subDrops, bloodtide], everHeld: [], now: NOW });
  assert.deepEqual(unheld, []);
});

test("a card whose campaign predates the subscription field is judged only once the campaign has ended", () => {
  const WD = "WARDOGS";
  const launch = { campaignId: "launch", watchVersion: 1, drops: [drop("WARDOG", WD, 0, 30), drop("WARLORD", WD, 1)] };
  const beta = { campaignId: "beta", watchVersion: 0, drops: [drop("WARDOG", WD, null, null), drop("WARLORD", WD, null, null)] };
  const betaCard = (over) => card("beta", "WARDOGS — WARDOGS Beta", [item("WARDOG", WD), item("WARLORD", WD)], { catalogState: "soldout", ...over });

  // Still running: nothing is known about its own drops, so nothing is decided.
  assert.deepEqual(planRepair({ sets: [betaCard()], manifests: [launch, beta], everHeld: [], now: NOW }), []);

  // Ended (by the card's own date, or because Twitch says so): the item that is
  // subscriber-only in the game's other campaign and that nobody ever held goes.
  for (const args of [
    { sets: [betaCard({ campaignEndAt: new Date(NOW - 864e5) })] },
    { sets: [betaCard({ campaignEndAt: null })], campaignEnded: new Map([["beta", true]]) },
  ]) {
    const [p] = planRepair({ ...args, manifests: [launch, beta], everHeld: [], now: NOW });
    assert.equal(p.action, "trim-hide", "a sold-out card must not come back as in stock");
    assert.equal(p.basis, "ended");
    assert.deepEqual(
      p.keep.map((i) => i.name),
      ["WARDOG"],
    );
    assert.deepEqual(p.write, { items: p.keep, listed: false });
  }

  // Held by someone: left alone, ended or not.
  assert.deepEqual(
    planRepair({ sets: [betaCard({ campaignEndAt: new Date(NOW - 864e5) })], manifests: [launch, beta], everHeld: [key("WARLORD", WD)], now: NOW }),
    [],
  );
});

test("only campaign cards are planned — never a listing mirror or a stack", () => {
  const sets = [
    { ...paydayCard, _id: "orphan", sourceEventKey: "autofarm:set:6aa40ec0fef8fbebb4921624" },
    { ...paydayCard, _id: "stack", sourceEventKey: "autofarm-stack:6ab51298f323e1d610fc8047" },
    { ...paydayCard, _id: "manual", sourceEventKey: "" },
  ];
  assert.deepEqual(planRepair({ sets, manifests: [payday], everHeld: [], now: NOW }), []);
});

test("subOnlyKeysOf: a reward a watch drop also gives is not subscriber-only", () => {
  const G = "Some Game";
  const m = { drops: [drop("Charm", G, 1), drop("Charm", G, 0, 60), drop("Badge", G, 2), drop("Old", G, null)] };
  assert.deepEqual([...subOnlyKeysOf(m)], [key("Badge", G)]);
  assert.equal(campaignIdOf({ sourceEventKey: "autofarm:84f27bd4-9c9f" }), "84f27bd4-9c9f");
});

/* ---------------- run(): the reads, the guard and the writes ---------------- */

// The whole script against an in-memory Mongo, rows shaped like prod's.
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const CampaignDrops = require("../models/CampaignDrops");
const TwitchCampaign = require("../models/TwitchCampaign");
const DropSet = require("../models/DropSet");
const DropLog = require("../models/DropLog");
const CatalogInquiry = require("../models/CatalogInquiry");
const { run } = require("../scripts/repair-sub-only-catalog-items");

let mem;
let backupDir;
const PR = "Predecessor";
const WD = "WARDOGS";
const MT = "Metaphor: ReFantazio";
const RL = "Rocket League";
const soon = new Date(Date.now() + 5 * 864e5);
const past = new Date(Date.now() - 8 * 864e5);

async function holds(names, game, over = {}) {
  const account = new mongoose.Types.ObjectId();
  for (const name of names) {
    await DropLog.create({ account, benefitId: String(account) + ":" + name, name, game, itemKey: key(name, game), ...over });
  }
}

async function seed() {
  await Promise.all([CampaignDrops, TwitchCampaign, DropSet, DropLog, CatalogInquiry].map((M) => M.deleteMany({})));
  await CampaignDrops.create([
    { ...payday, game: PD },
    { campaignId: "badge", game: MT, watchVersion: 1, drops: [drop("Homo Tenta Badge", MT, 1)] },
    { campaignId: "rl", game: RL, watchVersion: 1, drops: [drop("Torque TX (Crimson)", RL, 1)] },
    { campaignId: "launch", game: WD, watchVersion: 1, drops: [drop("WARDOG", WD, 0, 30), drop("WARLORD", WD, 1)] },
    { campaignId: "beta", game: WD, watchVersion: 0, drops: [drop("WARDOG", WD, null, null), drop("WARLORD", WD, null, null)] },
    { campaignId: "grizzly", game: PR, watchVersion: 1, drops: [drop("Ion Loot Core", PR, 2), drop("Quantum Loot Core", PR, 5)] },
    { campaignId: "bloodtide", game: PR, watchVersion: 1, drops: [drop("Ion Loot Core", PR, 0, 60), drop("Quantum Loot Core", PR, 0, 360)] },
  ]);
  await TwitchCampaign.create([
    { campaignId: "payday", status: "ACTIVE", endAt: soon },
    // Missing from one dashboard read: marked EXPIRED, but its end date has not come.
    { campaignId: "badge", status: "EXPIRED", endAt: soon },
    { campaignId: "rl", status: "EXPIRED", endAt: past },
    { campaignId: "launch", status: "EXPIRED", endAt: past },
    { campaignId: "beta", status: "EXPIRED", endAt: past },
    { campaignId: "bloodtide", status: "ACTIVE", endAt: soon },
  ]);
  const mk = (campaignId, name, items, over = {}) =>
    DropSet.create({ name, sourceType: "autofarm_event", sourceEventKey: "autofarm:" + campaignId, items, listed: true, catalogState: "preorder", price: 1, campaignEndAt: soon, ...over });
  const cards = {
    payday: await mk("payday", "PAYDAY 3 — PAYDAY 3", [item("Dallas", PD), item("Chains", PD), item("Hoxton", PD), item("Wolf", PD)]),
    badge: await mk("badge", "Metaphor: ReFantazio — Homo Tenta Badge", [item("Homo Tenta Badge", MT)]),
    rl: await mk("rl", "Rocket League — RL Worlds Sub Drops", [item("Torque TX (Crimson)", RL)], { listed: false, campaignEndAt: past }),
    launch: await mk("launch", "WARDOGS — WARDOGS Beta & Launch", [item("WARDOG", WD), item("WARLORD", WD)], { listed: false, campaignEndAt: past }),
    beta: await mk("beta", "WARDOGS — WARDOGS Beta", [item("WARDOG", WD), item("WARLORD", WD)], { catalogState: "soldout", campaignEndAt: null }),
    // Never to be touched: loot cores some account holds, and rows that are not campaign cards.
    bloodtide: await mk("bloodtide", "Predecessor — Bloodtide Drops", [item("Ion Loot Core", PR), item("Quantum Loot Core", PR)], { catalogState: "instock" }),
    orphan: await mk("x", "PAYDAY 3 mirror of a listing", [item("Dallas", PD), item("Chains", PD)], { sourceEventKey: "autofarm:set:6aa40ec0fef8fbebb4921624" }),
    custom: await DropSet.create({ name: "WARDOGS hand-made", items: [item("WARDOG", WD), item("WARLORD", WD)], listed: true, custom: true, price: 2 }),
    profile: await DropSet.create({ name: "Predecessor Drops — Complete Bundle", sourceType: "catalog_profile", sourceEventKey: "catalog-profile:abc", items: [item("Ion Loot Core", PR)], listed: true, price: 3 }),
  };
  await holds(["Chains", "Hoxton", "Wolf"], PD);
  await holds(["Chains", "Hoxton", "Wolf"], PD);
  await holds(["WARDOG"], WD);
  await holds(["Ion Loot Core", "Quantum Loot Core"], PR);
  await holds(["Ion Loot Core", "Quantum Loot Core"], PR, { soldAt: new Date(), soldToUsername: "gameflip" });
  return cards;
}

const snapshot = async () => JSON.stringify(await DropSet.find({}).sort({ _id: 1 }).lean());
const backups = () => fs.readdirSync(backupDir);

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("subonlyrepair"));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-only-repair-"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test("a dry run reads, reports and writes nothing — no row, no file", async () => {
  const cards = await seed();
  await CatalogInquiry.create({ listing: cards.badge._id, quantity: 5, contact: "@buyer" });
  const before = await snapshot();
  const lines = [];
  const r = await run({ apply: false, log: (l) => lines.push(l), backupDir });
  assert.equal(r.written, 0);
  assert.equal(r.backup, "");
  assert.equal(await snapshot(), before);
  assert.deepEqual(backups(), []);
  const out = lines.join("\n");
  assert.match(out, /would trim {2}PAYDAY 3 — PAYDAY 3/);
  assert.match(out, /keep: {3}Chains \+ Hoxton \+ Wolf \| accounts holding that, unsold: about 2 -> the card comes IN STOCK/);
  assert.match(out, /would unlist {2}Metaphor: ReFantazio — Homo Tenta Badge \[preorder, on the storefront, campaign running/);
  assert.match(out, /would trim-hide {2}WARDOGS — WARDOGS Beta \[soldout/);
  assert.match(out, /OPEN customer inquiries on those cards: 1/);
  assert.match(out, /dry run: nothing written/);
  assert.doesNotMatch(out, /Predecessor —/);
});

test("apply changes exactly the cards that name an unearnable item, keeps a copy of each, and is done after one run", async () => {
  const cards = await seed();
  const untouched = async () =>
    JSON.stringify(
      await DropSet.find({ _id: { $in: [cards.bloodtide._id, cards.orphan._id, cards.custom._id, cards.profile._id, cards.rl._id] } })
        .sort({ _id: 1 })
        .lean(),
    );
  const before = await untouched();
  const r = await run({ apply: true, log: () => {}, backupDir });
  assert.equal(r.written, 4);
  assert.deepEqual(
    r.plan.map((p) => [p.campaignId, p.action]).sort(),
    [
      ["badge", "unlist"],
      ["beta", "trim-hide"],
      ["launch", "trim"],
      ["payday", "trim"],
      ["rl", "none"],
    ],
  );
  const now = async (c) => DropSet.findById(c._id).lean();
  const named = (s) => s.items.map((i) => i.name);

  // A running campaign: earnable items kept, still listed.
  assert.deepEqual(named(await now(cards.payday)), ["Chains", "Hoxton", "Wolf"]);
  assert.equal((await now(cards.payday)).listed, true);
  // Nothing earnable: hidden, its one item left as the record of what it was.
  assert.equal((await now(cards.badge)).listed, false);
  assert.deepEqual(named(await now(cards.badge)), ["Homo Tenta Badge"]);
  // Over and hidden already: items corrected, still hidden.
  assert.deepEqual(named(await now(cards.launch)), ["WARDOG"]);
  assert.equal((await now(cards.launch)).listed, false);
  // Over, on the storefront as sold out: corrected AND hidden, never revived.
  assert.deepEqual(named(await now(cards.beta)), ["WARDOG"]);
  assert.equal((await now(cards.beta)).listed, false);
  assert.equal((await now(cards.beta)).catalogState, "soldout");
  // Held loot cores, a listing mirror, a hand-made set, a profile, a hidden card.
  assert.equal(await untouched(), before);

  // The copy: every changed row as it was, under a name .gitignore covers.
  assert.equal(backups().length, 1);
  assert.match(backups()[0], /^_bk_sub_only_catalog_repair_\d{8}T\d{9}\.json$/);
  const saved = JSON.parse(fs.readFileSync(r.backup, "utf8"));
  assert.equal(saved.sets.length, 4);
  const savedPayday = saved.sets.find((s) => s._id === String(cards.payday._id));
  assert.deepEqual(
    savedPayday.items.map((i) => i.name),
    ["Dallas", "Chains", "Hoxton", "Wolf"],
  );
  assert.equal(savedPayday.listed, true);

  // Run again: nothing left to do, nothing written, no second copy.
  const again = await run({ apply: true, log: () => {}, backupDir });
  assert.equal(again.written, 0);
  assert.deepEqual(again.plan.map((p) => p.action).sort(), ["none", "none"]);
  assert.equal(backups().length, 1);
});

test("a card whose campaign Twitch marked EXPIRED before its end date is not treated as over", async () => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir);
  const cards = await seed();
  // The watcher marks a campaign EXPIRED the first time one dashboard read
  // misses it. Give the still-running "badge" campaign an earnable item too.
  await CampaignDrops.updateOne({ campaignId: "badge" }, { $push: { drops: drop("Free Emote", MT, 0, 60) } });
  await DropSet.updateOne({ _id: cards.badge._id }, { $push: { items: item("Free Emote", MT) } });
  const r = await run({ apply: true, log: () => {}, backupDir });
  const badge = r.plan.find((p) => p.campaignId === "badge");
  assert.equal(badge.ended, false);
  assert.equal(badge.action, "trim", "kept on the storefront, not hidden as an ended campaign's card would be");
  const row = await DropSet.findById(cards.badge._id).lean();
  assert.equal(row.listed, true);
  assert.deepEqual(
    row.items.map((i) => i.name),
    ["Free Emote"],
  );
});

test("a card something else changed after it was read is left for the next run", async () => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir);
  const cards = await seed();
  // The last read before the writes: edit a card there, as a live sync could.
  const origCount = CatalogInquiry.countDocuments;
  CatalogInquiry.countDocuments = async function (...args) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await DropSet.updateOne({ _id: cards.payday._id }, { $set: { expectedUnits: 99 } });
    return origCount.apply(this, args);
  };
  const lines = [];
  let r;
  try {
    r = await run({ apply: true, log: (l) => lines.push(l), backupDir });
  } finally {
    CatalogInquiry.countDocuments = origCount;
  }
  assert.equal(r.written, 3);
  assert.match(lines.join("\n"), /skipped PAYDAY 3 — PAYDAY 3: changed since it was read/);
  const payday3 = await DropSet.findById(cards.payday._id).lean();
  assert.equal(payday3.items.length, 4, "not overwritten");
  assert.equal(payday3.expectedUnits, 99);
  // The next run picks it up.
  assert.equal((await run({ apply: true, log: () => {}, backupDir })).written, 1);
  assert.equal((await DropSet.findById(cards.payday._id).lean()).items.length, 3);
});
