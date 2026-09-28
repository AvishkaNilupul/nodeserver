/* global structuredClone */
// One summary line per no-claim game (owner, 2026-09-28): farming, holding
// stock, free, where it is on sale, sold 7/30 days with money, and when the
// running wave ends. DB-only; the models and the holdings snapshot are stubbed.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

function model(rows) {
  const q = (v) => ({ lean: async () => structuredClone(v) });
  return { find: () => q(rows) };
}

test("gamesSummary: one row per no-claim game from every source", async () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const ago = (d) => new Date(now.getTime() - d * 864e5);
  const settingsReal = require("../utils/settings");
  const settings = new Proxy(settingsReal, {
    get: (t, k) => (k === "getAutoFarm" ? () => ({ ...t.getAutoFarm(), noClaimGames: ["overwatch", "rainbow six"] }) : t[k]),
  });
  const stubs = new Map([
    [require.resolve("../utils/settings"), settings],
    [require.resolve("../models/NoclaimHolding"), model([{ game: "Overwatch" }, { game: "Overwatch" }, { game: "Rainbow Six Siege" }])],
    [
      require.resolve("../models/TwitchCampaign"),
      model([
        { game: "Tom Clancy's Rainbow Six Siege", endAt: new Date("2026-09-30T05:00:00Z"), name: "R6S S2 2026 11" },
        { game: "Rainbow Six Siege", endAt: new Date("2026-10-13T14:00:00Z"), name: "R6S Wasteland circuit" },
      ]),
    ],
    [
      require.resolve("../utils/noclaimHoldings"),
      {
        pickerGames: async () => [
          { game: "Overwatch", accounts: 2, free: 1, fresh: 1 },
          { game: "Rainbow Six Siege", accounts: 1, free: 0, fresh: 0 },
        ],
        summary: async () => ({ accounts: 3, fresh: 3, stale: 0, newestReadAt: now }),
      },
    ],
    [
      require.resolve("../models/UnclaimedAccount"),
      model([
        { game: "Overwatch", status: "listed", market: "gameflip" },
        { game: "Overwatch", status: "listed", market: "gameflip" },
        { game: "Overwatch", status: "listed", market: "ggsel" },
        { game: "Overwatch", status: "manual" },
        { game: "Overwatch", status: "sold", soldAt: ago(2), soldPriceUsd: 1 },
        { game: "Overwatch", status: "sold", soldAt: ago(20), soldPriceUsd: 1.21 },
        { game: "Rainbow Six Siege", status: "sold", soldAt: ago(1), soldPriceUsd: 4.5 },
      ]),
    ],
    [
      require.resolve("../models/MarketplaceListing"),
      model([
        { marketplace: "gameflip", set: "S-OW", accountLogin: "a", noclaimStock: false, lotSize: 0 },
        { marketplace: "eldorado", set: "S-OW", noclaimStock: true, qtyTarget: 80, autoPaused: false, units: [{ deliveredAt: ago(1) }, { deliveredAt: ago(9) }] },
      ]),
    ],
    [require.resolve("../models/DropSet"), model([{ _id: "S-OW", coverGame: "Overwatch" }])],
  ]);
  const path = require.resolve("../routes/unclaimedAutoRoutes");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  delete require.cache[path];
  try {
    const r = await require("../routes/unclaimedAutoRoutes").gamesSummary(now);
    const by = Object.fromEntries(r.games.map((g) => [g.game, g]));
    const ow = by.overwatch;
    assert.deepStrictEqual(
      { farming: ow.farming, holdingStock: ow.holdingStock, free: ow.free, onShopListings: ow.onShopListings },
      { farming: 2, holdingStock: 2, free: 1, onShopListings: 1 },
    );
    assert.deepStrictEqual(ow.autoListed, { gameflipLive: 1, gameflipWaiting: 1, other: 1 });
    assert.deepStrictEqual(ow.shopOffers, [{ market: "eldorado", paused: false, stock: 80, delivered7: 1 }]);
    assert.deepStrictEqual({ s7: ow.sold7, s30: ow.sold30 }, { s7: { n: 1, usd: 1 }, s30: { n: 2, usd: 2.21 } });
    const r6 = by["rainbow six"];
    assert.strictEqual(r6.waveName, "R6S S2 2026 11", "the wave that ends first");
    assert.deepStrictEqual(r6.sold7, { n: 1, usd: 4.5 });
    assert.strictEqual(r.snapshot.accounts, 3);
  } finally {
    Module._load = origLoad;
    delete require.cache[path];
  }
});
