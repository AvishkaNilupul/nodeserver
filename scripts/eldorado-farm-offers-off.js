#!/usr/bin/env node
// Take the Eldorado rent-farm ("Automatic Farming") offers OFF SALE, or put
// back the ones a run took off.
//
//   node scripts/eldorado-farm-offers-off.js                        # dry run
//   node scripts/eldorado-farm-offers-off.js --apply --out=off.json # pause them
//   node scripts/eldorado-farm-offers-off.js --resume=off.json            # dry run
//   node scripts/eldorado-farm-offers-off.js --resume=off.json --apply    # back on sale
//
// Why it exists: Eldorado does not allow a service in an item category, and it
// reads a farming window as a service ("an actual item / account with the
// items ready" is what may be sold there). The owner, 2026-10-13: take every
// service listing down for now.
//
// It PAUSES, never deletes: a paused offer is off the market at once, keeps its
// id, price and sales history, and comes back with one call. Only offers that
// are Active are paused; the --out file names exactly those, so a later
// --resume cannot put back an offer that was paused on purpose before the run.
//
// What stays untouched: every offer that is not a farming window (the bundles,
// the account packs), and every window ALREADY SOLD — a paid order is still
// delivered and its account is still farmed (utils/eldoradoFarmService reads
// the order's title, not the offer's state).
//
// Nothing in the server puts a paused rent-farm offer back on sale: the
// keep-alive renews Active offers only, and the stock sync resumes only rows
// it paused itself (autoPaused), which no rent-farm offer is.
//
// It runs BESIDE the live server on the same Eldorado login, behind the three
// guards of scripts/reprice-eldorado-farm.js (never renews the login, never
// keeps a response cookie, cannot save settings). A "quota exceeded" answer or
// three failures in a row stop the run; it can simply be started again.
//
// Read-only until --apply.

const { installSessionGuards, isQuota, isLapse, gameOf } = require("./reprice-eldorado-farm");

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULTS = { gapMs: 1000, settleMs: 700, lapseWaitMs: 80000, lapseTries: 3 };
const WHY = "off sale: Eldorado does not allow a farming service in the item category";

