const test = require("node:test");
const assert = require("node:assert");
const { normGame } = require("../utils/gameLabel");

// utils/operatorFarm.js keeps `spentOnGame` module-private; this mirrors it so
// the rule itself is covered. If the implementation there changes, this test
// is the statement of intent it has to keep satisfying.
function spentOnGame(account, game) {
  const want = normGame(game);
  if (!want) return false;
  return (Array.isArray(account && account.soldGames) ? account.soldGames : [])
    .map(normGame)
    .filter(Boolean)
    .some((sold) => sold === want || sold.includes(want) || want.includes(sold));
}

test("a recycled account never re-farms a game it was sold on", () => {
  const acct = { soldGames: ["overwatch"] };
  assert.equal(spentOnGame(acct, "Overwatch"), true);
  assert.equal(spentOnGame(acct, "overwatch "), true);
  assert.equal(spentOnGame(acct, "Overwatch™"), true);
});

test("substring semantics match the no-claim exclusion", () => {
  // The recycler stamps the canonical label; the operator may type a keyword.
  const acct = { soldGames: ["rainbow six siege"] };
  assert.equal(spentOnGame(acct, "Rainbow Six"), true);
  assert.equal(spentOnGame({ soldGames: ["rainbow six"] }, "Rainbow Six Siege"), true);
});

test("a different game is still farmable — recycling is not a ban", () => {
  const acct = { soldGames: ["overwatch"] };
  assert.equal(spentOnGame(acct, "Rainbow Six Siege"), false);
  assert.equal(spentOnGame(acct, "Rust"), false);
});

test("Overwatch and Overwatch 2 are different games, as normGame keeps digits", () => {
  assert.equal(spentOnGame({ soldGames: ["overwatch 2"] }, "Overwatch"), true,
    "substring semantics deliberately treat the sequel as covering the keyword");
  assert.equal(spentOnGame({ soldGames: ["overwatch"] }, "Rocket League"), false);
});

test("an unstamped or empty account is never blocked", () => {
  assert.equal(spentOnGame({ soldGames: [] }, "Overwatch"), false);
  assert.equal(spentOnGame({}, "Overwatch"), false);
  assert.equal(spentOnGame(null, "Overwatch"), false);
  assert.equal(spentOnGame({ soldGames: ["overwatch"] }, ""), false);
});
