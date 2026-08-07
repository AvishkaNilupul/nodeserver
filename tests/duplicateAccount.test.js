// Two live listings handed the same Twitch account to two buyers on prod
// (jhono5c2v9 on digiseller 6015622 + gameflip 6434f071; conrad78grant59 on
// digiseller 6010082 + gameflip c5c7f08d). Per-drop reservation was supposed to
// make that impossible, and these tests pin down the two holes it had:
//
//   1. Reservation is checked per DROP, but a sale hands over the whole
//      ACCOUNT. A bot that keeps farming the same campaign adds fresh copies of
//      the set's items, and those copies read as free stock — so a second
//      marketplace could claim an account whose credentials were already on
//      sale. One set is now claimable once per account.
//   2. The same login can exist as two BotAccount rows (the pool was fed the
//      same account twice), and each row has its own drop rows — so neither
//      one's reservation was visible to the other. The guard spans an account's
//      duplicate rows.
//
// And the repair itself: the listing that claimed the account FIRST keeps it,
// because that is the one a buyer may already have paid against.
const test = require("node:test");
const assert = require("node:assert");

const { claimAllowed } = require("../utils/dropReservation");
const { fixPlanFor, claimedAtOn } = require("../utils/guardianFixes");

test("a set already reserved on these credentials cannot be claimed again", () => {
  const held = [{ soldAt: new Date(), soldToUsername: "gameflip" }];
  assert.equal(claimAllowed(held, { soldToUsername: "digiseller" }), false);
  // Even the same marketplace: two products of one set would double-sell too.
  assert.equal(claimAllowed(held, { soldToUsername: "gameflip" }), false);
});

test("free credentials are claimable, and the owner may re-reserve its own", () => {
  assert.equal(claimAllowed([], { soldToUsername: "gameflip" }), true);
  assert.equal(claimAllowed(null, {}), true);
  // The guardian's claim-mismatch fix re-reserves drops its listing owns.
  assert.equal(claimAllowed([{ soldAt: new Date() }], { reclaim: true }), true);
});

test("a unit's own feed time decides when a qty listing claimed the account", () => {
  const early = new Date("2026-08-02T01:35:00Z");
  const late = new Date("2026-08-07T11:17:56Z");
  const ds = {
    marketplace: "digiseller",
    createdAt: early,
    units: [
      { accountId: "a1", login: "Conrad78Grant59", addedAt: late },
      { accountId: "a2", login: "Damian49Malone72", addedAt: late },
    ],
  };
  // The product predates the Gameflip offer, but this account only went INTO
  // it on the 7th — so Gameflip (the 5th) holds the earlier claim.
  assert.equal(claimedAtOn(ds, "a1", "Conrad78Grant59"), late.getTime());
  const gf = {
    marketplace: "gameflip",
    createdAt: new Date("2026-08-05T16:21:10Z"),
    units: [],
  };
  assert.ok(
    claimedAtOn(gf, "a9", "conrad78grant59") <
      claimedAtOn(ds, "a1", "Conrad78Grant59"),
  );
  // Matching by login alone works too: the duplicate row has a different id.
  assert.equal(claimedAtOn(ds, "", "conrad78grant59"), late.getTime());
});

test("an untracked account falls back to when the listing itself went up", () => {
  const row = {
    marketplace: "ggsel",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    units: [],
  };
  assert.equal(
    claimedAtOn(row, "nobody", "nobody"),
    Date.parse("2026-08-01T00:00:00Z"),
  );
});

test("the dedupe fix is offered only while both listings are really live", () => {
  const f = {
    status: "open",
    type: "duplicate-account",
    accountLogin: "jhono5c2v9",
  };
  const live = (marketplace) => ({ marketplace, status: "active" });
  assert.equal(
    fixPlanFor(f, null, [live("digiseller"), live("gameflip")]).action,
    "dedupe",
  );
  assert.equal(
    fixPlanFor(f, null, [
      live("digiseller"),
      { marketplace: "gameflip", status: "sold" },
    ]),
    null,
  );
});
