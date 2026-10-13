#!/usr/bin/env node
// Set the price ladder of the Eldorado rent-farm ("Automatic Farming") offers:
// one price per term, every game, in place.
//
//   node scripts/reprice-eldorado-farm.js --ladder=30:2.49,120:3.99,365:8.99
//   node scripts/reprice-eldorado-farm.js --ladder=… --expect=30:1.99,120:3,365:7 \
//        --only="Ragnarok Online" --limit=2 --apply            # two offers first
//   node scripts/reprice-eldorado-farm.js --ladder=… --expect=… --except="Albion Online" --apply
//
// Operator-instructed, never automatic. Nothing in the server reprices a
// rent-farm offer (reprice-eldorado-game.js and the unclaimed pricer both skip
// them), so the ladder moves only when the owner says so. To undo, run it again
// with the two ladders swapped.
//
// What it will not do:
//   - touch an offer the farm reads no term from: the title is what an order is
//     filled from, so the term is read with the farm's own parser;
//   - touch a bulk pack (priced per pack), or an offer that is not on sale;
//   - replace a price it did not expect (--expect): a price somebody set by
//     hand is reported, not overwritten. With --expect a new price more than
//     three times the old one (or under a third of it) is taken for a typo and
//     refused unless --force is given;
//   - count a write Eldorado does not show afterwards. The price call answers
//     with what it was SENT, so every write is read back and only a read-back
//     that agrees counts (the same rule as reprice-eldorado-game.js);
//   - keep knocking. A "quota exceeded" answer stops the run at once, and so do
//     three failures in a row: the live server delivers paid orders through the
//     same login. The run is in place and can simply be started again.
//
// It runs BESIDE the live server on the same Eldorado login, and that login must
// never be moved from here: a second process that renews the session, or writes
// back the cookies a response carried, can leave the server holding a dead one.
// So before the marketplace module is loaded (installSessionGuards):
//   1. any call to /authentication/refreshTokens is refused;
//   2. `set-cookie` is dropped from every eldorado.gg response;
//   3. this process cannot save settings at all.
// When the short-lived token lapses mid-run the call fails instead of renewing;
// the run waits for the server to renew it and tries that call again.
//
// Read-only until --apply.

const FARM_PACK = /\bPACK\s+OF\s+\d+\s+ACCOUNTS?\b/i;
const LIVE_STATES = ["Active", "Paused"];
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULTS = { gapMs: 1500, settleMs: 1000, lapseWaitMs: 80000, lapseTries: 3 };

const cents = (n) => Math.round(Number(n) * 100);
const money = (n) => "$" + Number(n).toFixed(2);

// "30:2.49,120:3.99" -> Map(30 => 2.49, 120 => 3.99). Throws on anything it
// cannot read: a ladder with a typo must not reprice half a catalogue.
function parseLadder(text, label = "--ladder") {
  const out = new Map();
  for (const part of String(text || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,4})\s*[:=]\s*(\d+(?:\.\d{1,2})?)$/);
    if (!m) throw new Error(label + ': cannot read "' + part + '" (want days:price, e.g. 120:3.99)');
    const days = parseInt(m[1], 10);
    const price = Number(m[2]);
    if (days < 1 || days > 730) throw new Error(label + ": " + days + " days is not a term (1..730)");
    if (!(price >= 0.5)) throw new Error(label + ": " + money(price) + " is under Eldorado's $0.50 minimum");
    if (out.has(days)) throw new Error(label + ": " + days + " days is given twice");
    out.set(days, price);
  }
  return out;
}

// A new price far from the one it replaces is far more likely a slipped
// decimal point than a decision. Returns what looks wrong, as text.
function ladderDoubts(ladder, expect) {
  const out = [];
  if (!expect) return out;
  for (const [days, to] of ladder) {
    const from = expect.get(days);
    if (from === undefined) continue;
    if (to > from * 3 || to < from / 3) out.push(days + " days: " + money(from) + " -> " + money(to));
  }
  return out;
}

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

