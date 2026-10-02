// The auto-lister deals a campaign's accounts across the markets round-robin,
// Gameflip first, and Gameflip ANCHORS the listing: its publish failing deletes
// the set and lists the bundle on no market at all. An account already sold on
// Gameflip (its other games still in stock) is refused there — "code for digital
// goods already exists" — so it must never take a Gameflip slot (2026-10-02).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { dealShares } = require("../utils/autoLister");

const acc = (login) => ({ accountId: "id-" + login, login });
const shares = () => ({ gameflip: [], plati: [], ggsel: [], eldorado: [] });
const logins = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((a) => a.login)]));

test("with nothing held it is exactly the old round-robin", () => {
  const order = ["gameflip", "plati", "ggsel", "eldorado"];
  for (let n = 0; n <= 11; n++) {
    const accounts = Array.from({ length: n }, (_, i) => acc("a" + i));
    const old = shares();
    accounts.forEach((a, i) => old[order[i % order.length]].push(a));
    assert.deepStrictEqual(logins(dealShares(accounts, order, shares(), new Set())), logins(old), "n=" + n);
  }
});

test("REGRESSION: an account already sold on Gameflip never takes a Gameflip slot — it sells elsewhere", () => {
  const order = ["gameflip", "plati", "eldorado"];
  const accounts = ["sold-gf", "b", "c", "d", "e", "f"].map(acc);
  const s = dealShares(accounts, order, shares(), new Set(["sold-gf"]));
  // Gameflip takes the next account it accepts (b); the held one moves to the
  // next market's slot (Plati) instead of being dropped.
  assert.deepStrictEqual(s.gameflip.map((a) => a.login), ["b", "d"]);
  assert.deepStrictEqual(s.plati.map((a) => a.login), ["sold-gf", "e"], "still listed, on another market");
  assert.deepStrictEqual(s.eldorado.map((a) => a.login), ["c", "f"]);
  assert.strictEqual(s.gameflip.length + s.plati.length + s.eldorado.length, accounts.length, "nothing lost");
});

test("held logins match case-blind", () => {
  const s = dealShares(["Sold-GF", "b"].map(acc), ["gameflip", "plati"], shares(), new Set(["sold-gf"]));
  assert.deepStrictEqual(s.gameflip.map((a) => a.login), ["b"]);
});

test("when every account is held Gameflip gets none — and the others still get theirs", () => {
  const s = dealShares(["x", "y", "z"].map(acc), ["gameflip", "plati", "ggsel"], shares(), new Set(["x", "y", "z"]));
  assert.deepStrictEqual(s.gameflip, []);
  assert.strictEqual(s.plati.length + s.ggsel.length, 3);
});

test("with only Gameflip in the order, held accounts stay unlisted (and the deal ends)", () => {
  const s = dealShares(["x", "ok", "y"].map(acc), ["gameflip"], shares(), new Set(["x", "y"]));
  assert.deepStrictEqual(s.gameflip.map((a) => a.login), ["ok"]);
});

test("both listing paths deal through it and learn from a refusal", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "autoLister.js"), "utf8");
  assert.doesNotMatch(src, /accounts\.forEach\(\(acc, i\) => \{\s*shares\[marketOrder/, "a raw round-robin deal is back");
  assert.strictEqual((src.match(/dealShares\(accounts, marketOrder, shares, await gameflipCodeHeldLogins\(\)\)/g) || []).length, 2);
  assert.strictEqual((src.match(/noteIfCodeRefused\(gfDeliver\.login, e\)/g) || []).length, 2);
});
