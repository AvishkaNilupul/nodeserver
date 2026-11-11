const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../utils/g2gGames'), 'utf8'), {
  module: mod,
  require: (name) => {
    assert.equal(name, './marketplaces');
    return { G2G_ITEMS_SERVICE: '0765978e-3fdf-48b4-bed3-184823aa439e' };
  },
});
const { brandForGame, gamesWithG2gBrand, NOT_LISTABLE } = mod.exports;

test('Siege aliases use the owner-selected Mobile shelf while retaining the game identity', () => {
  for (const game of ['Rainbow Six Siege', 'Rainbow Six Siege X', "Tom Clancy's Rainbow Six Siege", "Tom Clancy's Rainbow Six Siege X", 'TOM CLANCYS RAINBOW SIX SIEGE']) {
    assert.equal(brandForGame(game).brandId, 'lgc_game_30876');
    assert.equal(brandForGame(game).seoTerm, 'tom-clancy-s-rainbow-six-mobile-items');
  }
  assert(gamesWithG2gBrand().includes('Rainbow Six Siege'));
  assert(NOT_LISTABLE.has('lgc_game_24713'));
});

test('the explicit Siege route does not broaden unrelated category matching', () => {
  for (const game of ['Overwatch', 'VALORANT', 'Rainbow Six Extraction', 'Rainbow Six Mobile']) assert.equal(brandForGame(game), null);
  assert.equal(brandForGame('Rocket League').brandId, 'lgc_game_23797');
});
