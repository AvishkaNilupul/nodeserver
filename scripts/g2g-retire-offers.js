#!/usr/bin/env node
// Take named G2G bundle offers off the shelf for good: delist the offer, close
// its row, and hand back the accounts it was holding.
//
//   node scripts/g2g-retire-offers.js --ids=G1791...,G1790...
//   node scripts/g2g-retire-offers.js --file=ids.txt --why="duplicate of G179…" --apply
//
// Operator-instructed. It exists because the Listings "delist" button stops
// half-way for the auto-lister's G2G share: it delists the offer and closes the
// row, but the accounts reserved behind it stay reserved under the "g2g" tag —
// held for an offer that no longer exists, sellable nowhere.
//
// What it does to one offer, in this order:
//   1. delists it on G2G and reads the status back (a status change, not a
//      delete: the offer keeps its history and `g2gRelist` is the inverse);
//   2. closes the row — only if it is still active, so a change that landed in
//      between is never trampled;
//   3. releases the row's FREE units (set-scoped, "g2g" tag only) and takes them
//      off the row, so a later relist cannot advertise accounts it no longer
//      holds. A unit a buyer was sent stays exactly as it is.
//
// What it will not touch:
//   - a row that sells through its own layer — no-claim, account listing, bulk
//     pack (close those where they were made);
//   - a row with an order mid hand-over (a unit that carries an order id and no
//     message yet), or an offer G2G lists a paid order for;
//   - a row that has sold, unless --allow-sold: an offer with sales keeps its
//     place in G2G's ranking, which is the one thing a new offer cannot buy.
//
// Read-only until --apply.

const CLAIM_TAG = "g2g";

// Pure. A unit is free when nobody was ever sent it; "mid" when an order took
// it and the credential has not gone out yet.
function unitState(u) {
  if (!u) return "none";
  if (u.messagedAt || u.deliveredAt) return "sold";
  if (u.orderId) return "mid";
  return "free";
}

// Pure. What may be done with one row, and why not when nothing may.
// `pendingOfferIds`: offers G2G currently lists a paid order for.
function planRow(row, { allowSold = false, pendingOfferIds = new Set() } = {}) {
  const out = { id: row ? String(row.externalId || "") : "", title: row ? String(row.title || "") : "", action: "skip", why: "", free: [], sold: 0 };
  if (!row) return { ...out, why: "no listing row for this offer" };
  const units = row.units || [];
  out.free = units.filter((u) => unitState(u) === "free" && u.accountId).map((u) => String(u.accountId));
  out.sold = units.filter((u) => unitState(u) === "sold").length;
  if (row.marketplace !== "g2g") out.why = "not a G2G row";
  else if (row.status !== "active") out.why = "row is already " + row.status;
  else if (row.noclaimStock) out.why = "a no-claim listing — delist it on the Listings page, its own layer hands the accounts back";
  else if (row.accountOffer) out.why = "an account listing — delist it on the Listings page";
  else if (row.bulkOfferId) out.why = "a bulk pack — close it on the bulk packs page";
  else if (units.some((u) => unitState(u) === "mid")) out.why = "an order is mid hand-over on it";
  else if (pendingOfferIds.has(out.id)) out.why = "G2G lists a paid order for it";
  else if (out.sold && !allowSold) out.why = "it has sold " + out.sold + " — kept for its place in the ranking (--allow-sold to retire it anyway)";
  else out.action = "retire";
  return out;
}

