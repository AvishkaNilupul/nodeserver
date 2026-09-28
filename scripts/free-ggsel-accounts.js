// free_ggsel.js — owner request 2026-09-28 ("yes plati and ggsell"): take the
// accounts off GGSel and let the other markets sell them.
//
// GGSel's API cannot take an offer off sale (batch_pause answers 200 and a job
// id but never applies; PATCH refuses `status`) — so the OWNER pauses the offers
// in the GGSel seller panel, and this script only releases what is provably
// safe afterwards:
//   - only offers GGSel itself reports as NOT active (paused/draft/gone);
//   - per (set) of our paused GGSel rows: R = accounts whose drops are reserved
//     with tag "ggsel" for that set; GGSel's own counters give S (codes still in
//     the offer) and X (codes it sold). X == 0 → every reserved account is still
//     in the vault → release all R. X > 0 → release only when exactly X of R are
//     connected (a buyer claimed them), and then release the rest. Anything
//     else → keep all reserved (which ones sold cannot be told apart).
//   - an account also on another market's active listing of the set is kept.
// No-claim rows (origin "unclaimed") are left to the engine's reconcile, which
// closes a non-active GGSel row itself. Rows released here are marked delisted.
//
// Dry run by default (reads GGSel + DB, writes nothing but the before-state
// JSON; also reports what an all-paused run WOULD release). --apply acts.
// Run ON PROD from the repo root: node scripts/<this file> [--apply]
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const req = (m) => require(m.startsWith("./") ? path.join(__dirname, "..", m) : m);
req("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = req("mongoose");
const config = req("./config/config");

const APPLY = process.argv.includes("--apply");
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  await mongoose.connect(config.MONGO_URI);
  const mp = req("./utils/marketplaces");
  const { releaseSetForAccounts } = req("./utils/dropReservation");
  const { logEvent } = req("./utils/systemLog");
  const db = mongoose.connection.db;
  const Listings = db.collection("marketplacelistings");

  const rows = await Listings.find(
    { marketplace: "ggsel", status: "active", rentFarm: { $ne: true } },
    { projection: { externalId: 1, set: 1, origin: 1, note: 1, accountId: 1, units: 1, noclaimStock: 1, accountOffer: 1, unclaimedGame: 1, title: 1 } },
  ).toArray();
  const mine = rows.filter((r) => !(r.noclaimStock || r.accountOffer || r.unclaimedGame || r.origin === "unclaimed") && r.externalId && r.set);

  // GGSel's own view of every offer: the paged list is only a fallback for an
  // offer whose single read fails. If the LIST itself fails (GGSel's nginx
  // 504s), "not in the list" proves nothing: such an offer reads as unknown,
  // never as gone.
  let list = [];
  let listOk = true;
  try {
    list = await mp.ggselAllOffers();
  } catch (e) {
    listOk = false;
    log("offer list unreadable (" + String(e.message).slice(0, 60) + ") — using single-offer reads only");
  }
  const status = new Map(list.map((o) => [String(o.id), String(o.status || "")]));
  const offStatus = (ext) =>
    status.has(String(ext)) ? status.get(String(ext)) : listOk ? "gone" : "";

  // Counters per offer (one paced single-offer read each): status, codes still
  // in stock, codes sold. ggselReadOffer is not exported, so this is the same
  // GET it makes, with the same auth header.
  const counters = new Map();
  const axios = req("axios");
  const { loadSettings } = req("./utils/settings");
  const enc = (loadSettings().marketplaces || {}).ggsel || {};
  const apiKey = req("./utils/secretBox").decrypt(enc.apiKey || "") || enc.apiKey;
  const H = { Authorization: apiKey, "Content-Type": "application/json" };
  for (const r of mine) {
    const ext = String(r.externalId);
    try {
      const g = await axios.get("https://seller.ggsel.com/api_sellers/v2/offers/" + Number(ext), { headers: H, timeout: 20000 });
      const d = (g.data && g.data.data) || g.data || {};
      const split = !!d.has_splitted_products;
      counters.set(ext, {
        status: String(d.status || offStatus(ext)),
        inStock: Number(split ? d.in_stock_splitted_products_count : d.in_stock_products_count) || 0,
        sold: Number(split ? d.sold_splitted_products_count : d.sold_products_count) || 0,
      });
    } catch (e) {
      counters.set(ext, { status: offStatus(ext), inStock: null, sold: null, err: e.response ? "HTTP " + e.response.status : e.message });
    }
    await wait(250);
  }

  // Reserved accounts per set (tag ggsel), with "any drop connected".
  const setIds = [...new Set(mine.map((r) => String(r.set)))];
  const resv = await db.collection("droplogs").aggregate([
    { $match: { soldAt: { $ne: null }, soldToUsername: "ggsel", soldSetId: { $in: setIds } } },
    { $group: { _id: { s: "$soldSetId", a: "$account" }, conn: { $max: { $cond: [{ $eq: ["$connected", true] }, 1, 0] } } } },
  ]).toArray();
  const bySet = new Map();
  for (const x of resv) {
    const m = bySet.get(String(x._id.s)) || new Map();
    m.set(String(x._id.a), !!x.conn);
    bySet.set(String(x._id.s), m);
  }
  const others = await Listings.find({ status: "active", marketplace: { $ne: "ggsel" }, set: { $in: mine.map((r) => r.set) } }, { projection: { set: 1, accountId: 1, units: 1 } }).toArray();
  const liveElsewhere = new Set();
  for (const r of others) {
    for (const a of String(r.accountId || "").split(",").map((s) => s.trim()).filter(Boolean)) liveElsewhere.add(String(r.set) + "|" + a);
    for (const u of r.units || []) if (!u.deliveredAt && u.accountId) liveElsewhere.add(String(r.set) + "|" + String(u.accountId));
  }

  // Decide per set, over every one of our GGSel rows of that set.
  const plan = [];
  const bySetRows = new Map();
  for (const r of mine) (bySetRows.get(String(r.set)) || bySetRows.set(String(r.set), []).get(String(r.set))).push(r);
  for (const [set, rs] of bySetRows.entries()) {
    const c = rs.map((r) => counters.get(String(r.externalId)) || {});
    const allOff = c.every((x) => x.status && x.status !== "active");
    const known = c.every((x) => x.sold != null && x.inStock != null);
    const X = c.reduce((n, x) => n + (Number(x.sold) || 0), 0);
    const S = c.reduce((n, x) => n + (Number(x.inStock) || 0), 0);
    const m = bySet.get(set) || new Map();
    const R = [...m.keys()];
    const connected = R.filter((a) => m.get(a));
    let release = [];
    let why = "";
    if (!known) why = "counters unreadable";
    else if (X === 0) { release = R; why = "nothing sold"; }
    else if (connected.length === X) { release = R.filter((a) => !m.get(a)); why = "sold = connected"; }
    else why = `sold ${X}, connected ${connected.length} — cannot tell which`;
    release = release.filter((a) => !liveElsewhere.has(set + "|" + a));
    plan.push({ set, rows: rs.map((r) => String(r._id)), exts: rs.map((r) => String(r.externalId)), allOff, S, X, R: R.length, release, why });
  }
  const wouldIfPaused = plan.reduce((n, p) => n + p.release.length, 0);
  const ready = plan.filter((p) => p.allOff);
  const releaseNow = ready.reduce((n, p) => n + p.release.length, 0);
  const statusCount = {};
  for (const r of mine) { const s = (counters.get(String(r.externalId)) || {}).status || "?"; statusCount[s] = (statusCount[s] || 0) + 1; }

  // Before-state for undo: rows + every reservation field that would be reset.
  const pairs = ready.flatMap((p) => p.release.map((a) => [p.set, a]));
  const drops = [];
  for (let i = 0; i < pairs.length; i += 200) {
    const chunk = pairs.slice(i, i + 200);
    if (!chunk.length) break;
    drops.push(...(await db.collection("droplogs").find(
      { $or: chunk.map(([set, a]) => ({ account: new mongoose.Types.ObjectId(a), soldSetId: set, soldToUsername: "ggsel", soldAt: { $ne: null } })) },
      { projection: { account: 1, soldAt: 1, soldToUsername: 1, soldToAdminId: 1, soldSetId: 1, soldBulkOrderId: 1 } },
    ).toArray()));
  }
  const backup = `/root/_rehome_work/free_ggsel_before_${TS}.json`;
  fs.writeFileSync(backup, JSON.stringify({ at: new Date(), apply: APPLY, rows, plan, reservations: drops }, null, 0));
  log(`${APPLY ? "APPLY" : "DRY RUN"}: ${mine.length} GGSel rows (${rows.length - mine.length} left to their own layer), GGSel status ${JSON.stringify(statusCount)}. Sets ${plan.length}: ready (all offers off sale) ${ready.length}. Release now ${releaseNow} account/set pairs; if every offer were paused: ${wouldIfPaused}. Backup ${backup}`);
  const whyCount = {};
  for (const p of plan) whyCount[p.why.split(" —")[0]] = (whyCount[p.why.split(" —")[0]] || 0) + 1;
  log("per-set verdicts:", JSON.stringify(whyCount));
  if (!APPLY || !ready.length) { await mongoose.disconnect(); return; }

  let released = 0;
  for (const p of ready) {
    for (const a of p.release) { await releaseSetForAccounts([a], p.set, "ggsel"); released++; }
    await Listings.updateMany(
      { _id: { $in: p.rows.map((id) => new mongoose.Types.ObjectId(id)) }, status: "active" },
      { $set: { status: "delisted", lastError: "", note: `freed ${TS.slice(0, 8)}: GGSel switched off by the owner (offer paused on GGSel) — ${p.release.length} account(s) released (${p.why})` } },
    );
  }
  logEvent({ category: "listings", action: "ggsel_freed", actor: "claude (owner: free Plati + GGSel)", count: released, detail: `GGSel freed: ${ready.length} sets (paused offers), ${released} account/set reservations released. Undo: ${backup}` });
  await wait(1500);
  log("DONE released", released);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
