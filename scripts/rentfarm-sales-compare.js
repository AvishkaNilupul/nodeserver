#!/usr/bin/env node
// Rent-farm sales before and after a price change: accounts sold per term, and
// what they brought in at the list price in force when each order came in.
//
//   node scripts/rentfarm-sales-compare.js --at=2026-01-31T04:00:00Z --days=7 \
//        --before=30:1.99,120:3 --after=30:2.49,120:3.99 --except="Albion Online"
//
// "Before" is the --days days up to --at; "after" runs from --at for --days
// days, or up to now when the test is still running — so both are also shown
// per day. A game named in --except kept the old ladder and is counted at it.
//
// Read-only: one find on FarmServiceOrder, no marketplace call. The order rows
// carry no price, so the money is the LIST price (before the market's fee and
// before any refund); cancelled and failed orders are left out and counted on
// their own line.
const { parseLadder, gameList } = require("./reprice-eldorado-farm");

const DAY = 864e5;
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const money = (n) => "$" + Number(n).toFixed(2);
const DEAD = ["cancelled", "failed"];

// Pure. `orders`: rows { createdAt, game, days, quantity, state }.
function compare(orders, { at, days, before, after, except = new Set(), now = Date.now() }) {
  const atMs = new Date(at).getTime();
  const span = days * DAY;
  const afterEnd = Math.min(now, atMs + span);
  const mk = (from, to) => ({ from, to, spanDays: Math.max(0, to - from) / DAY, accounts: 0, orders: 0, revenue: 0, unpriced: 0, dead: 0, byTerm: {}, byGame: {} });
  const out = { before: mk(atMs - span, atMs), after: mk(atMs, afterEnd) };
  for (const o of orders || []) {
    const t = new Date(o.createdAt).getTime();
    const w = t >= out.before.from && t < out.before.to ? out.before : t >= out.after.from && t < out.after.to ? out.after : null;
    if (!w) continue;
    const qty = Math.max(1, Number(o.quantity) || 1);
    if (DEAD.includes(o.state)) {
      w.dead += qty;
      continue;
    }
    const ladder = w === out.after && !except.has(norm(o.game)) ? after : before;
    const price = ladder.get(Number(o.days));
    w.orders += 1;
    w.accounts += qty;
    w.byTerm[o.days] = (w.byTerm[o.days] || 0) + qty;
    w.byGame[o.game || "?"] = (w.byGame[o.game || "?"] || 0) + qty;
    if (price === undefined) w.unpriced += qty;
    else w.revenue += qty * price;
  }
  for (const w of [out.before, out.after]) {
    w.revenue = Math.round(w.revenue * 100) / 100;
    w.accountsPerDay = w.spanDays > 0 ? w.accounts / w.spanDays : 0;
    w.revenuePerDay = w.spanDays > 0 ? w.revenue / w.spanDays : 0;
  }
  return out;
}

function lines(label, w) {
  const terms = Object.keys(w.byTerm).map(Number).sort((a, b) => a - b);
  const games = Object.entries(w.byGame).sort((a, b) => b[1] - a[1]);
  return [
    label + "  " + new Date(w.from).toISOString().slice(0, 16) + "Z → " + new Date(w.to).toISOString().slice(0, 16) + "Z  (" + w.spanDays.toFixed(1) + " days)",
    "  accounts " + w.accounts + " in " + w.orders + " order(s) — " + w.accountsPerDay.toFixed(1) + " a day",
    "  list revenue " + money(w.revenue) + " — " + money(w.revenuePerDay) + " a day" + (w.accounts ? ", " + money(w.revenue / w.accounts) + " an account" : ""),
    "  by term: " + (terms.map((t) => t + " d " + w.byTerm[t]).join(" · ") || "none"),
    "  by game: " + (games.slice(0, 12).map(([g, n]) => g + " " + n).join(", ") || "none") + (games.length > 12 ? ", …" : ""),
    ...(w.unpriced ? ["  no list price for " + w.unpriced + " account(s) (term not on the ladder) — not in the revenue"] : []),
    ...(w.dead ? ["  cancelled or failed, left out: " + w.dead + " account(s)"] : []),
  ];
}

// The one-line comparison, per day. A few hours of sales say nothing — one
// busy evening is a third of a day's orders — so under a day it says so.
function verdict(r) {
  if (!(r.before.accountsPerDay > 0)) return "nothing sold in the days before — nothing to compare against";
  if (r.after.spanDays < 1) return "under a day since the change — too early to compare";
  const pct = (a, b) => (b > 0 ? (a >= b ? "+" : "") + ((a / b - 1) * 100).toFixed(0) + " %" : "n/a");
  return "per day, after vs before: accounts " + pct(r.after.accountsPerDay, r.before.accountsPerDay) +
    " · list revenue " + pct(r.after.revenuePerDay, r.before.revenuePerDay);
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f, d = "") => {
    const hit = args.find((a) => a.startsWith("--" + f + "="));
    return hit ? hit.slice(f.length + 3) : d;
  };
  const at = new Date(val("at"));
  if (!val("at") || Number.isNaN(at.getTime())) throw new Error("--at is required: the moment the prices changed, e.g. --at=2026-01-31T04:00:00Z");
  const days = parseInt(val("days", "7"), 10) || 7;
  const before = parseLadder(val("before"), "--before");
  const after = parseLadder(val("after"), "--after");
  if (!before.size || !after.size) throw new Error("--before and --after are required (days:price, …)");
  const market = val("market", "eldorado");

  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const FarmServiceOrder = require("../models/FarmServiceOrder");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const orders = await FarmServiceOrder.find(
    // The oldest rows predate the `market` field; they were all Eldorado.
    { createdAt: { $gte: new Date(at.getTime() - days * DAY), $lt: new Date(at.getTime() + days * DAY) }, market: market === "eldorado" ? { $in: ["eldorado", null] } : market },
    { createdAt: 1, game: 1, days: 1, quantity: 1, state: 1 },
  ).lean();
  await mongoose.disconnect();

  const r = compare(orders, { at, days, before, after, except: gameList(val("except")) });
  console.log(market + " rent-farm, " + days + " days each side of " + at.toISOString().slice(0, 16) + "Z\n");
  console.log(lines("BEFORE", r.before).join("\n") + "\n");
  console.log(lines("AFTER ", r.after).join("\n") + "\n");
  console.log(verdict(r));
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}

module.exports = { compare, lines, verdict };
