// autoFarm.g2gMinItems — a game's smallest bundle that still gets a G2G share.
//
// Owner, 2026-10-13: stop spending accounts on small Rocket League, Marvel
// Rivals and Tarkov bundles on G2G. There a fresh 2-5 item set sits under
// 25-160 item accounts sold at the same price, so a share only keeps its
// accounts reserved for a market that does not sell them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS_PATH = require.resolve("../utils/settings");
let n = 0;
// A fresh utils/settings.js reading its own settings file.
function settingsWith(autoFarm) {
  const file = path.join(os.tmpdir(), "g2g-min-items-" + process.pid + "-" + ++n + ".json");
  fs.writeFileSync(file, JSON.stringify(autoFarm === undefined ? {} : { autoFarm }));
  const before = process.env.SETTINGS_FILE;
  process.env.SETTINGS_FILE = file;
  delete require.cache[SETTINGS_PATH];
  try {
    const s = require("../utils/settings");
    s.getAutoFarm(); // read while the file is the one above
    return { s, file };
  } finally {
    if (before === undefined) delete process.env.SETTINGS_FILE;
    else process.env.SETTINGS_FILE = before;
    delete require.cache[SETTINGS_PATH];
  }
}
const cleanup = (file) => {
  for (const f of fs.readdirSync(path.dirname(file))) {
    if (f.startsWith(path.basename(file))) fs.rmSync(path.join(path.dirname(file), f), { force: true });
  }
};

test("no game has a minimum until one is set", () => {
  const { s, file } = settingsWith(undefined);
  try {
    assert.deepEqual(s.getAutoFarm().g2gMinItems, {});
    assert.equal(s.getAutoFarm().g2gEvergreen, false);
    assert.equal(s.g2gMinItemsFor("Rocket League"), 0);
    assert.equal(s.g2gMinItemsFor(""), 0);
  } finally {
    cleanup(file);
  }
});

test("a game's minimum is found through case and punctuation, and only for that exact game", () => {
  const { s, file } = settingsWith({ g2gMinItems: { "rocket league": 6, "Escape from Tarkov": 8, "Marvel Rivals": "6" } });
  try {
    assert.equal(s.g2gMinItemsFor("Rocket League"), 6);
    assert.equal(s.g2gMinItemsFor("ROCKET-LEAGUE "), 6);
    assert.equal(s.g2gMinItemsFor("escape from tarkov"), 8);
    assert.equal(s.g2gMinItemsFor("Marvel Rivals"), 6);
    assert.equal(s.g2gMinItemsFor("Rocket League Sideswipe"), 0, "another game is not swept in");
    assert.equal(s.g2gMinItemsFor("Halo Infinite"), 0);
  } finally {
    cleanup(file);
  }
});

test("a minimum that is not a number above zero is no minimum", () => {
  for (const bad of [{ "Rocket League": 0 }, { "Rocket League": -3 }, { "Rocket League": "many" }, { "Rocket League": null }, ["Rocket League"], "Rocket League", null]) {
    const { s, file } = settingsWith({ g2gMinItems: bad });
    try {
      assert.equal(s.g2gMinItemsFor("Rocket League"), 0, JSON.stringify(bad));
    } finally {
      cleanup(file);
    }
  }
  const { s, file } = settingsWith({ g2gMinItems: { "Rocket League": 6.9 } });
  try {
    assert.equal(s.g2gMinItemsFor("Rocket League"), 6);
  } finally {
    cleanup(file);
  }
});

test("the auto-lister refuses a G2G share for a bundle under its game's minimum, and says why", () => {
  const settings = require("../utils/settings");
  const autoLister = require("../utils/autoLister");
  const real = settings.g2gMinItemsFor;
  const three = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const six = [...three, { name: "d" }, { name: "e" }, { name: "f" }];
  try {
    settings.g2gMinItemsFor = (game) => (game === "Rocket League" ? 6 : 0);
    assert.equal(
      autoLister.g2gBundleTooSmall("Rocket League", three),
      "under G2G's minimum of 6 items for Rocket League (this bundle has 3)",
    );
    assert.equal(autoLister.g2gBundleTooSmall("Rocket League", six), "", "a bundle AT the minimum is listed");
    assert.equal(autoLister.g2gBundleTooSmall("Halo Infinite", three), "", "a game with no minimum is untouched");
    assert.match(autoLister.g2gBundleTooSmall("Rocket League", []), /this bundle has 0/);
    assert.match(autoLister.g2gBundleTooSmall("Rocket League", null), /this bundle has 0/);
  } finally {
    settings.g2gMinItemsFor = real;
  }
});

test("both places that give G2G a share ask the minimum first", () => {
  // The first publish and the retry of a missing share are the only two
  // callers of publishG2gShare. A share the first one refused must not be
  // brought back by the second on the next sweep.
  const src = fs.readFileSync(require.resolve("../utils/autoLister"), "utf8");
  assert.equal((src.match(/publishG2gShare\(\{/g) || []).length, 3, "the definition and its two callers");
  assert.match(src, /const g2gTooSmall = g2gBundleTooSmall\(task\.game, items\);\s+const g2gEnabled =\s+!!af\.g2gAuto && !!brandForGame\(task\.game\) && !g2gTooSmall;/);
  assert.match(src, /g2gMissing &&\s+af\.g2gAuto &&\s+brandForGame\(task\.game\) &&\s+!g2gBundleTooSmall\(task\.game, set\.items \|\| \[\]\)\s+\) \{\s+targets\.push\("g2g"\);/);
});
