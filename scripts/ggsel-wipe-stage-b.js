// Run ON PROD from the repo root, as it was run on 2026-09-30 (dry 15:34Z, apply 15:47Z):
//   node - [--apply] < scripts/ggsel-wipe-stage-b.js
// (stdin mode: the ./utils requires resolve against the working directory).
// Result 2026-09-30: 3,589 products (3,298 archived / 53 sold / 238 in stock);
// 238 archived, 3 never-sold reservations released, 8 sold accounts re-protected (61 drops).
// GGSel full wipe — STAGE B (owner 2026-10-01). Dry run unless --apply.
// Reads EVERY product of EVERY GGSel offer (status in_stock | archived | sold),
// then:
//   1. archives any code still in_stock (read back);
//   2. RELEASE: a ggsel-tagged reservation (set, account) whose codes on that set's
//      offers are ALL archived (none sold, none in stock) never sold -> released,
//      set- and account-scoped, tag ggsel only;
//   3. RE-PROTECT: a code GGSel SOLD whose set drops on that account are back in
//      the sellable pool (a past delist released them tag-wide) -> those free drops
//      are re-reserved to ggsel for that set (the buyer holds the account);
//      drops of that set now reserved by ANOTHER market = conflict, reported only;
//   4. no-claim offers: sold codes vs ledger status, reported only.
// Undo data: /root/_rehome_work/ggsel_wipeB_before_<ts>.json
require("dotenv").config({ quiet: true });
const fs = require("fs");
const axios = require("axios");
const mongoose = require("mongoose");
const config = require("./config/config");
const APPLY = process.argv.includes("--apply");
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const loginOf = (v) => { const m = /Login:\s*(\S+)/i.exec(String(v || "")); return m ? m[1].toLowerCase() : ""; };
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
(async () => {
  const mp = require("./utils/marketplaces");
  const settings = require("./utils/settings");
  if (settings.getAutoFarm().ggselEnabled !== false) throw new Error("ggselEnabled is not false — refusing");
  const enc = (settings.loadSettings().marketplaces || {}).ggsel || {};
  const apiKey = require("./utils/secretBox").decrypt(enc.apiKey || "") || enc.apiKey;
  const H = { Authorization: apiKey, "Content-Type": "application/json" };
  const API = "https://seller.ggsel.com/api_sellers/v2";
  async function gg(fn) { for (let a = 0; ; a++) { try { const r = await fn(); await wait(450); return r; } catch (e) { const st = e.response && e.response.status; if (a < 4 && (!st || st === 429 || st >= 500)) { await wait(12000); continue; } throw e; } } }
  const allOffers = async () => { for (let a = 0; a < 6; a++) { try { return await mp.ggselAllOffers({ pageSize: 50, paceMs: 600 }); } catch (e) { await wait(15000); } } throw new Error("offer list unreadable"); };
  const productsOf = async (id) => { const out = []; for (let p = 1; p <= 30; p++) { const r = await gg(() => axios.get(`${API}/offers/${id}/products?page=${p}&limit=100`, { headers: H, timeout: 25000 })); const rows = (r.data && r.data.data) || []; out.push(...rows); const pg = (r.data && r.data.pagination) || {}; if (!pg.has_next_page) break; } return out; };
  await mongoose.connect(config.MONGO_URI);
  const db = mongoose.connection.db;
  const L = db.collection("marketplacelistings");
  const D = db.collection("droplogs");
  const oid = (s) => { try { return new mongoose.Types.ObjectId(String(s)); } catch { return null; } };

  const offers = await allOffers();
  log(APPLY ? "APPLY" : "DRY RUN", "offers", offers.length, JSON.stringify(offers.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {})));
  const rows = await L.find({ marketplace: "ggsel" }, { projection: { externalId: 1, set: 1, status: 1, origin: 1 } }).toArray();
  const rowsByExt = new Map();
  for (const r of rows) (rowsByExt.get(String(r.externalId)) || rowsByExt.set(String(r.externalId), []).get(String(r.externalId))).push(r);

  // 1) read every product
  const prods = []; // {offer, id, status, login, set, origin, hasRow}
  let unreadable = 0;
  for (const [i, o] of offers.entries()) {
    let ps;
    try { ps = await productsOf(o.id); } catch (e) { unreadable++; log("products unreadable", o.id, e.response ? e.response.status : e.message); continue; }
    const rs = rowsByExt.get(String(o.id)) || [];
    const set = (rs.find((r) => r.set) || {}).set;
    for (const p of ps) prods.push({ offer: String(o.id), id: p.id, status: p.status, login: loginOf(p.value), set: set ? String(set) : "", origin: (rs[0] || {}).origin || "", hasRow: rs.length > 0, created: p.created_at });
    if ((i + 1) % 100 === 0) log(`read ${i + 1}/${offers.length} offers, ${prods.length} products`);
  }
  const vocab = prods.reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {});
  log("products:", prods.length, JSON.stringify(vocab), "unreadable offers:", unreadable, "no-login products:", prods.filter((p) => !p.login).length);
  const inStock = prods.filter((p) => p.status === "in_stock");
  log("in_stock codes left:", inStock.length, "on offers", [...new Set(inStock.map((p) => p.offer))].join(","), "| hand-made:", inStock.filter((p) => !p.hasRow).length);

  // index (set|login) -> statuses; login -> statuses (any offer)
  const bySetLogin = new Map();
  for (const p of prods) {
    if (!p.login || !p.set) continue;
    const k = p.set + "|" + p.login;
    (bySetLogin.get(k) || bySetLogin.set(k, []).get(k)).push(p.status);
  }

  // 2) reservations tagged ggsel
  const res = await D.find({ soldToUsername: "ggsel", soldAt: { $ne: null } }, { projection: { account: 1, login: 1, soldSetId: 1, itemKey: 1, soldAt: 1, connected: 1 } }).toArray();
  const groups = new Map(); // set|account -> {set, account, login, drops:[]}
  for (const d of res) { const k = String(d.soldSetId) + "|" + String(d.account); const g = groups.get(k) || groups.set(k, { set: String(d.soldSetId), account: String(d.account), login: String(d.login || "").toLowerCase(), drops: [] }).get(k); g.drops.push(d); }
  const cls = { sold: [], archivedOnly: [], inStock: [], noProduct: [] };
  for (const g of groups.values()) {
    const st = bySetLogin.get(g.set + "|" + g.login) || [];
    if (st.includes("sold")) cls.sold.push(g);
    else if (st.includes("in_stock")) cls.inStock.push(g);
    else if (st.length && st.every((s) => s === "archived")) cls.archivedOnly.push(g);
    else cls.noProduct.push(g);
  }
  const dropsOf = (a) => a.reduce((n, g) => n + g.drops.length, 0);
  log("ggsel reservations:", res.length, "drops in", groups.size, "(set,account) groups | sold", cls.sold.length, "(" + dropsOf(cls.sold) + " drops) | archived-only", cls.archivedOnly.length, "(" + dropsOf(cls.archivedOnly) + ") | in-stock", cls.inStock.length, "| no product", cls.noProduct.length, "(" + dropsOf(cls.noProduct) + ")");
  // live-elsewhere guard for releases: account on another active listing of that set
  const others = await L.find({ status: "active", marketplace: { $ne: "ggsel" }, set: { $ne: null } }, { projection: { set: 1, accountId: 1, units: 1 } }).toArray();
  const liveElsewhere = new Set();
  for (const r of others) { for (const a of String(r.accountId || "").split(",").map((s) => s.trim()).filter(Boolean)) liveElsewhere.add(String(r.set) + "|" + a); for (const u of r.units || []) if (!u.deliveredAt && u.accountId) liveElsewhere.add(String(r.set) + "|" + String(u.accountId)); }

  // 3) sold codes -> are their set drops back in the pool?
  const soldProds = prods.filter((p) => p.status === "sold" && p.login && p.set);
  const setIds = [...new Set(soldProds.map((p) => p.set))];
  const sets = new Map((await db.collection("dropsets").find({ _id: { $in: setIds.map(oid).filter(Boolean) } }, { projection: { items: 1, name: 1, stockSource: 1 } }).toArray()).map((s) => [String(s._id), s]));
  async function soldCheck() {
  const reprotect = []; const conflicts = []; let soldChecked = 0; let soldOk = 0; let soldNoSet = 0;
  const seenSL = new Set();
  for (const p of soldProds) {
    const k = p.set + "|" + p.login; if (seenSL.has(k)) continue; seenSL.add(k);
    const s = sets.get(p.set);
    if (!s || s.stockSource === "noclaim") { soldNoSet++; continue; }
    const keys = [...new Set((s.items || []).map((i) => i.itemKey).filter(Boolean))];
    if (!keys.length) { soldNoSet++; continue; }
    soldChecked++;
    const dl = await D.find({ login: new RegExp("^" + p.login.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "$", "i"), itemKey: { $in: keys }, connected: { $ne: true } }, { projection: { account: 1, itemKey: 1, soldAt: 1, soldToUsername: 1, soldSetId: 1 } }).toArray();
    const free = dl.filter((d) => !d.soldAt);
    const foreign = dl.filter((d) => d.soldAt && !(d.soldToUsername === "ggsel" && String(d.soldSetId) === p.set));
    if (foreign.length) conflicts.push({ set: p.set, setName: String(s.name || "").slice(0, 60), login: p.login, offer: p.offer, tags: [...new Set(foreign.map((d) => d.soldToUsername + ":" + String(d.soldSetId).slice(-6)))], free: free.length });
    if (free.length) reprotect.push({ set: p.set, login: p.login, offer: p.offer, ids: free.map((d) => String(d._id)) });
    if (!free.length && !foreign.length) soldOk++;
  }
  return { reprotect, conflicts, soldChecked, soldOk, soldNoSet };
  }
  let { reprotect, conflicts, soldChecked, soldOk, soldNoSet } = await soldCheck();
  log("sold codes: (set,login) checked", soldChecked, "| still protected", soldOk, "| back in pool -> re-protect", reprotect.length, "(" + reprotect.reduce((n, r) => n + r.ids.length, 0) + " drops) | reserved by another market (conflict)", conflicts.length, "| no-claim/no-set", soldNoSet);
  for (const c of conflicts.slice(0, 30)) log("  CONFLICT", c.login, "sold on ggsel", c.offer, "set", c.set.slice(-6), c.setName, "| now reserved as", c.tags.join(","), "| free", c.free);

  // 4) no-claim offers: sold codes vs ledger status
  const ncSold = prods.filter((p) => p.status === "sold" && p.origin === "unclaimed" && p.login);
  const ledgers = await db.collection("unclaimedaccounts").find({ login: { $in: [...new Set(ncSold.map((p) => p.login))] } }, { projection: { login: 1, status: 1, market: 1 } }).toArray();
  const ledByLogin = new Map(); for (const l of ledgers) (ledByLogin.get(String(l.login).toLowerCase()) || ledByLogin.set(String(l.login).toLowerCase(), []).get(String(l.login).toLowerCase())).push(l.status + "/" + l.market);
  const ncMismatch = ncSold.filter((p) => !(ledByLogin.get(p.login) || []).some((s) => s.startsWith("sold")));
  log("no-claim sold codes:", ncSold.length, "| ledger not sold:", ncMismatch.length, JSON.stringify(ncMismatch.slice(0, 10).map((p) => [p.login, (ledByLogin.get(p.login) || []).join("|")])));

  const backup = `/root/_rehome_work/ggsel_wipeB_before_${TS}.json`;
  fs.writeFileSync(backup, JSON.stringify({ at: new Date(), apply: APPLY, products: prods, archivedOnly: cls.archivedOnly.map((g) => ({ set: g.set, account: g.account, login: g.login, drops: g.drops.map((d) => ({ _id: d._id, soldAt: d.soldAt, soldSetId: d.soldSetId })) })), reprotect, conflicts, ncMismatch }));
  log("backup", backup);
  if (!APPLY) { await mongoose.disconnect(); return; }

  // APPLY
  const { releaseSetForAccounts } = require("./utils/dropReservation");
  const out = { archived: 0, archiveFail: 0, released: 0, keptLiveElsewhere: 0, reprotected: 0, reprotectDrops: 0 };
  const byOffer = new Map(); for (const p of inStock) (byOffer.get(p.offer) || byOffer.set(p.offer, []).get(p.offer)).push(p.id);
  for (const [offer, ids] of byOffer) {
    for (let i = 0; i < ids.length; i += 100) { try { await gg(() => axios.delete(`${API}/offers/${offer}/products`, { headers: H, data: { product_ids: ids.slice(i, i + 100) }, timeout: 30000 })); } catch (e) { out.archiveFail++; log("archive failed", offer, e.message); } }
  }
  if (byOffer.size) { await wait(20000); for (const offer of byOffer.keys()) { const ps = await productsOf(offer); out.archived += ps.filter((p) => byOffer.get(offer).includes(p.id) && p.status === "archived").length; } }
  for (const g of cls.archivedOnly) {
    if (liveElsewhere.has(g.set + "|" + g.account)) { out.keptLiveElsewhere++; continue; }
    await releaseSetForAccounts([g.account], g.set, "ggsel");
    out.released++;
  }
  // Re-check AFTER the releases: a release above may have freed drops a sold
  // code of ANOTHER set still needs (the same itemKeys under two sets).
  ({ reprotect, conflicts } = await soldCheck());
  log("after releases: re-protect", reprotect.length, "(" + reprotect.reduce((n, r) => n + r.ids.length, 0) + " drops), conflicts", conflicts.length);
  const now = new Date();
  for (const r of reprotect) {
    const w = await D.updateMany({ _id: { $in: r.ids.map(oid) }, soldAt: null, connected: { $ne: true } }, { $set: { soldAt: now, soldToUsername: "ggsel", soldToAdminId: "", soldSetId: r.set, soldBulkOrderId: "" } });
    out.reprotectDrops += w.modifiedCount; if (w.modifiedCount) out.reprotected++;
  }
  // Undo data for the re-protect (the before-file holds the dry-run list).
  out.reprotectList = reprotect.map((r) => ({ set: r.set, login: r.login, offer: r.offer, ids: r.ids }));
  out.releasedGroups = cls.archivedOnly.filter((g) => !liveElsewhere.has(g.set + "|" + g.account)).map((g) => ({ set: g.set, account: g.account, login: g.login, drops: g.drops.map((d) => String(d._id)) }));
  const offersAfter = await allOffers();
  out.offerStatuses = offersAfter.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {});
  let stillIn = 0;
  for (const offer of byOffer.keys()) { const ps = await productsOf(offer); stillIn += ps.filter((p) => p.status === "in_stock").length; }
  out.inStockLeftOnArchivedOffers = stillIn;
  out.conflicts = conflicts.map((c) => ({ login: c.login, offer: c.offer, set: c.set, setName: c.setName, tags: c.tags }));
  const { logEvent } = require("./utils/systemLog");
  logEvent({ category: "listings", action: "ggsel_wipe_stage_b", actor: "claude (owner: wipe GGSel and start again)", count: out.released, detail: `GGSel wipe stage B: ${prods.length} products read (${JSON.stringify(vocab)}); ${out.archived}/${inStock.length} leftover in-stock codes archived; ${out.released} never-sold (set,account) reservations released (${out.keptLiveElsewhere} kept, live elsewhere); ${out.reprotected} sold accounts re-protected (${out.reprotectDrops} drops back to ggsel); ${conflicts.length} sold-on-GGSel accounts now reserved by another market (reported). Undo: ${backup}` });
  await wait(1500);
  log("DONE", JSON.stringify(out));
  fs.writeFileSync(`/root/_rehome_work/ggsel_wipeB_result_${TS}.json`, JSON.stringify(out));
  await mongoose.disconnect();
})().catch(async (e) => { console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
