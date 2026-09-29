#!/usr/bin/env node
// Re-add a batch of ALREADY-SOLD accounts to the no-claim (unclaimed) farm as a
// new dedicated bot, so the farm keeps collecting drops on them for the buyer
// who already holds them — exactly what the delivery note promises
// ("our farm keeps collecting them automatically ... leave it linked").
//
// This is off the normal path on purpose:
//   * the standard create-bot flow only claims FRESH pool accounts;
//   * readyPoolQuery excludes manualSold, so sold accounts are never re-picked.
// Here we take specific accounts by username, build ONE new no-claim bot from
// them (fleet.createBotFromAccounts), and set manualSold so they can never be
// re-listed or re-sold. We do NOT clear soldGames, touch status, or delist
// anything — the buyer already has these; we are only continuing to farm.
//
//   node scripts/noclaim-readd-sold-batch.js            # dry run (default)
//   node scripts/noclaim-readd-sold-batch.js --verify   # dry run + live token check via the Pi
//   node scripts/noclaim-readd-sold-batch.js --apply     # mark sold + create the bot
//
// MUST be run where prod is reachable (Atlas + the Pi over SSH) — i.e. on the
// production server, not a local checkout.
require("dotenv").config();
const mongoose = require("mongoose");

const AvailableAccount = require("../models/AvailableAccount");
const settings = require("../utils/settings");
const fleet = require("../utils/noclaimFleet");

// --- the batch --------------------------------------------------------------
const USERNAMES = [
  "pjfk44anes",
  "nwvhuo988qw",
  "npeyxq259z",
  "fee152mmvlsy",
  "exupcw",
  "enhhqpajz",
  "vo278rsbzuyh",
  "dswn350vcn",
  "uowxtt823nk",
  "upoxxjk",
];
const GAME_KEYWORD = "overwatch"; // must be a noClaimGames entry

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify") || APPLY; // always verify before we actually build

function log(...a) {
  console.log(...a);
}

// Pick the exact FavouriteGames string to write. Prefer the string an existing
// Overwatch no-claim bot already uses (so the new bot matches the live fleet
// verbatim); fall back to the noClaimGames entry that matches the keyword.
function resolveGameString(bots) {
  const kw = settings.normGameName(GAME_KEYWORD);
  const existing = (bots || []).find((b) => {
    const g = settings.normGameName(b.game);
    return g && (g.includes(kw) || kw.includes(g));
  });
  if (existing && existing.game) return existing.game;
  const list = settings.getAutoFarm().noClaimGames || [];
  const entry = list.find((x) => settings.normGameName(x).includes(kw));
  return entry || GAME_KEYWORD;
}

