// One-time live cleanup: replacing a gameflip cover uploads the new grid but the
// rate limiter rejects the follow-up delete of the old photo (a stale-photo
// delete right after an upload is exactly what gameflipReplaceCover gives up
// on). After fix-unclaimed-covers.js every gameflip listing had its correct new
// cover PLUS 1-2 stale grids still in the gallery. This prunes every active
// unclaimed gameflip listing down to just its cover, spaced out so the limiter
// keeps up. Idempotent — a listing already down to its cover is a no-op.
//
//   node scripts/prune-gameflip-photos.js            # dry run
//   node scripts/prune-gameflip-photos.js --apply    # write
require("dotenv").config();
const mongoose = require("mongoose");
const mp = require("../utils/marketplaces");
const MarketplaceListing = require("../models/MarketplaceListing");

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { pruned: 0, alreadyClean: 0, failed: 0, deletedPhotos: 0, errors: [] };

  const rows = await MarketplaceListing.find({
    origin: "unclaimed",
    marketplace: "gameflip",
    status: "active",
  }).lean();
  log("active unclaimed gameflip rows: " + rows.length);

  for (const row of rows) {
    if (!APPLY) {
      log("would prune " + row.externalId);
      continue;
    }
    try {
      const r = await mp.gameflipDeleteNonCoverPhotos(row.externalId);
      if (r.deleted > 0) {
        out.pruned++;
        out.deletedPhotos += r.deleted;
        log("PRUNED " + row.externalId + " — deleted " + r.deleted + ", remaining extras " + r.remaining);
      } else {
        out.alreadyClean++;
        log("clean  " + row.externalId + " — no extra photos");
      }
    } catch (e) {
      out.failed++;
      out.errors.push(row.externalId + ": " + e.message.slice(0, 200));
      log("FAIL   " + row.externalId + ": " + e.message.slice(0, 200));
    }
    // Space listings out so the delete does not re-trigger the burst limiter.
    await sleep(6000);
  }

  log("\n--- SUMMARY ---");
  log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
