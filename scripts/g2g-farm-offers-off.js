#!/usr/bin/env node
// Take the G2G rent-farm ("Automatic Farming") offers OFF SALE, or put back the
// ones a run took off.
//
//   node scripts/g2g-farm-offers-off.js                          # dry run
//   node scripts/g2g-farm-offers-off.js --apply --out=off.json   # delist them
//   node scripts/g2g-farm-offers-off.js --relist=off.json          # dry run
//   node scripts/g2g-farm-offers-off.js --relist=off.json --apply  # back on sale
//
// Why it exists: G2G's Items rules ask for every listing to sit under the right
// service type and not to list a service as an item; the matching type for a
// farming window is Boosting. Eldorado suspended the account on 2026-10-13 for
// the same product. The owner, 2026-10-14: take the G2G farm offers off sale
// until G2G says which category they belong in.
//
// It DELISTS, never deletes: a delisted G2G offer keeps its id, price, stock
// and sales history, and comes back with one status write (g2gRelist). Only
// offers ON SALE are taken off; the --out file names exactly those, so a later
// --relist cannot put back an offer that was delisted on purpose before the run
// (the 15 old hand-made "Automatic farming 180 days" offers at $5 are).
//
// What stays untouched: every offer that is not a farming window (the bundles,
// the hand-made "Custom order"), and every window ALREADY SOLD — a paid order is
// still delivered (utils/g2gFarmService reads the order, not the offer's state).
//
// Nothing in the server puts a delisted farm offer back on sale: a farm offer
// has no listing row, and the stock sync, the evergreen pass and the bulk-pack
// loop relist only rows they track.
//
// G2G's offer lists trail a status change by a few seconds, so the read-back
// asks again a few times before it calls an offer missing. Three failures in a
// row, or a 429, stop the run; it can simply be started again.
//
// Read-only until --apply.

// The test a paid order goes through in utils/g2gFarmService (FARM_TITLE), so
// "farm offer" means the same thing here as at delivery.
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULTS = { gapMs: 1500, readTries: 5, readWaitMs: 8000 };

function gameOf(title) {
  const m = String(title || "").match(/^(.*?)\s+Twitch Drops\s+Automatic\s+Farming\b/i);
  return m ? m[1].trim() : "";
}

// One row per farm offer ON SALE. `offers` = mp.g2gListOffers() rows (that
// list holds offers on sale only); `also` adds offers by id.
function buildPlan(offers, { also = new Set() } = {}) {
  const rows = [];
  for (const o of offers || []) {
    if (!o || !o.offerId) continue;
    const id = String(o.offerId);
    const title = String(o.title || "").trim();
    if (!FARM_TITLE.test(title) && !also.has(id)) continue;
    rows.push({
      id,
      title,
      game: gameOf(title),
      price: o.unitPrice,
      stock: o.actualQty,
      status: String(o.status || ""),
      action: "delist",
    });
  }
  return rows;
}

function isRateLimited(e) {
  return !!e && (e.status === 429 || /\(HTTP 429\)|too many requests/i.test(String(e.message || "")));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask G2G's list `listFn` up to `tries` times until every id in `ids` is in it.
async function readBack(listFn, ids, { tries, waitMs }) {
  let seen = new Set();
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(waitMs);
    const rows = await listFn();
    seen = new Set(rows.map((r) => String(r.offerId)));
    if (ids.every((id) => seen.has(id))) break;
  }
  return { present: ids.filter((id) => seen.has(id)), missing: ids.filter((id) => !seen.has(id)) };
}

// Run one status write per offer. `write(id)` throws on failure.
async function runWrites(ids, write, { gapMs, log = () => {} } = {}) {
  const out = { done: [], failed: [], stopped: "" };
  let streak = 0;
  for (const id of ids) {
    try {
      await write(id);
      out.done.push(id);
      streak = 0;
      log("  ✓ " + id);
    } catch (e) {
      out.failed.push({ id, error: String((e && e.message) || e).slice(0, 300) });
      log("  ✗ " + id + "  " + String((e && e.message) || e).slice(0, 160));
      if (isRateLimited(e)) { out.stopped = "G2G answered 429"; break; }
      if (++streak >= MAX_CONSECUTIVE_FAILURES) { out.stopped = MAX_CONSECUTIVE_FAILURES + " failures in a row"; break; }
    }
    if (gapMs) await sleep(gapMs);
  }
  return out;
}

async function main(argv) {
  require("dotenv").config({ quiet: true });
  const fs = require("fs");
  const mp = require("../utils/marketplaces");
  const arg = (name) => {
    const hit = argv.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
    if (!hit) return null;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
  };
  const apply = !!arg("apply");
  const outFile = arg("out");
  const relistFile = arg("relist");
  const also = new Set(String(arg("also") || "").split(",").map((s) => s.trim()).filter(Boolean));
  const o = { ...DEFAULTS };
  const log = (s) => console.log(s);
  const live = () => mp.g2gListOffers({ pageSize: 100, maxPages: 5 });
  const delisted = () => mp.g2gListOffers({ pageSize: 100, maxPages: 5, status: "delisted" });

  if (relistFile && relistFile !== true) {
    const rec = JSON.parse(fs.readFileSync(relistFile, "utf8"));
    const ids = (rec.done || []).map(String);
    log("relist " + ids.length + " offer(s) from " + relistFile + (apply ? "" : "  (dry run)"));
    if (!apply || !ids.length) return;
    const res = await runWrites(ids, (id) => mp.g2gRelist(id), { gapMs: o.gapMs, log });
    const rb = await readBack(live, res.done, { tries: o.readTries, waitMs: o.readWaitMs });
    log(JSON.stringify({ relisted: res.done.length, failed: res.failed.length, stopped: res.stopped, onSaleNow: rb.present.length, notSeenOnSale: rb.missing }));
    return;
  }

  const plan = buildPlan(await live(), { also });
  const byGame = {};
  for (const r of plan) byGame[r.game || "?"] = (byGame[r.game || "?"] || 0) + 1;
  log("farm offers on sale: " + plan.length + "  " + JSON.stringify(byGame) + (apply ? "" : "  (dry run)"));
  for (const r of plan) log("  " + r.id + "  $" + r.price + "  x" + r.stock + "  " + r.title);
  const record = { at: new Date().toISOString(), apply, plan, done: [], failed: [], stopped: "" };
  const save = () => outFile && outFile !== true && fs.writeFileSync(outFile, JSON.stringify(record, null, 1));
  save();
  if (!apply || !plan.length) return;

  const res = await runWrites(plan.map((r) => r.id), (id) => mp.g2gDelist(id), { gapMs: o.gapMs, log });
  Object.assign(record, res);
  save();
  const off = await readBack(delisted, res.done, { tries: o.readTries, waitMs: o.readWaitMs });
  const stillLive = buildPlan(await live(), { also }).map((r) => r.id);
  record.readBack = { delistedSeen: off.present.length, notSeenDelisted: off.missing, farmOffersStillOnSale: stillLive };
  save();
  log(JSON.stringify({ delisted: res.done.length, failed: res.failed.length, stopped: res.stopped, ...record.readBack }));
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => setTimeout(() => process.exit(0), 200))
    .catch((e) => { console.error("ERR", (e && e.stack) || e); process.exit(1); });
}

module.exports = { FARM_TITLE, gameOf, buildPlan, runWrites, readBack, isRateLimited };
