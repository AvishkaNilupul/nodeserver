"use strict";
// Code shop daily digest (docs/code-shop/04-OPS.md, "digest.js"): one plain
// Telegram message a day with what the farm earned, what sold, what is on sale
// and what needs the owner.
//
// - digestText(d) is pure: numbers in, at most 25 lines out. Lines that only
//   matter when something needs attention (expiring, drafts, held, logins down)
//   are left out at zero.
// - collectDigest(deps, now) reads those numbers from the ledger, the products
//   and the farm logins. Counts and names only — never a code.
// - run() sends once per UTC day from `digest.hourUtc` on. `lastSentDay` is
//   written only after Telegram took the message, so a failed send is retried
//   on the next tick; run() never throws (the scheduler's next step must run).

const { DEFAULTS } = require("./config");
const { DEAD, REJECTED } = require("../soop/farmViews");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EXPIRING_MS = 3 * DAY_MS;
const MAX_LINES = 25;
const MAX_SUB_LINES = 5; // product lines under "Sold" and under "Expiring"
const MAX_GAMES = 5;
const NAME_MAX = 60;

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SoopAccount: () => require("../../models/SoopAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const text = (v) => (v === undefined || v === null ? "" : String(v));
const pad2 = (n) => String(n).padStart(2, "0");
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const money = (v) => {
  const n = Number(v);
  return "$" + (Number.isFinite(n) ? n : 0).toFixed(2);
};
const cents = (n) => Math.round(n * 100) / 100;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Owner-set names may carry line breaks; one name must stay on one line.
function oneLine(v, max = NAME_MAX) {
  const s = text(v).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

// "2026-10-15" (UTC).
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// "2026-10-17 14:00 UTC".
function utcWhen(v) {
  const ms = toMs(v);
  if (ms === null) return "an unknown time";
  const d = new Date(ms);
  return `${utcDay(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

const list = (v) => (Array.isArray(v) ? v : []);

// Pure. `d` = { day, earned: [{game, n}], sold: {units, usd, byProduct: [{name, units, usd}]},
// onSale: {units, products}, expiring: [{name, units, useBy}], drafts, held, loginsDown, inStock }.
function digestText(d = {}) {
  const lines = [`Code shop - ${text(d.day)}`];

  const earned = list(d.earned).filter((g) => count(g && g.n) > 0);
  const earnedTotal = earned.reduce((s, g) => s + count(g.n), 0);
  let earnedLine = `Earned (24 h): ${plural(earnedTotal, "code", "codes")}`;
  if (earned.length) {
    const parts = earned.slice(0, MAX_GAMES).map((g) => `${oneLine(g.game) || "Unknown game"}: ${count(g.n)}`);
    if (earned.length > MAX_GAMES) parts.push(`+${earned.length - MAX_GAMES} more`);
    earnedLine += ` (${parts.join(", ")})`;
  }
  lines.push(earnedLine);

  const sold = d.sold || {};
  lines.push(`Sold (24 h): ${plural(count(sold.units), "bundle", "bundles")}, ${money(sold.usd)}`);
  const byProduct = list(sold.byProduct);
  for (const p of byProduct.slice(0, MAX_SUB_LINES)) {
    lines.push(`  - ${oneLine(p.name) || "Unnamed product"}: ${plural(count(p.units), "bundle", "bundles")}, ${money(p.usd)}`);
  }
  if (byProduct.length > MAX_SUB_LINES) lines.push(`  + ${byProduct.length - MAX_SUB_LINES} more`);

  const onSale = d.onSale || {};
  lines.push(`On sale: ${plural(count(onSale.units), "bundle", "bundles")} in ${plural(count(onSale.products), "product", "products")}`);

  const expiring = list(d.expiring).filter((e) => count(e && e.units) > 0);
  if (expiring.length) {
    const total = expiring.reduce((s, e) => s + count(e.units), 0);
    lines.push(`Expiring within 3 days: ${plural(total, "bundle", "bundles")}`);
    for (const e of expiring.slice(0, MAX_SUB_LINES)) {
      lines.push(`  - ${oneLine(e.name) || "Unnamed product"}: ${plural(count(e.units), "bundle", "bundles")}, first by ${utcWhen(e.useBy)}`);
    }
    if (expiring.length > MAX_SUB_LINES) lines.push(`  + ${expiring.length - MAX_SUB_LINES} more`);
  }

  if (count(d.drafts)) lines.push(`Drafts waiting for you: ${count(d.drafts)}`);
  if (count(d.held)) lines.push(`Held for checking: ${count(d.held)}`);
  if (count(d.loginsDown)) lines.push(`Farm logins down: ${count(d.loginsDown)}`);
  lines.push(`Free codes not in any bundle: ${count(d.inStock)}`);

  // The caps above keep it near 20 lines; this is only the backstop.
  return lines.slice(0, MAX_LINES).join("\n");
}

async function configOf(deps) {
  try {
    if (deps && deps.config && typeof deps.config.get === "function") return (await deps.config.get()) || DEFAULTS;
  } catch {
    // config.get never throws in production; a fake might
  }
  return DEFAULTS;
}

function gameLabel(cfg, gameNo, gameName) {
  const g = cfg && cfg.games && gameNo ? cfg.games[gameNo] : null;
  return oneLine((g && g.displayName) || gameName || (gameNo ? "Game " + gameNo : "")) || "Unknown game";
}

function productLabel(p) {
  if (!p) return "Unnamed product";
  return oneLine(p.name) || oneLine(p.texts && p.texts.title) || oneLine(p.gameName) || "Unnamed product";
}

const idOf = (v) => (v === null || v === undefined ? "" : String(v));

// Builds `d` for digestText from the database, as of `now` (ms or Date).
async function collectDigest(deps = {}, now) {
  let t = toMs(now);
  if (t === null) t = toMs(typeof deps.now === "function" ? deps.now() : Date.now());
  if (t === null) t = Date.now();
  const since = new Date(t - DAY_MS);
  const at = new Date(t);

  const cfg = await configOf(deps);
  const CodeStock = modelOf(deps, "CodeStock");
  const CodeProduct = modelOf(deps, "CodeProduct");
  const SoopAccount = modelOf(deps, "SoopAccount");

  const [earnedRows, soldRows, saleRows, drafts, held, inStock, loginsDown] = await Promise.all([
    // A ledger row is created when its code was stored, which is what
    // "earned" means to the shop (inventory sentAt can be days earlier).
    // By when the farm earned the code, not when the shop first saw it: the
    // first pass after a deploy would otherwise call every old code "new".
    CodeStock.find({ earnedAt: { $gt: since, $lte: at } }, { gameNo: 1, gameName: 1 }).lean(),
    // Replacement codes handed to a buyer after a dead code are not a sale.
    CodeStock.find(
      { state: { $in: ["sold", "dead"] }, soldAt: { $gt: since, $lte: at }, market: { $ne: "replacement" } },
      { unit: 1, product: 1, saleUsd: 1 },
    ).lean(),
    CodeStock.find({ state: "in_unit", unitStatus: "available" }, { unit: 1, product: 1, useBy: 1 }).lean(),
    // A stale draft is one the planner no longer proposes: not waiting on anyone.
    CodeProduct.countDocuments({ status: "draft", stale: { $ne: true } }),
    CodeStock.countDocuments({ state: "held" }),
    CodeStock.countDocuments({ state: "in_stock" }),
    // The same two statuses the farm panel calls a login that cannot farm.
    SoopAccount.countDocuments({ sold: { $ne: true }, status: { $in: [DEAD, REJECTED] } }),
  ]);

  // Earned, by game.
  const games = new Map();
  for (const r of earnedRows) {
    const key = text(r.gameNo) || "name:" + text(r.gameName);
    const g = games.get(key) || { game: gameLabel(cfg, text(r.gameNo), r.gameName), n: 0 };
    g.n += 1;
    games.set(key, g);
  }
  const earned = [...games.values()].sort((a, b) => b.n - a.n || a.game.localeCompare(b.game));

  // Sold: bundles are distinct units; money is each code's share of its sale.
  const soldUnits = new Set();
  const soldBy = new Map();
  let usd = 0;
  for (const r of soldRows) {
    const s = Number(r.saleUsd);
    const share = Number.isFinite(s) ? s : 0;
    usd += share;
    const pid = idOf(r.product);
    const p = soldBy.get(pid) || { product: r.product, units: new Set(), usd: 0 };
    p.usd += share;
    if (r.unit) {
      soldUnits.add(idOf(r.unit));
      p.units.add(idOf(r.unit));
    }
    soldBy.set(pid, p);
  }

  // On sale: distinct units the stock sync can sell right now.
  const saleUnits = new Set();
  const saleProducts = new Set();
  const soon = new Map(); // product id -> { product, units: Set, useBy }
  const horizon = t + EXPIRING_MS;
  for (const r of saleRows) {
    if (r.unit) saleUnits.add(idOf(r.unit));
    if (r.product) saleProducts.add(idOf(r.product));
    const u = toMs(r.useBy);
    if (u === null || u > horizon || !r.unit) continue;
    const pid = idOf(r.product);
    const e = soon.get(pid) || { product: r.product, units: new Set(), useBy: u };
    e.units.add(idOf(r.unit));
    if (u < e.useBy) e.useBy = u;
    soon.set(pid, e);
  }

  const productIds = [...new Set([...soldBy.values(), ...soon.values()].map((x) => x.product).filter(Boolean).map(idOf))];
  const products = productIds.length
    ? await CodeProduct.find({ _id: { $in: productIds } }, { name: 1, gameName: 1, "texts.title": 1 }).lean()
    : [];
  const productById = new Map(products.map((p) => [idOf(p._id), p]));
  const nameOf = (pid) => (pid ? productLabel(productById.get(pid)) : "No product");

  const byProduct = [...soldBy.entries()]
    .map(([pid, p]) => ({ name: nameOf(pid), units: p.units.size, usd: cents(p.usd) }))
    .filter((p) => p.units > 0 || p.usd > 0)
    .sort((a, b) => b.usd - a.usd || b.units - a.units || a.name.localeCompare(b.name));

  const expiring = [...soon.entries()]
    .map(([pid, e]) => ({ name: nameOf(pid), units: e.units.size, useBy: new Date(e.useBy) }))
    .sort((a, b) => a.useBy - b.useBy || a.name.localeCompare(b.name));

  return {
    day: utcDay(t),
    earned,
    sold: { units: soldUnits.size, usd: cents(usd), byProduct },
    onSale: { units: saleUnits.size, products: saleProducts.size },
    expiring,
    drafts,
    held,
    loginsDown,
    inStock,
  };
}

function createDigest(deps = {}) {
  const clock = () => {
    const t = toMs(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  // Resolved on first use so a test's fakes never load the real ones.
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig({ now: clock }));
  const getEvents = () => events || (events = require("./events").createEvents({ now: clock }));

  async function note(entry) {
    try {
      const ev = getEvents();
      if (ev && typeof ev.log === "function") await ev.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  const errText = (err) => text(err && err.message).slice(0, 200);

  async function run({ force = false } = {}) {
    try {
      const now = clock();
      const today = utcDay(now);
      const cfg = await configOf({ config: getConfig() });
      const dg = (cfg && cfg.digest) || DEFAULTS.digest;
      if (!force) {
        if (!dg.enabled) return { sent: false };
        const h = Number(dg.hourUtc);
        const hourUtc = Number.isFinite(h) ? h : DEFAULTS.digest.hourUtc;
        if (new Date(now).getUTCHours() < hourUtc) return { sent: false };
        if (text(dg.lastSentDay) === today) return { sent: false };
      }

      let body;
      try {
        body = digestText(await collectDigest({ ...deps, config: getConfig() }, now));
      } catch (err) {
        await note({ level: "error", kind: "digest", msg: "Daily digest was not built: " + errText(err) });
        return { sent: false };
      }

      try {
        const telegram = deps.telegram;
        if (!telegram || typeof telegram.send !== "function") throw new Error("no Telegram sender configured");
        await telegram.send(body);
      } catch (err) {
        // lastSentDay stays as it was, so the next tick tries again.
        await note({ level: "warn", kind: "digest", msg: "Daily digest was not sent: " + errText(err) });
        return { sent: false, text: body };
      }

      try {
        await getConfig().set({ digest: { lastSentDay: today } }, { actor: "digest" });
      } catch (err) {
        // Sent already; without the mark the next tick sends it once more.
        await note({ level: "warn", kind: "digest", msg: "Daily digest sent, but the day was not saved: " + errText(err) });
      }
      await note({ kind: "digest", msg: `Daily digest sent for ${today}` + (force ? " (asked for)" : "") });
      return { sent: true, text: body };
    } catch (err) {
      await note({ level: "error", kind: "digest", msg: "Daily digest failed: " + errText(err) });
      return { sent: false };
    }
  }

  return { run };
}

module.exports = { digestText, collectDigest, createDigest };
