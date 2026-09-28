// free_plati.js — owner request 2026-09-28 ("yes plati and ggsell"): the Plati
// (Digiseller) seller account is blocked, so take every live Plati product off
// sale and send its accounts to the markets that sell.
//
// For each active digiseller row: disable the product, then delete each of its
// undelivered delivery codes by contentId. A delete that SUCCEEDS proves that
// code was still in the product's vault — i.e. the account was never sold — and
// only such accounts get their (account, set, "digiseller") drop reservation
// released. A delete that fails (already delivered, unknown) keeps the account
// reserved. Accounts also live on another market's active listing of the same
// set are never released. Rows owned by other layers (no-claim, account
// listings, unclaimed) are skipped.
//
// Dry run by default: reads only, calls nothing, writes nothing but the
// before-state JSON. --apply acts. Serial and paced; stops after 15 platform
// failures in a row. Undo data: /root/_rehome_work/free_plati_before_<ts>.json
// (rows + every DropLog reservation field it would release).
// Run ON PROD from the repo root: node scripts/<this file> [--apply]
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const req = (m) => require(m.startsWith("./") ? path.join(__dirname, "..", m) : m);
req("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = req("mongoose");
const config = req("./config/config");

const APPLY = process.argv.includes("--apply");
// Digiseller allows only a few dozen seller requests a minute ("seller-limit-1"
// hit at ~60/min on the first run): one call every ~2 s, and a rate-limit answer
// waits a minute and retries instead of counting as a failure.
const PACE_MS = 2100;
const LIMIT_RE = /seller-limit|requests per minute/i;
const MAX_FAIL_STREAK = 15;
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function paced(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < 6 && LIMIT_RE.test(String((e && e.message) || e))) {
        await wait(65000);
        continue;
      }
      throw e;
    }
  }
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  await mongoose.connect(config.MONGO_URI);
  const mp = req("./utils/marketplaces");
  const { releaseSetForAccounts } = req("./utils/dropReservation");
  const { logEvent } = req("./utils/systemLog");
  const db = mongoose.connection.db;
  const Listings = db.collection("marketplacelistings");

  const all = await Listings.find(
    { marketplace: "digiseller", status: "active", rentFarm: { $ne: true } },
    { projection: { externalId: 1, set: 1, origin: 1, status: 1, note: 1, lastError: 1, accountId: 1, units: 1, noclaimStock: 1, accountOffer: 1, unclaimedGame: 1, lastStock: 1, qtyTarget: 1, title: 1 } },
  ).toArray();
  const ownLayer = (r) => r.noclaimStock || r.accountOffer || r.unclaimedGame || r.origin === "unclaimed";
  const rows = all.filter((r) => !ownLayer(r) && r.externalId);
  const skippedRows = all.filter((r) => ownLayer(r) || !r.externalId);

  // Accounts on OTHER markets' active listings, per set: never released.
  const others = await Listings.find(
    { status: "active", marketplace: { $ne: "digiseller" }, set: { $ne: null } },
    { projection: { set: 1, accountId: 1, units: 1 } },
  ).toArray();
  const liveElsewhere = new Set();
  for (const r of others) {
    for (const a of String(r.accountId || "").split(",").map((s) => s.trim()).filter(Boolean)) liveElsewhere.add(String(r.set) + "|" + a);
    for (const u of r.units || []) if (!u.deliveredAt && u.accountId) liveElsewhere.add(String(r.set) + "|" + String(u.accountId));
  }

  // Every (account, set) that is an undelivered code on some Plati row.
  const unitRows = new Map(); // set|account -> [rowId]
  let codes = 0;
  for (const r of rows) {
    for (const u of r.units || []) {
      if (u.deliveredAt || !u.contentId || !u.accountId) continue;
      codes++;
      const k = String(r.set) + "|" + String(u.accountId);
      (unitRows.get(k) || unitRows.set(k, []).get(k)).push(String(r._id));
    }
  }

  // Before-state: rows + every reservation field a release would reset.
  const pairs = [...unitRows.keys()].map((k) => k.split("|"));
  const drops = [];
  for (let i = 0; i < pairs.length; i += 200) {
    const chunk = pairs.slice(i, i + 200);
    const found = await db.collection("droplogs").find(
      { $or: chunk.map(([set, acct]) => ({ account: new mongoose.Types.ObjectId(acct), soldSetId: set, soldToUsername: "digiseller", soldAt: { $ne: null } })) },
      { projection: { account: 1, soldAt: 1, soldToUsername: 1, soldToAdminId: 1, soldSetId: 1, soldBulkOrderId: 1 } },
    ).toArray();
    drops.push(...found);
  }
  const backup = `/root/_rehome_work/free_plati_before_${TS}.json`;
  fs.mkdirSync("/root/_rehome_work", { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ at: new Date(), apply: APPLY, rows: all, reservations: drops }, null, 0));

  const crossListed = [...unitRows.keys()].filter((k) => liveElsewhere.has(k)).length;
  log(`${APPLY ? "APPLY" : "DRY RUN"}: ${rows.length} Plati rows to take down (${skippedRows.length} skipped: own layer), ${codes} codes, ${unitRows.size} account/set pairs (${crossListed} also live elsewhere → kept), ${drops.length} reserved drops behind them. Backup ${backup}`);
  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  const out = { rowsDown: 0, rowsFailed: 0, codesDeleted: 0, codesFailed: 0, released: 0, keptLiveElsewhere: 0, keptUnproven: 0, failures: [] };
  const proven = new Map(); // rowId -> Set(account)
  let streak = 0;
  for (const [i, r] of rows.entries()) {
    if (streak >= MAX_FAIL_STREAK) { log(`STOP: ${streak} platform failures in a row`); break; }
    const rowId = String(r._id);
    let down = false;
    try {
      await paced(() => mp.digisellerDelist(r.externalId));
      down = true;
      streak = 0;
    } catch (e) {
      const why = String((e && e.message) || e);
      if (mp.delistOutcome(why)) { down = true; streak = 0; } else { streak++; out.rowsFailed++; out.failures.push({ row: rowId, ext: r.externalId, step: "disable", why: why.slice(0, 200) }); }
    }
    await wait(PACE_MS);
    if (!down) continue;
    const ok = new Set();
    for (const u of r.units || []) {
      if (u.deliveredAt || !u.contentId || !u.accountId) continue;
      try {
        await paced(() => mp.digisellerRemoveContent(r.externalId, u.contentId));
        ok.add(String(u.accountId));
        out.codesDeleted++;
        streak = 0;
      } catch (e) {
        out.codesFailed++;
        streak++;
        out.failures.push({ row: rowId, ext: r.externalId, step: "code", login: u.login, why: String((e && e.message) || e).slice(0, 200) });
      }
      await wait(PACE_MS);
      if (streak >= MAX_FAIL_STREAK) break;
    }
    proven.set(rowId, ok);
    await Listings.updateOne(
      { _id: r._id, status: "active" },
      {
        $set: {
          status: "delisted",
          lastError: "",
          note: ((r.note ? r.note + " " : "") + `freed ${TS.slice(0, 8)}: Plati switched off (seller blocked) — product disabled, ${ok.size} code(s) removed, those accounts released to other markets`).slice(0, 900),
        },
      },
    );
    out.rowsDown++;
    if ((i + 1) % 25 === 0) log(`progress ${i + 1}/${rows.length}: down ${out.rowsDown}, codes deleted ${out.codesDeleted}, failed ${out.codesFailed}`);
  }

  // Release an account only when EVERY Plati row it was a code on proved it
  // unsold, and it is on no other market's live listing of that set.
  for (const [k, rowIds] of unitRows.entries()) {
    const [set, acct] = k.split("|");
    if (liveElsewhere.has(k)) { out.keptLiveElsewhere++; continue; }
    if (!rowIds.every((id) => proven.has(id) && proven.get(id).has(acct))) { out.keptUnproven++; continue; }
    await releaseSetForAccounts([acct], set, "digiseller");
    out.released++;
  }

  logEvent({
    category: "listings",
    action: "plati_freed",
    actor: "claude (owner: free Plati + GGSel)",
    count: out.released,
    detail: `Plati freed: ${out.rowsDown} products disabled (${out.rowsFailed} failed), ${out.codesDeleted} codes removed (${out.codesFailed} failed), ${out.released} account/set reservations released, ${out.keptUnproven} kept (unproven), ${out.keptLiveElsewhere} kept (live elsewhere). Undo: ${backup}`,
  });
  await wait(1500);
  log("DONE", JSON.stringify({ ...out, failures: out.failures.length }));
  fs.writeFileSync(`/root/_rehome_work/free_plati_result_${TS}.json`, JSON.stringify(out, null, 1));
  log("failures (first 10):", JSON.stringify(out.failures.slice(0, 10)));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
