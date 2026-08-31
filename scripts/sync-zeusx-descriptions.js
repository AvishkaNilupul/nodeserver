// One-time sync: ZeusX applies offer updates but answers with a 500, so the
// fix-live-descriptions run left the PLATFORM correct and the DB stale. This
// reads each active auto ZeusX offer's live description, updates the DB row to
// the verified text, and retries the few that still mention Gameflip.
//
//   node scripts/sync-zeusx-descriptions.js            # dry run
//   node scripts/sync-zeusx-descriptions.js --apply    # write
require("dotenv").config();
const mongoose = require("mongoose");
const mp = require("../utils/marketplaces");
const MarketplaceListing = require("../models/MarketplaceListing");

const APPLY = process.argv.includes("--apply");
const RE = /Any issue or question — message me here on Gameflip[^\n]*/;
const LINE = "Any issue or question — message me here on ZeusX before opening a dispute. I reply fast and always make it right.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const rows = await MarketplaceListing.find({
    origin: "auto",
    marketplace: "zeusx",
    status: "active",
  }).lean();
  const out = { total: rows.length, dbSynced: 0, platformRetried: 0, failed: [] };
  let i = 0;
  for (const row of rows) {
    i++;
    let live = "";
    try {
      const cur = await mp.zeusxOffer(row.externalId);
      live = String(cur.description || "");
    } catch (e) {
      out.failed.push(row.externalId + ": offer read failed: " + e.message.slice(0, 80));
      continue;
    }
    const dbMentions = /Gameflip/i.test(String(row.description || ""));
    if (/ZeusX/i.test(live) && dbMentions) {
      const next = String(row.description || "").replace(RE, LINE);
      console.log("SYNC " + row.externalId + " (" + i + "/" + rows.length + ")");
      if (APPLY) {
        await MarketplaceListing.updateOne(
          { _id: row._id, status: "active" },
          { $set: { description: next } },
        ).catch(() => {});
        out.dbSynced++;
      }
    } else if (/Gameflip/i.test(live)) {
      console.log("RETRY " + row.externalId + " (" + i + "/" + rows.length + ") still Gameflip live");
      if (APPLY) {
        try {
          await mp.zeusxUpdateOffer(row.externalId, {
            description: String(row.description || "").replace(RE, LINE),
          });
          out.platformRetried++;
          const cur = await mp.zeusxOffer(row.externalId);
          if (/ZeusX/i.test(String(cur.description || ""))) {
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { description: String(row.description || "").replace(RE, LINE) } },
            ).catch(() => {});
            out.dbSynced++;
          }
        } catch (e) {
          out.failed.push(row.externalId + ": " + e.message.slice(0, 80));
        }
        await sleep(1500);
      }
    }
    if (i % 20 === 0) console.log("  progress " + i + "/" + rows.length);
  }
  console.log("\n--- SUMMARY ---");
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
