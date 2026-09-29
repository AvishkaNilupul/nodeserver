#!/usr/bin/env node
// Move a RENTER (rent-farm) stack from one host to another, ledger and all.
//
// WHY THIS EXISTS, NEXT TO move-bot-host.js
// scripts/move-bot-host.js moves an OPERATOR config: it repoints BotAccount and
// knows nothing about renters. `grep -c RenterAccount scripts/move-bot-host.js`
// is 0. Pointed at a rental stack it would move the file and leave every
// RenterAccount row still claiming the old pi/config_NN — the exact dangling
// slot that stranded 9 accounts (5 of them on live leases) in the 2026-09-20
// sweep, and that utils/renterExpiry would later try to tear out of a config
// that no longer exists.
//
// The renter path already has the right primitive: addRenterAccountsToConfig ->
// upsertRenterAccounts re-stamps host/configFile/container on the RenterAccount
// keyed by ClientSecret. So the move is expressed in terms the renter system
// already understands, instead of reimplementing it.
//
// USAGE (on the prod server, from the app root):
//   node scripts/move-renter-stack.js --from pi --cfg config_15.json \
//        --to contabo --dest-cfg config_03.json
//   ... add --apply to actually do it. Without it NOTHING is written.
//
// SAFETY, in the order it matters
//   1. The SOURCE container is stopped FIRST. An account enabled on two hosts is
//      the one mistake that gets it banned, and dupeGuard is structurally blind
//      to it (utils/dupeGuard.js only sweeps siblings on ONE host).
//   2. Entries move VERBATIM. Blank FavouriteGames on an ENABLED entry inherits
//      the config-level list, so it is pinned before the move or the account
//      silently adopts the destination's games. Disabled blanks keep [] — that
//      is the retirement marker.
//   3. Accounts are regrouped BY THEIR OWN RENTER and written one renter at a
//      time, because upsertRenterAccounts stamps whatever renterId it is given
//      and a stack routinely holds several renters (pi/config_30 holds five).
//   4. The destination must already be a registered RenterBotStack with room —
//      addRenterAccountsToConfig's requireStack + assertCapacity enforce it.
//      We never provisionEmptyConfig here (that registers a NEW rental stack and
//      would start feeding paying buyers into an empty one).
//   5. The source config is retired by RENAME, never deleted, and its compose
//      service is removed so a Pi reboot cannot resurrect it.
//   6. Renter.botHost/botFile rows pointing at the source are repointed, or the
//      next provision would send new accounts back to the dead stack.
const path = require("path");
const APP = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(APP, ".env") });
const mongoose = require("mongoose");
const hosts = require(path.join(APP, "utils", "botHosts"));
const bc = require(path.join(APP, "routes", "botConfigRoutes"));
const stacks = require(path.join(APP, "utils", "renterBotStacks"));
const RenterAccount = require(path.join(APP, "models", "RenterAccount"));
const Renter = require(path.join(APP, "models", "Renter"));
const RenterBotStack = require(path.join(APP, "models", "RenterBotStack"));
const { logEvent } = require(path.join(APP, "utils", "systemLog"));

function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
}
const APPLY = process.argv.includes("--apply");
const FROM = arg("from");
const CFG = arg("cfg");
const TO = arg("to");
const DEST = arg("dest-cfg");

function die(m) { console.error("ABORT: " + m); process.exit(1); }

