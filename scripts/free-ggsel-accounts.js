// free-ggsel-accounts.js — owner 2026-09-28: "leave Plati and GGSel, get the
// accounts listed there and sell them on other platforms, put a block on those
// two — we will use them later when they are fixed".
//
// The GGSel seller account is BLOCKED: every offer edit answers 422 "User is
// blocked", and batch_pause answers 200 + a job id but never applies — so an
// offer cannot be paused or hidden. What still works is archiving an offer's
// products (its delivery codes): DELETE /offers/{id}/products {product_ids}
// → the product reads "archived" seconds later. That takes OUR accounts out of
// GGSel's vault, which is what lets them sell elsewhere without a second buyer
// ever receiving them from GGSel once the account is unblocked.
//
// Scope: only GGSel offers WE made (a MarketplaceListing row of ours, any
// status) and never a rent-farm service offer. Offers made by hand on the GGSel
// dashboard are left alone. For each such offer that still holds in-stock codes:
//   1. our ACTIVE row is marked delisted FIRST — the guardian and the no-claim
//      engine read GGSel stock, and would otherwise count the vanishing codes as
//      sales. A no-claim row's listed ledgers are parked "skipped" (held) and
//      their owner tick cleared, which is what the engine's reconcile does for a
//      market that was switched off;
//   2. every in-stock code is archived, then read back;
//   3. a code confirmed archived was unsold at that moment, so its account's
//      (account, set, "ggsel") drop reservation is released — unless the account
//      is live on another market's listing of that set. The offers themselves
//      stay on GGSel (at 0 stock) for the owner to reuse once it is fixed.
//
// Run ON PROD from the repo root: node scripts/free-ggsel-accounts.js [--apply]
// Dry run by default (reads only). Serial, ~1 s between GGSel calls. Undo
// data: /root/_rehome_work/ggsel_accounts_before_<ts>.json (rows, ledgers,
// every code archived, every reservation field reset).
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const req = (m) => require(m.startsWith("./") ? path.join(__dirname, "..", m) : m);
req("dotenv").config({ quiet: true });
const fs = require("fs");
const axios = req("axios");
const mongoose = req("mongoose");
const config = req("./config/config");

const APPLY = process.argv.includes("--apply");
const PACE_MS = 1000;
const API = "https://seller.ggsel.com/api_sellers/v2";
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const loginOf = (value) => {
  const m = /Login:\s*(\S+)/i.exec(String(value || ""));
  return m ? m[1].toLowerCase() : "";
};

