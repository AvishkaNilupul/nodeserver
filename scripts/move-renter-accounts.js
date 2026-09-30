#!/usr/bin/env node
// Move SOME accounts between renter stacks — the partial-move counterpart to
// scripts/move-renter-stack.js (which moves a whole stack and retires it).
//
// WHY: rent-farm stacks drift into a bad shape. Orders always land in whichever
// stack the holder currently points at, so one stack grows huge while migrated
// stacks sit at 7-11 accounts. A TwitchDropsBot container degrades past roughly
// 50 accounts (thread decay — some accounts silently stop farming), so an
// oversized stack is not just untidy, it quietly loses drops.
//
// USAGE
//   node scripts/move-renter-accounts.js --from local/config_21.json \
//        --to local/config_22.json --count 40 [--apply]
//   node scripts/move-renter-accounts.js --from contabo/config_06.json \
//        --to contabo/config_03.json --all [--apply]
//   ... --logins a,b,c  moves exactly those.
//
// ORDERING — why this differs from the whole-stack move
// A whole-stack move stops the source container first, because every account in
// it is leaving. Here the source keeps running for the accounts that STAY, so we
// cannot just stop it. Instead the accounts are taken OUT of the source config
// first and the source is restarted, so they are live in NO config before they
// are written to the destination. That window costs a few idle minutes; the
// alternative — writing the destination first — would leave an account enabled
// in two configs at once, which is the one mistake that gets it banned.
//
// The ledger follows automatically: addRenterAccountsToConfig -> upsertRenterAccounts
// re-stamps host/configFile/container keyed by ClientSecret.
const path = require("path");
const APP = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(APP, ".env") });
const mongoose = require("mongoose");
const hosts = require(path.join(APP, "utils", "botHosts"));
const bc = require(path.join(APP, "routes", "botConfigRoutes"));
const stacks = require(path.join(APP, "utils", "renterBotStacks"));
const RenterAccount = require(path.join(APP, "models", "RenterAccount"));
const Renter = require(path.join(APP, "models", "Renter"));
const { logEvent } = require(path.join(APP, "utils", "systemLog"));
const { reservedSlots } = require(path.join(APP, "utils", "renterBotOps"));

