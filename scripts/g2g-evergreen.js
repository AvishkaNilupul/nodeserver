#!/usr/bin/env node
// The G2G bundle shelf, game by game: what the evergreen rules would do to it,
// and — with --apply — doing it.
//
//   node scripts/g2g-evergreen.js                       # the plan, every game
//   node scripts/g2g-evergreen.js --games="Halo Infinite,Rust" --publish
//   node scripts/g2g-evergreen.js --add=Rust --publish   # every game + Rust
//   node scripts/g2g-evergreen.js --only=retire --apply --out=run.json
//
// Operator-instructed. The rules live in utils/g2gEvergreen.js (read its
// header first); the server runs one of them by itself — "rescue" — after
// every stock sync when autoFarm.g2gEvergreen is on. This runs them all:
//
//   rescue    an offer that has sold and ran out moves to the biggest bundle
//             of its game we can still deliver
//   keep      the biggest bundle we can deliver stays on the shelf
//   retire    every other never-sold offer comes down (they hold no accounts)
//   upgrade   (only with --upgrade) the game's best-selling offer moves up to
//             a bigger bundle that holds everything it sells now — it changes
//             what a SELLING offer sells, so it is never a default
//   publish   (only with --publish) a game whose biggest bundle has no offer
//             gets one. A game with no offer at all must be named: --games=
//             plans only the games it names, --add= plans them as well.
//
// --price="Rust:1" sets what a bundle PUBLISHED for that game goes up at. A
// rewritten offer takes the bundle's own price and never costs more than it
// did (see the header).
// Read-only until --apply. Every write is read back from G2G.

const STEPS = ["rescue", "upgrade", "keep", "retire", "publish"];

function parseArgs(argv) {
  const has = (f) => argv.includes("--" + f);
  const val = (f, d = "") => {
    const hit = argv.find((a) => a.startsWith("--" + f + "="));
    return hit ? hit.slice(f.length + 3) : d;
  };
  const list = (s) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const only = list(val("only"));
  const bad = only.filter((s) => !STEPS.includes(s));
  if (bad.length) throw new Error("unknown step in --only: " + bad.join(", ") + " (steps: " + STEPS.join(", ") + ")");
  const step = (s) => (only.length ? only.includes(s) : true);
  const prices = new Map();
  for (const pair of list(val("price"))) {
    const i = pair.lastIndexOf(":");
    const usd = Number(pair.slice(i + 1));
    if (i < 1 || !(usd > 0)) throw new Error('--price wants "Game:USD", got "' + pair + '"');
    prices.set(pair.slice(0, i).trim().toLowerCase(), usd);
  }
  return {
    apply: has("apply"),
    games: list(val("games")),
    add: list(val("add")),
    steps: {
      rescue: step("rescue"),
      keepBest: step("keep"),
      retire: step("retire"),
      // Changing what a selling offer sells, and making a new offer, are never
      // defaults: --upgrade / --publish, or named in --only.
      upgrade: only.length ? only.includes("upgrade") : has("upgrade"),
      publish: only.length ? only.includes("publish") : has("publish"),
    },
    prices,
    // Left out, the engine's own minimum applies (MIN_STOCK).
    minStock: parseInt(val("min-stock", ""), 10) >= 1 ? parseInt(val("min-stock", ""), 10) : undefined,
    limit: parseInt(val("limit", ""), 10) || 0,
    gapMs: parseInt(val("gap", ""), 10) || 2500,
    out: val("out"),
    actor: val("actor", "g2g-evergreen"),
  };
}

// One line per action, for the plan and for the log.
function describe(a, titleOf = () => "") {
  if (a.type === "rewrite") {
    return (
      a.kind.toUpperCase().padEnd(8) + a.offerId + "  " + a.fromTitle + " $" + a.fromPrice + "\n" +
      "           -> " + (a.title || titleOf(a.toSet)) + " $" + a.price + "  (" + a.size + " items, " + a.stock + " accounts)" +
      (a.absorb ? "\n           takes over the bundle of " + a.absorb + ", which comes down" : "")
    );
  }
  if (a.type === "publish") return "PUBLISH  " + titleOf(a.toSet) + " $" + a.price + "  (" + a.size + " items, " + a.stock + " accounts)";
  return "RETIRE   " + a.offerId + "  " + (a.title || "") + " — " + a.why;
}

