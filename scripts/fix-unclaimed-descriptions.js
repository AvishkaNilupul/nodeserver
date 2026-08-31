// One-time live repair: the unclaimed auto-list engine used to build a plain,
// hand-rolled description that (a) did NOT match the auto-farm's house template
// and (b) was identical on every marketplace (no per-site support line). The
// engine now reuses autoLister.buildDescription per marketplace, so all FUTURE
// listings are correct. This rewrites the description on every ACTIVE unclaimed
// listing to the new house copy:
//   - gameflip   -> gameflipReprice (patch /description inside its off-sale window)
//   - ggsel      -> ggselUpdateOffer (description in place)
//   - digiseller -> no text-edit API: delist + republish with the same listed units
//
// Idempotent: a row whose stored description already equals the freshly built
// house copy is left untouched, so the script is safe to re-run.
//
//   node scripts/fix-unclaimed-descriptions.js                       # dry run (all)
//   node scripts/fix-unclaimed-descriptions.js --apply               # write (all)
//   node scripts/fix-unclaimed-descriptions.js --apply --market=gameflip,ggsel
require("dotenv").config();
const mongoose = require("mongoose");
const settings = require("../utils/settings");
const mp = require("../utils/marketplaces");
const engine = require("../utils/unclaimedAutoList");
const { buildSetGridImage } = require("../utils/setImage");
const { decrypt } = require("../utils/secretBox");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const AvailableAccount = require("../models/AvailableAccount");
const WebBotAccount = require("../models/WebBotAccount");

const APPLY = process.argv.includes("--apply");
const marketArg =
  (process.argv.find((a) => a.startsWith("--market=")) || "").split("=")[1] || "";