function arg(n, d = null) { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; }
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const FROM = arg("from"), TO = arg("to"), COUNT = Number(arg("count", 0));
const LOGINS = (arg("logins", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_PER_BOT = Number(arg("max", 50));
function die(m) { console.error("ABORT: " + m); process.exit(1); }
function split(s) { const [h, f] = String(s || "").split("/"); return { h, f }; }

(async () => {
  if (!FROM || !TO) die("need --from host/config_NN.json --to host/config_NN.json");
  if (!ALL && !COUNT && !LOGINS.length) die("need --count N, --logins a,b,c, or --all");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const s = split(FROM), d = split(TO);
  const srcHost = hosts.resolveHost(s.h), dstHost = hosts.resolveHost(d.h);
  if (!srcHost || !dstHost) die("unknown host");

  const dstStack = await stacks.findStack(d.h, d.f);
  if (!dstStack) die(`${TO} is not a registered RenterBotStack`);

  const srcRaw = JSON.parse(await hosts.readFile(srcHost, s.f));
  const srcUsers = (srcRaw.TwitchSettings || {}).TwitchUsers || [];
  const dstRaw = JSON.parse(await hosts.readFile(dstHost, d.f));
  const dstUsers = (dstRaw.TwitchSettings || {}).TwitchUsers || [];
  const inherited = Array.isArray((srcRaw.TwitchSettings || {}).FavouriteGames) ? srcRaw.TwitchSettings.FavouriteGames
    : (Array.isArray(srcRaw.FavouriteGames) ? srcRaw.FavouriteGames : []);

  console.log(`\n=== ${FROM} (${srcUsers.length}) -> ${TO} (${dstUsers.length})  cap ${MAX_PER_BOT} ===`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN\n");

  // choose which entries move
  let chosen;
  if (LOGINS.length) {
    const want = new Set(LOGINS.map(l => l.toLowerCase()));
    chosen = srcUsers.filter(u => u && want.has(String(u.Login || "").toLowerCase()));
    const missing = [...want].filter(l => !chosen.some(u => String(u.Login).toLowerCase() === l));
    if (missing.length) die("not in the source config: " + missing.join(", "));
  } else {
    const n = ALL ? srcUsers.length : COUNT;
    chosen = srcUsers.filter(u => u && u.ClientSecret).slice(0, n);
  }
  const room = MAX_PER_BOT - dstUsers.length;
  if (chosen.length > room) {
    die(`destination would hold ${dstUsers.length + chosen.length}, over the ${MAX_PER_BOT} cap (room for ${room})`);
  }
  if (srcUsers.length - chosen.length > MAX_PER_BOT) {
    console.log(`  NOTE: source will still hold ${srcUsers.length - chosen.length}, above the ${MAX_PER_BOT} cap — another pass is needed.`);
  }

  // pin inherited games onto enabled blanks before they leave
  let pinned = 0;
  const entries = chosen.map(u => {
    const games = Array.isArray(u.FavouriteGames) ? u.FavouriteGames.filter(Boolean) : [];
    const enabled = u.Enabled !== false;
    let fav = games;
    if (!games.length && enabled && inherited.length) { fav = inherited.slice(); pinned++; }
    return { ClientSecret: u.ClientSecret, UniqueId: u.UniqueId || "", Login: u.Login || "",
             Id: u.Id == null ? "" : u.Id, Enabled: enabled, FavouriteGames: fav };
  });
  if (pinned) console.log(`  pinning ${JSON.stringify(inherited)} onto ${pinned} enabled blank entr(ies)`);

  // group by owning renter; refuse anything untracked
  const ledger = await RenterAccount.find({ clientSecret: { $in: entries.map(e => e.ClientSecret) } })
    .select("clientSecret renter login").lean();
  const bySecret = new Map(ledger.map(r => [r.clientSecret, r]));
  const groups = new Map(); const orphans = [];
  for (const e of entries) {
    const row = bySecret.get(e.ClientSecret);
    if (!row) { orphans.push(e.Login); continue; }
    const k = String(row.renter);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  if (orphans.length) die("entries with no RenterAccount row: " + orphans.join(", "));
  const renters = await Renter.find({}).select("username botHost botFile").lean();
  const rname = new Map(renters.map(r => [String(r._id), r.username]));

  // Capacity exactly as the destination write will count it — the stack's
  // registered capacity, less what is in it, less slots held for OTHER
  // renters' stopped accounts (utils/renterBotOps.reservedSlots) — checked per
  // renter group BEFORE the source is touched: a write refused after the
  // source was emptied left the accounts on no bot.
  const present = new Set(dstUsers.filter(u => u && typeof u === "object").map(u => u.ClientSecret));
  let fill = dstUsers.length;
  for (const [rid, l] of groups) {
    const reserved = await reservedSlots(d.h, d.f, present, { except: rid });
    if (fill + reserved + l.length > Number(dstStack.capacity)) {
      die(`destination ${TO} would hold ${fill + l.length} + ${reserved} slot(s) held for stopped renters — over its capacity ${dstStack.capacity}`);
    }
    fill += l.length;
  }
  console.log("\n  moving:");
  for (const [rid, l] of groups) console.log(`    ${String(rname.get(rid) || rid).padEnd(22)} ${l.length}`);
  console.log(`  source after: ${srcUsers.length - entries.length}   destination after: ${dstUsers.length + entries.length}`);

  if (!APPLY) { console.log("\nDRY RUN — nothing written."); await mongoose.disconnect(); return; }

  // 1. out of the source FIRST (never enabled in two configs at once)
  console.log("\n[1/4] removing from the source config…");
  let removed = 0;
  for (const e of entries) removed += await bc.removeAccountFromConfig(srcHost, s.f, { clientSecret: e.ClientSecret });
  console.log(`      removed ${removed}`);
  console.log("[2/4] restarting the source so it drops them…");
  try { await bc.restartConfigContainer(srcHost, s.f); console.log("      ok"); }
  catch (e) { console.log("      (restart failed: " + e.message + ")"); }

  // 2. into the destination (this repoints the ledger). A move keeps every
  // window as it was (keepWindow). A write that still fails puts the rest
  // back into the source, so nothing is left on no bot.
  console.log("[3/4] writing to the destination…");
  const written = new Set();
  try {
    for (const [rid, l] of groups) {
      const res = await bc.addRenterAccountsToConfig(dstHost, d.f, l, rid, { keepWindow: true });
      for (const e of l) written.add(e.ClientSecret);
      console.log(`      ${String(rname.get(rid) || rid).padEnd(22)} added=${res.added} (now ${res.total})`);
    }
  } catch (err) {
    console.log("      !! destination write failed: " + err.message + " — putting the rest back into the source");
    for (const [rid, l] of groups) {
      const back = l.filter(e => !written.has(e.ClientSecret));
      if (!back.length) continue;
      try {
        await bc.addRenterAccountsToConfig(srcHost, s.f, back, rid, { keepWindow: true });
        console.log(`      put back ${back.length} for ${rname.get(rid) || rid}`);
      } catch (e2) {
        console.log(`      !! COULD NOT put back (${e2.message}) — on no bot now: ${back.map(e => e.Login).join(", ")}`);
      }
    }
    try { await bc.restartConfigContainer(srcHost, s.f); } catch (e3) { console.log("      (source restart failed: " + e3.message + ")"); }
    throw err;
  }
  console.log("[4/4] starting/restarting the destination…");
  try {
    const ps = await hosts.dockerPs(dstHost).catch(() => ({}));
    const c = bc.containerForFile(d.f);
    const up = ps[c] && /^running/i.test(String(ps[c].state || ""));
    if (up) { await bc.restartConfigContainer(dstHost, d.f); console.log("      restarted " + c); }
    else { const r = await bc.startConfigContainer(dstHost, d.f); console.log("      started " + r.container); }
  } catch (e) { console.log("      !! " + e.message); }

  // verify
  const after = await RenterAccount.find({ clientSecret: { $in: entries.map(e => e.ClientSecret) } })
    .select("login host configFile").lean();
  const wrong = after.filter(a => a.host !== d.h || a.configFile !== d.f);
  console.log(`\n  ledger repointed: ${after.length - wrong.length}/${after.length}`);
  wrong.forEach(w => console.log(`  !! ${w.login} still ${w.host}/${w.configFile}`));
  await logEvent({
    category: "renter", action: "accounts_rebalanced", actor: "move-renter-accounts",
    subject: `${FROM} -> ${TO}`, count: entries.length,
    detail: `moved ${entries.length} renter account(s) to keep bots at or below ${MAX_PER_BOT}`,
  });
  console.log("DONE.");
  await mongoose.disconnect();
})().catch(e => { console.error("FAIL", e && e.stack); process.exit(1); });
