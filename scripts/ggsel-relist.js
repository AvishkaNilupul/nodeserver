// ggsel-relist.js — owner 2026-10-01: "the block on GGSel is lifted — do a full
// wipe and start again, a proper listing this time, no issues; careful the
// accounts don't collide with other live markets".
//
// After the wipe (every old GGSel offer paused, every code archived), this
// re-creates the GGSel catalog from what the business actually sells: every
// bundle that is live on Gameflip through the auto-lister gets ONE fresh GGSel
// offer, built exactly as the auto-lister builds a GGSel share:
//   - accounts: autoLister.pickDeliveryAccounts(task) — they hold the whole
//     bundle (unsold, unconnected), have a password and a live token, are on
//     NO active listing of any marketplace, are not a renter's, and one Twitch
//     account counts once however many records it has;
//   - publish: autoLister.publishGgselShare — GGSel venue price, per-set
//     reservation under "ggsel" with rollback on failure, autoselling codes,
//     activation, a row carrying accountId + accountLogin + qtyTarget (the
//     guardian then keeps it topped up);
//   - text: the Gameflip title (cut to GGSel's 100 characters by the
//     connector) and the house description with GGSel's own support line;
//   - category: GGSel's own "Games > <game> > Twitch Drops" (or the game's
//     Accounts section), never a default bucket — no category, no offer.
// Rules: no no-claim game (Overwatch / Rainbow Six / Call of Duty sell only
// unclaimed, from the no-claim farm); one offer per distinct title; at most 3
// accounts per offer and never more than half the bundle's spare accounts, so
// the Gameflip chain keeps stock to relist from; a bundle with fewer than 2
// spare accounts is left to Gameflip. Serial and paced.
//
// Run ON PROD from the repo root: node scripts/ggsel-relist.js [--apply] [--limit=N]
// Dry run by default. Result: /root/_rehome_work/ggsel_relist_<ts>.json
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const req = (m) => require(m.startsWith("./") ? path.join(__dirname, "..", m) : m);
req("dotenv").config({ quiet: true });
const fs = require("fs");
const fsp = require("fs/promises");
const mongoose = req("mongoose");
const config = req("./config/config");

const APPLY = process.argv.includes("--apply");
// A dry run resolves GGSel categories only when asked: each lookup is a GGSel
// call (the first builds a 100-offer history), and GGSel stopped answering this
// server for ~10 h after the wipe's ~7,500 reads (2026-09-30). The apply run
// resolves them once, paced.
const DRY_CATS = process.argv.includes("--cats");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 0;
const PACE_MS = 12000;
const MAX_PER_OFFER = 3;
const TS = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
// GGSel stamps created_at in Moscow time with an offset; a minute of slack
// covers clock skew between this server and GGSel.
const RUN_STARTED = new Date(Date.now() - 60000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const normTitle = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
const plain = (items) => (items || []).map((i) => (i && typeof i.toObject === "function" ? i.toObject() : i));
// Does GGSel's category tree ("Games > Halo Infinite > Twitch Drops") belong to
// this game? Word sets, not substrings: the resolver's own loose match would
// let "Rust" land in a "Trusty …" section.
const normGame = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, " ").trim();
const words = (s) => new Set(normGame(s).split(" ").filter((w) => w.length > 1 || /\d/.test(w)));
function categoryFits(tree, game) {
  const parts = String(tree || "").split(">").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || !/^(games|игры)$/i.test(parts[0])) return false;
  const a = words(game);
  const b = words(parts[1]);
  if (!a.size || !b.size) return false;
  const sub = (x, y) => [...x].every((w) => y.has(w));
  return (sub(a, b) || sub(b, a)) && /twitch|accounts|аккаунт/i.test(parts[parts.length - 1]);
}

