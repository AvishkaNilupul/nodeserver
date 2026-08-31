// One-time fix: the cap-trim repair removed Digiseller units from OUR rows but
// the /product/content DELETE calls failed (rate-limited), so the old products
// still carry the released/manual-sold accounts as deliverable content. Their
// contentIds are gone from the row bookkeeping, and Digiseller has no
// content-list endpoint — the documented remedy is delist + republish with
// exactly the kept units.
//
//   node scripts/repair-digiseller-republish.js            # dry run
//   node scripts/repair-digiseller-republish.js --apply    # write
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
const TARGETS = ["6072470", "6072573", "6072587", "6072598"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unitCreds(ledger) {
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
    if (!pool) return null;
    let pw = "";
    try { pw = decrypt(pool.password || ""); } catch { pw = ""; }
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

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { targets: 0, republished: 0, failed: [], errors: [] };
  const log = (m) => console.log(m);

  if (APPLY) {
    settings.setAutoFarm({ unclaimedAutoListPaused: true });
    log("engine paused for digiseller republish");
  }

  try {
    for (const extId of TARGETS) {
      const oldRow = await MarketplaceListing.findOne({
        origin: "unclaimed",
        marketplace: "digiseller",
        externalId: extId,
        status: "active",
      }).lean();
      if (!oldRow) {
        log("SKIP " + extId + ": no active row");
        continue;
      }
      out.targets++;
      const set = await DropSet.findById(oldRow.set).lean();
      if (!set) { out.errors.push(extId + ": set not found"); continue; }
      const kept = await UnclaimedAccount.find({
        set: oldRow.set,
        market: "digiseller",
        status: "listed",
      }).lean();
      const units = [];
      for (const l of kept) {
        const c = await unitCreds(l);
        if (c && c.login && c.password) units.push(c);
        else out.errors.push(extId + ": no creds for " + (l.login || l._id));
      }
      const game = (set.items && set.items[0] && set.items[0].game) || set.coverGame || "";
      const drops = (set.items || []).map((i) => ({
        name: i.name,
        game: i.game,
        campaign: "",
        imageURL: i.image || "",
        itemKey: i.itemKey,
      }));
      log("REPUBLISH " + extId + " set=" + String(oldRow.set) + " units=" + units.length + " (was " + (oldRow.units || []).length + ")");
      if (!APPLY) continue;
      if (!units.length) { out.errors.push(extId + ": no units to publish"); continue; }

      let newRow = null;
      for (let attempt = 1; attempt <= 3 && !newRow; attempt++) {
        try {
          await mp.digisellerDelist(extId).catch(() => {});
          await MarketplaceListing.updateOne(
            { _id: oldRow._id, status: "active" },
            { $set: { status: "delisted", lastError: "rebuilt — digiseller republish" } },
          ).catch(() => {});
          let img = "";
          try { img = await buildSetGridImage(set); } catch { img = ""; }
          newRow = await engine.publishProduct(
            set,
            "digiseller",
            units,
            game,
            drops,
            Number(set.price) || 0,
            img,
            "",
          );
        } catch (e) {
          out.errors.push(extId + " attempt " + attempt + ": " + e.message);
          await sleep(15000 * attempt);
        }
      }
      if (!newRow) { out.failed.push(extId); continue; }
      await UnclaimedAccount.updateMany(
        { set: oldRow.set, market: "digiseller", status: "listed" },
        { $addToSet: { listingIds: String(newRow._id) } },
      ).catch(() => {});
      const live = await mp.digisellerProductStock(newRow.externalId).catch(() => null);
      log("  new product " + newRow.externalId + " liveStock=" + live + " expected=" + units.length + (live === units.length ? " OK" : " *** MISMATCH ***"));
      out.republished++;
      await sleep(3000);
    }
    log("\n--- SUMMARY ---");
    log(JSON.stringify(out, null, 2));
  } finally {
    if (APPLY) {
      settings.setAutoFarm({ unclaimedAutoListPaused: false });
      log("engine resumed");
    }
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
