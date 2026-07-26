// Pure-function coverage for the repack planner (utils/botConsolidator).
// buildPlan decides which containers survive and which accounts move, and the
// live run trusts it completely — an off-by-one here would either strand
// accounts or overfill a container. No docker, no Mongo.
const test = require("node:test");
const assert = require("node:assert");

const { buildPlan, enabledCount } = require("../utils/botConsolidator");

// A container holding `n` enabled accounts, plus optional disabled ones.
function box(container, n, disabled = 0) {
  const users = [];
  for (let i = 0; i < n; i++) {
    users.push({
      ClientSecret: container + "-s" + i,
      Login: container + "-u" + i,
      Enabled: true,
      FavouriteGames: ["Rust"],
    });
  }
  for (let i = 0; i < disabled; i++) {
    users.push({
      ClientSecret: container + "-d" + i,
      Login: container + "-x" + i,
      Enabled: false,
      FavouriteGames: [],
    });
  }
  return {
    file: "config_" + container.replace(/\D/g, "") + ".json",
    container,
    data: { TwitchSettings: { TwitchUsers: users } },
    users,
    enabled: n,
    total: users.length,
  };
}

test("packs 14 ten-account bots into two at capacity 70", () => {
  const boxes = [];
  for (let i = 21; i <= 34; i++) boxes.push(box("twitchbotx" + i, 10));
  const p = buildPlan(boxes, 70);

  assert.strictEqual(p.totalEnabled, 140);
  assert.strictEqual(p.after.containers, 2);
  assert.strictEqual(p.retire.length, 12);
  assert.strictEqual(p.stranded, 0);
  // Every account is accounted for: what the survivors hold equals the total.
  const held = p.targets.reduce((s, t) => s + t.willHold, 0);
  assert.strictEqual(held, 140);
  assert.ok(p.savingMB > 1000, "should model a >1GB saving, got " + p.savingMB);
});

test("capacity 140 collapses the same fleet to a single container", () => {
  const boxes = [];
  for (let i = 21; i <= 34; i++) boxes.push(box("twitchbotx" + i, 10));
  const p = buildPlan(boxes, 140);
  assert.strictEqual(p.after.containers, 1);
  assert.strictEqual(p.retire.length, 13);
  assert.strictEqual(p.targets[0].willHold, 140);
  assert.strictEqual(p.stranded, 0);
});

test("no target is ever pushed past capacity", () => {
  const boxes = [box("a1", 30), box("a2", 30), box("a3", 30), box("a4", 30)];
  const p = buildPlan(boxes, 50);
  for (const t of p.targets) {
    assert.ok(
      t.willHold <= 50,
      t.container + " holds " + t.willHold + " > capacity 50",
    );
  }
  assert.strictEqual(p.stranded, 0);
});

test("disabled accounts move but do not consume seats", () => {
  // b1 is 5 enabled + 95 disabled. It is the donor (fewest seats), so all 100
  // of its entries must land in b2 even though only 5 of them cost a seat —
  // a sold/finished account's token must never be left in a retired container.
  const boxes = [box("b1", 5, 95), box("b2", 15)];
  const p = buildPlan(boxes, 20);
  assert.strictEqual(p.totalEnabled, 20);
  assert.strictEqual(p.totalUsers, 115);
  assert.strictEqual(p.after.containers, 1);
  assert.strictEqual(p.targets[0].container, "b2");
  assert.strictEqual(p.retire[0].container, "b1");

  const movedAccounts = p.moves.reduce((s, m) => s + m.accounts, 0);
  const movedSeats = p.moves.reduce((s, m) => s + m.seats, 0);
  assert.strictEqual(movedAccounts, 100, "all entries move");
  assert.strictEqual(movedSeats, 5, "only enabled ones cost seats");
  assert.strictEqual(p.stranded, 0);
});

test("the fullest containers are kept, so the fewest accounts move", () => {
  const boxes = [box("small", 5), box("big", 60), box("mid", 20)];
  const p = buildPlan(boxes, 90);
  assert.strictEqual(p.after.containers, 1);
  assert.strictEqual(p.targets[0].container, "big");
  assert.deepStrictEqual(
    p.retire.map((r) => r.container).sort(),
    ["mid", "small"],
  );
});

test("an already-packed fleet produces no moves", () => {
  const p = buildPlan([box("solo", 40)], 70);
  assert.strictEqual(p.moves.length, 0);
  assert.strictEqual(p.retire.length, 0);
  assert.strictEqual(p.after.containers, 1);
});

test("enabledCount ignores junk and honours Enabled:false", () => {
  assert.strictEqual(
    enabledCount([{ Enabled: true }, {}, { Enabled: false }, null]),
    2,
  );
});
