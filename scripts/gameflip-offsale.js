#!/usr/bin/env node
// Gameflip off-sale (owner, 2026-10-15): our listings sit in "Other" without Gameflip's
// Game Accounts approval, so every listing of ours comes OFF Gameflip before the
// approval request is sent. Dry run by default.
//
//   node gameflip-offsale.js                      plan only (DB reads, no Gameflip call)
//   node gameflip-offsale.js --apply [--limit=N] [--kinds=orphan,unclaimed,noclaim,rentfarm,account,head,other]
//   node gameflip-offsale.js --apply --pending    retire the relist / renewal debts that could republish
//
// Per listing: end it on Gameflip (off sale -> delete -> read back) and count it gone ONLY on
// Gameflip's own 404, then settle the row with the release calls the sale watcher itself uses
// (utils/gameflipFulfiller settleLapsed / 404 branch). Rent-farm rows are only retired: the
// buffer pass returns their accounts itself, 5 per 15 min (each hand-back restarts a bot).
// A sold / sale_pending listing is never touched — the watcher books the sale.
// Touch /root/_gf_offsale/STOP to halt after the current listing.
"use strict";
const path = require("path");
const fs = require("fs");
const Module = require("module");

const ROOT = "/var/www/redeemer/nodeserver";
const HERE = "/root/_gf_offsale";
const BACKUP = path.join(ROOT, "_deploy_backup_20261015035350_gameflip-offsale");
process.chdir(ROOT);
const rq = Module.createRequire(path.join(ROOT, "server.js"));
rq("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PENDING = args.includes("--pending");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const KINDS = ((args.find((a) => a.startsWith("--kinds=")) || "").split("=")[1] || "orphan,unclaimed,noclaim,rentfarm,account,head,other")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ROW_GAP_MS = Number((args.find((a) => a.startsWith("--gap=")) || "").split("=")[1]) || 15000;

const DAY = "2026-10-15";
const OFFSALE = "off sale " + DAY + ": taken off Gameflip by the owner (listed outside Game Accounts; approval being requested) — do not relist";
const NOTE_TAG = "— taken off Gameflip " + DAY + " (owner: wrong category)";
const WHY = "taken off Gameflip " + DAY + " (owner: wrong category)";

// The watcher's own release helpers are not exported. Compile the LIVE file with them added to
// its exports, under its real filename, before anything else loads it — the same bytes the
// server runs, no copy of their logic here.
function loadWithExtras(rel, names) {
  const file = rq.resolve(rel);
  const src = fs.readFileSync(file, "utf8");
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  Module._cache[file] = m;
  m._compile(src + "\n;module.exports.__x = { " + names.join(", ") + " };\n", file);
  m.loaded = true;
  return m.exports;
}
const gf = loadWithExtras("./utils/gameflipFulfiller", [
  "releaseHeadAccount", "setReleased", "releaseSuppliedUnits", "retireNoclaimUnit",
]);
const X = gf.__x;
const mongoose = rq("mongoose");
const mp = rq("./utils/marketplaces");
const { gameflipGone } = rq("./utils/gameflipGone");
const settings = rq("./utils/settings");
const noclaim = rq("./utils/noclaimListings");
const uc = rq("./utils/unclaimedAutoList");
const ML = rq("./models/MarketplaceListing");
const UnclaimedAccount = rq("./models/UnclaimedAccount");

fs.mkdirSync(HERE, { recursive: true });
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const LOG = path.join(HERE, (APPLY ? "run-" : "plan-") + STAMP + ".jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(o) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...o });
  fs.appendFileSync(LOG, line + "\n");
  console.log(line);
}
const is429 = (e) => !!e && (e.status === 429 || /\b429\b|Too many attempts/i.test(String(e.message || e)));
const stopRequested = () => fs.existsSync(path.join(HERE, "STOP"));

function kindOf(r) {
  if (r.rentFarm) return "rentfarm";
  if (r.noclaimStock) return "noclaim";
  if (r.origin === "unclaimed") return "unclaimed";
  if (r.accountOffer) return "offer";
  if (r.accountId) return "account";
  if (r.autoDeliver && !r.bulkOfferId && !r.lotId && !(Number(r.lotSize) > 0)) return "head";
  return "other";
}

// End one listing on Gameflip. Gone = Gameflip's own 404, nothing less.
// Every listing was on sale at the 03:55Z backup, so the off-sale patch goes first; a listing
// that changed state since (sold, sale_pending) refuses it and is read once to say why.
async function endOnGameflip(id) {
  let endErr = null;
  try {
    const r = await mp.gameflipEndListing(id, { status: "onsale" });
    if (r && r.confirmed === true) return { gone: true };
  } catch (e) {
    endErr = e;
  }
  await sleep(3000);
  try {
    const st = await mp.gameflipListingState(id);
    return { gone: false, status: st.status || "?", error: endErr ? String(endErr.message).slice(0, 200) : "no confirmation", rate: is429(endErr) };
  } catch (e2) {
    if (gameflipGone(e2)) return { gone: true, late: true };
    return { gone: false, status: "unreadable", error: String((endErr || e2).message).slice(0, 200), rate: is429(endErr) || is429(e2) };
  }
}

// Retire FIRST (conditional on still active), release second — the watcher's order.
async function retire(row) {
  const was = String(row.accountLogin || "").slice(0, 120);
  const note = (row.note ? String(row.note) + " " : "") + NOTE_TAG +
    (was && !row.rentFarm ? "; account " + was + " handed back" : "");
  return ML.findOneAndUpdate(
    { _id: row._id, status: "active" },
    { $set: { status: "delisted", lastError: OFFSALE, relistAttempts: 0, relistRetryAt: null, note } },
    { returnDocument: "after" },
  );
}

// settleLapsed's release block, minus the renewal (nothing is renewed) — same calls, same order.
async function release(row, kind) {
  const out = { kind };
  let released = true;
  if (kind === "rentfarm") {
    out.release = "left to the buffer pass (5 per 15 min)";
    return out;
  } else if (row.accountId) {
    await gf.releaseAccount(row.accountId, row.set).catch((e) => { out.releaseError = e.message; });
    released = await X.setReleased(row.accountId, row.set);
    out.release = released ? "account released" : "account release NOT confirmed (link kept on the row)";
  } else if (row.accountOffer) {
    released = (await X.releaseSuppliedUnits(row, WHY)) !== false;
    out.release = released ? "supplied units released" : "supplied release failed";
  } else if (kind === "head") {
    const ok = await X.releaseHeadAccount(row).catch((e) => { out.releaseError = e.message; return false; });
    out.release = ok ? "head account released" : "head account NOT released (none / several / unnamed reservation — left held)";
  } else {
    out.release = "nothing to release";
  }
  if (released) {
    await ML.updateOne({ _id: row._id }, { $set: { accountId: "", units: [] } }).catch(() => {});
  }
  return out;
}

async function doRow(row) {
  const kind = kindOf(row);
  const base = { id: row.externalId, row: String(row._id), kind, title: String(row.title || "").slice(0, 70) };
  if (kind === "noclaim") {
    // The Listings Delist route's no-claim branch, call for call.
    await noclaim.beforeDelist(row);
    const down = (await noclaim.gameflipTakeDown(row.externalId).catch((e) => ({ state: "unreadable", status: "", error: e.message }))) || {};
    if (down.state !== "gone") {
      log({ ...base, result: down.state === "sold" ? "skipped-sold" : "failed", state: down.state, status: down.status, error: down.error });
      return { ok: down.state === "sold", rate: /429|Too many/i.test(String(down.error || "")) };
    }
    const r = await retire(row);
    const after = r ? await noclaim.afterDelist(r, { outcome: "delisted", gone: true }).catch((e) => ({ error: e.message })) : null;
    log({ ...base, result: r ? "ended+retired" : "ended (row changed meanwhile)", noclaim: after });
    return { ok: true };
  }
  if (kind === "unclaimed") return doUnclaimed(row, base);

  const end = await endOnGameflip(row.externalId);
  if (!end.gone) {
    const sold = end.status === "sold" || end.status === "sale_pending";
    log({ ...base, result: sold ? "skipped-" + end.status : "failed", status: end.status, error: end.error });
    return { ok: sold, rate: end.rate };
  }
  let r = await retire(row);
  let how = "ended+retired";
  if (!r) {
    // The watcher may have seen the 404 first and retired it ("removed"). Its 404 branch does
    // not hand a head row's account back — do that here.
    r = await ML.findById(row._id).lean();
    how = "ended; row was already " + (r && r.status);
    if (!r || r.status === "active" || r.status === "sold") {
      log({ ...base, result: "ended-but-row-" + (r && r.status), note: "left for a look" });
      return { ok: true };
    }
    if (kind !== "head") {
      log({ ...base, result: how, release: "done by the watcher" });
      return { ok: true };
    }
  }
  const rel = await release(row, kind);
  log({ ...base, result: how + (end.late ? " (gone on read-back)" : ""), ...rel });
  return { ok: true };
}

// Unclaimed (no-claim fleet) chains: the engine republishes a Gameflip head from its waiting
// units (repairGameflipChains) and never checks the market list, so its ledgers move first.
// Mirrors the engine's own "market off" branch for GGSel: units back to held stock ("skipped"),
// owner mark cleared, to be listed again only on the markets the game still allows (GGSel).
async function doUnclaimed(row, base) {
  const live = String(row.accountLogin || "").toLowerCase();
  const ledgers = await UnclaimedAccount.find({ set: row.set, market: "gameflip", status: "listed" }).lean();
  const waiting = ledgers.filter((l) => String(l.loginLower || "").toLowerCase() !== live);
  const hold = async (l) => {
    const u = await UnclaimedAccount.updateOne(
      { _id: l._id, status: "listed" },
      { $set: { status: "skipped", note: "held — Gameflip taken off for this game " + DAY + " (owner: wrong category)", lastCheckedAt: new Date(), lotId: "" } },
    ).catch(() => null);
    if (u && u.modifiedCount) await uc.markOwnerUnlisted(l).catch(() => {});
    return !!(u && u.modifiedCount);
  };
  let waitingHeld = 0;
  for (const l of waiting) if (await hold(l)) waitingHeld++;
  const end = await endOnGameflip(row.externalId);
  if (!end.gone) {
    const sold = end.status === "sold" || end.status === "sale_pending";
    log({ ...base, result: sold ? "skipped-" + end.status : "failed", status: end.status, error: end.error, waitingHeld });
    return { ok: sold, rate: end.rate };
  }
  let liveHeld = 0;
  for (const l of ledgers.filter((x) => String(x.loginLower || "").toLowerCase() === live)) if (await hold(l)) liveHeld++;
  const r = await retire(row);
  log({ ...base, result: r ? "ended+retired" : "ended (row changed meanwhile)", waitingHeld, liveHeld, ledgers: ledgers.length });
  return { ok: true };
}

// On sale on Gameflip at the 03:55Z backup with no ACTIVE row here: hand-made listings with no
// row at all, or a row we already closed (e.g. "sold") over a listing Gameflip still sells.
// Only the listing is ended; a closed row keeps its record.
async function orphans() {
  const f = path.join(BACKUP, "public-backup", "onsale-without-db-row.json");
  const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
  const out = [];
  for (const o of list) {
    if (await ML.exists({ marketplace: "gameflip", externalId: o.id, status: "active" })) continue;
    const closed = await ML.findOne({ marketplace: "gameflip", externalId: o.id }, { status: 1 }).lean();
    out.push({ ...o, rowStatus: closed ? closed.status : "no row" });
  }
  return out;
}

async function pendingDebts() {
  return ML.find({
    marketplace: "gameflip",
    status: { $in: ["sold", "removed"] },
    $or: [
      { lastError: /^auto-relist failed/, qtyRemaining: { $gt: 0 } },
      { lastError: /^expired on Gameflip — renewal pending/ },
    ],
  }).lean();
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const af = settings.getAutoFarm();
  const guards = {
    gameflipRentFarm: af.gameflipRentFarm, gameflipRenewExpired: af.gameflipRenewExpired,
    skipAll: (af.autoListSkipGames || []).includes("*"), skipLen: (af.autoListSkipGames || []).length,
    copy: af.autofarmOfferCopyMarkets, bulk: af.bulkPacksMarkets, ugm: af.unclaimedGameMarkets,
  };
  log({ phase: "start", apply: APPLY, kinds: KINDS, limit: LIMIT === Infinity ? null : LIMIT, gapMs: ROW_GAP_MS, guards });
  if (APPLY && (guards.gameflipRentFarm !== false || guards.gameflipRenewExpired !== false)) {
    throw new Error("refusing: the Gameflip republishers are not switched off (settings)");
  }

  if (PENDING) {
    const rows = await pendingDebts();
    for (const r of rows) {
      const was = "was: status " + r.status + ", qtyRemaining " + (r.qtyRemaining || 0) + ", lastError " + String(r.lastError || "").slice(0, 120);
      if (!APPLY) { log({ phase: "pending", id: r.externalId, plan: "cancel", was }); continue; }
      const u = await ML.updateOne(
        { _id: r._id, status: r.status, lastError: r.lastError },
        { $set: { qtyRemaining: 0, relistRetryAt: null, lastError: "relist/renewal cancelled " + DAY + " — Gameflip taken off by the owner (wrong category)", note: (r.note ? r.note + " " : "") + "— " + was } },
      );
      log({ phase: "pending", id: r.externalId, result: u.modifiedCount ? "cancelled" : "changed meanwhile — left", was });
    }
    await mongoose.disconnect();
    return;
  }

  const rows = await ML.find({ marketplace: "gameflip", status: "active" }).sort({ createdAt: 1 }).lean();
  const byKind = {};
  for (const r of rows) (byKind[kindOf(r)] = byKind[kindOf(r)] || []).push(r);
  const orph = await orphans();
  const counts = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length]));
  counts.orphan = orph.length;
  log({ phase: "plan", active: rows.length, counts });

  if (!APPLY) {
    // What the release step would do, from the DB alone.
    const DropLog = rq("./models/DropLog");
    let headOne = 0, headMany = 0, headNone = 0;
    for (const r of byKind.head || []) {
      const n = (await DropLog.distinct("account", { soldSetId: String(r.set), soldToUsername: gf.GF_CLAIM_TAG, soldAt: { $ne: null } })).length;
      if (n === 1) headOne++; else if (n > 1) headMany++; else headNone++;
    }
    const leased = (byKind.rentfarm || []).filter((r) => r.rentFarmRenewingAt).length;
    const noPool = (byKind.rentfarm || []).filter((r) => !r.rentFarmPoolId).length;
    let ucLedgers = 0;
    for (const r of byKind.unclaimed || []) ucLedgers += await UnclaimedAccount.countDocuments({ set: r.set, market: "gameflip", status: "listed" });
    log({ phase: "plan-detail", headOneReservation: headOne, headSeveral: headMany, headNone, rentfarmLeased: leased, rentfarmNoPoolId: noPool, unclaimedListedLedgers: ucLedgers, orphans: orph.map((o) => o.id + " [" + o.rowStatus + "] " + String(o.name).slice(0, 50)) });
    log({ phase: "pending-debts", n: (await pendingDebts()).length });
    await mongoose.disconnect();
    return;
  }

  const queue = [];
  for (const k of KINDS) {
    if (k === "orphan") orph.forEach((o) => queue.push({ orphan: o }));
    else (byKind[k] || []).forEach((r) => queue.push({ row: r }));
  }
  let done = 0, failStreak = 0, rateStreak = 0, paused = false;
  const retry = [];
  const tally = {};
  const bump = (k) => (tally[k] = (tally[k] || 0) + 1);
  try {
    for (let i = 0; i < queue.length && done < LIMIT; i++) {
      if (stopRequested()) { log({ phase: "stop-file" }); break; }
      const item = queue[i];
      let res;
      if (item.orphan) {
        const o = item.orphan;
        const end = await endOnGameflip(o.id);
        log({ id: o.id, kind: "orphan", rowStatus: o.rowStatus, title: String(o.name).slice(0, 70), result: end.gone ? "ended" : "failed", status: end.status, error: end.error });
        res = { ok: end.gone, rate: end.rate };
      } else {
        const fresh = await ML.findById(item.row._id).lean();
        if (!fresh || fresh.status !== "active") { log({ id: item.row.externalId, result: "skipped — row is " + (fresh && fresh.status) }); continue; }
        if (kindOf(fresh) === "unclaimed" && !paused) {
          await settings.setAutoFarm({ unclaimedAutoListPaused: true }, { actor: "claude:gameflip-offsale" });
          paused = true;
          log({ phase: "unclaimed engine paused for the Gameflip take-down" });
          await sleep(5000);
        }
        if (kindOf(fresh) !== "unclaimed" && paused) {
          await settings.setAutoFarm({ unclaimedAutoListPaused: false }, { actor: "claude:gameflip-offsale" });
          paused = false;
          log({ phase: "unclaimed engine resumed" });
        }
        res = await doRow(fresh).catch((e) => ({ ok: false, error: e.message, rate: is429(e) }));
        if (res.error) log({ id: fresh.externalId, result: "threw", error: String(res.error).slice(0, 200) });
      }
      done++;
      bump(res.ok ? "ok" : "failed");
      if (res.ok) { failStreak = 0; rateStreak = 0; }
      else {
        failStreak++;
        retry.push(item);
        if (res.rate) {
          rateStreak++;
          log({ phase: "rate-limited", waitMin: 3 * rateStreak });
          if (rateStreak >= 4) { log({ phase: "stopping: Gameflip keeps answering 429" }); break; }
          await sleep(180000 * rateStreak);
          continue;
        }
        if (failStreak >= 5) { log({ phase: "stopping: 5 failures in a row" }); break; }
      }
      await sleep(ROW_GAP_MS);
    }
  } finally {
    if (paused) {
      await settings.setAutoFarm({ unclaimedAutoListPaused: false }, { actor: "claude:gameflip-offsale" }).catch(() => {});
      log({ phase: "unclaimed engine resumed (finally)" });
    }
  }
  const left = await ML.countDocuments({ marketplace: "gameflip", status: "active" });
  log({ phase: "end", processed: done, tally, retryLater: retry.map((x) => (x.orphan ? x.orphan.id : x.row.externalId)), activeGameflipRowsLeft: left, log: LOG });
  await mongoose.disconnect();
}

main().catch(async (e) => {
  log({ phase: "fatal", error: e.message });
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