// Read every no-claim bot config on the Pi in one round trip and collect the
// ClientSecrets already in use, so we can warn about duplicates before we write
// a login into a second config (which makes it fight itself for the session).
async function existingSecrets(bots) {
  const ids = (bots || []).map((b) => b.id).filter(Boolean);
  if (!ids.length) return new Set();
  const hosts = require("../utils/botHosts");
  const script = ids
    .map(
      (id) =>
        `echo "__CFG__"; cat ${hosts.shq(fleet.configPath(id))} 2>/dev/null || true`,
    )
    .join("; ");
  const out = await fleet.sh(script, { timeout: 40000 });
  const secrets = new Set();
  for (const chunk of out.split("__CFG__")) {
    const raw = chunk.trim();
    if (!raw) continue;
    try {
      const cfg = JSON.parse(raw);
      for (const u of (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [])
        if (u && u.ClientSecret) secrets.add(String(u.ClientSecret));
    } catch {
      /* a non-JSON / partial config: skip, the dupe check is best-effort */
    }
  }
  return secrets;
}

// Optional live check: does this token still work, one Twitch inventory query
// per account, egressing via the Pi (same as the no-claim console).
async function verifyTokens(accounts) {
  const twitchInventory = require("../utils/twitchInventory");
  const host = fleet.pi();
  const result = new Map();
  const CONCURRENCY = 5;
  let next = 0;
  async function worker() {
    while (next < accounts.length) {
      const i = next++;
      const a = accounts[i];
      try {
        await twitchInventory.fetchInventory(a.clientSecret, { host });
        result.set(a.username, { ok: true });
      } catch (e) {
        result.set(a.username, {
          ok: false,
          why: e && e.code === "token_invalid" ? "token invalid" : e.message,
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker),
  );
  return result;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});

  const lower = USERNAMES.map((u) => u.toLowerCase());
  const rows = await AvailableAccount.find(
    { usernameLower: { $in: lower } },
    {
      username: 1,
      usernameLower: 1,
      status: 1,
      clientSecret: 1,
      twitchId: 1,
      manualSold: 1,
      listed: 1,
      soldGames: 1,
      claimedNote: 1,
      lastCheckStatus: 1,
    },
  ).lean();
  const byLower = new Map(rows.map((r) => [String(r.usernameLower || "").toLowerCase(), r]));

  // Classify every requested username.
  const farmable = [];
  const notFarmable = [];
  for (const u of USERNAMES) {
    const r = byLower.get(u.toLowerCase());
    if (!r) {
      notFarmable.push({ username: u, why: "not in pool" });
      continue;
    }
    const hasToken = !!(r.clientSecret && String(r.clientSecret).trim());
    const hasId = !!(r.twitchId && /^[0-9]+$/.test(String(r.twitchId)));
    if (hasToken && hasId) {
      farmable.push(r);
    } else {
      notFarmable.push({
        username: u,
        why: !hasToken ? "no token (clientSecret)" : "no/invalid numeric twitchId",
      });
    }
  }

  // Resolve the fleet + game string + duplicate secrets.
  const { bots, provisioning, imageBuilt } = await fleet.readFleet();
  const game = resolveGameString(bots);
  const dupes = await existingSecrets(bots).catch((e) => {
    log(`  (dupe scan skipped: ${e.message})`);
    return new Set();
  });
  const dupWarn = farmable.filter((r) => dupes.has(String(r.clientSecret)));

  let tokenCheck = new Map();
  if (VERIFY && farmable.length) {
    log(`\nVerifying ${farmable.length} token(s) via the Pi …`);
    tokenCheck = await verifyTokens(farmable).catch((e) => {
      log(`  (token verify skipped: ${e.message})`);
      return new Map();
    });
  }

  // ---- Report --------------------------------------------------------------
  log(`\n=== no-claim re-add (SOLD batch) — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  log(`Game string to write: "${game}"  (isNoClaimGame=${settings.isNoClaimGame(game)})`);
  log(`Fleet: ${bots.length} no-claim bot(s), image built=${imageBuilt}, provisioning=${provisioning}`);
  log(`\nFarmable (${farmable.length}):`);
  for (const r of farmable) {
    const tc = tokenCheck.get(r.username);
    const tcStr = tc ? (tc.ok ? "token OK" : `TOKEN FAIL: ${tc.why}`) : "";
    log(
      `  ${r.username.padEnd(14)} twitchId=${r.twitchId} manualSold=${r.manualSold ? "Y" : "n"}` +
        `${dupes.has(String(r.clientSecret)) ? "  ⚠ ALREADY IN A LIVE BOT" : ""}` +
        `${tcStr ? "  " + tcStr : ""}`,
    );
  }
  if (notFarmable.length) {
    log(`\nCannot farm (${notFarmable.length}) — need a token refresh / not found:`);
    for (const n of notFarmable) log(`  ${n.username.padEnd(14)} ${n.why}`);
  }
  if (dupWarn.length) {
    log(
      `\n⚠ ${dupWarn.length} account(s) are ALREADY in a live no-claim bot config. ` +
        `Adding them to a second bot makes them fight themselves for the Twitch session. ` +
        `Remove them from the other bot first, or drop them from this batch.`,
    );
  }
  const failedTokens = [...tokenCheck.entries()].filter(([, v]) => !v.ok);
  if (failedTokens.length) {
    log(`\n⚠ ${failedTokens.length} token(s) failed the live check and will farm NOTHING until refreshed.`);
  }

  if (!farmable.length) {
    log("\nNothing farmable — no bot created. (Refresh tokens first.)");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    const id = await fleet.nextBotId();
    log(`\nDRY RUN — would create no-claim bot ${id} (container ${fleet.containerFor(id)}) with ${farmable.length} account(s),`);
    log(`and set manualSold=true on the ${farmable.filter((r) => !r.manualSold).length} not-yet-flagged row(s).`);
    log("Re-run with --apply to do it.");
    await mongoose.disconnect();
    return;
  }

  // ---- Apply ---------------------------------------------------------------
  if (provisioning || (await fleet.provisionBusy())) {
    log("\nA build/provision is already running on the Pi. Try again shortly — nothing changed.");
    await mongoose.disconnect();
    return;
  }

  // 1) Guard: never re-listed / re-sold. Set-only (no $push), so no usageHistory
  //    enum risk. Leaves soldGames + status untouched.
  const toFlag = farmable.filter((r) => !r.manualSold).map((r) => r._id);
  if (toFlag.length) {
    const res = await AvailableAccount.updateMany(
      { _id: { $in: toFlag } },
      { $set: { manualSold: true } },
    );
    log(`\nmanualSold set on ${res.modifiedCount} account(s) (${farmable.length - toFlag.length} already flagged).`);
  } else {
    log(`\nAll ${farmable.length} account(s) were already manualSold.`);
  }

  // 2) Build the new bot from these specific accounts.
  const id = await fleet.nextBotId();
  await fleet.createBotFromAccounts(id, farmable, game);
  log(`\n✅ Created no-claim bot ${id} (container ${fleet.containerFor(id)}) with ${farmable.length} account(s), game "${game}".`);
  log("It is building/starting on the Pi now — watch the no-claim console logs (or: docker logs -f " + fleet.containerFor(id) + ").");
  log("To stop farming later: Release bot " + id + " in the no-claim console. manualSold stays set, so they will not be re-listed or re-sold.");

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
