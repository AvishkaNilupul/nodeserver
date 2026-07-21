// One-time migration: move account-level reservations down to the drops.
//
// Reservation used to live on BotAccount.soldAt (whole account). It's now per
// drop (DropLog.soldAt) so an "everything" account stays sellable for its other
// games. This copies each currently-reserved account's reservation onto the
// drops of its reserved set — freeing the account's OTHER games — while leaving
// the account-level shadow intact for rollback.
//
//   node scripts/migrate-per-drop-reservations.js                    # dry run
//   node scripts/migrate-per-drop-reservations.js --apply             # write
//   node scripts/migrate-per-drop-reservations.js --revert --apply    # roll back
//
// Uses the RAW MongoDB driver (not Mongoose models) so it can run BEFORE the
// new code is deployed — the old running code simply ignores the new DropLog
// field. Idempotent: only ever stamps drops that are not already reserved.
// Rollback clears every drop-level reservation (reads then fall back to the
// untouched BotAccount shadow).
require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const ID_RE = /^[a-f0-9]{24}$/;
const { ObjectId } = mongoose.Types;

function empty() {
  return {
    soldAt: null,
    soldToUsername: "",
    soldToAdminId: "",
    soldSetId: "",
    soldBulkOrderId: "",
  };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const droplogs = db.collection("droplogs");
  const botaccounts = db.collection("botaccounts");
  const dropsets = db.collection("dropsets");

  if (REVERT) {
    const n = await droplogs.countDocuments({ soldAt: { $ne: null } });
    console.log(`REVERT: ${n} reserved drops`, APPLY ? "(APPLY)" : "(dry-run)");
    if (APPLY) {
      const r = await droplogs.updateMany(
        { soldAt: { $ne: null } },
        { $set: empty() },
      );
      console.log("cleared:", r.modifiedCount);
    }
    await mongoose.disconnect();
    return;
  }

  const sold = await botaccounts
    .find(
      { soldAt: { $ne: null } },
      {
        projection: {
          login: 1,
          soldAt: 1,
          soldToUsername: 1,
          soldToAdminId: 1,
          soldSetId: 1,
          soldBulkOrderId: 1,
        },
      },
    )
    .toArray();
  console.log(
    `reserved accounts: ${sold.length}`,
    APPLY ? "(APPLY)" : "(dry-run)",
  );

  const setCache = new Map();
  let perGame = 0;
  let wholeAccount = 0;
  let dropsMarked = 0;

  for (const a of sold) {
    const stamp = {
      soldAt: a.soldAt || new Date(),
      soldToUsername: a.soldToUsername || "",
      soldToAdminId: a.soldToAdminId || "",
      soldSetId: a.soldSetId || "",
      soldBulkOrderId: a.soldBulkOrderId || "",
    };
    // Only stamp drops that aren't already reserved (idempotent).
    const filter = { account: a._id, soldAt: null };
    let keys = null;
    if (a.soldSetId && ID_RE.test(a.soldSetId)) {
      let set = setCache.get(a.soldSetId);
      if (set === undefined) {
        set = await dropsets.findOne(
          { _id: new ObjectId(a.soldSetId) },
          { projection: { items: 1 } },
        );
        setCache.set(a.soldSetId, set);
      }
      if (set) keys = (set.items || []).map((i) => i.itemKey).filter(Boolean);
    }
    if (keys && keys.length) {
      filter.itemKey = { $in: keys }; // per-game: reserve only this set's drops
      perGame++;
    } else {
      // No mappable set (legacy / manual) — conservatively reserve every drop
      // so the account stays as unavailable as it is today.
      wholeAccount++;
    }
    if (APPLY) {
      const r = await droplogs.updateMany(filter, { $set: stamp });
      dropsMarked += r.modifiedCount || 0;
    } else {
      dropsMarked += await droplogs.countDocuments(filter);
    }
  }

  console.log({
    perGameAccounts: perGame,
    wholeAccountAccounts: wholeAccount,
    dropsMarked,
  });
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("migration error:", e.message);
  process.exit(1);
});
