// Trusted operator import. Contains no credentials and never releases stock.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  validateReport,
  digest,
  validId,
} = require("../../utils/rivalsAccounts");

function reportFromWorker(job, manifest) {
  if (!job || manifest.jobId !== job.id || manifest.rivalsUid !== job.rivalsUid)
    throw Error("Evidence profile mismatch");
  const proofs = job.expectedRewards.map((r) => {
    const slug = r.name
      .replace(/ Costume$/i, "")
      .toLowerCase()
      .replace(/\s+/g, "-");
    const p = manifest.verifiedCostumes.find((p) => p.hero === slug);
    if (!p) throw Error("Costume evidence missing: " + r.name);
    return {
      rewardId: r.id,
      hero: r.name.replace(/ Costume$/i, ""),
      costume: p.costume,
      file: p.file,
      sha256: p.sha256,
    };
  });
  return {
    id: job.id,
    holdId: job.holdId,
    steamAccountId: job.steamAccountId,
    twitchAccountId: job.twitchAccountId,
    rivalsUid: job.rivalsUid,
    state: job.state,
    phase: job.phase,
    verifiedRewards: job.verifiedRewards,
    verifiedAt: job.verifiedAt,
    completedAt: job.completedAt,
    proofs,
  };
}

async function importReport(db, report, sourceDir, targetRoot) {
  if (!validId(report?.id)) throw Error("Invalid preparation");
  const preps = db.collection("rivalspreparations");
  const prep = await preps.findOne({ _id: report.id });
  const gameReport = validateReport(prep, report);
  const steam = await db
    .collection("steamaccounts")
    .findOne(
      { _id: prep.steamId },
      { projection: { stage: 1, notes: 1, soldAt: 1 } },
    );
  if (
    !steam ||
    steam.stage !== "problem" ||
    steam.soldAt ||
    !String(steam.notes).includes(prep._id)
  )
    throw Error("Steam hold changed");
  const count = (name, filter) =>
    db.collection(name).countDocuments(filter, { limit: 1, maxTimeMS: 5000 });
  const conflicts = await Promise.all([
    count("steamlistings", {
      accounts: {
        $elemMatch: { steamAccountId: prep.steamId, state: { $ne: "removed" } },
      },
    }),
    count("steamsales", { "accounts.steamAccountId": prep.steamId }),
    count("steamg2gunits", {
      steamAccountId: prep.steamId,
      state: { $ne: "removed" },
    }),
    count("steamboosts", {
      steamAccountId: prep.steamId,
      state: { $in: ["queued", "boosting", "stopping"] },
    }),
  ]);
  if (conflicts.some(Boolean))
    throw Error("Steam account has another commitment");
  const held = await db
    .collection("droplogs")
    .countDocuments({
      account: prep.twitchId,
      soldSetId: prep.holdId,
      soldToUsername: "manual",
      soldAt: { $ne: null },
    });
  if (!prep.reservedCount || held !== prep.reservedCount)
    throw Error("Twitch reservation changed");
  if (
    prep.gameReport &&
    JSON.stringify(prep.gameReport) !== JSON.stringify(gameReport)
  )
    throw Error("Existing verification differs; review required");
  const target = path.join(targetRoot, prep._id);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const p of gameReport.proofs) {
    const bytes = await fs.readFile(path.join(sourceDir, p.file));
    if (digest(bytes) !== p.sha256) throw Error("Evidence checksum mismatch");
    try {
      await fs.writeFile(path.join(target, p.file), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (
        e.code !== "EEXIST" ||
        digest(await fs.readFile(path.join(target, p.file))) !== p.sha256
      )
        throw Error("Stored evidence differs");
    }
  }
  if (!prep.gameReport) {
    const result = await preps.updateOne(
      {
        _id: prep._id,
        status: "held",
        holdId: report.holdId,
        steamId: prep.steamId,
        twitchId: prep.twitchId,
        gameReport: { $exists: false },
      },
      { $set: { gameReport } },
    );
    if (result.matchedCount !== 1)
      throw Error("Preparation changed during import");
  }
  return {
    id: prep._id,
    verified: gameReport.proofs.length,
    state: gameReport.state,
    phase: gameReport.phase,
  };
}

if (require.main === module) {
  (async () => {
    const [reportPath, sourceDir] = process.argv.slice(2);
    if (!reportPath || !sourceDir)
      throw Error(
        "Usage: node import-game-report.cjs REPORT_JSON PRIVATE_ASSET_DIR",
      );
    require("dotenv").config({ quiet: true });
    const mongoose = require("mongoose");
    await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    });
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      console.log(
        JSON.stringify(
          await importReport(
            mongoose.connection.db,
            report,
            sourceDir,
            process.env.RIVALS_PROOF_DIR ||
              path.resolve(__dirname, "../../.rivals-proof"),
          ),
        ),
      );
    } finally {
      await mongoose.disconnect();
    }
  })().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
module.exports = { reportFromWorker, importReport };
