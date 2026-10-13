#!/usr/bin/env node
// Set the price ladder — and, when asked, the advertised stock — of the G2G
// rent-farm ("Automatic Farming") offers, in place.
//
//   node scripts/reprice-g2g-farm.js --ladder=120:3.99,180:4.99,365:8.99
//   node scripts/reprice-g2g-farm.js --ladder=… --expect=120:3,180:4,365:7 --stock=20 \
//        --only="Hunt: Showdown 1896" --limit=1 --apply         # one offer first
//   node scripts/reprice-g2g-farm.js --ladder=… --expect=… --stock=20 --apply
//
// The G2G twin of scripts/reprice-eldorado-farm.js, built on its rules: which
// offers count as rent-farm, the term read with the farm's own parser, a price
// nobody expected reported instead of replaced (--expect), bulk packs and
// offers that are neither on sale nor delisted left alone, a typo-sized jump
// refused without --force. Operator-instructed, never automatic; to undo, run
// it again with the two ladders swapped.
//
// A run that would move a price needs --expect: the account also holds old
// hand-made farm offers, delisted at their own prices ($5, $6), and without it
// a stock top-up "repriced" one of them (2026-10-13; put back the same minute).
// To top up stock only, give the ladder as its own --expect.
//
// --stock=N tops an offer up to N. A farm offer has no listing row, so the
// stock sync never sees it and its quantity only goes down with sales; this is
// the one place it is raised. It never lowers a quantity.
//
// Every write is read back, and only a read-back that agrees counts: G2G
// answers 200 to writes that changed nothing (its create call returns an empty
// draft). A "quota" answer or three failures in a row stop the run — the live
// server ships paid orders through the same login.
//
// No session guard is needed here, unlike Eldorado: G2G's seller session is
// renewed from a refresh token that is not rotated, so a second process that
// renews the access token cannot strand the server's login.
//
// Read-only until --apply.
const { parseLadder, ladderDoubts, gameList, buildPlan, summary, isQuota, MAX_CONSECUTIVE_FAILURES } = require("./reprice-eldorado-farm");

const cents = (n) => Math.round(Number(n) * 100);
const money = (n) => "$" + Number(n).toFixed(2);
const DEFAULTS = { gapMs: 2500, settleMs: 1200 };

// A G2G offer in the shape the shared plan reads. "live" is on sale; a
// "delisted" offer is repriced too, so a relist does not bring an old price
// back. Any other status (a draft, a removed offer) is left alone.
function toPlanOffer(o) {
  const status = String((o && o.status) || "");
  return {
    id: String((o && o.offerId) || ""),
    offerTitle: String((o && o.title) || ""),
    offerState: status === "live" ? "Active" : status === "delisted" ? "Paused" : status || "unknown",
    pricePerUnit: { amount: Number(o && o.unitPrice), currency: (o && o.currency) || "USD" },
  };
}

// The shared plan, plus the stock top-up. A row is worked on when its price
// moves ("reprice") or only its stock does ("stock").
function planG2g(offers, { ladder, expect = null, except, only, limit = 0, stock = 0 } = {}, farm) {
  const byId = new Map((offers || []).map((o) => [String(o.offerId), o]));
  const rows = buildPlan((offers || []).map(toPlanOffer), { ladder, expect, except, only }, farm);
  let n = 0;
  for (const r of rows) {
    const o = byId.get(r.id) || {};
    r.stockFrom = Number.isFinite(Number(o.actualQty)) ? Number(o.actualQty) : null;
    r.stockTo = null;
    if (r.action === "skip") continue;
    if (stock > 0 && r.stockFrom !== null && r.stockFrom < stock) {
      r.stockTo = stock;
      if (r.action === "already") r.action = "stock";
    }
    if (r.action === "already") continue;
    if (limit > 0 && ++n > limit) {
      r.action = "skip";
      r.why = "over the --limit";
      r.stockTo = null;
    }
  }
  return rows;
}

// Pure. Why an --apply must not start, or "" when it may.
function refusal(rows, expect) {
  const priced = rows.filter((r) => r.action === "reprice").length;
  if (priced && !expect)
    return priced + " price(s) would change and no --expect was given — name the prices the offers have now " +
      "(for a stock-only top-up, give the ladder itself as --expect)";
  return "";
}

