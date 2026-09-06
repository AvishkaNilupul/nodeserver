#!/usr/bin/env node
// Free a game's unclaimed accounts from some marketplaces for MANUAL bulk sale.
//
//   node scripts/free-unclaimed-market.js --game=overwatch --markets=ggsel,digiseller [--cap=25] [--apply]
//
// What it does (dry-run unless --apply):
//   1. pauses the unclaimed auto-list engine (awaited; resumed in `finally`),
//   2. delists every ACTIVE origin:"unclaimed" row of that game on the given
//      marketplaces (platform delist + row status "delisted"),
//   3. parks those rows' listed ledgers as status "skipped" with a note — the
//      accounts KEEP their drops and keep farming; they are now the "held"
//      manual bulk-sale stock (Bundles panel "held" count, export-creds),
//   4. writes settings so the engine does not re-attach them:
//      unclaimedGameMarkets[game] = the markets NOT freed (e.g. ["gameflip"]),
//      unclaimedGameCaps[game]   = --cap, else (gameflip ledgers left + 2),
//   5. resumes the engine and VERIFIES unclaimedAutoListPaused === false.
// Pool / WebBotAccount rows are never touched. Gameflip rows are never
// touched unless "gameflip" is in --markets.
require("dotenv").config();
const mongoose = require("mongoose");
const settings = require("../utils/settings");
const mp = require("../utils/marketplaces");
const engine = require("../utils/unclaimedAutoList");
const { logEvent } = require("../utils/systemLog");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);
const APPLY = !!args.apply;
const GAME = String(args.game || "").trim();
const MARKETS = String(args.markets || "")
  .split(/[,\s]+/)
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);
const CAP = args.cap ? parseInt(args.cap, 10) : 0;
const log = (...a) => console.log(...a);

if (!GAME || !MARKETS.length) {
  console.error("usage: --game=<name> --markets=ggsel,digiseller [--cap=N] [--apply]");
  process.exit(2);
}
for (const m of MARKETS) {
  if (!settings.UNCLAIMED_MARKETS.includes(m)) {
    console.error("unknown market: " + m);
    process.exit(2);
  }
}

const sameGame = (g) => settings.normGameName(g).includes(settings.normGameName(GAME));