// Our rows against G2G's live list, both ways. Read-only.
//   - a row that says "on sale" must be live there; one the sync paused must not;
//   - a live offer whose row is closed is on sale with nothing watching it.
// (A live offer with no row at all is a rent-farm offer or one made by hand.)
async function auditShelf(d, MarketplaceListing) {
  const rows = await MarketplaceListing.find({ marketplace: "g2g" }, { externalId: 1, title: 1, autoPaused: 1, status: 1, lastError: 1 }).lean();
  const liveList = await d.mp.g2gListOffers({ pageSize: 100, maxPages: 10 });
  const live = new Set(liveList.map((o) => String(o.offerId)));
  const wrong = [];
  let active = 0;
  for (const r of rows) {
    const isLive = live.has(String(r.externalId));
    if (r.status === "active") {
      active++;
      if (!r.autoPaused && !isLive) wrong.push({ offerId: r.externalId, title: r.title, why: "our row says on sale, G2G does not list it live" });
      if (r.autoPaused && isLive) wrong.push({ offerId: r.externalId, title: r.title, why: "our row says paused, G2G lists it live" });
    } else if (isLive) {
      wrong.push({ offerId: r.externalId, title: r.title, why: "LIVE on G2G while our row is " + r.status + " — nothing watches its stock" });
    }
    if (r.status === "delisted" && String(r.lastError || "").startsWith("evergreen:")) {
      wrong.push({ offerId: r.externalId, title: r.title, why: "closed by a rewrite: " + r.lastError });
    }
  }
  return { rows: active, live: live.size, wrong };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const fs = require("fs");
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const eg = require("../utils/g2gEvergreen");
  const settings = require("../utils/settings");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const { logEvent } = require("../utils/systemLog");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const d = eg.realDeps();
  const now = Date.now();

  // Rescues are the server's once its switch is on: two writers of one offer
  // is the one thing every rule here is built to avoid.
  const af = settings.getAutoFarm() || {};
  if (o.apply && af.g2gEvergreen === true && o.steps.rescue) {
    console.log("note: autoFarm.g2gEvergreen is ON — the server does the rescues; this run leaves them to it.\n");
    o.steps.rescue = false;
  }

  // An offer put on sale — rewritten or published — has to be delivered and
  // kept in step with stock, by the server. Taking offers down needs neither.
  if (o.apply && !eg.g2gIsLive(d) && (o.steps.rescue || o.steps.upgrade || o.steps.publish)) {
    console.log("note: G2G delivery or its stock sync is not live — nothing is rewritten or published in this run.\n");
    o.steps.rescue = o.steps.upgrade = o.steps.publish = false;
  }

  const games = await eg.readShelf(d, now);
  for (const name of [...o.games, ...o.add]) {
    const brand = d.brandForGame(name);
    if (!brand) throw new Error('"' + name + '" has no G2G brand (utils/g2gGames.js)');
    const key = String(brand.brandId);
    if (!games.has(key)) games.set(key, { brandId: key, game: name, labels: new Set([name]), rows: [], docs: new Map(), sets: new Map() });
  }
  const wanted = o.games.length ? new Set(o.games.map((n) => String(d.brandForGame(n).brandId))) : null;
  const listed = await d.listedLogins();

  const plans = [];
  for (const g of [...games.values()].sort((a, b) => a.game.localeCompare(b.game))) {
    if (wanted && !wanted.has(g.brandId)) continue;
    const p = await eg.planFor(d, g, {
      steps: o.steps,
      listed,
      now,
      publishPrice: o.prices.get(g.game.toLowerCase()),
      minStock: o.minStock,
    });
    plans.push({ g, ...p });
    const titleOf = (setId) => {
      const s = p.setsById.get(String(setId));
      return s ? d.text(s, eg.setGame(s)).title : "set " + setId;
    };
    const acts = new Set(p.plan.actions.filter((a) => a.offerId).map((a) => a.offerId));
    for (const a of p.plan.actions) if (a.absorb) acts.add(a.absorb);
    console.log("\n== " + g.game + " — " + g.rows.length + " offer(s) now, " + p.candidates.length + " bundle(s) we could move to");
    for (const r of g.rows.filter((r) => !acts.has(r.offerId))) {
      console.log(
        "  keep     " + r.offerId + "  " + r.title.slice(0, 80) + " $" + r.price +
          "  [" + r.shape + (r.sold ? ", sold " + r.sold : "") + (r.paused ? ", OFF SALE" : "") + "]",
      );
    }
    for (const a of p.plan.actions) console.log("  " + describe(a, titleOf).replace(/\n/g, "\n  "));
    for (const n of p.plan.notes) console.log("  note     " + (n.offerId ? n.offerId + "  " : "") + n.why);
  }

  const all = plans.flatMap((p) => p.plan.actions);
  const count = (t) => all.filter((a) => a.type === t).length;
  const before = [...games.values()].filter((g) => !wanted || wanted.has(g.brandId)).reduce((a, g) => a + g.rows.length, 0);
  console.log(
    "\noffers now " + before + " | rewrite " + count("rewrite") + " | retire " + (count("retire") + all.filter((a) => a.absorb).length) +
      " | publish " + count("publish") + " | offers after " + (before - count("retire") - all.filter((a) => a.absorb).length + count("publish")),
  );

  const run = { rewritten: [], retired: [], published: [], skipped: [], errors: [], parked: [], recovered: [] };
  let audit = null;
  if (!o.apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  } else if (all.length) {
    console.log("");
    // A rewrite that an earlier run or the server left half done comes first.
    run.recovered = await eg.recoverParked(d, Date.now());
    for (const r of run.recovered) console.log("  " + (r.reopened ? "reopened " : "STILL CLOSED ") + r.offerId + ": " + r.why);
    // Read once for the retires; a rewrite reads its own, at the last moment.
    const paid = await eg.paidOffers(d);
    let left = o.limit || Infinity;
    let streak = 0;
    for (const p of plans) {
      if (left <= 0) break;
      const acts = p.plan.actions.slice(0, left);
      if (!acts.length) continue;
      left -= acts.length;
      // One game's plan is one piece (runActions stops it when a step fails).
      const r = await eg.runActions(d, acts, p.setsById, { paid, listed, now: Date.now(), minStock: o.minStock, gapMs: o.gapMs }, { log: (l) => console.log("  " + l) });
      for (const k of ["rewritten", "retired", "published", "skipped", "errors", "parked"]) run[k].push(...r[k].map((x) => ({ game: p.g.game, ...x })));
      if (r.parked.length) {
        console.log("\nSTOPPED: an offer was left closed — look at it on G2G before anything else is run");
        break;
      }
      streak = r.errors.length ? streak + 1 : 0;
      if (streak >= 3) {
        console.log("\nSTOPPED: 3 games in a row with a failure");
        break;
      }
    }
    console.log(
      "\nrewritten " + run.rewritten.length + " | retired " + run.retired.length + " | published " + run.published.length +
        " | skipped " + run.skipped.length + " | FAILED " + run.errors.length,
    );
    await logEvent({
      category: "marketplace",
      action: "g2g_evergreen_run",
      actor: o.actor,
      severity: run.errors.length ? "warn" : "info",
      subject: "g2g",
      count: run.rewritten.length + run.retired.length + run.published.length,
      detail:
        "operator ran the G2G evergreen plan: " + run.rewritten.length + " offer(s) rewritten in place, " + run.retired.length +
        " retired, " + run.published.length + " published" + (run.errors.length ? "; " + run.errors.length + " FAILED" : ""),
    }).catch(() => {});
    // An order that slipped in between the first look and a delist is still
    // delivered (delivery finds the row whatever its status) — it is said here
    // so nobody is surprised by a sale on an offer that just came down.
    try {
      const gone = new Set(run.retired.map((r) => String(r.offerId)));
      const late = (await d.mp.g2gPendingOrders()).filter((x) => x && gone.has(String(x.offerId)));
      if (late.length) console.log("  ⚠ G2G lists a paid order on " + late.map((x) => x.offerId).join(", ") + " — watch that it is delivered");
    } catch {
      console.log("  note: G2G's paid orders could not be re-read after the run");
    }
    // G2G's lists trail a change by a few seconds.
    await d.sleep(8000);
    audit = await auditShelf(d, MarketplaceListing);
    console.log("\nshelf check: " + audit.rows + " active row(s), " + audit.live + " live on G2G (rent-farm offers included), " + audit.wrong.length + " that disagree");
    for (const w of audit.wrong) console.log("  ⚠ " + w.offerId + "  " + w.why + "  " + String(w.title).slice(0, 70));
  }
  if (o.out) {
    fs.writeFileSync(
      o.out,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          apply: o.apply,
          steps: o.steps,
          plans: plans.map((p) => ({ game: p.g.game, offers: p.g.rows.length, actions: p.plan.actions, notes: p.plan.notes })),
          run,
          audit,
        },
        null,
        1,
      ),
    );
  }
  await mongoose.disconnect();
  return run.errors.length ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("ERR", e.message);
      process.exit(1);
    });
}

module.exports = { parseArgs, describe, auditShelf, STEPS };
