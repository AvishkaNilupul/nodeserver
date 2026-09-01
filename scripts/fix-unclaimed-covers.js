// One-time live repair: some unclaimed listings carry a STALE cover image. The
// cover is a grid built from set.items at publish time; when a set was later
// corrected (a mixed multi-game set reduced to one game, or duplicate drops
// deduped to one item) the title/description were rebuilt but the already-
// uploaded cover was not — so e.g. a "1 Item — Alpha Pack" listing still shows a
// 3-tile grid (Alpha Pack + two unrelated items). This regenerates the grid from
// the CURRENT (correct) set and replaces the cover:
//   - gameflip : gameflipReplaceCover (off-sale, upload fresh, delete stale) — in place
//   - ggsel    : NO in-place cover API -> delist + republish with the fresh cover
//                (mints a new offer id; opt-in via --ggsel-republish)
//   - digiseller: covers were already rebuilt by the description republish -> skipped
//
// Idempotent for gameflip (regenerating a correct cover just re-uploads the same
// grid). Pauses the engine (awaited) so a concurrent tick can't fight the swap.
//
//   node scripts/fix-unclaimed-covers.js                       # dry run (gameflip)
//   node scripts/fix-unclaimed-covers.js --apply               # write gameflip covers
//   node scripts/fix-unclaimed-covers.js --apply --ggsel-republish  # + republish ggsel
require("dotenv").config();
const fsp = require("fs/promises");
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
const GGSEL_REPUBLISH = process.argv.includes("--ggsel-republish");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

function setItemsToDrops(items) {
  return (items || []).map((i) => ({
    name: i.name,
    game: i.game || "",
    campaign: i.campaign || "",
    imageURL: i.image || "",
    itemKey: i.itemKey || i.name,
  }));
}

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

async function resolveGgselCategory(game) {
  const af = settings.getAutoFarm();
  let cat = "";
  try {
    cat = await mp.ggselResolveCategoryId(game);
  } catch {
    cat = "";
  }
  if (!cat) cat = String(af.ggselCategoryId || "");
  return cat;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = {
    gameflip: { fixed: 0, failed: 0 },
    ggsel: { republished: 0, skipped: 0, failed: 0 },
    digiseller: { skipped: 0 },
    errors: [],
  };

  if (APPLY) {
    await settings.setAutoFarm({ unclaimedAutoListPaused: true });
    log("engine paused for cover repair");
  }

  try {
    const rows = await MarketplaceListing.find({
      origin: "unclaimed",
      status: "active",
    }).lean();
    log("active unclaimed rows: " + rows.length);

    for (const row of rows) {
      const mkt = row.marketplace;
      const set = await DropSet.findById(row.set).lean();
      if (!set) {
        out.errors.push(row.externalId + ": set not found");
        continue;
      }
      const nItems = (set.items || []).length;
      const game =
        (set.items && set.items[0] && set.items[0].game) || set.coverGame || "";

      if (mkt === "gameflip") {
        log("gameflip " + row.externalId + " (" + game + ", " + nItems + " item grid)");
        if (!APPLY) continue;
        let img = "";
        try {
          img = await buildSetGridImage(set);
        } catch (e) {
          out.errors.push("gameflip " + row.externalId + ": grid build " + e.message.slice(0, 120));
        }
        if (!img) {
          out.gameflip.failed++;
          continue;
        }
        try {
          await mp.gameflipReplaceCover(row.externalId, img);
          out.gameflip.fixed++;
        } catch (e) {
          out.gameflip.failed++;
          out.errors.push("gameflip " + row.externalId + ": " + e.message.slice(0, 200));
        } finally {
          await fsp.unlink(img).catch(() => {});
        }
        await sleep(2000);
      } else if (mkt === "ggsel") {
        if (!GGSEL_REPUBLISH) {
          out.ggsel.skipped++;
          log("ggsel " + row.externalId + " (" + game + ", " + nItems + " item grid) — SKIP (no in-place cover API; pass --ggsel-republish)");
          continue;
        }
        log("ggsel " + row.externalId + " (" + game + ", " + nItems + " item grid) — republish");
        if (!APPLY) continue;
        const kept = await UnclaimedAccount.find({
          set: row.set,
          market: "ggsel",
          status: "listed",
        }).lean();
        const units = [];
        for (const l of kept) {
          const c = await unitCreds(l);
          if (c && c.login && c.password) units.push(c);
          else out.errors.push(row.externalId + ": no creds for " + (l.login || l._id));
        }
        if (!units.length) {
          out.ggsel.failed++;
          out.errors.push(row.externalId + ": no units to republish");
          continue;
        }
        const cat = await resolveGgselCategory(game);
        if (!cat) {
          out.ggsel.failed++;
          out.errors.push(row.externalId + ": no ggsel category resolved for " + game);
          continue;
        }
        const drops = setItemsToDrops(set.items);
        const price = Number(row.price) || Number(set.price) || 1;
        let img = "";
        try {
          img = await buildSetGridImage(set);
        } catch {
          img = "";
        }
        let newRow = null;
        for (let attempt = 1; attempt <= 3 && !newRow; attempt++) {
          try {
            await mp.ggselDelist(row.externalId).catch(() => {});
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { status: "delisted", lastError: "rebuilt — cover repair republish" } },
            ).catch(() => {});
            newRow = await engine.publishProduct(
              set,
              "ggsel",
              units,
              game,
              drops,
              price,
              img,
              cat,
            );
          } catch (e) {
            out.errors.push(row.externalId + " attempt " + attempt + ": " + e.message.slice(0, 160));
            await sleep(15000 * attempt);
          }
        }
        if (img) await fsp.unlink(img).catch(() => {});
        if (!newRow) {
          out.ggsel.failed++;
          continue;
        }
        await UnclaimedAccount.updateMany(
          { set: row.set, market: "ggsel", status: "listed" },
          { $addToSet: { listingIds: String(newRow._id) } },
        ).catch(() => {});
        out.ggsel.republished++;
        await sleep(3000);
      } else if (mkt === "digiseller") {
        out.digiseller.skipped++;
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