function gameList(text) {
  return new Set(String(text || "").split(",").map(norm).filter(Boolean));
}

// The game as the title spells it: everything before "Twitch Drops".
function gameOf(title) {
  return String(title || "").split(/\s+Twitch\s+Drops\b/i)[0].trim();
}

// An offer's price in USD, or null when it cannot be told. Eldorado answers in
// the reader's currency next to the USD amount on some endpoints; a price in
// another currency with no USD figure beside it is never guessed at.
function usdOf(offer) {
  if (!offer) return null;
  const inUsd = offer.pricePerUnitInUSD;
  if (inUsd && Number.isFinite(Number(inUsd.amount))) return Number(inUsd.amount);
  const p = offer.pricePerUnit;
  if (p && Number.isFinite(Number(p.amount)) && (!p.currency || p.currency === "USD")) return Number(p.amount);
  return null;
}

// One row per offer, with what would be done to it and why not when nothing
// would. `farm` is { FARM_TITLE, termToDays } from utils/eldoradoFarmService —
// the parser a real order goes through. `limit` caps the offers repriced.
function buildPlan(offers, { ladder, expect = null, except = new Set(), only = new Set(), limit = 0 } = {}, farm) {
  const rows = [];
  for (const raw of offers || []) {
    const o = (raw && raw.offer) || raw;
    if (!o || !o.id) continue;
    const title = String(o.offerTitle || "").trim();
    if (!farm.FARM_TITLE.test(title)) continue;
    const row = { id: String(o.id), title, game: gameOf(title), days: 0, state: String(o.offerState || ""), from: usdOf(o), to: null, action: "skip", why: "" };
    rows.push(row);
    if (FARM_PACK.test(title)) row.why = "a bulk pack, priced per pack";
    else if (!row.game) row.why = "no game in the title";
    else if (only.size && !only.has(norm(row.game))) row.why = "not one of the games asked for";
    else if (except.has(norm(row.game))) row.why = "game left out on purpose";
    else if (!LIVE_STATES.includes(row.state)) row.why = "offer is " + (row.state || "in an unknown state");
    else {
      row.days = farm.termToDays(title);
      if (!row.days) row.why = "no term in the title";
      else if (!ladder.has(row.days)) row.why = "no price given for " + row.days + " days";
      else if (row.from === null) row.why = "current price could not be read";
      else {
        row.to = ladder.get(row.days);
        if (cents(row.from) === cents(row.to)) {
          row.action = "already";
        } else if (expect && (!expect.has(row.days) || cents(expect.get(row.days)) !== cents(row.from))) {
          row.why = "unexpected price " + money(row.from) +
            (expect.has(row.days) ? " (expected " + money(expect.get(row.days)) + ")" : " (no expected price for this term)");
        } else {
          row.action = "reprice";
        }
      }
    }
  }
  rows.sort((a, b) => a.game.localeCompare(b.game) || a.days - b.days || a.id.localeCompare(b.id));
  if (limit > 0) {
    let n = 0;
    for (const r of rows) {
      if (r.action !== "reprice") continue;
      if (++n > limit) {
        r.action = "skip";
        r.why = "over the --limit";
      }
    }
  }
  return rows;
}

const statusOf = (e) => (e && (e.status || (e.response && e.response.status))) || 0;
const isQuota = (e) => statusOf(e) === 429 || /HTTP 429|quota exceeded/i.test(String((e && e.message) || ""));
// The token lapsed and this process is not allowed to renew it.
const isLapse = (e) => statusOf(e) === 401 || /session refresh failed|HTTP 401/i.test(String((e && e.message) || ""));

