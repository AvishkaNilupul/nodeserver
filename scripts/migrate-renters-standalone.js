/**
 * One-time migration: move existing renters onto the STANDALONE renter system.
 *
 * Historically a renter's accounts were ordinary BotAccount docs and their
 * drops ordinary DropLog docs — i.e. mixed into the operator's cross-host index
 * and Drops Archive. This script de-links them:
 *
 *   For every Renter with an assigned bot (botFile):
 *     1. Copy each BotAccount on that renter's config into RenterAccount
 *        (stamped with the renter).
 *     2. Copy that account's DropLog rows into RenterDrop (re-pointed at the new
 *        RenterAccount, stamped with the renter).
 *     3. DELETE the migrated DropLog rows and BotAccount docs, so the operator's
 *        Drops Archive / account pool / scanner no longer count them.
 *
 * Usage:
 *   node scripts/migrate-renters-standalone.js --dry-run   # report only
 *   node scripts/migrate-renters-standalone.js             # perform migration
 *
 * Safe to re-run: once a renter's BotAccounts are migrated+deleted, a re-run
 * finds nothing to move for them (RenterAccount upserts are idempotent too).
 */
const mongoose = require("mongoose");

require("dotenv").config();

const Renter = require("../models/Renter");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const RenterAccount = require("../models/RenterAccount");
const RenterDrop = require("../models/RenterDrop");

const DRY_RUN = process.argv.includes("--dry-run");

// Match the BotAccounts belonging to a renter's config. Local accounts may
// predate the `host` field, so treat "local"/empty/missing host as local — the
// same normalisation routes/botConfigRoutes.js /bot-configs/health uses.
function accountMatch(renter) {
  const host = renter.botHost || "local";
  const hostMatch =
    host === "local"
      ? { $or: [{ host: "local" }, { host: { $exists: false } }, { host: "" }] }
      : { host };
  return { ...hostMatch, configFile: renter.botFile };
}

async function migrateRenter(renter) {
  const match = accountMatch(renter);
  const bots = await BotAccount.find(match).lean();
  let movedAccounts = 0;
  let movedDrops = 0;

  for (const b of bots) {
    // Drops attached to this BotAccount in the operator archive.
    const drops = await DropLog.find({ account: b._id }).lean();

    if (DRY_RUN) {
      movedAccounts += 1;
      movedDrops += drops.length;
      continue;
    }

    // 1. Upsert the RenterAccount (idempotent on clientSecret).
    const ra = await RenterAccount.findOneAndUpdate(
      { clientSecret: b.clientSecret },
      {
        $set: {
          renter: renter._id,
          login: b.login || "",
          twitchId: b.twitchId || "",
          uniqueId: b.uniqueId || "",
          configFile: b.configFile || renter.botFile,
          container: b.container || "",
          host: b.host || "local",
          enabled: b.enabled !== false,
          lastScanAt: b.lastScanAt || null,
          lastScanStatus: b.lastScanStatus || "pending",
          lastScanError: b.lastScanError || "",
          dropCount: b.dropCount || 0,
        },
      },
      { upsert: true, new: true },
    );

    // 2. Copy the drops across, re-pointed at the RenterAccount.
    for (const d of drops) {
      await RenterDrop.updateOne(
        { account: ra._id, benefitId: d.benefitId },
        {
          $set: {
            renter: renter._id,
            login: d.login || "",
            dropId: d.dropId || "",
            name: d.name || "",
            imageURL: d.imageURL || "",
            imageLocal: d.imageLocal || "",
            game: d.game || "",
            gameId: d.gameId || "",
            campaign: d.campaign || "",
            itemKey: d.itemKey || "",
            count: d.count || 1,
            awardedAt: d.awardedAt || null,
            connected: !!d.connected,
            requiredAccountLink: d.requiredAccountLink || "",
            state: d.state || "claimed",
            source: d.source || "gameEventDrop",
            lastSeenAt: d.lastSeenAt || new Date(),
          },
          $setOnInsert: { firstSeenAt: d.firstSeenAt || new Date() },
        },
        { upsert: true },
      );
      movedDrops += 1;
    }

    // Keep the renter account's dropCount consistent with what we copied.
    const rc = await RenterDrop.countDocuments({ account: ra._id });
    if (rc !== ra.dropCount) {
      await RenterAccount.updateOne({ _id: ra._id }, { $set: { dropCount: rc } });
    }

    // 3. De-link from the operator archive: drop the DropLog rows, then the
    //    BotAccount itself (only after the copy above succeeded).
    await DropLog.deleteMany({ account: b._id });
    await BotAccount.deleteOne({ _id: b._id });
    movedAccounts += 1;
  }

  return { movedAccounts, movedDrops };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  console.log(
    (DRY_RUN ? "[DRY RUN] " : "") + "Connected to MongoDB — migrating renters",
  );

  const renters = await Renter.find({ botFile: { $gt: "" } }).lean();
  console.log(`Found ${renters.length} renter(s) with an assigned bot.`);

  let totalAccounts = 0;
  let totalDrops = 0;
  for (const r of renters) {
    const { movedAccounts, movedDrops } = await migrateRenter(r);
    totalAccounts += movedAccounts;
    totalDrops += movedDrops;
    console.log(
      `  ${r.username} (${r.botHost || "local"}/${r.botFile}): ` +
        `${movedAccounts} account(s), ${movedDrops} drop(s)` +
        (DRY_RUN ? " would move" : " moved"),
    );
  }

  console.log(
    (DRY_RUN ? "[DRY RUN] " : "") +
      `Done: ${totalAccounts} account(s) and ${totalDrops} drop(s) across ` +
      `${renters.length} renter(s).`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
