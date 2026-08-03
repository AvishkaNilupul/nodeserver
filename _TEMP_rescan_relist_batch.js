// Rescan + relist the farmed-but-unlisted (stale-scan) tasks from
// /tmp/more_like_this.json. Same fix that recovered GW4: refresh DropLog for
// each task's accounts, then run the fixed lister. Paced.
process.chdir("/var/www/redeemer/nodeserver");
require("dotenv").config();
const mongoose = require("mongoose");
const config = require("./config/config");
const AFT = require("./models/AutoFarmTask");
const BotAccount = require("./models/BotAccount");
const dropScanner = require("./utils/dropScanner");
const autoLister = require("./utils/autoLister");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(config.MONGO_URI);
  const cands = JSON.parse(require("fs").readFileSync("/tmp/more_like_this.json", "utf8"));
  const results = [];
  for (const c of cands) {
    const t = await AFT.findById(c.id);
    if (!t) continue;
    console.log("\n=== " + t.game + " — " + t.campaignName + " (rescanning " + (t.assignedAccounts || []).length + ") ===");
    let scanned = 0;
    for (const login of t.assignedAccounts || []) {
      const acc = await BotAccount.findOne({ login: new RegExp("^" + login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }, { _id: 1 }).lean();
      if (!acc) continue;
      const r = await dropScanner.scanAccountNow(acc._id).catch(() => ({ ok: false }));
      if (r && r.ok !== false) scanned++;
      process.stdout.write(".");
    }
    console.log("\nrescanned " + scanned);
    t.listing = undefined; t.wouldList = undefined; await t.save();
    const res = await autoLister.listActivatedTask(t._id, { dryRun: false }).catch((e) => ({ error: e.message }));
    if (res.listed) { console.log("LISTED -> " + res.listed.url + " (gf qty " + res.listed.qty + ", plati " + (res.listed.plati && res.listed.plati.qty) + ", ggsel " + (res.listed.ggsel && res.listed.ggsel.qty) + ")"); results.push({ game: t.game, listed: res.listed.url }); }
    else { console.log("no-op/err: " + JSON.stringify(res)); results.push({ game: t.game, result: res.skipped || res.error || "?" }); }
    await sleep(8000);
  }
  console.log("\n=== BATCH SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
  await mongoose.disconnect();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