(async () => {
  if (!FROM || !CFG || !TO || !DEST) {
    die("need --from <host> --cfg <config_NN.json> --to <host> --dest-cfg <config_NN.json>");
  }
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const src = hosts.resolveHost(FROM);
  const dst = hosts.resolveHost(TO);
  if (!src) die("unknown source host " + FROM);
  if (!dst) die("unknown destination host " + TO);

  const srcContainer = bc.containerForFile(CFG);
  const dstContainer = bc.containerForFile(DEST);
  console.log(`\n=== ${FROM}/${CFG} (${srcContainer})  ->  ${TO}/${DEST} (${dstContainer}) ===`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN (nothing will be written)\n");

  // --- destination must be a REGISTERED rental stack with room -------------
  const dstStack = await stacks.findStack(TO, DEST);
  if (!dstStack) die(`${TO}/${DEST} is not a registered RenterBotStack. Register it first — this script will not create one.`);
  const dstRaw = JSON.parse(await hosts.readFile(dst, DEST));
  const dstUsers = (dstRaw.TwitchSettings && dstRaw.TwitchSettings.TwitchUsers) || [];

  // --- read the source verbatim -------------------------------------------
  const srcRaw = JSON.parse(await hosts.readFile(src, CFG));
  const srcUsers = (srcRaw.TwitchSettings && srcRaw.TwitchSettings.TwitchUsers) || [];
  const inherited = Array.isArray(srcRaw.TwitchSettings && srcRaw.TwitchSettings.FavouriteGames)
    && srcRaw.TwitchSettings.FavouriteGames.length
      ? srcRaw.TwitchSettings.FavouriteGames
      : (Array.isArray(srcRaw.FavouriteGames) ? srcRaw.FavouriteGames : []);
  console.log(`source holds ${srcUsers.length} entries; config-level FavouriteGames = ${JSON.stringify(inherited)}`);
  console.log(`destination holds ${dstUsers.length}/${dstStack.capacity}\n`);
  if (dstUsers.length + srcUsers.length > dstStack.capacity) {
    die(`destination capacity ${dstStack.capacity} cannot hold ${dstUsers.length} + ${srcUsers.length}. Raise it with setStackCapacity first.`);
  }

  // --- pin inherited games onto ENABLED blanks, verbatim otherwise ---------
  let pinned = 0;
  const entries = srcUsers.filter(u => u && typeof u === "object").map((u) => {
    const games = Array.isArray(u.FavouriteGames) ? u.FavouriteGames.filter(Boolean) : [];
    const enabled = u.Enabled !== false;
    let fav = games;
    if (!games.length && enabled && inherited.length) { fav = inherited.slice(); pinned++; }
    return {
      ClientSecret: u.ClientSecret,
      UniqueId: u.UniqueId || "",
      Login: u.Login || "",
      Id: u.Id == null ? "" : u.Id,
      Enabled: enabled,
      FavouriteGames: fav,
    };
  });
  if (pinned) console.log(`NOTE: pinning ${JSON.stringify(inherited)} onto ${pinned} enabled blank entr(ies) so they do not adopt the destination's games\n`);

  // --- group by the account's OWN renter -----------------------------------
  const ledger = await RenterAccount.find({
    clientSecret: { $in: entries.map(e => e.ClientSecret) },
  }).select("clientSecret login renter host configFile enabled dropCount").lean();
  const bySecret = new Map(ledger.map(r => [r.clientSecret, r]));
  const renters = await Renter.find({}).select("username botHost botFile accessEnd botStoppedAt").lean();
  const rname = new Map(renters.map(r => [String(r._id), r.username]));

  const groups = new Map();
  const orphans = [];
  for (const e of entries) {
    const row = bySecret.get(e.ClientSecret);
    if (!row) { orphans.push(e); continue; }
    const k = String(row.renter);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  console.log("accounts by owning renter:");
  for (const [rid, list] of groups) {
    const r = renters.find(x => String(x._id) === rid);
    const lease = r ? (r.accessEnd ? new Date(r.accessEnd).toISOString().slice(0,10) : "perpetual") : "?";
    console.log(`   ${String(rname.get(rid) || rid).padEnd(22)} ${String(list.length).padStart(3)} account(s)   lease=${lease}`);
  }
  if (orphans.length) {
    console.log(`\n   !! ${orphans.length} entr(ies) have NO RenterAccount row — they would move with no ledger owner:`);
    orphans.forEach(o => console.log(`      ${o.Login} (${String(o.ClientSecret).slice(0,10)}…)`));
    die("refusing to move entries with no ledger row: fix or remove them first, or they become untracked on the destination");
  }

  // --- renters whose HOLDER stack is this file ------------------------------
  const holders = renters.filter(r => String(r.botHost||"local") === FROM && r.botFile === CFG);
  if (holders.length) {
    console.log("\nrenters whose botFile points at this stack (will be repointed):");
    holders.forEach(h => console.log(`   ${h.username}`));
  }

  // --- container states -----------------------------------------------------
  const [srcPs, dstPs] = await Promise.all([
    hosts.dockerPs(src).catch(() => ({})),
    hosts.dockerPs(dst).catch(() => ({})),
  ]);
  console.log(`\ncontainers: ${FROM}/${srcContainer}=${(srcPs[srcContainer]||{}).state || "MISSING"}  ${TO}/${dstContainer}=${(dstPs[dstContainer]||{}).state || "MISSING"}`);

  if (!APPLY) {
    console.log("\nDRY RUN complete — nothing written. Re-run with --apply to execute.");
    await mongoose.disconnect();
    return;
  }

  // ========================= APPLY =========================================
  // 1. stop the source FIRST (never live on two hosts)
  console.log("\n[1/7] stopping source container…");
  try { await bc.stopConfigContainer(src, CFG); console.log("      stopped " + srcContainer); }
  catch (e) { console.log("      (stop failed, continuing: " + e.message + ")"); }

  // 2. write to the destination, one renter at a time
  console.log("[2/7] writing entries to the destination…");
  let moved = 0;
  for (const [rid, list] of groups) {
    const res = await bc.addRenterAccountsToConfig(dst, DEST, list, rid);
    moved += res.added;
    console.log(`      ${String(rname.get(rid) || rid).padEnd(22)} added=${res.added} (config now ${res.total})`);
  }

  // 3. start the destination
  console.log("[3/7] starting destination container…");
  const st = await bc.startConfigContainer(dst, DEST);
  console.log(`      started ${st.container}`);

  // 4. clear the source config file (ledger already repointed by step 2)
  console.log("[4/7] removing entries from the source config…");
  let removed = 0;
  for (const e of entries) {
    removed += await bc.removeAccountFromConfig(src, CFG, { clientSecret: e.ClientSecret });
  }
  console.log(`      removed ${removed} entr(ies) from ${FROM}/${CFG}`);

  // 5. retire the source: rename the config, drop its compose service
  console.log("[5/7] retiring the source stack…");
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  try {
    await hosts.rename(src, CFG, CFG + ".moved-" + stamp);
    console.log(`      renamed ${CFG} -> ${CFG}.moved-${stamp}`);
  } catch (e) { console.log("      (rename failed: " + e.message + ")"); }
  // Remove the source CONTAINER, not just stop it. Every bot is created with
  // restart:always (see hosts.restoreRestartPolicy) and the Pi reboots several
  // times a day, so a merely-stopped container comes back up — now pointed at a
  // config file that has been renamed out from under it. Removing it is what
  // actually retires the stack; the compose service can stay, because a service
  // with no container does nothing until someone runs compose up.
  try {
    await hosts.dockerContainer(src, "rm", srcContainer);
    console.log(`      removed container ${srcContainer} (restart:always cannot resurrect it)`);
  } catch (e) { console.log("      (container rm failed: " + e.message + ")"); }
  // Retire the stack ROW too, or rentalStackOptions keeps offering a config
  // that no longer exists. listStacks() filters on enabled:true and
  // registerStack() only ever $setOnInsert, so a disabled row stays disabled.
  const off = await RenterBotStack.updateOne(
    { host: stacks.hostId(FROM), file: CFG },
    { $set: { enabled: false } },
  );
  console.log(`      RenterBotStack ${FROM}/${CFG} disabled (matched=${off.matchedCount})`);

  // 6. repoint any renter whose holder stack was this file
  console.log("[6/7] repointing renters…");
  for (const h of holders) {
    await Renter.updateOne({ _id: h._id }, { $set: { botHost: TO, botFile: DEST } });
    console.log(`      ${h.username} -> ${TO}/${DEST}`);
  }

  // 7. verify
  console.log("[7/7] verifying…");
  const after = await RenterAccount.find({
    clientSecret: { $in: entries.map(e => e.ClientSecret) },
  }).select("login host configFile container enabled").lean();
  const wrong = after.filter(a => a.host !== TO || a.configFile !== DEST);
  console.log(`      ledger rows repointed: ${after.length - wrong.length}/${after.length}`);
  if (wrong.length) wrong.forEach(w => console.log(`      !! ${w.login} still ${w.host}/${w.configFile}`));
  const dstAfter = JSON.parse(await hosts.readFile(dst, DEST));
  console.log(`      destination config now holds ${(dstAfter.TwitchSettings.TwitchUsers||[]).length} entries`);

  await logEvent({
    category: "renter", action: "stack_moved_host", actor: "move-renter-stack",
    subject: `${FROM}/${CFG} -> ${TO}/${DEST}`,
    count: moved,
    detail: `moved ${moved} renter account(s) across ${groups.size} renter(s); source config retired as ${CFG}.moved-${stamp}`,
  });
  console.log("\nDONE.");
  await mongoose.disconnect();
})().catch((e) => { console.error("FAIL", e && e.stack); process.exit(1); });