// One row per rent-farm offer with what would be done to it. `farm` is
// { FARM_TITLE } from utils/eldoradoFarmService — the test a paid order goes
// through, so "service offer" means the same thing here as at delivery.
// `also` adds offers by id (a hand-made service offer with another title).
function buildPlan(offers, farm, { also = new Set() } = {}) {
  const rows = [];
  for (const raw of offers || []) {
    const o = (raw && raw.offer) || raw;
    if (!o || !o.id) continue;
    const title = String(o.offerTitle || "").trim();
    const id = String(o.id);
    if (!farm.FARM_TITLE.test(title) && !also.has(id)) continue;
    const state = String(o.offerState || "");
    const row = { id, title, game: gameOf(title), state, action: "skip", why: "" };
    if (state === "Active") row.action = "pause";
    else if (state === "Paused") row.action = "already";
    else row.why = "offer is " + (state || "in an unknown state");
    rows.push(row);
  }
  rows.sort((a, b) => a.game.localeCompare(b.game) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return rows;
}

// The offers a --resume puts back: the ones the named run paused, and only
// while they are still Paused (an offer closed or deleted since is left).
function buildResumePlan(offers, pausedIds) {
  const want = new Set((pausedIds || []).map(String));
  const rows = [];
  for (const raw of offers || []) {
    const o = (raw && raw.offer) || raw;
    if (!o || !o.id || !want.has(String(o.id))) continue;
    const title = String(o.offerTitle || "").trim();
    const state = String(o.offerState || "");
    const row = { id: String(o.id), title, game: gameOf(title), state, action: "skip", why: "" };
    if (state === "Paused") row.action = "resume";
    else if (state === "Active") row.action = "already";
    else row.why = "offer is " + (state || "in an unknown state");
    rows.push(row);
  }
  rows.sort((a, b) => a.game.localeCompare(b.game) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return rows;
}

// Do the plan's rows one at a time. `verb` is "pause" or "resume", `want` the
// state a read-back must show. `io` is { act(id), read(id), confirmed(row),
// sleep(ms), log(line) } — the real calls in main(), fakes in the test.
async function applyPlan(rows, verb, want, io, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const todo = rows.filter((r) => r.action === verb);
  const out = { done: [], failed: [], stopped: "", left: 0 };

  // One call, waiting out a lapsed token (this process may not renew it).
  const call = async (fn) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!isLapse(e) || isQuota(e)) throw e;
        if (attempt >= o.lapseTries) {
          e.sessionGone = true;
          throw e;
        }
        io.log("  … the login token lapsed; waiting " + Math.round(o.lapseWaitMs / 1000) + " s for the server to renew it");
        await io.sleep(o.lapseWaitMs);
      }
    }
  };

  let streak = 0;
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    let sent = false;
    try {
      await call(() => io.act(row.id));
      sent = true;
      await io.sleep(o.settleMs);
      const live = await call(() => io.read(row.id));
      const now = String((live && live.offerState) || "");
      if (now !== want) throw new Error("Eldorado still shows it " + (now || "in an unknown state"));
      await io.confirmed(row);
      out.done.push(row);
      streak = 0;
      io.log("  ✓ " + row.id.slice(0, 8) + "  " + want + "  " + row.title);
    } catch (e) {
      const msg = String((e && e.message) || e);
      out.failed.push({ ...row, error: (sent ? "sent, not confirmed: " : "") + msg });
      io.log("  ✗ " + row.id.slice(0, 8) + "  " + row.title + " — " + (sent ? "sent, not confirmed: " : "") + msg);
      if (isQuota(e)) out.stopped = "Eldorado answered 'quota exceeded'";
      else if (e && e.sessionGone) out.stopped = "the login token did not come back";
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
  const fs = require("fs");
  const args = process.argv.slice(2);
  const has = (f) => args.includes("--" + f);
  const val = (f, d = "") => {
    const hit = args.find((a) => a.startsWith("--" + f + "="));
    return hit ? hit.slice(f.length + 3) : d;
  };
  const apply = has("apply");
  const resumeFile = val("resume");
  const also = new Set(val("also").split(",").map((s) => s.trim()).filter(Boolean));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Guards first: utils/marketplaces takes hold of saveSettings as it loads.
  require("dotenv").config({ quiet: true });
  const seen = installSessionGuards();
  const mongoose = require("mongoose");
  const mp = require("../utils/marketplaces");
  const farm = require("../utils/eldoradoFarmService");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const { logEvent } = require("../utils/systemLog");

  const listAll = async () => {
    const offers = [];
    for (let page = 1; page <= 40; page++) {
      const r = await mp.eldoradoMyListings(page, 50);
      const results = (r && r.results) || [];
      for (const x of results) offers.push(x.offer || x);
      if (!results.length || page >= ((r && r.totalPages) || 1)) break;
      await sleep(800);
    }
    return offers;
  };

  const offers = await listAll();
  const byState = {};
  for (const o of offers) byState[o.offerState || "?"] = (byState[o.offerState || "?"] || 0) + 1;
  console.log("offers on the account " + offers.length + " — " + Object.entries(byState).map(([k, n]) => k + " " + n).join(", "));

  let verb = "pause";
  let want = "Paused";
  let rows;
  let others = [];
  if (resumeFile) {
    verb = "resume";
    want = "Active";
    const prior = JSON.parse(fs.readFileSync(resumeFile, "utf8"));
    rows = buildResumePlan(offers, prior.done || []);
    console.log("offers the run in " + resumeFile + " paused: " + (prior.done || []).length + " | found " + rows.length);
  } else {
    rows = buildPlan(offers, farm, { also });
    // Everything that is NOT a rent-farm offer, by title, so a service offer
    // with another wording is seen by a person before it is believed absent.
    const farmIds = new Set(rows.map((r) => r.id));
    others = offers
      .filter((o) => !farmIds.has(String(o.id)))
      .map((o) => ({ id: String(o.id), title: String(o.offerTitle || "").trim(), state: String(o.offerState || "") }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    if (has("others")) {
      console.log("\nnot rent-farm (left alone):");
      for (const o of others) console.log("  " + (o.state || "?").padEnd(7) + o.id.slice(0, 8) + "  " + o.title.slice(0, 150));
      console.log("");
    }
  }
  const todo = rows.filter((r) => r.action === verb);
  console.log("rent-farm offers " + rows.length + " | to " + verb + " " + todo.length +
    " | already " + want.toLowerCase() + " " + rows.filter((r) => r.action === "already").length +
    " | left alone " + rows.filter((r) => r.action === "skip").length);
  const games = new Map();
  for (const r of todo) games.set(r.game, (games.get(r.game) || 0) + 1);
  console.log("  " + [...games.entries()].map(([g, n]) => g + " ×" + n).join(" · "));
  for (const r of rows.filter((r) => r.action === "skip")) console.log("  left alone — " + r.why + ": " + r.title);

  let out = { done: [], failed: [], stopped: "", left: 0 };
  let stillWrong = [];
  if (!apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  } else if (todo.length) {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("");
    out = await applyPlan(
      rows,
      verb,
      want,
      {
        act: (id) => (verb === "pause" ? mp.eldoradoDelist(id) : mp.eldoradoRelist(id)),
        read: (id) => mp.eldoradoOffer(id),
        // The few rent-farm offers with a row of ours: keep it saying what
        // Eldorado now shows, so no health check reads it as drift.
        confirmed: (row) =>
          (verb === "pause"
            ? MarketplaceListing.updateOne(
                { marketplace: "eldorado", externalId: row.id, status: "active" },
                { $set: { status: "delisted", lastError: WHY } },
              )
            : MarketplaceListing.updateOne(
                { marketplace: "eldorado", externalId: row.id, status: "delisted", lastError: WHY },
                { $set: { status: "active", lastError: "" } },
              )
          ).catch(() => null),
        sleep,
        log: (line) => console.log(line),
      },
      { gapMs: parseInt(val("gap", ""), 10) || DEFAULTS.gapMs },
    );
    console.log("\n" + verb + "d " + out.done.length + " of " + todo.length +
      (out.failed.length ? " | NOT done " + out.failed.length : "") +
      (out.stopped ? " | STOPPED: " + out.stopped + " (" + out.left + " not tried)" : ""));

    // The whole account once more: what is on sale now is the result.
    if (!out.stopped) {
      await sleep(3000);
      const after = await listAll();
      const again = resumeFile ? buildResumePlan(after, out.done.map((r) => r.id)) : buildPlan(after, farm, { also });
      stillWrong = again.filter((r) => r.action === verb);
      console.log("read back: rent-farm offers still to " + verb + " — " + stillWrong.length);
      for (const r of stillWrong) console.log("  ! " + r.id + "  " + r.state + "  " + r.title);
    }
    await logEvent({
      category: "marketplace",
      action: verb === "pause" ? "listing_delisted" : "listing_relisted",
      actor: val("actor", "eldorado-farm-offers-off"),
      severity: out.failed.length || out.stopped || stillWrong.length ? "warn" : "info",
      subject: "eldorado",
      count: out.done.length,
      detail:
        "operator-instructed " + verb + " of " + out.done.length + " of " + todo.length + " eldorado rent-farm offer(s)" +
        (verb === "pause" ? " — " + WHY : "") +
        (out.failed.length ? "; " + out.failed.length + " NOT done" : "") +
        (out.stopped ? "; stopped: " + out.stopped : ""),
    }).catch(() => {});
    await mongoose.disconnect();
  }

  if (val("out")) {
    fs.writeFileSync(
      val("out"),
      JSON.stringify({ at: new Date().toISOString(), apply, verb, rows, others, done: out.done.map((r) => r.id), failed: out.failed, stopped: out.stopped, stillWrong: stillWrong.map((r) => r.id) }, null, 1),
    );
  }
  console.log("login guards: " + seen.refreshRefused + " renewal(s) refused, " + seen.cookiesDropped +
    " response cookie(s) dropped, " + seen.savesRefused + " settings save(s) refused");
  if (seen.savesRefused) console.log("  ⚠ a settings save was attempted and refused — tell the developer; the login was not touched");
  return out.stopped ? 3 : out.failed.length || stillWrong.length ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}

module.exports = { buildPlan, buildResumePlan, applyPlan, MAX_CONSECUTIVE_FAILURES, DEFAULTS, WHY };
