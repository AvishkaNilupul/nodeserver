// Mirror account-pool passwords onto bot accounts.
//
// Bot configs only carry the ClientSecret (token), so a BotAccount created
// from a config has no credPassword — but selling an account hands the buyer
// its login+password, and that password lives in the account pool
// (AvailableAccount). Without a password an account is undeliverable and
// counts as zero stock, so every path that creates/places BotAccounts must
// mirror promptly: the deploy paste (botConfigRoutes.upsertBotAccounts), the
// full "Sync from bots" walk, and the pool import. Before this was shared,
// only the manual sync mirrored — accounts deployed after a pool import sat
// passwordless (0 stock on every listing) until someone happened to sync.
//
// Fill-only: never overwrites an existing BotAccount password. Pass `logins`
// to limit the pass to just-touched accounts; omit for a full sweep.
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const { encrypt, decrypt } = require("./secretBox");

async function fillBotPasswordsFromPool(logins) {
  const wanted = Array.isArray(logins)
    ? new Set(
        logins.map((l) => String(l || "").trim().toLowerCase()).filter(Boolean),
      )
    : null;
  if (wanted && !wanted.size) return 0;
  let bots = await BotAccount.find(
    { $or: [{ credPassword: "" }, { credPassword: { $exists: false } }] },
    { login: 1 },
  ).lean();
  if (wanted) {
    bots = bots.filter((b) =>
      wanted.has(String(b.login || "").toLowerCase()),
    );
  }
  if (!bots.length) return 0;
  const lowers = [
    ...new Set(
      bots.map((b) => String(b.login || "").toLowerCase()).filter(Boolean),
    ),
  ];
  const pool = await AvailableAccount.find(
    { usernameLower: { $in: lowers }, password: { $ne: "" } },
    { usernameLower: 1, password: 1 },
  ).lean();
  const poolMap = new Map(pool.map((a) => [a.usernameLower, a.password]));
  const ops = [];
  for (const b of bots) {
    const enc = poolMap.get(String(b.login || "").toLowerCase());
    if (!enc) continue;
    const pw = decrypt(enc);
    if (!pw) continue;
    ops.push({
      updateOne: {
        filter: { _id: b._id },
        update: { $set: { credPassword: encrypt(pw), hasPassword: true } },
      },
    });
  }
  if (ops.length) await BotAccount.bulkWrite(ops, { ordered: false });
  return ops.length;
}

module.exports = { fillBotPasswordsFromPool };
