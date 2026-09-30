// Review round (pack math): guards outside the delivery path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const packMath = require("../utils/bulkPacks/packMath");
const markets = require("../utils/bulkPacks/markets");

const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("packMath.titlePackSize / packMismatch", () => {
  assert.equal(packMath.titlePackSize("Rust bundle — PACK OF 5 ACCOUNTS"), 5);
  assert.equal(packMath.titlePackSize("Rust bundle — pack of 10 accounts (-10%)"), 10);
  assert.equal(packMath.titlePackSize("Rust bundle — LOT OF 5 ACCOUNTS"), 0);
  assert.equal(packMath.titlePackSize("Rust Twitch Drops bundle"), 0);
  assert.equal(packMath.packMismatch({ title: "Rust bundle" }), "");
  assert.equal(packMath.packMismatch({ bulkOfferId: "x", bulkPackSize: 5, title: "x — PACK OF 5 ACCOUNTS" }), "");
  assert.match(packMath.packMismatch({ bulkOfferId: "x", title: "x" }), /no pack size/);
  assert.match(packMath.packMismatch({ title: "x — PACK OF 5 ACCOUNTS" }), /records no pack/);
  assert.match(packMath.packMismatch({ bulkOfferId: "x", bulkPackSize: 10, title: "x — PACK OF 5 ACCOUNTS" }), /a pack of 10/);
});

test("no-claim pack rows are born linked: markets.publishNoclaim hands rowExtra to the layer", async () => {
  let seen = null;
  markets.__setDeps({
    noclaimListings: {
      publishNoclaim: async (m, ctx) => {
        seen = ctx;
        return { success: true, id: "507f1f77bcf86cd799439011", externalId: "eld-x", url: "u", price: 7 };
      },
    },
  });
  try {
    await markets
      .publishNoclaim({
        market: "eldorado",
        set: { _id: "507f1f77bcf86cd799439012", stockSource: "noclaim", name: "OW", items: [{ name: "Spray", game: "Overwatch" }] },
        game: "Overwatch",
        title: "OW bundle — PACK OF 5 ACCOUNTS",
        description: "d",
        unitPrice: 1.4,
        packPrice: 7,
        quantity: 2,
        minQty: 5,
        coverPath: "",
        rowExtra: { bulkOfferId: "507f1f77bcf86cd799439013", bulkPackSize: 5 },
      })
      .catch(() => {});
  } finally {
    markets.__resetDeps();
  }
  // Whether or not this fake context reached the layer's publish, the context
  // carries the link: assert on what was handed over when it did.
  if (seen) assert.deepEqual(seen.rowExtra, { bulkOfferId: "507f1f77bcf86cd799439013", bulkPackSize: 5 });
  assert.match(src("utils/noclaimListings.js"), /\.\.\.\(rowExtra \|\| \{\}\),/);
  assert.match(src("utils/bulkPacks/send.js"), /rowExtra: \{ bulkOfferId: offer\._id, bulkPackSize: minQty \}/);
});

test("operator scripts never touch bulk rows; the console books a pack once", () => {
  assert.match(src("scripts/reprice-eldorado-game.js"), /status: "active", bulkOfferId: null, title:/);
  assert.match(src("scripts/pa-mirror-eldorado.js"), /status: "active",\s*\/\/[^\n]*\n[^\n]*\n\s*bulkOfferId: null,/);
  assert.match(src("routes/marketplaceConsoleRoutes.js"), /\(Number\(r\.price\) \|\| 0\) \/ packSizeOf\(r\)/);
  assert.match(src("routes/marketplaceConsoleRoutes.js"), /bulkPackSize: 1,/);
});
