// "Does this drop still need watch time?" — the one rule both scanners use for
// BotAccount / RenterAccount inProgressCount + inProgressGames (and the operator
// scanner's farmingProgress). Those fields decide whether a bot reads as still
// farming (utils/farmCompletion.js), so a drop counted here that can never
// progress keeps its whole bot from parking.
//
// The case behind this file (2026-10-25): Twitch's Inventory keeps ENDED
// campaigns under dropCampaignsInProgress with status "EXPIRED". contabo's
// twitchbot held 99 accounts each carrying a Warframe drop at 63/90 from an
// ended campaign; the bot itself logged "No broadcaster or campaign left" for
// all 99, yet the scanner kept reading them as working, and it sat awake ~5 days.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const inv = require("../utils/twitchInventory");

const drop = (extra = {}) => ({
  name: "Random Furniture",
  game: "Warframe",
  campaign: "PMCFQ Coloring Stream",
  current: 63,
  required: 90,
  claimed: false,
  campaignStatus: "ACTIVE",
  ...extra,
});

test("an unclaimed drop short of its minutes in a live campaign is pending", () => {
  assert.strictEqual(inv.isPendingDrop(drop()), true);
});

test("a drop of an ended (EXPIRED) campaign is never pending", () => {
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: "EXPIRED" })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: "expired" })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: " Expired " })), false);
  assert.strictEqual(inv.isEndedCampaign(drop({ campaignStatus: "EXPIRED" })), true);
});

test("a missing or unknown status still counts as live (fail toward farming)", () => {
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: undefined })), true);
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: "" })), true);
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: "UPCOMING" })), true);
  assert.strictEqual(inv.isPendingDrop(drop({ campaignStatus: "SOMETHING_NEW" })), true);
  const { campaignStatus, ...noField } = drop();
  assert.strictEqual(inv.isPendingDrop(noField), true);
  assert.strictEqual(inv.isEndedCampaign(noField), false);
});

test("the older rules still hold: claimed, zero-minute and complete drops are not pending", () => {
  assert.strictEqual(inv.isPendingDrop(drop({ claimed: true })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ required: 0, current: 0 })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ current: 90 })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ current: 120 })), false);
  assert.strictEqual(inv.isPendingDrop(drop({ current: undefined })), true);
  assert.strictEqual(inv.isPendingDrop(null), false);
  assert.strictEqual(inv.isPendingDrop(undefined), false);
});

test("filtering a mixed inventory keeps only work that can still be done", () => {
  const list = [
    drop({ name: "expired, half watched", campaignStatus: "EXPIRED" }),
    drop({ name: "live, half watched" }),
    drop({ name: "live, done", current: 90 }),
    drop({ name: "expired, done", current: 90, campaignStatus: "EXPIRED" }),
  ];
  assert.deepStrictEqual(list.filter(inv.isPendingDrop).map((d) => d.name), ["live, half watched"]);
});

test("buildInProgress carries each campaign's status onto its drops", () => {
  const build = inv.__test.buildInProgress;
  const out = build({
    dropCampaignsInProgress: [
      {
        id: "c-ended",
        name: "PMCFQ Coloring Stream",
        status: "EXPIRED",
        game: { displayName: "Warframe" },
        accountLinkURL: "https://twitch.tv/",
        self: { isAccountConnected: false },
        timeBasedDrops: [
          { name: "Random Furniture", requiredMinutesWatched: 90, self: { currentMinutesWatched: 63, isClaimed: false } },
        ],
      },
      {
        id: "c-live",
        name: "Master Class 26 (Oct 25)",
        status: "ACTIVE",
        game: { displayName: "Black Desert" },
        timeBasedDrops: [
          { name: "2 Hours Reward", requiredMinutesWatched: 120, self: { currentMinutesWatched: 60, isClaimed: false } },
        ],
      },
      {
        id: "c-nostatus",
        name: "Old shape",
        game: { displayName: "Rust" },
        timeBasedDrops: [
          { name: "Crate", requiredMinutesWatched: 60, self: { currentMinutesWatched: 10, isClaimed: false } },
        ],
      },
    ],
  });
  const by = Object.fromEntries(out.map((d) => [d.campaignId, d]));
  assert.strictEqual(by["c-ended"].campaignStatus, "EXPIRED");
  assert.strictEqual(by["c-live"].campaignStatus, "ACTIVE");
  assert.strictEqual(by["c-nostatus"].campaignStatus, "");
  // Every existing field is still there, unchanged.
  assert.strictEqual(by["c-ended"].current, 63);
  assert.strictEqual(by["c-ended"].required, 90);
  assert.strictEqual(by["c-ended"].game, "Warframe");
  assert.strictEqual(by["c-ended"].campaign, "PMCFQ Coloring Stream");
  assert.strictEqual(by["c-ended"].accountLinkURL, "https://twitch.tv/");
  // And the pending rule reads it: only the live and the status-less drop remain.
  assert.deepStrictEqual(out.filter(inv.isPendingDrop).map((d) => d.campaignId).sort(), ["c-live", "c-nostatus"]);
});

test("the Inventory query asks Twitch for each in-progress campaign's status", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "twitchInventory.js"), "utf8");
  const q = src.slice(src.indexOf("dropCampaignsInProgress {"), src.indexOf("timeBasedDrops {"));
  assert.match(q, /\n\s+status\n/);
});

test("both scanners compute pending through the shared rule, not an inline copy", () => {
  // Pinned by reading the source, like the other scanner hooks: a copy-pasted
  // filter would quietly drop the ended-campaign rule on one side again.
  for (const file of ["dropScanner.js", "renterDropScanner.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "utils", file), "utf8");
    assert.match(src, /require\("\.\/twitchInventory"\)/, file);
    assert.match(src, /\bisPendingDrop\b[^;]*\}\s*=\s*require\("\.\/twitchInventory"\)/, file);
    assert.match(src, /const pending = \(inProgress \|\| \[\]\)\.filter\(isPendingDrop\);/, file);
    assert.doesNotMatch(src, /\(d\) => !d\.claimed && \(d\.required \|\| 0\) > 0/, file);
  }
});