(async () => {
  await mongoose.connect(config.MONGO_URI);
  const autoLister = req("./utils/autoLister");
  const mp = req("./utils/marketplaces");
  const settings = req("./utils/settings");
  const { buildSetGridImage } = req("./utils/setImage");
  const { logEvent } = req("./utils/systemLog");
  const DropSet = req("./models/DropSet");
  const AutoFarmTask = req("./models/AutoFarmTask");
  const MarketplaceListing = req("./models/MarketplaceListing");

  // The live auto catalog: newest active Gameflip auto row per set.
  const gf = await MarketplaceListing.find(
    { marketplace: "gameflip", status: "active", origin: "auto", set: { $ne: null } },
    { set: 1, title: 1, price: 1, createdAt: 1 },
  ).sort({ createdAt: -1 }).lean();
  const bySet = new Map();
  for (const r of gf) if (!bySet.has(String(r.set))) bySet.set(String(r.set), r);
  // Idempotent: a set that already has a live GGSel offer is never listed twice.
  const liveGg = new Set((await MarketplaceListing.distinct("set", { marketplace: "ggsel", status: "active" })).map(String));

  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const cands = [];
  for (const [sid, gfRow] of bySet) {
    if (liveGg.has(sid)) { skip("already live on GGSel"); continue; }
    const set = await DropSet.findById(sid);
    if (!set) { skip("set missing"); continue; }
    if (set.stockSource === "noclaim") { skip("no-claim set"); continue; }
    const games = [...new Set((set.items || []).map((i) => i.game).filter(Boolean))];
    if (!games.length) { skip("no items"); continue; }
    if (games.some((g) => settings.isNoClaimGame(g))) { skip("no-claim game (sold unclaimed only)"); continue; }
    if (/automatic\s+farming/i.test(gfRow.title || "")) { skip("farm service"); continue; }
    const task = await AutoFarmTask.findOne({ $or: [{ "listing.setId": sid }, { "stackListing.setId": sid }] }).sort({ createdAt: -1 });
    if (!task) { skip("no auto-farm task"); continue; }
    const spare = (await autoLister.pickDeliveryAccounts(task, 30, set.items || [])).length;
    if (spare < 2) { skip("fewer than 2 spare accounts"); continue; }
    cands.push({ sid, set, task, gfRow, spare, key: normTitle(gfRow.title) });
  }
  // One offer per distinct title: the set with the most spare accounts wins.
  const byTitle = new Map();
  for (const c of cands) {
    const cur = byTitle.get(c.key);
    if (!cur || c.spare > cur.spare) byTitle.set(c.key, c);
  }
  let chosen = [...byTitle.values()].sort((a, b) => b.spare - a.spare);
  if (cands.length > chosen.length) skipped["duplicate title (kept the bundle with most spare)"] = cands.length - chosen.length;
  if (LIMIT) chosen = chosen.slice(0, LIMIT);
  const plannedAccounts = chosen.reduce((n, c) => n + Math.min(MAX_PER_OFFER, Math.floor(c.spare / 2)), 0);
  log(APPLY ? "APPLY" : "DRY RUN", "— live auto bundles", bySet.size, "| to list on GGSel:", chosen.length, "offers,", plannedAccounts, "accounts | skipped:", JSON.stringify(skipped));

  const catCache = new Map();
  async function categoryFor(game) {
    const k = String(game || "").toLowerCase();
    if (catCache.has(k)) return catCache.get(k);
    let cat = "";
    for (let attempt = 0; attempt < 2 && !cat; attempt++) {
      try { cat = await mp.ggselResolveCategoryId(game); } catch { cat = ""; }
    }
    catCache.set(k, cat || "");
    return cat || "";
  }

  const axios = req("axios");
  const ggFulfiller = req("./utils/ggselFulfiller");
  const GG_API = "https://seller.ggsel.com/api_sellers/v2";
  const ggKey = (() => {
    const enc = (settings.loadSettings().marketplaces || {}).ggsel || {};
    return req("./utils/secretBox").decrypt(enc.apiKey || "") || enc.apiKey;
  })();
  async function readOffer(id) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await axios.get(GG_API + "/offers/" + Number(id), { headers: { Authorization: ggKey }, timeout: 25000 });
        return (r.data && r.data.data) || {};
      } catch (e) {
        if (a === 2) throw e;
        await wait(8000);
      }
    }
    return {};
  }
  // Take a just-published offer back down the way the Listings delist does:
  // row delisted FIRST (no stock reader may count vanishing codes as sales),
  // then pause, empty the vault, and hand back what GGSel proves unsold.
  async function retract(ext, reason) {
    const row = await MarketplaceListing.findOne({ marketplace: "ggsel", externalId: String(ext) });
    if (row) {
      row.status = "delisted";
      row.note = (row.note ? row.note + " " : "") + "— retracted by ggsel-relist: " + reason;
      await row.save();
    }
    await mp.ggselDelist(ext).catch(() => {});
    let vault = null;
    try { vault = await mp.ggselEmptyVault(ext); } catch { vault = null; }
    const rel = row && vault ? await ggFulfiller.releaseProvenUnsold(row, vault) : null;
    if (row) {
      row.note += vault ? "; vault emptied: " + vault.archived.length + " archived, " + (rel ? rel.released.length : 0) + " account(s) back in stock" : "; vault unreadable — accounts kept reserved";
      await row.save();
    }
    return { archived: vault ? vault.archived.length : null, released: rel ? rel.released.length : 0 };
  }
  const badCategory = new Set();

  const results = [];
  for (const [i, c] of chosen.entries()) {
    const n = Math.min(MAX_PER_OFFER, Math.floor(c.spare / 2));
    const entry = { set: c.sid, game: c.task.game, title: String(c.gfRow.title || "").slice(0, 100), gfPrice: c.gfRow.price, spare: c.spare, qty: n, task: String(c.task._id), taskStatus: c.task.status };
    if (!APPLY) {
      if (DRY_CATS) entry.categoryId = await categoryFor(c.task.game);
      entry.venuePrice = await autoLister.venuePrice("ggsel", c.gfRow.price, { title: c.gfRow.title });
      results.push(entry);
      continue;
    }
    const cat = await categoryFor(c.task.game);
    entry.categoryId = cat;
    if (!cat) { entry.error = "no GGSel category for " + c.task.game; results.push(entry); log(`[${i + 1}/${chosen.length}] SKIP`, entry.error); continue; }
    if (badCategory.has(cat)) { entry.error = "GGSel category " + cat + " is not " + c.task.game + "'s own"; results.push(entry); log(`[${i + 1}/${chosen.length}] SKIP`, entry.error); continue; }
    // Fresh pick at publish time — the earlier count is only the plan.
    const accounts = (await autoLister.pickDeliveryAccounts(c.task, 30, c.set.items || [])).slice(0, n);
    if (!accounts.length) { entry.error = "no spare account at publish time"; results.push(entry); continue; }
    const listingKey = String(c.task.listing && c.task.listing.setId) === c.sid ? "listing" : "stackListing";
    const description = autoLister.buildDescription({
      game: c.task.game,
      items: plain(c.set.items),
      campaignName: c.task.campaignName,
      postEvent: !!(c.task[listingKey] && c.task[listingKey].postEvent),
      marketplace: "ggsel",
    });
    let img = "";
    try { img = await buildSetGridImage(c.set); } catch { img = ""; }
    let r = null;
    let price = Number(c.gfRow.price) || 0;
    try {
      for (let attempt = 0; attempt < 3 && !r; attempt++) {
        try {
          r = await autoLister.publishGgselShare({ set: c.set, title: c.gfRow.title, description, price, img, accounts, categoryId: cat });
        } catch (e) {
          // GGSel's per-category minimum is published nowhere; a refusal is
          // the only way to learn it (project note: category min price).
          if (/category minimum price/i.test(e.message || "") && attempt < 2) {
            price = Math.round(price * 1.5 * 100) / 100;
            entry.minPriceRetry = price;
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      entry.error = String(e.message || e).slice(0, 300);
    } finally {
      if (img) await fsp.unlink(img).catch(() => {});
    }
    if (r) {
      entry.externalId = r.externalId;
      entry.url = r.url;
      entry.fed = r.qty;
      // GGSel's own word on where the offer landed.
      try {
        const o = await readOffer(r.externalId);
        entry.categoryTree = String((o.category && o.category.tree) || "");
      } catch (e) {
        entry.categoryTree = "";
        entry.readBack = "category unreadable: " + String(e.message || e).slice(0, 80);
      }
      if (entry.categoryTree && !categoryFits(entry.categoryTree, c.task.game)) {
        badCategory.add(cat);
        entry.retracted = await retract(r.externalId, "landed in GGSel category \"" + entry.categoryTree + "\", not " + c.task.game + "'s own");
        entry.error = "wrong category " + entry.categoryTree;
        r = null;
      }
    }
    if (r) {
      const t = await AutoFarmTask.findById(c.task._id);
      if (t) {
        t[listingKey] = t[listingKey] || {};
        t[listingKey].ggsel = { externalId: r.externalId, url: r.url || "", qty: r.qty || accounts.length, error: "" };
        t.markModified(listingKey);
        await t.save();
      }
    }
    results.push(entry);
    log(`[${i + 1}/${chosen.length}]`, r ? "LISTED " + r.externalId + " ×" + r.qty : "FAILED " + entry.error, "|", entry.title.slice(0, 70));
    await wait(PACE_MS);
  }

  if (APPLY) {
    // GGSel attaches codes through an async job: read every new offer back,
    // and re-finalize a stocked offer the activation left paused.
    await wait(30000);
    for (const e of results.filter((x) => x.externalId && !x.retracted)) {
      try {
        const o = await readOffer(e.externalId);
        const st = String(o.status || "");
        const stock = mp.ggselStockField(o);
        e.status = st;
        e.stock = stock;
        if ((st === "paused" || st === "draft") && Number(stock) > 0) {
          const fin = await mp.ggselFinalizeStock(e.externalId);
          e.status = fin.activationStuck ? fin.activationStatus : "active";
          e.refinalized = true;
        }
      } catch (err) {
        e.readBack = String(err.message || err).slice(0, 120);
      }
      await wait(700);
    }
    // A publish that timed out after GGSel created the offer leaves a draft we
    // have no row for — possibly holding codes of accounts the rollback already
    // released. Pause it and archive its codes so it can never sell them.
    const orphans = [];
    try {
      const all = await mp.ggselAllOffers({ pageSize: 100, paceMs: 800 });
      const known = new Set((await MarketplaceListing.distinct("externalId", { marketplace: "ggsel" })).map(String));
      for (const o of all) {
        if (known.has(String(o.id))) continue;
        if (!(new Date(o.created_at) >= RUN_STARTED)) continue;
        await mp.ggselDelist(String(o.id)).catch(() => {});
        let v = null;
        try { v = await mp.ggselEmptyVault(String(o.id)); } catch { v = null; }
        orphans.push({ id: String(o.id), title: String(o.title_en || "").slice(0, 60), archived: v ? v.archived.length : null });
      }
    } catch (e) {
      orphans.push({ error: "orphan sweep failed: " + String(e.message || e).slice(0, 100) });
    }
    if (orphans.length) log("orphan offers (no row) paused + emptied:", JSON.stringify(orphans));
    // Active tasks this run did not list keep no stale pointer at a dead
    // GGSel offer, so the auto-lister's own retry can list them later.
    const cleared = [];
    for (const t of await AutoFarmTask.find({ status: "active", "listing.ggsel.externalId": { $nin: ["", null] } })) {
      const row = await MarketplaceListing.findOne({ marketplace: "ggsel", externalId: String(t.listing.ggsel.externalId) }, { status: 1 }).lean();
      if (row && row.status === "active") continue;
      cleared.push({ task: String(t._id), game: t.game, was: t.listing.ggsel.externalId });
      t.listing.ggsel = { externalId: "", url: "", qty: 0, error: "" };
      t.markModified("listing");
      await t.save();
    }
    const ok = results.filter((x) => x.externalId && !x.retracted);
    const trees = {};
    for (const x of ok) trees[x.game] = x.categoryTree || "?";
    log("categories:", JSON.stringify(trees));
    const retracted = results.filter((x) => x.retracted);
    if (retracted.length) log("retracted (wrong category):", JSON.stringify(retracted.map((x) => [x.externalId, x.game, x.categoryTree])));
    const statusCount = ok.reduce((m, x) => ((m[x.status || "?"] = (m[x.status || "?"] || 0) + 1), m), {});
    const summary = `GGSel relist: ${ok.length} fresh offers (${JSON.stringify(statusCount)}), ${ok.reduce((n, x) => n + (x.fed || 0), 0)} accounts committed; ${results.filter((x) => x.error && !x.retracted).length} failed/skipped at publish; ${results.filter((x) => x.retracted).length} retracted for a wrong category; ${cleared.length} stale GGSel pointers cleared on active tasks; ${orphans.filter((o) => o.id).length} row-less offers from this run emptied`;
    logEvent({ category: "listings", action: "ggsel_relist", actor: "claude (owner: GGSel start again)", count: ok.length, detail: summary });
    await wait(1500);
    log(summary);
    fs.writeFileSync(`/root/_rehome_work/ggsel_relist_${TS}.json`, JSON.stringify({ at: new Date(), results, cleared, skipped, orphans }, null, 1));
  } else {
    if (DRY_CATS) {
      const noCat = results.filter((x) => !x.categoryId);
      log("dry run: categories resolved for", results.length - noCat.length, "of", results.length, "| no category:", JSON.stringify([...new Set(noCat.map((x) => x.game))]));
    }
    for (const x of results) log("  plan", x.qty + "x", "$" + x.gfPrice, "-> GGSel $" + x.venuePrice, "| spare", x.spare, "|", x.game, "|", x.title.slice(0, 80));
    fs.writeFileSync(`/root/_rehome_work/ggsel_relist_dry_${TS}.json`, JSON.stringify({ at: new Date(), results, skipped }, null, 1));
  }
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FATAL", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
