// GGSel category resolution never files a Twitch-drops account under a
// platform's game-account section.
//
// A game with no "Twitch Drops" section on GGSel used to fall back to its
// "Accounts" child and walk down to the FIRST leaf — "Accounts > PlayStation >
// Standard Edition", "Accounts > Steam" — sections that sell that platform's
// game accounts. Rematch, RuneScape: Dragonwilds and Madden NFL 27 landed there
// on 2026-10-01. A plain Accounts leaf is still used (Where Winds Meet's
// pattern); an Accounts section split by platform is not.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

function loadWith(tree) {
  const fakeAxios = {
    async get(url) {
      if (/\/offers\?limit=100/.test(url)) return { data: { data: [] } };
      const q = /\/categories\/search\?q=(.*)$/.exec(url);
      if (q) return { data: { data: tree.search } };
      const p = /\/categories\?parent_id=(\d+)/.exec(url);
      if (p) return { data: { data: tree.children[p[1]] || [] } };
      throw new Error("unexpected GET " + url);
    },
  };
  const mpPath = require.resolve("../utils/marketplaces");
  const settingsPath = require.resolve("../utils/settings");
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios") return fakeAxios;
    try {
      if (Module._resolveFilename(request, parent, isMain) === settingsPath) {
        return { loadSettings: () => ({ marketplaces: { ggsel: { apiKey: "k" } } }), saveSettings: () => {} };
      }
    } catch {
      /* fall through */
    }
    return orig.apply(this, arguments);
  };
  delete require.cache[mpPath];
  delete require.cache[settingsPath];
  try {
    return require(mpPath);
  } finally {
    Module._load = orig;
    delete require.cache[mpPath];
    delete require.cache[settingsPath];
  }
}

const GAME = { id: 10, title: "Madden NFL 27", tree: "Games > Madden NFL 27", has_children: true };

test("an Accounts section split by platform is not a Twitch-drops category", async () => {
  const mp = loadWith({
    search: [GAME],
    children: {
      10: [{ id: 11, title: "Accounts", has_children: true }],
      11: [{ id: 12, title: "PlayStation", has_children: false }, { id: 13, title: "Steam", has_children: false }],
    },
  });
  assert.equal(await mp.ggselResolveCategoryId("Madden NFL 27"), "");
});

test("a plain Accounts leaf is still the fallback", async () => {
  const mp = loadWith({
    search: [GAME],
    children: { 10: [{ id: 21, title: "Accounts", has_children: false }] },
  });
  assert.equal(await mp.ggselResolveCategoryId("Madden NFL 27"), "21");
});

test("a Twitch Drops section wins over Accounts", async () => {
  const mp = loadWith({
    search: [GAME],
    children: {
      10: [
        { id: 31, title: "Accounts", has_children: true },
        { id: 32, title: "Twitch Drops", has_children: false },
      ],
    },
  });
  assert.equal(await mp.ggselResolveCategoryId("Madden NFL 27"), "32");
});
