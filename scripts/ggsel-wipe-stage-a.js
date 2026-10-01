// Run ON PROD from the repo root, as it was run on 2026-09-30 15:29Z:
//   node - < scripts/ggsel-wipe-stage-a.js
// (stdin mode: the ./utils requires resolve against the working directory).
// GGSel full wipe — STAGE A (owner 2026-10-01: "do a full wipe on there and start
// again"). Emergency half: nothing on GGSel stays buyable.
//   1. backup: every offer (summary), every active ggsel row (full doc), DbD products
//   2. our ACTIVE ggsel rows -> delisted FIRST (guardian must not read the change as sales)
//   3. batch_pause EVERY active offer (ours + hand-made), read back, retry stragglers
//   4. archive the in-stock codes of hand-made offer 102779821 (4 of 5 live on ZeusX)
// No reservation is released here (stage B proves unsold first).
require("dotenv").config({ quiet: true });
const fs = require("fs");
const axios = require("axios");
const mongoose = require("mongoose");
const config = require("./config/config");
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const loginOf = (v) => { const m = /Login:\s*(\S+)/i.exec(String(v || "")); return m ? m[1].toLowerCase() : ""; };
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
(async () => {
  const mp = require("./utils/marketplaces");
  const settings = require("./utils/settings");
  if (settings.getAutoFarm().ggselEnabled !== false) throw new Error("ggselEnabled is not false — refusing to wipe while listers may add stock");
  const enc = (settings.loadSettings().marketplaces || {}).ggsel || {};
  const apiKey = require("./utils/secretBox").decrypt(enc.apiKey || "") || enc.apiKey;
  const H = { Authorization: apiKey, "Content-Type": "application/json" };
  const API = "https://seller.ggsel.com/api_sellers/v2";
  async function gg(fn) { for (let a = 0; ; a++) { try { const r = await fn(); await wait(700); return r; } catch (e) { const st = e.response && e.response.status; if (a < 3 && (!st || st === 429 || st >= 500)) { await wait(15000); continue; } throw e; } } }
  const allOffers = async () => { for (let a = 0; a < 6; a++) { try { return await mp.ggselAllOffers({ pageSize: 50, paceMs: 600 }); } catch (e) { log("list failed, retry"); await wait(15000); } } throw new Error("offer list unreadable"); };
  await mongoose.connect(config.MONGO_URI);
  const db = mongoose.connection.db;
  const L = db.collection("marketplacelistings");
  const { logEvent } = require("./utils/systemLog");

  const offers = await allOffers();
  const activeRows = await L.find({ marketplace: "ggsel", status: "active" }).toArray();
  const dbd = (await gg(() => axios.get(`${API}/offers/102779821/products?page=1&limit=100`, { headers: H, timeout: 20000 }))).data.data || [];
  const backup = `/root/_rehome_work/ggsel_wipeA_before_${TS}.json`;
  fs.mkdirSync("/root/_rehome_work", { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ at: new Date(), offers: offers.map((o) => ({ id: o.id, status: o.status, q: o.quantity, auto: o.is_autoselling, deliv: o.delivery, price: o.price, title: String(o.title_en || o.title_ru || "").slice(0, 120), created: o.created_at })), activeRows, dbdProducts: dbd.map((p) => ({ id: p.id, status: p.status, login: loginOf(p.value) })) }));
  log("backup", backup, "offers", offers.length, "active rows", activeRows.length);

  // 2. rows off the books first
  let rowsDelisted = 0;
  for (const r of activeRows) {
    const w = await L.updateOne({ _id: r._id, status: "active" }, { $set: { status: "delisted", lastError: "", note: (r.note ? r.note + " " : "") + `delisted ${TS.slice(0, 8)}: GGSel full wipe (owner 2026-10-01: wipe GGSel and start again) — offer paused` } });
    rowsDelisted += w.modifiedCount;
  }
  log("rows delisted:", rowsDelisted);

  // 3. pause every active offer
  const act = offers.filter((o) => o.status === "active").map((o) => Number(o.id));
  for (let i = 0; i < act.length; i += 50) {
    const chunk = act.slice(i, i + 50);
    try { const r = await gg(() => axios.post(`${API}/offers/batch_pause`, { offer_ids: chunk }, { headers: H, timeout: 30000 })); log("batch_pause", chunk.length, "->", r.status, JSON.stringify(r.data).slice(0, 120)); }
    catch (e) { log("batch_pause chunk failed", e.response ? e.response.status + " " + JSON.stringify(e.response.data).slice(0, 200) : e.message); }
  }
  // 4. archive DbD in-stock codes
  const dbdIds = dbd.filter((p) => p.status === "in_stock").map((p) => p.id);
  if (dbdIds.length) {
    try { const r = await gg(() => axios.delete(`${API}/offers/102779821/products`, { headers: H, data: { product_ids: dbdIds }, timeout: 30000 })); log("archive DbD", dbdIds.length, "->", r.status, JSON.stringify(r.data).slice(0, 120)); }
    catch (e) { log("archive DbD failed", e.response ? e.response.status + " " + JSON.stringify(e.response.data).slice(0, 200) : e.message); }
  }
  await wait(25000);
  // read back
  let after = await allOffers();
  let still = after.filter((o) => o.status === "active").map((o) => Number(o.id));
  log("after pause: active", still.length, "of", after.length);
  if (still.length) {
    for (let i = 0; i < still.length; i += 25) {
      try { await gg(() => axios.post(`${API}/offers/batch_pause`, { offer_ids: still.slice(i, i + 25) }, { headers: H, timeout: 30000 })); } catch (e) { log("retry pause failed", e.message); }
    }
    await wait(30000);
    after = await allOffers();
    still = after.filter((o) => o.status === "active").map((o) => Number(o.id));
    log("after retry: active", still.length, still.slice(0, 20).join(","));
  }
  const dbdAfter = (await gg(() => axios.get(`${API}/offers/102779821/products?page=1&limit=100`, { headers: H, timeout: 20000 }))).data.data || [];
  const byS = {}; for (const o of after) byS[o.status] = (byS[o.status] || 0) + 1;
  log("offer statuses now:", JSON.stringify(byS), "| DbD products:", JSON.stringify(dbdAfter.map((p) => p.status)));
  logEvent({ category: "listings", action: "ggsel_wipe_stage_a", actor: "claude (owner: wipe GGSel and start again)", count: act.length, detail: `GGSel wipe stage A: ${rowsDelisted} active rows delisted, ${act.length} active offers paused (${still.length} still active after retry), hand-made DbD offer 102779821: ${dbdIds.length} in-stock codes archived (4 of 5 were live on ZeusX). Backup ${backup}` });
  await wait(1500);
  fs.writeFileSync(`/root/_rehome_work/ggsel_wipeA_result_${TS}.json`, JSON.stringify({ rowsDelisted, paused: act.length, stillActive: still, statuses: byS, dbdAfter: dbdAfter.map((p) => p.status) }));
  await mongoose.disconnect();
})().catch(async (e) => { console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
