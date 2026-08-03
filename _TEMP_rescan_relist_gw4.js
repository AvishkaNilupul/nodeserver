// Rescan the GW4 task's accounts (refresh stale DropLog), then relist via the
// fixed lister (holdings gate will now see the full 4-item bundle).
process.chdir("/var/www/redeemer/nodeserver");
require("dotenv").config();
const mongoose = require("mongoose");
const config = require("./config/config");
const AFT = require("./models/AutoFarmTask");
const BotAccount = require("./models/BotAccount");
const dropScanner = require("./utils/dropScanner");
const autoLister = require("./utils/autoLister");

async function main() {
  await mongoose.connect(config.MONGO_URI);
  const t = await AFT.findOne({ campaignName: "Global Warfare 4", status: "active" });
  const logins = t.assignedAccounts || [];
  console.log("rescanning " + logins.length + " GW4 accounts...");
  let scanned = 0;
  for (const login of logins) {
    const acc = await BotAccount.findOne({ login: new RegExp("^" + login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }, { _id: 1 }).lean();
    if (!acc) continue;
    const r = await dropScanner.scanAccountNow(acc._id).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok !== false) scanned++;
    process.stdout.write(".");
  }
  console.log("\nrescanned " + scanned + "/" + logins.length);
  // Relist: clear stale pointer, run fixed lister.
  t.listing = undefined; t.wouldList = undefined; await t.save();
  const res = await autoLister.listActivatedTask(t._id, { dryRun: false }).catch((e) => ({ error: e.message }));
  console.log("relist result:", JSON.stringify(res));
  await mongoose.disconnect();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