// Retire the planned rows one at a time. `io` is { delist(id), status(id),
// closeRow(id, note), freshRow(id), release(accountIds, setId), pullUnits(id,
// accountIds), sleep(ms), log(line) } — the real calls in main(), fakes in
// tests/g2gRetireOffers.test.js.
async function retire(plans, io, { why = "", gapMs = 2500 } = {}) {
  const todo = plans.filter((p) => p.action === "retire");
  const out = { done: [], failed: [], released: 0, stopped: "" };
  let streak = 0;
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    try {
      await io.delist(p.id);
      const st = await io.status(p.id);
      if (st !== "delisted") throw new Error('G2G still shows it "' + st + '" after the delist');
      const closed = await io.closeRow(p.id, why);
      if (!closed) throw new Error("delisted on G2G, but the row was no longer active — left as it is, look at it by hand");
      // The units as they are NOW: a sale that landed after the plan was made
      // has turned one of them into the buyer's.
      const fresh = await io.freshRow(p.id);
      const free = ((fresh && fresh.units) || []).filter((u) => unitState(u) === "free" && u.accountId).map((u) => String(u.accountId));
      if (free.length) {
        await io.release(free, String(fresh.set));
        await io.pullUnits(p.id, free);
      }
      out.released += free.length;
      out.done.push({ ...p, released: free.length });
      streak = 0;
      io.log("  ✓ " + p.id + "  off the shelf" + (free.length ? ", " + free.length + " account(s) handed back" : "") + "  " + p.title);
    } catch (e) {
      out.failed.push({ ...p, error: String((e && e.message) || e) });
      io.log("  ✗ " + p.id + "  " + p.title + " — " + String((e && e.message) || e));
      if (++streak >= 3) {
        out.stopped = "3 failures in a row";
        break;
      }
    }
    if (i < todo.length - 1) await io.sleep(gapMs);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes("--" + f);
  const val = (f, d = "") => {
    const hit = args.find((a) => a.startsWith("--" + f + "="));
    return hit ? hit.slice(f.length + 3) : d;
  };
  const fs = require("fs");
  const ids = [
    ...new Set(
      (val("ids") + "," + (val("file") ? fs.readFileSync(val("file"), "utf8").replace(/\s+/g, ",") : ""))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) throw new Error("name the offers: --ids=G…,G… or --file=ids.txt");
  const apply = has("apply");
  const why = val("why", "retired by the operator");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const mp = require("../utils/marketplaces");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const { releaseSetForAccounts } = require("../utils/dropReservation");
  const { logEvent } = require("../utils/systemLog");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const pending = new Set();
  try {
    for (const o of await mp.g2gPendingOrders()) if (o && o.offerId) pending.add(String(o.offerId));
  } catch (e) {
    throw new Error("could not read G2G's paid orders (" + e.message + ") — nothing retired");
  }
  const plans = [];
  for (const id of ids) {
    const row = await MarketplaceListing.findOne({ marketplace: "g2g", externalId: id }).lean();
    plans.push({ ...planRow(row, { allowSold: has("allow-sold"), pendingOfferIds: pending }), id });
  }
  const todo = plans.filter((p) => p.action === "retire");
  console.log("offers named " + ids.length + " | to retire " + todo.length + " | left alone " + (plans.length - todo.length) +
    " | accounts to hand back " + todo.reduce((a, p) => a + p.free.length, 0));
  for (const p of todo) console.log("    " + p.id + "  " + (p.free.length ? String(p.free.length).padStart(2) + " held" : "       ") + "  " + p.title);
  for (const p of plans.filter((p) => p.action !== "retire")) console.log("  left alone — " + p.why + ": " + p.id + "  " + p.title);

  let out = { done: [], failed: [], released: 0, stopped: "" };
  if (!apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  } else if (todo.length) {
    console.log("");
    const note = " — retired " + new Date().toISOString().slice(0, 10) + ": " + why;
    out = await retire(
      plans,
      {
        delist: (id) => mp.g2gDelist(id),
        // G2G answers 404 "Data was not found" when asked for an offer that is
        // off sale, so a delisted offer cannot be read back by its id: the
        // account's delisted list is where it shows.
        status: async (id) => {
          try {
            return String(((await mp.g2gGetOffer(id)) || {}).status || "");
          } catch (e) {
            const off = await mp.g2gListOffers({ pageSize: 100, maxPages: 10, status: mp.G2G_STATUS.DELISTED });
            return off.some((o) => String(o.offerId) === String(id)) ? "delisted" : "unreadable (" + e.message + ")";
          }
        },
        closeRow: async (id) => {
          const row = await MarketplaceListing.findOne({ marketplace: "g2g", externalId: id, status: "active" }, { note: 1 }).lean();
          if (!row) return false;
          const r = await MarketplaceListing.updateOne(
            { _id: row._id, status: "active" },
            { $set: { status: "delisted", autoPaused: false, lastError: "", note: (String(row.note || "") + note).slice(0, 1000) } },
          );
          return r.modifiedCount === 1;
        },
        freshRow: (id) => MarketplaceListing.findOne({ marketplace: "g2g", externalId: id }, { units: 1, set: 1 }).lean(),
        release: (accountIds, setId) => releaseSetForAccounts(accountIds, setId, CLAIM_TAG),
        // Only units still free: the filter repeats the test, so a unit a sale
        // took in this very second is not pulled out from under it.
        pullUnits: (id, accountIds) =>
          MarketplaceListing.updateOne(
            { marketplace: "g2g", externalId: id },
            { $pull: { units: { accountId: { $in: accountIds }, orderId: { $in: ["", null] }, messagedAt: null, deliveredAt: null } } },
          ),
        sleep,
        log: (line) => console.log(line),
      },
      { why, gapMs: parseInt(val("gap", ""), 10) || 2500 },
    );
    console.log("\nretired " + out.done.length + " of " + todo.length + " | accounts handed back " + out.released +
      (out.failed.length ? " | NOT retired " + out.failed.length : "") + (out.stopped ? " | STOPPED: " + out.stopped : ""));
    await logEvent({
      category: "marketplace",
      action: "listing_retired",
      actor: val("actor", "g2g-retire-offers"),
      severity: out.failed.length ? "warn" : "info",
      subject: "g2g",
      count: out.done.length,
      detail: "operator retired " + out.done.length + " of " + todo.length + " g2g offer(s) (" + why + "); " + out.released +
        " reserved account(s) handed back" + (out.failed.length ? "; " + out.failed.length + " NOT retired" : ""),
    }).catch(() => {});
    // An order that slipped in between the first look and the delist.
    try {
      const late = (await mp.g2gPendingOrders()).filter((o) => o && out.done.some((d) => d.id === String(o.offerId)));
      if (late.length) console.log("  ⚠ G2G lists a paid order on " + late.map((o) => o.offerId).join(", ") + " — deliver it by hand");
    } catch {
      console.log("  note: G2G's paid orders could not be re-read after the run");
    }
  }
  if (val("out")) fs.writeFileSync(val("out"), JSON.stringify({ at: new Date().toISOString(), apply, why, plans, done: out.done, failed: out.failed }, null, 1));
  await mongoose.disconnect();
  return out.stopped ? 3 : out.failed.length ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}

module.exports = { unitState, planRow, retire, CLAIM_TAG };