const ONLY = marketArg
  ? new Set(marketArg.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const want = (m) => !ONLY || ONLY.has(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// Drop shape the engine's listing copy expects (same as the scan sellable path).
function setItemsToDrops(items) {
  return (items || []).map((i) => ({
    name: i.name,
    game: i.game || "",
    campaign: i.campaign || "",
    imageURL: i.image || "",
    itemKey: i.itemKey || i.name,
  }));
}

// Login + password for a listed ledger, for the Digiseller republish only.
async function unitCreds(ledger) {
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
    if (!pool) return null;
    let pw = "";
    try {
      pw = decrypt(pool.password || "");
    } catch {
      pw = "";
    }
    if (!pw) pw = engine.plainPassword(pool.credPasswordEnc);
    return { login: ledger.login || pool.login || "", password: pw, id: String(pool._id) };
  }
  if (ledger.source === "webbot" && ledger.webBotAccountId) {
    const wb = await WebBotAccount.findById(ledger.webBotAccountId).lean();
    if (!wb) return null;
    return {
      login: ledger.login || wb.login || "",
      password: engine.plainPassword(wb.credPasswordEnc),
      id: String(wb._id),
    };
  }
  return null;
}

function rebuild(set, marketplace) {
  const game =
    (set.items && set.items[0] && set.items[0].game) || set.coverGame || "";
  const drops = setItemsToDrops(set.items);
  return {
    game,
    drops,
    title: engine.listingTitle(game, drops),
    description: engine.listingDescription(game, drops, marketplace),
  };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = {
    gameflip: { fixed: 0, unchanged: 0 },
    ggsel: { fixed: 0, unchanged: 0 },
    digiseller: { fixed: 0, unchanged: 0 },
    errors: [],
  };

  if (APPLY) {
    // MUST await — setAutoFarm is an async atomic write (tmp + rename). An
    // un-awaited resume in the finally below loses the race with process.exit
    // and strands the engine paused; every setAutoFarm here is awaited so both
    // the pause and the resume are flushed to settings.json before we move on.
    await settings.setAutoFarm({ unclaimedAutoListPaused: true });
    log("engine paused for description repair");
  }

  try {
    const rows = await MarketplaceListing.find({
      origin: "unclaimed",
      status: "active",
    }).lean();
    log("active unclaimed rows: " + rows.length);

    for (const row of rows) {
      const mkt = row.marketplace;
      if (!["gameflip", "ggsel", "digiseller"].includes(mkt) || !want(mkt)) continue;

      const set = await DropSet.findById(row.set).lean();
      if (!set) {
        out.errors.push(row.externalId + ": set not found");
        continue;
      }
      const { game, drops, description } = rebuild(set, mkt);
      const same = String(row.description || "") === description;
      if (same) {
        out[mkt].unchanged++;
        log("UNCHANGED " + mkt + " " + row.externalId + " (" + game + ")");
        continue;
      }
      log("FIX " + mkt + " " + row.externalId + " (" + game + ")");
      if (!APPLY) continue;

      if (mkt === "gameflip") {
        try {
          await mp.gameflipReprice(row.externalId, { description });
          await MarketplaceListing.updateOne(
            { _id: row._id, status: "active" },
            { $set: { description } },
          );
          out.gameflip.fixed++;
          await sleep(1500);
        } catch (e) {
          out.errors.push("gameflip " + row.externalId + ": " + e.message.slice(0, 160));
          await sleep(4000);
        }
      } else if (mkt === "ggsel") {
        try {
          await mp.ggselUpdateOffer(row.externalId, { description });
          await MarketplaceListing.updateOne(
            { _id: row._id, status: "active" },
            { $set: { description } },
          );
          out.ggsel.fixed++;
          await sleep(1500);
        } catch (e) {
          out.errors.push("ggsel " + row.externalId + ": " + e.message.slice(0, 160));
          await sleep(4000);
        }
      } else if (mkt === "digiseller") {
        // No text-edit API: delist + republish carrying the same listed units.
        const kept = await UnclaimedAccount.find({
          set: row.set,
          market: "digiseller",
          status: "listed",
        }).lean();
        const units = [];
        for (const l of kept) {
          const c = await unitCreds(l);
          if (c && c.login && c.password) units.push(c);
          else out.errors.push(row.externalId + ": no creds for " + (l.login || l._id));
        }
        if (!units.length) {
          out.errors.push(row.externalId + ": no units to republish");
          continue;
        }
        const price = Number(row.price) || Number(set.price) || 1;
        let newRow = null;
        for (let attempt = 1; attempt <= 3 && !newRow; attempt++) {
          try {
            await mp.digisellerDelist(row.externalId).catch(() => {});
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { status: "delisted", lastError: "rebuilt — description repair republish" } },
            ).catch(() => {});
            let img = "";
            try {
              img = await buildSetGridImage(set);
            } catch {
              img = "";
            }
            newRow = await engine.publishProduct(
              set,
              "digiseller",
              units,
              game,
              drops,
              price,
              img,
              "",
            );
          } catch (e) {
            out.errors.push(row.externalId + " attempt " + attempt + ": " + e.message.slice(0, 160));
            await sleep(15000 * attempt);
          }
        }
        if (!newRow) {
          out.errors.push(row.externalId + ": republish failed");
          continue;
        }
        await UnclaimedAccount.updateMany(
          { set: row.set, market: "digiseller", status: "listed" },
          { $addToSet: { listingIds: String(newRow._id) } },
        ).catch(() => {});
        const live = await mp.digisellerProductStock(newRow.externalId).catch(() => null);
        log(
          "  new product " +
            newRow.externalId +
            " liveStock=" +
            live +
            " expected=" +
            units.length +
            (live === units.length ? " OK" : " *** MISMATCH ***"),
        );
        out.digiseller.fixed++;
        await sleep(3000);
      }
    }

    log("\n--- SUMMARY ---");
    log(JSON.stringify(out, null, 2));
  } finally {
    if (APPLY) {
      await settings.setAutoFarm({ unclaimedAutoListPaused: false });
      log("engine resumed");
    }
    await mongoose.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