// Reprice the plan's rows one at a time. `io` is { reprice(id, usd), read(id),
// confirmed(row, usd), sleep(ms), log(line) } — the real calls in main(), fakes
// in tests/repriceEldoradoFarm.test.js.
async function applyPlan(rows, io, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const todo = rows.filter((r) => r.action === "reprice");
  const out = { done: [], failed: [], stopped: "", left: 0 };

  // One call, waiting out a lapsed token. Anything else is the caller's.
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
    let wrote = false;
    try {
      await call(() => io.reprice(row.id, row.to));
      wrote = true;
      await io.sleep(o.settleMs);
      const live = await call(() => io.read(row.id));
      const now = usdOf(live);
      if (now === null) throw new Error("the price could not be read back");
      if (cents(now) !== cents(row.to)) throw new Error("Eldorado still shows " + money(now) + " after the write");
      await io.confirmed(row, now);
      out.done.push(row);
      streak = 0;
      io.log("  ✓ " + row.id.slice(0, 8) + "  " + money(row.from) + " -> " + money(now) + "  " + row.title);
    } catch (e) {
      const msg = String((e && e.message) || e);
      out.failed.push({ ...row, error: (wrote ? "sent, not confirmed: " : "") + msg });
      io.log("  ✗ " + row.id.slice(0, 8) + "  " + row.title + " — " + (wrote ? "sent, not confirmed: " : "") + msg);
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

// See the header. `deps` is for tests; the real ones are the process's own.
function installSessionGuards(deps = {}) {
  const axios = deps.axios || require("axios");
  const settings = deps.settings || require("../utils/settings");
  const seen = { refreshRefused: 0, cookiesDropped: 0, savesRefused: 0 };
  axios.interceptors.request.use((cfg) => {
    if (/authentication\/refreshTokens/i.test(String((cfg && cfg.url) || ""))) {
      seen.refreshRefused++;
      throw new Error("this script never renews the Eldorado login — the live server does");
    }
    return cfg;
  });
  axios.interceptors.response.use((res) => {
    const url = String((res && res.config && res.config.url) || "");
    const h = res && res.headers;
    if (h && /(^|\/\/|\.)eldorado\.gg(\/|:|$)/i.test(url) && h["set-cookie"] !== undefined) {
      if (typeof h.delete === "function") h.delete("set-cookie");
      delete h["set-cookie"];
      seen.cookiesDropped++;
    }
    return res;
  });
  settings.saveSettings = async () => {
    seen.savesRefused++;
  };
  return seen;
}

function summary(rows) {
  const by = new Map();
  for (const r of rows.filter((r) => r.action === "reprice")) {
    const k = r.days + "|" + cents(r.from) + "|" + cents(r.to);
    by.set(k, (by.get(k) || 0) + 1);
  }
  return [...by.entries()]
    .map(([k, n]) => {
      const [days, from, to] = k.split("|").map(Number);
      return { days, from: from / 100, to: to / 100, n };
    })
    .sort((a, b) => a.days - b.days || a.from - b.from);
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes("--" + f);
  const val = (f, d = "") => {
    const hit = args.find((a) => a.startsWith("--" + f + "="));
    return hit ? hit.slice(f.length + 3) : d;
  };
  const ladder = parseLadder(val("ladder"));
  if (!ladder.size) throw new Error("--ladder is required, e.g. --ladder=30:2.49,120:3.99");
  const expect = val("expect") ? parseLadder(val("expect"), "--expect") : null;
  const doubts = ladderDoubts(ladder, expect);
  if (doubts.length && !has("force"))
    throw new Error("that is a big jump — a typo? " + doubts.join("; ") + " (add --force if it is meant)");
  const apply = has("apply");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Guards first: utils/marketplaces takes hold of saveSettings as it loads.
  require("dotenv").config({ quiet: true });
  const seen = installSessionGuards();
  const mongoose = require("mongoose");
  const mp = require("../utils/marketplaces");
  const farm = require("../utils/eldoradoFarmService");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const { logEvent } = require("../utils/systemLog");

  const offers = [];
  for (let page = 1; page <= 40; page++) {
    const r = await mp.eldoradoMyListings(page, 50);
    const results = (r && r.results) || [];
    for (const x of results) offers.push(x.offer || x);
    if (!results.length || page >= ((r && r.totalPages) || 1)) break;
    await sleep(800);
  }

  const rows = buildPlan(
    offers,
    { ladder, expect, except: gameList(val("except")), only: gameList(val("only")), limit: parseInt(val("limit", "0"), 10) || 0 },
    farm,
  );
  const todo = rows.filter((r) => r.action === "reprice");
  console.log("offers on the account " + offers.length + " | rent-farm offers " + rows.length +
    " | to reprice " + todo.length + " | already there " + rows.filter((r) => r.action === "already").length +
    " | left alone " + rows.filter((r) => r.action === "skip").length);
  for (const s of summary(rows)) console.log("  " + String(s.days).padStart(3) + " days  " + money(s.from) + " -> " + money(s.to) + "   x" + s.n);
  const why = new Map();
  for (const r of rows.filter((r) => r.action === "skip")) why.set(r.why, (why.get(r.why) || []).concat(r));
  for (const [reason, list] of why) {
    console.log("  left alone — " + reason + ": " + list.length);
    for (const r of list.slice(0, 8)) console.log("      " + (r.from === null ? "$?" : money(r.from)).padEnd(7) + r.title);
    if (list.length > 8) console.log("      … and " + (list.length - 8) + " more");
  }

  let out = { done: [], failed: [], stopped: "", left: 0 };
  if (!apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  } else if (todo.length) {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("");
    out = await applyPlan(
      rows,
      {
        reprice: (id, usd) => mp.eldoradoReprice(id, usd),
        read: (id) => mp.eldoradoOffer(id),
        // Keep our own row (the few farm offers that have one) saying what
        // Eldorado now charges.
        confirmed: (row, usd) =>
          MarketplaceListing.updateOne({ marketplace: "eldorado", externalId: row.id }, { $set: { price: usd } }).catch(() => null),
        sleep,
        log: (line) => console.log(line),
      },
      { gapMs: parseInt(val("gap", ""), 10) || DEFAULTS.gapMs },
    );
    console.log("\nrepriced " + out.done.length + " of " + todo.length +
      (out.failed.length ? " | NOT applied " + out.failed.length : "") +
      (out.stopped ? " | STOPPED: " + out.stopped + " (" + out.left + " not tried)" : ""));
    await logEvent({
      category: "marketplace",
      action: "listing_repriced",
      actor: val("actor", "reprice-eldorado-farm"),
      severity: out.failed.length || out.stopped ? "warn" : "info",
      subject: "eldorado",
      count: out.done.length,
      detail:
        "operator-instructed reprice of " + out.done.length + " of " + todo.length + " eldorado rent-farm offer(s): " +
        summary(out.done).map((s) => s.days + " d " + money(s.from) + " -> " + money(s.to) + " x" + s.n).join(", ") +
        (out.failed.length ? "; " + out.failed.length + " NOT applied" : "") +
        (out.stopped ? "; stopped: " + out.stopped : ""),
    }).catch(() => {});
    await mongoose.disconnect();
  }

  if (val("out")) {
    require("fs").writeFileSync(
      val("out"),
      JSON.stringify({ at: new Date().toISOString(), apply, ladder: [...ladder], expect: expect ? [...expect] : null, rows, done: out.done.map((r) => r.id), failed: out.failed, stopped: out.stopped }, null, 1),
    );
  }
  console.log("login guards: " + seen.refreshRefused + " renewal(s) refused, " + seen.cookiesDropped +
    " response cookie(s) dropped, " + seen.savesRefused + " settings save(s) refused");
  if (seen.savesRefused) console.log("  ⚠ a settings save was attempted and refused — tell the developer; the login was not touched");
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

module.exports = { parseLadder, ladderDoubts, gameList, gameOf, usdOf, buildPlan, applyPlan, installSessionGuards, summary, isQuota, isLapse, MAX_CONSECUTIVE_FAILURES, DEFAULTS };