(async () => {
  await mongoose.connect(config.MONGO_URI);
  const mp = req("./utils/marketplaces");
  const engine = req("./utils/unclaimedAutoList");
  const { releaseSetForAccounts } = req("./utils/dropReservation");
  const { logEvent } = req("./utils/systemLog");
  const { loadSettings } = req("./utils/settings");
  const enc = (loadSettings().marketplaces || {}).ggsel || {};
  const apiKey = req("./utils/secretBox").decrypt(enc.apiKey || "") || enc.apiKey;
  const H = { Authorization: apiKey, "Content-Type": "application/json" };
  const db = mongoose.connection.db;
  const Listings = db.collection("marketplacelistings");
  const Ledgers = db.collection("unclaimedaccounts");

  async function gg(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fn();
        await wait(PACE_MS);
        return r;
      } catch (e) {
        const st = e.response && e.response.status;
        if (attempt < 3 && (!st || st === 429 || st >= 500)) { await wait(20000); continue; }
        throw e;
      }
    }
  }
  const products = async (offerId) => {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const r = await gg(() => axios.get(`${API}/offers/${offerId}/products?page=${page}&limit=100`, { headers: H, timeout: 20000 }));
      const rows = (r.data && r.data.data) || [];
      out.push(...rows);
      const pg = (r.data && r.data.pagination) || {};
      if (!pg.has_next_page) break;
    }
    return out;
  };

  // Every offer GGSel has for us (the list 504s now and then — retried by gg).
  let offers = [];
  for (let attempt = 0; attempt < 4 && !offers.length; attempt++) {
    try { offers = await mp.ggselAllOffers(); } catch (e) { log("offer list failed:", String(e.message).slice(0, 80)); await wait(20000); }
  }
  if (!offers.length) throw new Error("GGSel offer list unreadable — nothing done");

  // Our rows (any status) by externalId, to know each offer's set and whether
  // it is an active row the guardian/engine still reads.
  const rows = await Listings.find({ marketplace: "ggsel" }, { projection: { externalId: 1, set: 1, status: 1, origin: 1, note: 1, rentFarm: 1, noclaimStock: 1, accountOffer: 1 } }).toArray();
  const rowsByExt = new Map();
  for (const r of rows) (rowsByExt.get(String(r.externalId)) || rowsByExt.set(String(r.externalId), []).get(String(r.externalId))).push(r);

  // Accounts live on other markets, per set.
  const others = await Listings.find({ status: "active", marketplace: { $ne: "ggsel" }, set: { $ne: null } }, { projection: { set: 1, accountId: 1, units: 1 } }).toArray();
  const liveElsewhere = new Set();
  for (const r of others) {
    for (const a of String(r.accountId || "").split(",").map((s) => s.trim()).filter(Boolean)) liveElsewhere.add(String(r.set) + "|" + a);
    for (const u of r.units || []) if (!u.deliveredAt && u.accountId) liveElsewhere.add(String(r.set) + "|" + String(u.accountId));
  }

  // Pass 1 (read): in-stock products of every offer.
  const plan = [];
  for (const [i, o] of offers.entries()) {
    const ext = String(o.id);
    if (!rowsByExt.has(ext)) continue; // not ours — never read, never touched
    let prods = [];
    try { prods = (await products(ext)).filter((p) => p.status === "in_stock"); } catch (e) { log("products unreadable for", ext, String(e.message).slice(0, 60)); continue; }
    if (!prods.length) continue;
    const rs = rowsByExt.get(ext) || [];
    // Ours only (see header): no row → a hand-made offer, left alone; a
    // rent-farm service offer sells a farming window, not these accounts.
    if (!rs.length || rs.some((r) => r.rentFarm) || /automatic\s+farming/i.test(String(o.title_en || o.title_ru || ""))) continue;
    plan.push({ ext, status: String(o.status || ""), title: String(o.title_en || o.title_ru || "").slice(0, 70), rows: rs.map((r) => ({ id: String(r._id), status: r.status, set: r.set ? String(r.set) : "", origin: r.origin || "", rentFarm: !!r.rentFarm })), products: prods.map((p) => ({ id: p.id, login: loginOf(p.value) })) });
    if ((i + 1) % 100 === 0) log(`read ${i + 1}/${offers.length} offers, ${plan.length} hold stock`);
  }
  const codes = plan.reduce((n, p) => n + p.products.length, 0);
  const notOurs = offers.filter((o) => !rowsByExt.has(String(o.id))).length;
  const activeRows = plan.flatMap((p) => p.rows.filter((r) => r.status === "active"));
  const noclaimRows = activeRows.filter((r) => r.origin === "unclaimed");

  // Before-state: rows, no-claim ledgers, and reservations that may be reset.
  const setIds = [...new Set(plan.flatMap((p) => p.rows.map((r) => r.set)).filter(Boolean))];
  const drops = setIds.length
    ? await db.collection("droplogs").find({ soldToUsername: "ggsel", soldAt: { $ne: null }, soldSetId: { $in: setIds } }, { projection: { account: 1, login: 1, soldAt: 1, soldToUsername: 1, soldToAdminId: 1, soldSetId: 1, soldBulkOrderId: 1 } }).toArray()
    : [];
  const ledgers = noclaimRows.length
    ? await Ledgers.find({ status: "listed", market: "ggsel" }).project({ drops: 0 }).toArray()
    : [];
  const backup = `/root/_rehome_work/ggsel_accounts_before_${TS}.json`;
  fs.mkdirSync("/root/_rehome_work", { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ at: new Date(), apply: APPLY, plan, rows: rows.filter((r) => r.status === "active"), ledgers, reservations: drops }, null, 0));
  log(`${APPLY ? "APPLY" : "DRY RUN"}: ${offers.length} GGSel offers, ${plan.length} of ours still hold ${codes} in-stock codes (${notOurs} hand-made offers left alone); ${activeRows.length} active rows to mark delisted (${noclaimRows.length} no-claim, ${ledgers.length} listed ledgers to hold). Backup ${backup}`);
  if (!APPLY) { await mongoose.disconnect(); return; }

  // Reservation lookup: set|login → account ids reserved with tag ggsel.
  const byLogin = new Map();
  for (const d of drops) {
    const k = String(d.soldSetId) + "|" + String(d.login || "").toLowerCase();
    (byLogin.get(k) || byLogin.set(k, new Set()).get(k)).add(String(d.account));
  }

  const out = { rowsDelisted: 0, ledgersHeld: 0, offers: 0, codesArchived: 0, codesNotConfirmed: 0, released: 0, keptLiveElsewhere: 0, unmatched: 0 };
  // Phase A: rows off the books FIRST (see header), then archive the codes.
  for (const [n, p] of plan.entries()) {
    for (const r of p.rows.filter((x) => x.status === "active")) {
      await Listings.updateOne(
        { _id: new mongoose.Types.ObjectId(r.id), status: "active" },
        { $set: { status: "delisted", lastError: "", note: `delisted ${TS.slice(0, 8)}: GGSel blocked by the owner — our codes archived so the accounts sell elsewhere (seller account blocked; the offer stays on GGSel at 0 stock)` } },
      );
      out.rowsDelisted++;
      if (r.origin === "unclaimed" && r.set) {
        const held = await Ledgers.find({ status: "listed", market: "ggsel", set: new mongoose.Types.ObjectId(r.set) }).toArray();
        for (const l of held) {
          const w = await Ledgers.updateOne({ _id: l._id, status: "listed" }, { $set: { status: "skipped", note: "held — GGSel taken off by the owner (codes archived)", lastCheckedAt: new Date() } });
          if (w.modifiedCount) { out.ledgersHeld++; await engine.markOwnerUnlisted({ ...l, status: "skipped" }).catch(() => {}); }
        }
      }
    }
    const ids = p.products.map((x) => x.id);
    for (let i = 0; i < ids.length; i += 100) {
      try {
        await gg(() => axios.delete(`${API}/offers/${p.ext}/products`, { headers: H, data: { product_ids: ids.slice(i, i + 100) }, timeout: 30000 }));
      } catch (e) {
        p.deleteError = e.response ? "HTTP " + e.response.status + " " + JSON.stringify(e.response.data).slice(0, 120) : e.message;
      }
    }
    if ((n + 1) % 50 === 0) log(`archive requested for ${n + 1}/${plan.length} offers`);
  }
  // GGSel archives asynchronously (seconds): one wait, then read everything back.
  await wait(20000);
  // Phase B: confirm, and release what the archive proves unsold.
  for (const p of plan) {
    let after = [];
    try { after = await products(p.ext); } catch { after = []; }
    const archived = new Set(after.filter((x) => x.status === "archived").map((x) => x.id));
    out.offers++;
    const set = (p.rows.find((r) => r.set) || {}).set || "";
    for (const prod of p.products) {
      if (!archived.has(prod.id)) { out.codesNotConfirmed++; continue; }
      out.codesArchived++;
      const accts = set && prod.login ? byLogin.get(set + "|" + prod.login) : null;
      if (!accts || !accts.size) { out.unmatched++; continue; }
      for (const a of accts) {
        if (liveElsewhere.has(set + "|" + a)) { out.keptLiveElsewhere++; continue; }
        await releaseSetForAccounts([a], set, "ggsel");
        out.released++;
      }
    }
    if (out.offers % 50 === 0) log(`confirmed ${out.offers}/${plan.length}: codes archived ${out.codesArchived}, released ${out.released}`);
  }
  out.deleteErrors = plan.filter((p) => p.deleteError).map((p) => ({ ext: p.ext, why: p.deleteError })).slice(0, 20);
  logEvent({ category: "listings", action: "ggsel_accounts_freed", actor: "claude (owner: sell GGSel accounts elsewhere)", count: out.released, detail: `GGSel accounts freed: ${out.offers} offers, ${out.codesArchived} codes archived (${out.codesNotConfirmed} not confirmed), ${out.rowsDelisted} rows delisted, ${out.ledgersHeld} no-claim ledgers held, ${out.released} reservations released, ${out.unmatched} codes with no reservation, ${out.keptLiveElsewhere} kept (live elsewhere). Undo: ${backup}` });
  await wait(1500);
  log("DONE", JSON.stringify(out));
  fs.writeFileSync(`/root/_rehome_work/ggsel_accounts_result_${TS}.json`, JSON.stringify(out, null, 1));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
