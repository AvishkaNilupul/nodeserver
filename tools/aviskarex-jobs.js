const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const config = require("../config/config");
const TwitchFollowJob = require("../models/TwitchFollowJob");
const TwitchFollowLog = require("../models/TwitchFollowLog");

async function main() {
  await mongoose.connect(config.MONGO_URI);
  const jobs = await TwitchFollowJob.find({ channelLogin: "aviskarex" })
    .sort({ createdAt: -1 })
    .lean();
  console.log("jobs for aviskarex : " + jobs.length);
  for (const j of jobs) {
    console.log(
      "\njob " + String(j._id).slice(-6) +
        "  status=" + j.status +
        "  created=" + new Date(j.createdAt).toISOString() +
        (j.finishedAt ? "  finished=" + new Date(j.finishedAt).toISOString() : ""),
    );
    console.log(
      "  requested=" + j.requestedCount +
        "  delivered=" + j.delivered +
        "  failed=" + j.failed +
        "  skipped=" + j.skipped +
        "  concurrency=" + (j.concurrency || 1),
    );
    if (j.lastError) console.log("  lastError=" + j.lastError);
    if (j.lastMessage) console.log("  lastMessage=" + j.lastMessage);
  }

  const perStatus = await TwitchFollowLog.aggregate([
    { $match: { channelLogin: "aviskarex" } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  console.log("\n===== log rows for aviskarex by status =====");
  perStatus.forEach((r) => console.log("  " + r._id.padEnd(20) + " " + r.count));

  // What kind of failures?
  const failedSample = await TwitchFollowLog.find({
    channelLogin: "aviskarex",
    status: { $in: ["failed", "skipped"] },
  })
    .sort({ at: -1 })
    .limit(15)
    .lean();
  if (failedSample.length) {
    console.log("\n===== recent failed/skipped attempts =====");
    failedSample.forEach((l) =>
      console.log(
        "  " + new Date(l.at).toISOString() +
          "  " + l.status.padEnd(10) +
          " host=" + (l.host || "").padEnd(6) +
          " acct=" + (l.botLogin || String(l.botAccountId).slice(-6)).padEnd(28) +
          " err=" + (l.error || "").slice(0, 120),
      ),
    );
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
