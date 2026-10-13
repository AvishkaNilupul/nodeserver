// scripts/rentfarm-sales-compare.js — the before/after count a price test is
// judged on. A wrong window or a wrong ladder here reads as "the rise worked"
// (or did not) when it is only arithmetic.
const test = require("node:test");
const assert = require("node:assert/strict");

const { compare, lines, verdict } = require("../scripts/rentfarm-sales-compare");
const { parseLadder, gameList } = require("../scripts/reprice-eldorado-farm");

const AT = "2026-01-31T04:00:00Z";
const at = new Date(AT).getTime();
const H = 3600e3;
const D = 24 * H;
const before = parseLadder("30:2,120:3,365:7");
const after = parseLadder("30:2.5,120:4,365:9");
const row = (offsetMs, game, days, quantity = 1, state = "delivered") => ({ createdAt: new Date(at + offsetMs), game, days, quantity, state });
const run = (orders, extra = {}) => compare(orders, { at: AT, days: 7, before, after, now: at + 7 * D, ...extra });

test("each order is priced on the ladder in force when it came in", () => {
  const r = run([row(-1 * H, "Rust", 120, 2), row(+1 * H, "Rust", 120, 2), row(-3 * D, "Apex Legends", 365), row(+3 * D, "Apex Legends", 30)]);
  assert.deepEqual([r.before.accounts, r.before.orders, r.before.revenue], [3, 2, 13]);
  assert.deepEqual([r.after.accounts, r.after.orders, r.after.revenue], [3, 2, 10.5]);
  assert.deepEqual(r.before.byTerm, { 120: 2, 365: 1 });
  assert.deepEqual(r.after.byGame, { Rust: 2, "Apex Legends": 1 });
});

test("the moment of the change belongs to 'after', and both windows have an end", () => {
  const r = run([row(0, "Rust", 30), row(-7 * D, "Rust", 30), row(-7 * D - 1, "Rust", 30), row(7 * D - 1, "Rust", 30), row(7 * D, "Rust", 30)]);
  assert.deepEqual([r.before.accounts, r.after.accounts], [1, 2]);
});

test("a game that kept the old ladder is counted at the old price", () => {
  const r = run([row(+1 * H, "Albion Online", 30), row(+2 * H, "Rust", 30)], { except: gameList("albion online") });
  assert.equal(r.after.revenue, 2 + 2.5);
});

test("cancelled and failed orders are left out and counted apart", () => {
  const r = run([row(+1 * H, "Rust", 30, 2, "cancelled"), row(+2 * H, "Rust", 30, 1, "failed"), row(+3 * H, "Rust", 30, 1, "sent")]);
  assert.deepEqual([r.after.accounts, r.after.dead, r.after.revenue], [1, 3, 2.5]);
});

test("a term with no list price is counted as sold but not as money", () => {
  const r = run([row(+1 * H, "Rust", 180), row(+2 * H, "Rust", 30)]);
  assert.deepEqual([r.after.accounts, r.after.unpriced, r.after.revenue], [2, 1, 2.5]);
  assert.match(lines("AFTER", r.after).join("\n"), /no list price for 1 account/);
});

test("a test still running is compared per day, not total against total", () => {
  // 2 days in: 6 accounts so far against 14 in the full week before.
  const orders = [];
  for (let i = 0; i < 14; i++) orders.push(row(-(i + 0.5) * 12 * H, "Rust", 30));
  for (let i = 0; i < 6; i++) orders.push(row((i + 0.5) * 8 * H, "Rust", 30));
  const r = run(orders, { now: at + 2 * D });
  assert.equal(r.after.spanDays, 2);
  assert.equal(r.before.accountsPerDay, 2);
  assert.equal(r.after.accountsPerDay, 3);
  assert.equal(r.before.revenuePerDay, 4);
  assert.equal(r.after.revenuePerDay, 7.5);
  // an order after "now" cannot exist; one after the window is not counted
  assert.equal(run([row(8 * D, "Rust", 30)]).after.accounts, 0);
});

test("a quantity that is missing counts as one account", () => {
  const r = run([{ createdAt: new Date(at + H), game: "Rust", days: 30, state: "delivered" }]);
  assert.deepEqual([r.after.accounts, r.after.revenue], [1, 2.5]);
});

test("the one-line comparison refuses to judge a few hours", () => {
  const week = [];
  for (let i = 0; i < 14; i++) week.push(row(-(i + 0.5) * 12 * H, "Rust", 30));
  assert.match(verdict(run(week, { now: at + 5 * H })), /too early to compare/);
  assert.match(verdict(run([row(H, "Rust", 30)])), /nothing to compare against/);
  const r = run(week.concat([row(H, "Rust", 30), row(2 * H, "Rust", 30), row(30 * H, "Rust", 30)]), { now: at + 2 * D });
  // 2 a day before ($4), 1.5 a day after ($3.75)
  assert.equal(verdict(r), "per day, after vs before: accounts -25 % · list revenue -6 %");
});
