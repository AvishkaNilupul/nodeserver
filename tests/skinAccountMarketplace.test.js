const test = require("node:test");
const assert = require("node:assert/strict");
const { updateListed } = require("../utils/skinAccountMarketplace");
function setup({ active = true, unchanged = false, price = 4.99 } = {}) {
  const events = [];
  let stored = {};
  const skin = {
    state: active ? "listed" : "paused",
    ownershipStatus: "owned",
    remoteOfferId: "offer",
  };
  let sold = false;
  const entry = {
    id: "same-entry",
    accountLogin: "epic-private",
    accountPassword: "epic-secret",
    emailPassword: "mail-secret",
    additionalInfo: "linked Twitch private secret",
  };
  const offer = {
    offerState: active ? "Active" : "Paused",
    quantity: 1,
    offerTitle: unchanged ? "new" : "old",
    description: unchanged ? "new-copy" : "old-copy",
    pricePerUnit: { amount: price, currency: "USD" },
    mainOfferImage: { largeImage: "real.png" },
    offerImages: [{ largeImage: "extra.png" }],
    hasOriginalEmail: false,
  };
  const deps = {
    read: async () => {
      events.push("read");
      return sold
        ? { sold: true }
        : {
            offer: { ...offer, pricePerUnit: { ...offer.pricePerUnit } },
            entry: { ...entry },
            active: offer.offerState === "Active",
          };
    },
    record: async (fields) => {
      Object.assign(stored, fields);
      events.push("record");
    },
    saveListing: async () => events.push("save"),
    section: () => ({ gameId: "1" }),
    eld: {
      pauseAccountOffer: async () => {
        events.push("pause");
        offer.offerState = "Paused";
      },
      resumeAccountOffer: async () => {
        events.push("resume");
        offer.offerState = "Active";
      },
      changeAccountOfferPrice: async (_id, value) => {
        events.push("price");
        offer.pricePerUnit.amount = value;
      },
      updateAccountOffer: async (_id, opts) => {
        events.push("edit");
        assert.deepEqual(opts.entries, [entry]);
        assert.deepEqual(opts.offerImages, offer.offerImages);
        assert.deepEqual(opts.mainOfferImage, offer.mainOfferImage);
        offer.offerTitle = opts.title;
        offer.description = opts.description;
        offer.pricePerUnit.amount = opts.priceUsd;
      },
    },
  };
  return {
    skin,
    preview: { title: "new", description: "new-copy" },
    priceUsd: 5.19,
    deps,
    events,
    entry,
    offer,
    stored,
    sell: () => {
      sold = true;
    },
  };
}
test("content edit pauses, preserves every private entry and photo, verifies, then resumes", async () => {
  const f = setup();
  const r = await updateListed(f, f.deps);
  assert.equal(r.changed, true);
  assert(f.events.indexOf("pause") < f.events.indexOf("edit"));
  assert(f.events.indexOf("resume") > f.events.indexOf("edit"));
  assert.deepEqual(f.stored.mutation, {});
  assert.equal(f.offer.pricePerUnit.amount, 5.19);
});
test("manually paused offers remain paused after a successful update", async () => {
  const f = setup({ active: false });
  await updateListed(f, f.deps);
  assert(!f.events.includes("resume"));
  assert.equal(f.offer.offerState, "Paused");
});
test("price-only edit does not submit stock or pause an offer", async () => {
  const f = setup({ unchanged: true });
  await updateListed(f, f.deps);
  assert(f.events.includes("price"));
  assert(!f.events.includes("edit"));
  assert(!f.events.includes("pause"));
});
test("unchanged public text and price perform no marketplace writes", async () => {
  const f = setup({ unchanged: true, price: 5.19 });
  const r = await updateListed(f, f.deps);
  assert.equal(r.changed, false);
  assert(
    !f.events.some((x) => ["edit", "price", "pause", "resume"].includes(x)),
  );
});
test("a sale while pausing prevents any stock rewrite or resume", async () => {
  const f = setup();
  f.deps.eld.pauseAccountOffer = async () => f.sell();
  const r = await updateListed(f, f.deps);
  assert.equal(r.sold, true);
  assert(!f.events.includes("edit"));
  assert(!f.events.includes("resume"));
});
test("a sale during edit prevents resume and never retries a create", async () => {
  const f = setup();
  f.deps.eld.updateAccountOffer = async () => f.sell();
  const r = await updateListed(f, f.deps);
  assert.equal(r.sold, true);
  assert(!f.events.includes("resume"));
  assert.equal(f.stored.mutation.kind, "edit");
});
test("unconfirmed pause, missing entry ID and changed private receipt all fail closed", async () => {
  for (const fault of ["pause", "id", "receipt"]) {
    const f = setup();
    if (fault === "pause") f.deps.eld.pauseAccountOffer = async () => {};
    if (fault === "id") f.entry.id = "";
    if (fault === "receipt") {
      const original = f.deps.eld.updateAccountOffer;
      f.deps.eld.updateAccountOffer = async (...args) => {
        await original(...args);
        f.entry.additionalInfo = "wrong";
      };
    }
    await assert.rejects(updateListed(f, f.deps));
    assert(!f.events.includes("resume"));
    assert.equal(f.stored.mutation.kind, "edit");
  }
});
test("failed remote update retains durable intent and does not resume", async () => {
  const f = setup();
  f.deps.eld.updateAccountOffer = async () => {
    throw Error("timeout");
  };
  await assert.rejects(updateListed(f, f.deps));
  assert.equal(f.stored.mutation.kind, "edit");
  assert.equal(f.offer.offerState, "Paused");
  assert(!f.events.includes("resume"));
});

test("USD extraction never interprets a local-currency amount as dollars", () => {
  const { usdPrice } = require("../utils/skinAccountMarketplace");
  assert.throws(() =>
    usdPrice({ pricePerUnit: { amount: 821, currency: "JPY" } }),
  );
  assert.equal(
    usdPrice({
      pricePerUnit: { amount: 821, currency: "JPY" },
      pricePerUnitInUSD: { amount: 4.99, currency: "USD" },
    }),
    4.99,
  );
});