// One PUT per offer carrying whatever changes, then the read-back. `io` is
// { update(id, fields), read(id), sleep(ms), log(line) } — the real calls in
// main(), fakes in tests/repriceG2gFarm.test.js.
async function applyG2g(rows, io, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const todo = rows.filter((r) => r.action === "reprice" || r.action === "stock");
  const out = { done: [], failed: [], stopped: "", left: 0 };
  let streak = 0;
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    const fields = {};
    if (row.action === "reprice") fields.unitPrice = row.to;
    if (row.stockTo !== null) fields.stock = row.stockTo;
    let wrote = false;
    try {
      await io.update(row.id, fields);
      wrote = true;
      await io.sleep(o.settleMs);
      const back = await io.read(row.id);
      const currency = back && (back.offer_currency || back.currency);
      const price = back && currency === "USD" && Number.isFinite(Number(back.unit_price)) ? Number(back.unit_price) : null;
      if (price === null) throw new Error("the price could not be read back");
      if (cents(price) !== cents(row.to)) throw new Error("G2G still shows " + money(price) + " after the write");
      if (row.stockTo !== null && Number(back.actual_qty) !== row.stockTo)
        throw new Error("G2G still shows a stock of " + back.actual_qty + " after the write");
      out.done.push(row);
      streak = 0;
      io.log("  ✓ " + row.id + "  " + money(row.from) + " -> " + money(price) +
        (row.stockTo !== null ? "  stock " + row.stockFrom + " -> " + row.stockTo : "") + "  " + row.title);
    } catch (e) {
      const msg = (wrote ? "sent, not confirmed: " : "") + String((e && e.message) || e);
      out.failed.push({ ...row, error: msg });
      io.log("  ✗ " + row.id + "  " + row.title + " — " + msg);
      if (isQuota(e)) out.stopped = "G2G answered 'quota exceeded'";
      else if (++streak >= MAX_CONSECUTIVE_FAILURES) out.stopped = MAX_CONSECUTIVE_FAILURES + " failures in a row";
      if (out.stopped) {
        out.left = todo.length - i - 1;
        break;
      }
    }
    if (i < todo.length - 1) await io.sleep(o.gapMs);
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
  const ladder = parseLadder(val("ladder"));
  if (!ladder.size) throw new Error("--ladder is required, e.g. --ladder=120:3.99,365:8.99");
  const expect = val("expect") ? parseLadder(val("expect"), "--expect") : null;
  const doubts = ladderDoubts(ladder, expect);
  if (doubts.length && !has("force"))
    throw new Error("that is a big jump — a typo? " + doubts.join("; ") + " (add --force if it is meant)");
  const stock = parseInt(val("stock", "0"), 10) || 0;
  const apply = has("apply");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const mp = require("../utils/marketplaces");
  // The parser a real G2G order goes through (shared with PlayerAuctions).
  const farm = require("../utils/g2gFarmService");
  const pa = require("../utils/playerauctionsFarmService");
  const { logEvent } = require("../utils/systemLog");

  // The account's offer list answers with the offers on sale only, and without
  // their stored quantity. So: the delisted ones are asked for by name, and
  // when a stock is being set each rent-farm offer is read in full first.
  const offers = await mp.g2gListOffers({ pageSize: 100, maxPages: 10 });
  const seen = new Set(offers.map((o) => String(o.offerId)));
  const delisted = await mp.g2gListOffers({ pageSize: 100, maxPages: 10, status: mp.G2G_STATUS.DELISTED }).catch((e) => {
    console.log("note: the delisted offers could not be listed (" + e.message + ") — only offers on sale are covered");
    return [];
  });
  for (const o of delisted) if (!seen.has(String(o.offerId))) offers.push(o);
  if (stock > 0) {
    for (const o of offers.filter((o) => farm.FARM_TITLE.test(String(o.title || "")) && !Number.isFinite(Number(o.actualQty)))) {
      const full = await mp.g2gGetOffer(o.offerId).catch(() => null);
      if (full && Number.isFinite(Number(full.actual_qty))) o.actualQty = Number(full.actual_qty);
      await sleep(600);
    }
  }
  const rows = planG2g(
    offers,
    { ladder, expect, except: gameList(val("except")), only: gameList(val("only")), limit: parseInt(val("limit", "0"), 10) || 0, stock },
    { FARM_TITLE: farm.FARM_TITLE, termToDays: pa.termToDays },
  );
  const todo = rows.filter((r) => r.action === "reprice" || r.action === "stock");
  console.log("offers on the account " + offers.length + " (" + delisted.length + " delisted) | rent-farm offers " + rows.length +
    " | to change " + todo.length + " (price " + rows.filter((r) => r.action === "reprice").length +
    ", stock only " + rows.filter((r) => r.action === "stock").length + ")" +
    " | already there " + rows.filter((r) => r.action === "already").length +
    " | left alone " + rows.filter((r) => r.action === "skip").length);
  for (const s of summary(rows)) console.log("  " + String(s.days).padStart(3) + " days  " + money(s.from) + " -> " + money(s.to) + "   x" + s.n);
  if (stock) {
    const unknown = rows.filter((r) => r.action !== "skip" && r.stockFrom === null).length;
    console.log("  stock topped up to " + stock + " on " + rows.filter((r) => r.stockTo !== null).length + " offer(s)" +
      (unknown ? " — " + unknown + " offer(s) whose stock could not be read are left as they are" : ""));
  }
  for (const r of todo) console.log("    " + r.id + "  " + r.state.padEnd(6) + " " + money(r.from) + (r.action === "reprice" ? " -> " + money(r.to) : "         ") + (r.stockTo !== null ? "  stock " + r.stockFrom + " -> " + r.stockTo : "") + "  " + r.title);
  const why = new Map();
  for (const r of rows.filter((r) => r.action === "skip")) why.set(r.why, (why.get(r.why) || []).concat(r));
  for (const [reason, list] of why) {
    console.log("  left alone — " + reason + ": " + list.length);
    for (const r of list.slice(0, 8)) console.log("      " + (r.from === null ? "$?" : money(r.from)).padEnd(7) + r.title);
    if (list.length > 8) console.log("      … and " + (list.length - 8) + " more");
  }

  let out = { done: [], failed: [], stopped: "", left: 0 };
  const no = refusal(rows, expect);
  if (no) console.log("\n  ⚠ " + no);
  if (apply && no) throw new Error("not applied: " + no);
  if (!apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  } else if (todo.length) {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("");
    out = await applyG2g(
      rows,
      { update: (id, fields) => mp.g2gUpdateOffer(id, fields), read: (id) => mp.g2gGetOffer(id), sleep, log: (line) => console.log(line) },
      { gapMs: parseInt(val("gap", ""), 10) || DEFAULTS.gapMs },
    );
    console.log("\nchanged " + out.done.length + " of " + todo.length +
      (out.failed.length ? " | NOT applied " + out.failed.length : "") +
      (out.stopped ? " | STOPPED: " + out.stopped + " (" + out.left + " not tried)" : ""));
    await logEvent({
      category: "marketplace",
      action: "listing_repriced",
      actor: val("actor", "reprice-g2g-farm"),
      severity: out.failed.length || out.stopped ? "warn" : "info",
      subject: "g2g",
      count: out.done.length,
      detail:
        "operator-instructed change of " + out.done.length + " of " + todo.length + " g2g rent-farm offer(s): " +
        (summary(out.done).map((s) => s.days + " d " + money(s.from) + " -> " + money(s.to) + " x" + s.n).join(", ") || "no price moved") +
        (stock ? "; stock topped up to " + stock + " on " + out.done.filter((r) => r.stockTo !== null).length : "") +
        (out.failed.length ? "; " + out.failed.length + " NOT applied" : "") +
        (out.stopped ? "; stopped: " + out.stopped : ""),
    }).catch(() => {});
    await mongoose.disconnect();
  }

  if (val("out")) {
    require("fs").writeFileSync(
      val("out"),
      JSON.stringify({ at: new Date().toISOString(), apply, ladder: [...ladder], expect: expect ? [...expect] : null, stock, rows, done: out.done.map((r) => r.id), failed: out.failed, stopped: out.stopped }, null, 1),
    );
  }
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

module.exports = { toPlanOffer, planG2g, applyG2g, refusal, DEFAULTS };