async function delistRow(row) {
  if (row.marketplace === "gameflip") return mp.gameflipDelist(row.externalId);
  if (row.marketplace === "digiseller") return mp.digisellerDelist(row.externalId);
  if (row.marketplace === "ggsel") return mp.ggselDelist(row.externalId);
  throw new Error("unsupported market " + row.marketplace);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { rows: 0, delisted: 0, delistErrors: 0, ledgersParked: 0, paused: false };
  const before = settings.getAutoFarm();
  out.paused = !!before.unclaimedAutoListPaused;
  if (APPLY && !out.paused) {
    await settings.setAutoFarm({ unclaimedAutoListPaused: true });
    log("engine paused");
  }
  try {
    // Candidate rows: active unclaimed rows on the freed markets whose set is
    // the game's (via its listed ledgers), plus a title safety net.
    const ledgers = await UnclaimedAccount.find(
      { status: "listed", market: { $in: MARKETS } },
      { game: 1, set: 1, market: 1, login: 1, loginLower: 1, source: 1, poolAccountId: 1, webBotAccountId: 1 },
    ).lean();
    const mine = ledgers.filter((l) => sameGame(l.game));
    const setIds = [...new Set(mine.map((l) => String(l.set)).filter(Boolean))];
    const titleRe = new RegExp(settings.normGameName(GAME).split(" ").join("\\s*"), "i");
    const rows = await MarketplaceListing.find({
      origin: "unclaimed",
      status: "active",
      marketplace: { $in: MARKETS },
      $or: [{ set: { $in: setIds } }, { title: titleRe }],
    }).lean();
    // Title-matched rows must still be the game's (set coverGame check).
    const sets = await DropSet.find({ _id: { $in: rows.map((r) => r.set) } }, { coverGame: 1, name: 1, items: 1 }).lean();
    const setById = new Map(sets.map((s) => [String(s._id), s]));
    const target = rows.filter((r) => {
      const s = setById.get(String(r.set));
      const g = (s && (s.coverGame || (s.items && s.items[0] && s.items[0].game))) || "";
      return setIds.includes(String(r.set)) || sameGame(g) || titleRe.test(r.title || "");
    });
    out.rows = target.length;
    log(`game=${GAME} markets=${MARKETS.join(",")} apply=${APPLY}`);
    log(`ledgers listed on those markets for the game: ${mine.length}; active rows to delist: ${target.length}`);
    for (const r of target) {
      const units = (r.units || []).length;
      log(`  ${r.marketplace} ${r.externalId} units=${units} $${r.price} | ${(r.title || "").slice(0, 70)}`);
    }
    if (APPLY) {
      for (const r of target) {
        try {
          await delistRow(r);
          await MarketplaceListing.updateOne(
            { _id: r._id, status: "active" },
            { $set: { status: "delisted", lastError: "freed for manual bulk sale (" + new Date().toISOString().slice(0, 10) + ")" } },
          );
          out.delisted++;
        } catch (e) {
          out.delistErrors++;
          log("  DELIST FAILED " + r.marketplace + " " + r.externalId + ": " + e.message);
          // Do not park ledgers of a row we could not take down — the units
          // are still purchasable there.
          continue;
        }
        const rowLedgers = mine.filter((l) => String(l.set) === String(r.set) && l.market === r.marketplace);
        for (const l of rowLedgers) {
          const u = await UnclaimedAccount.updateOne(
            { _id: l._id, status: "listed" },
            {
              $set: {
                status: "skipped",
                note: "held for manual bulk sale — freed from " + r.marketplace + " " + new Date().toISOString().slice(0, 10),
                lastCheckedAt: new Date(),
                lotId: "",
              },
            },
          );
          if (u.modifiedCount) {
            out.ledgersParked++;
            await engine.markOwnerUnlisted(l).catch(() => {});
          }
        }
      }
      logEvent({
        category: "unclaimed",
        action: "market_freed",
        actor: "free-unclaimed-market.js",
        game: GAME,
        count: out.ledgersParked,
        detail: `delisted ${out.delisted} ${MARKETS.join("/")} row(s), parked ${out.ledgersParked} account(s) as held for manual bulk sale`,
      });
    }
    // Settings: restrict the game to the markets NOT freed; cap the game.
    const keep = settings.UNCLAIMED_MARKETS.filter((m) => !MARKETS.includes(m));
    const gfLeft = await UnclaimedAccount.countDocuments({ status: "listed", market: { $nin: MARKETS } }).then(async () => {
      const rest = await UnclaimedAccount.find({ status: "listed", market: { $nin: MARKETS } }, { game: 1 }).lean();
      return rest.filter((l) => sameGame(l.game)).length;
    });
    const cap = CAP > 0 ? CAP : gfLeft + 2;
    const key = settings.normGameName(GAME);
    const af = settings.getAutoFarm();
    const gm = { ...(af.unclaimedGameMarkets || {}), [key]: keep };
    const gc = { ...(af.unclaimedGameCaps || {}), [key]: cap };
    log(`settings: unclaimedGameMarkets[${key}]=${JSON.stringify(keep)} unclaimedGameCaps[${key}]=${cap} (listed left on kept markets: ${gfLeft})`);
    if (APPLY) await settings.setAutoFarm({ unclaimedGameMarkets: gm, unclaimedGameCaps: gc });
    log("--- SUMMARY --- " + JSON.stringify(out));
  } finally {
    if (APPLY && !out.paused) {
      await settings.setAutoFarm({ unclaimedAutoListPaused: false });
      const now = settings.getAutoFarm();
      log("engine resumed; unclaimedAutoListPaused=" + now.unclaimedAutoListPaused);
      if (now.unclaimedAutoListPaused) log("!!! ENGINE STILL PAUSED — fix by hand: setAutoFarm({unclaimedAutoListPaused:false})");
    }
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
