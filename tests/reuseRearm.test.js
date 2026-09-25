// A recurring campaign is "reused": its old bots are started again with the
// accounts that farmed the game last time. completeEndedTasks had taken the
// game off those accounts and disabled the ones left with none, and the reuse
// paths never gave it back — 45 of 54 reuse tasks in 8 days earned 0 drops.
// planRearm decides which accounts get the game back. Re-enabling the wrong one
// is worse than farming nothing, so every exclusion below is pinned.
const test = require("node:test");
const assert = require("node:assert");
const { planRearm } = require("../utils/reuseRearm");

const GAME = "Black Desert";
const autoNote = { status: "claimed", claimedNote: "auto-farm: Black Desert (c1)", manualSold: false };

function world(overrides = {}) {
  const users = [
    { Login: "Alpha1", ClientSecret: "s-alpha", Enabled: false, FavouriteGames: [] },
    { Login: "beta2", ClientSecret: "s-beta", Enabled: true, FavouriteGames: ["Albion Online"] },
    { Login: "gamma3", ClientSecret: "s-gamma", Enabled: true, FavouriteGames: ["black desert "] },
  ];
  return {
    game: GAME,
    logins: ["alpha1", "BETA2", "gamma3"],
    botFiles: [{ host: "contabo", file: "config_42.json", container: "twitchbotx42", users }],
    enabledIn: new Map([
      ["s-beta", ["contabo|config_42.json"]],
      ["s-gamma", ["contabo|config_42.json"]],
    ]),
    pool: new Map([
      ["alpha1", autoNote],
      ["beta2", autoNote],
      ["gamma3", autoNote],
    ]),
    botAccounts: new Map(),
    gameSold: new Set(),
    noclaim: new Set(),
    renters: new Set(),
    ...overrides,
  };
}

const planned = (r) => [...r.plan.values()].flat();

test("a disabled account with the game removed gets it back and is enabled", () => {
  const r = planRearm(world());
  const alpha = planned(r).find((c) => c.login === "alpha1");
  assert.deepEqual({ addGame: alpha.addGame, enable: alpha.enable }, { addGame: true, enable: true });
  const beta = planned(r).find((c) => c.login === "beta2");
  assert.deepEqual({ addGame: beta.addGame, enable: beta.enable }, { addGame: true, enable: false });
  assert.deepEqual(r.alreadyArmed, ["gamma3"], "game compare is trimmed and case-insensitive");
  assert.deepEqual([...r.plan.keys()], ["contabo|config_42.json"]);
});

test("pool state decides: only the auto-farm's own claim is re-armed", () => {
  for (const [row, why] of [
    [undefined, "no pool row"],
    [{ ...autoNote, manualSold: true }, "hand-sold (manualSold)"],
    [{ ...autoNote, status: "available" }, "back in the pool"],
    [{ ...autoNote, claimedNote: "unclaimed stock — 14 drop(s) (Rainbow Six Siege)" }, "claimed by something else"],
    [{ ...autoNote, claimedNote: "noclaim-farm:Overwatch" }, "claimed by something else"],
    [{ ...autoNote, claimedNote: "rented to bulksellerhaz" }, "claimed by something else"],
    [{ ...autoNote, claimedNote: "spent — no-claim removed Overwatch" }, "claimed by something else"],
    [{ ...autoNote, unclaimedDropCount: 14 }, "holds unclaimed drops"],
  ]) {
    const w = world();
    if (row) w.pool.set("alpha1", row);
    else w.pool.delete("alpha1");
    const r = planRearm(w);
    assert.deepEqual(r.skipped[why], ["alpha1"], why);
    assert.equal(planned(r).some((c) => c.login === "alpha1"), false, why);
  }
});

test("dead, sold, no-claim, renter and elsewhere-enabled accounts are never re-armed", () => {
  const cases = [
    [{ botAccounts: new Map([["s-alpha", { lastScanStatus: "suspended" }]]) }, "dead token / suspended"],
    [{ botAccounts: new Map([["s-alpha", { lastScanStatus: "token_invalid" }]]) }, "dead token / suspended"],
    [{ botAccounts: new Map([["s-alpha", { lastScanStatus: "ok", soldAt: new Date(), soldToUsername: "buyer77" }]]) }, "sold to a buyer"],
    [{ gameSold: new Set(["alpha1"]) }, "this game sold or connected"],
    [{ noclaim: new Set(["s-alpha"]) }, "in a no-claim bot"],
    [{ renters: new Set(["alpha1"]) }, "in a renter stack"],
    [{ enabledIn: new Map([["s-alpha", ["contabo|config_24.json"]]]) }, "enabled in another config"],
  ];
  for (const [over, why] of cases) {
    const r = planRearm(world(over));
    assert.deepEqual(r.skipped[why], ["alpha1"], why);
  }
});

test("a marketplace reservation is not a sale — listed stock keeps farming", () => {
  const r = planRearm(
    world({ botAccounts: new Map([["s-alpha", { lastScanStatus: "ok", soldAt: new Date(), soldToUsername: "ggsel" }]]) }),
  );
  assert.ok(planned(r).some((c) => c.login === "alpha1"));
});

test("an account in two reused bots is re-armed in one place only", () => {
  const w = world();
  w.botFiles.push({
    host: "contabo",
    file: "config_24.json",
    container: "twitchbotx24",
    users: [{ Login: "alpha1", ClientSecret: "s-alpha", Enabled: true, FavouriteGames: ["Apex Legends"] }],
  });
  w.enabledIn.set("s-alpha", ["contabo|config_24.json"]);
  const r = planRearm(w);
  const alpha = [...r.plan.entries()].filter(([, v]) => v.some((c) => c.login === "alpha1"));
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0][0], "contabo|config_24.json", "the still-enabled home wins");
});

test("accounts not in the reused bots are reported, not invented", () => {
  const r = planRearm(world({ logins: ["alpha1", "stranger9", "alpha1"] }));
  assert.deepEqual(r.skipped["not in the reused bots"], ["stranger9"]);
  assert.equal(planned(r).filter((c) => c.login === "alpha1").length, 1, "dedupes logins");
});
