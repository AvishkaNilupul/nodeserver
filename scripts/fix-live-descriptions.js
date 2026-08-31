// One-time live repair: auto-farm descriptions were built with one house
// template whose closing line says "message me here on Gameflip" — wrong on
// every other marketplace. The code now builds a per-marketplace line, but the
// rows published before that fix still carry the Gameflip wording on GGSel and
// ZeusX. This swaps just the support line on those live rows (keeps the item
// list, post-event scarcity text, etc. untouched) and updates the row copy.
// Digiseller has no edit-text API, so its products are left as-is.
//
//   node scripts/fix-live-descriptions.js            # dry run
//   node scripts/fix-live-descriptions.js --apply    # write
require("dotenv").config();
const mongoose = require("mongoose");
const mp = require("../utils/marketplaces");
const MarketplaceListing = require("../models/MarketplaceListing");

const APPLY = process.argv.includes("--apply");
const REPLACE = {
  ggsel: "Any issue or question — message me here on GGSel before opening a dispute. I reply fast and always make it right.",
  zeusx: "Any issue or question — message me here on ZeusX before opening a dispute. I reply fast and always make it right.",
};
const RE = /Any issue or question — message me here on Gameflip[^\n]*/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { ggsel: 0, zeusx: 0, failed: [], skipped: 0 };

  for (const [marketplace, line] of Object.entries(REPLACE)) {
    const rows = await MarketplaceListing.find({
      origin: "auto",
      marketplace,
      status: "active",
    }).lean();
    console.log(marketplace + ": " + rows.length + " active rows");
    let i = 0;
    for (const row of rows) {
      i++;
      const d = String(row.description || "");
      if (!/Gameflip/i.test(d)) { out.skipped++; continue; }
      const next = d.replace(RE, line);
      if (next === d) { out.skipped++; continue; }
      console.log("FIX " + marketplace + " " + row.externalId + " (" + i + "/" + rows.length + ")");
      if (!APPLY) continue;
      try {
        if (marketplace === "ggsel") {
          await mp.ggselUpdateOffer(row.externalId, { description: next });
        } else {
          await mp.zeusxUpdateOffer(row.externalId, { description: next });
        }
        await MarketplaceListing.updateOne(
          { _id: row._id, status: "active" },
          { $set: { description: next } },
        ).catch(() => {});
        out[marketplace]++;
        await sleep(1200);
      } catch (e) {
        out.failed.push(marketplace + " " + row.externalId + ": " + e.message.slice(0, 120));
        await sleep(5000);
      }
    }
  }
  console.log("\n--- SUMMARY ---");
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
