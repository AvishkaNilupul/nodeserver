// delist-plati-everything.js — owner 2026-09-28: "delist everything on GGSel and
// Plati, we will fix that later".
//
// free-plati-accounts.js took down every Plati product WE have an active row
// for. This sweep asks Plati itself: it pages the seller's own goods list
// (show_hidden, so every product is seen) and disables every product that is
// still enabled (`visible > 0`) — products made by hand on the Plati
// dashboard, rows we already call delisted that Plati still shows, anything.
// An active row of ours for such a product is marked delisted too.
//
// The seller account is blocked ("продавец товара заблокирован") but writes
// still work. Digiseller allows only a few dozen seller requests a minute
// ("seller-limit-1"), so calls are ~2 s apart and a rate-limit answer waits a
// minute and retries.
//
// Run ON PROD from the repo root: node scripts/delist-plati-everything.js [--apply]
// Dry run by default (reads the goods list only).
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const req = (m) => require(m.startsWith("./") ? path.join(__dirname, "..", m) : m);
req("dotenv").config({ quiet: true });
const fs = require("fs");
const axios = req("axios");
const mongoose = req("mongoose");
const config = req("./config/config");

const APPLY = process.argv.includes("--apply");
const PACE_MS = 2100;
const LIMIT_RE = /seller-limit|requests per minute/i;
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function paced(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn();
      await wait(PACE_MS);
      return r;
    } catch (e) {
      const why = String((e && e.message) || e) + JSON.stringify((e && e.response && e.response.data) || "");
      if (attempt < 6 && LIMIT_RE.test(why)) { await wait(65000); continue; }
      throw e;
    }
  }
}

(async () => {
  await mongoose.connect(config.MONGO_URI);
  const mp = req("./utils/marketplaces");
  const { logEvent } = req("./utils/systemLog");
  const { loadSettings } = req("./utils/settings");
  const { decrypt } = req("./utils/secretBox");
  const keys = (loadSettings().marketplaces || {}).digiseller || {};
  const plain = (v) => { try { return decrypt(v || "") || v || ""; } catch { return v || ""; } };
  const sellerId = Number(plain(keys.sellerId));
  const apiKey = plain(keys.apiKey);
  const DS_API = "https://api.digiseller.com/api";
  // marketplaces.js keeps its token helper private; this is the same apilogin
  // call (sha256(apiKey + timestamp)), cached for the run.
  let token = "";
  const dsToken = async () => {
    if (token) return token;
    const ts = Math.floor(Date.now() / 1000);
    const sign = require("crypto").createHash("sha256").update(apiKey + ts).digest("hex");
    const r = await axios.post(`${DS_API}/apilogin`, { seller_id: sellerId, timestamp: ts, sign }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
    if (String(r.data && r.data.retval) !== "0" || !r.data.token) throw new Error("apilogin failed: " + JSON.stringify(r.data).slice(0, 120));
    token = r.data.token;
    return token;
  };

  const goods = [];
  for (let page = 1; page <= 40; page++) {
    const d = await paced(async () => {
      const r = await axios.post(`${DS_API}/seller-goods?token=${encodeURIComponent(await dsToken())}`, { id_seller: sellerId, order_col: "cntsell", order_dir: "desc", rows: 100, page, currency: "USD", lang: "en-US", show_hidden: 1 }, { headers: { "Content-Type": "application/json" }, timeout: 30000 });
      const body = r.data || {};
      if (body.retval !== undefined && String(body.retval) !== "0") throw new Error("seller-goods refused: " + JSON.stringify(body).slice(0, 200));
      return body;
    });
    const rows = Array.isArray(d.rows) ? d.rows : [];
    goods.push(...rows);
    if (!rows.length || page >= Number(d.pages || 1)) break;
  }
  const live = goods.filter((g) => Number(g.visible) > 0);
  const Listings = mongoose.connection.db.collection("marketplacelistings");
  const ours = await Listings.find({ marketplace: "digiseller", externalId: { $in: live.map((g) => String(g.id_goods)) } }, { projection: { externalId: 1, status: 1 } }).toArray();
  const activeOurs = ours.filter((r) => r.status === "active");
  fs.writeFileSync(`/root/_rehome_work/plati_everything_before_${TS}.json`, JSON.stringify({ at: new Date(), apply: APPLY, goodsTotal: goods.length, live: live.map((g) => ({ id: g.id_goods, name: g.name_goods || g.name, visible: g.visible, price: g.price })), ours }, null, 0));
  log(`${APPLY ? "APPLY" : "DRY RUN"}: Plati lists ${goods.length} products, ${live.length} still enabled (${ours.length} have a row of ours, ${activeOurs.length} of them active).`);
  if (!APPLY) { await mongoose.disconnect(); return; }

  const out = { disabled: 0, failed: 0, rowsDelisted: 0, failures: [] };
  for (const g of live) {
    const id = String(g.id_goods);
    try {
      await paced(() => mp.digisellerDelist(id));
      out.disabled++;
    } catch (e) {
      const why = String((e && e.message) || e);
      if (mp.delistOutcome(why)) out.disabled++;
      else { out.failed++; out.failures.push({ id, why: why.slice(0, 160) }); continue; }
    }
    const w = await Listings.updateMany({ marketplace: "digiseller", externalId: id, status: "active" }, { $set: { status: "delisted", lastError: "", note: `delisted ${TS.slice(0, 8)}: Plati taken off by the owner (seller account blocked)` } });
    out.rowsDelisted += w.modifiedCount || 0;
    if ((out.disabled + out.failed) % 25 === 0) log(`progress ${out.disabled + out.failed}/${live.length}`);
  }
  logEvent({ category: "listings", action: "plati_delisted_all", actor: "claude (owner: delist everything on Plati)", count: out.disabled, detail: `Plati sweep: ${out.disabled} enabled products disabled, ${out.failed} failed, ${out.rowsDelisted} rows marked delisted` });
  await wait(1500);
  log("DONE", JSON.stringify({ ...out, failures: out.failures.slice(0, 10) }));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
