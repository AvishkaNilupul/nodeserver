// Coverage for the drop checker's call into autoLister (utils/farm2/steps/verify.js).
//
// verify.js originally called `campaignItems(task)`. The real signature is
// `campaignItems(campaignId, game, campaignName)` — three positional arguments —
// so campaignId became an object, the Twitch fetch failed, and EVERY task
// reported "could not resolve campaign items". The live audit consequently
// showed all 16 unlisted tasks as broken, which read like a production outage
// and was entirely this bug.
//
// In a live lane it would have been worse than a misleading report:
// publishPrimary gates on verifyTask().ok, so nothing would ever have been
// listed at all.
//
// These tests pin the call shape by spying on the arguments, which is the only
// thing that would have caught it — the wrong call still "worked", it just
// always failed.
const test = require("node:test");
const assert = require("node:assert/strict");

const autoLister = require("../utils/autoLister");
const verify = require("../utils/farm2/steps/verify");

test("verifyTask calls campaignItems with (campaignId, game, campaignName)", async () => {
  const origItems = autoLister.campaignItems;
  const origHolders = autoLister.verifiedHoldersForItems;
  let seen = null;
  autoLister.campaignItems = async (...args) => {
    seen = args;
    return [{ itemKey: "k1", name: "Item One", qty: 1 }];
  };
  autoLister.verifiedHoldersForItems = async () => [
    { login: "a", password: "p", accountId: "1" },
  ];
  try {
    const r = await verify.verifyTask({
      _id: "t1",
      campaignId: "camp-123",
      game: "Test Game",
      campaignName: "Test Campaign",
      assignedAccounts: ["a", "b"],
    });
    assert.deepEqual(
      seen,
      ["camp-123", "Test Game", "Test Campaign"],
      "three positional args, in this order — not the task object",
    );
    assert.equal(r.ok, true);
    assert.equal(r.verified, 1);
    assert.equal(r.assigned, 2);
  } finally {
    autoLister.campaignItems = origItems;
    autoLister.verifiedHoldersForItems = origHolders;
  }
});

test("a task whose campaign resolves to no items is blocked, not silently ok", async () => {
  const orig = autoLister.campaignItems;
  autoLister.campaignItems = async () => [];
  try {
    const r = await verify.verifyTask({
      _id: "t2",
      campaignId: "c",
      game: "G",
      campaignName: "N",
      assignedAccounts: ["a"],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no resolvable drop items/i);
  } finally {
    autoLister.campaignItems = orig;
  }
});

test("a task with no assigned accounts is blocked", async () => {
  const r = await verify.verifyTask({
    _id: "t3",
    campaignId: "c",
    game: "G",
    assignedAccounts: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.assigned, 0);
  assert.match(r.reason, /no assigned accounts/i);
});

test("zero verified holders blocks publishing even when items resolve", async () => {
  const origItems = autoLister.campaignItems;
  const origHolders = autoLister.verifiedHoldersForItems;
  autoLister.campaignItems = async () => [{ itemKey: "k1", name: "I", qty: 1 }];
  autoLister.verifiedHoldersForItems = async () => [];
  try {
    const r = await verify.verifyTask({
      _id: "t4",
      campaignId: "c",
      game: "G",
      campaignName: "N",
      assignedAccounts: ["a", "b", "c"],
    });
    // This is the mid-farm state: the accounts exist but do not yet hold the
    // full bundle. Publishing here would sell content that is not there.
    assert.equal(r.ok, false);
    assert.equal(r.verified, 0);
    assert.equal(r.shortfall, 3);
  } finally {
    autoLister.campaignItems = origItems;
    autoLister.verifiedHoldersForItems = origHolders;
  }
});
