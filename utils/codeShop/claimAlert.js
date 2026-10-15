"use strict";
// Code shop claim alert (docs/code-shop/04-OPS.md, "claimAlert.js"): tell the
// owner, once per reward, that a farm reward is about to expire unclaimed.
//
// A reward still in a login's "available" list has not been claimed. Code
// rewards are claimed by the farm itself while the login works, so one that is
// close to its end usually sits on a login that is down; in-game and link
// rewards always need a click. Either way the owner has hours, not days, so
// every kind is reported.
//
// "Already told" is a stamp per inventory row (`claim-due:<loginId>|<key>`),
// taken only AFTER Telegram took the message: a failed send leaves no stamps,
// so the next tick tries again with the same rows. Stamps live 30 days (the
// event TTL), far longer than a reward's last day.
//
// Owner-facing plain text (no Markdown): reward and game names, login ids,
// dates. Never a code — this reads no code fields at all.

const { DEFAULTS } = require("./config");

const HOUR_MS = 60 * 60 * 1000;
const MAX_LINES = 15;
const NAME_MAX = 80;
const STAMP_PREFIX = "claim-due:";
const CLOSING =
  "Code rewards are claimed by themselves while the login works; in-game and link rewards need a click in the farm panel.";

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  SoopInventoryItem: () => require("../../models/SoopInventoryItem"),
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

// One line per reward: names arrive from SOOP and may carry line breaks.
function oneLine(v, max = NAME_MAX) {
  const s = text(v).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

// "2026-10-16 03:00" (UTC).
function utcStamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

function stampKey(row) {
  return STAMP_PREFIX + text(row.loginId) + "|" + text(row.key);
}

function leadOf(cfg) {
  const h = Number(cfg && cfg.claimAlert && cfg.claimAlert.leadHours);
  return Number.isFinite(h) && h >= 0 ? h : DEFAULTS.claimAlert.leadHours;
}

// Pure: the whole Telegram message for the rows not told yet (soonest first).
function alertText(rows, leadHours) {
  const lines = [`${rows.length} farm reward(s) expire unclaimed within ${leadHours} h`];
  for (const r of rows.slice(0, MAX_LINES)) {
    const game = oneLine(r.gameName) || "Unknown game";
    const name = oneLine(r.name) || oneLine(r.nameRaw) || "a reward";
    const exp = toMs(r.expiresAt);
    lines.push(`- ${game}: ${name} on ${oneLine(r.loginId)} (by ${exp === null ? "an unknown time" : utcStamp(exp)} UTC)`);
  }
  if (rows.length > MAX_LINES) lines.push(`+ ${rows.length - MAX_LINES} more`);
  lines.push(CLOSING);
  return lines.join("\n");
}

function createClaimAlert(deps = {}) {
  const clock = () => {
    const t = toMs(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  // Resolved on first use so a test's fakes never load the real ones.
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig({ now: clock }));
  const getEvents = () => events || (events = require("./events").createEvents({ now: clock }));

  async function effectiveConfig() {
    try {
      return (await getConfig().get()) || DEFAULTS;
    } catch {
      // config.get never throws in production; a fake might
      return DEFAULTS;
    }
  }

  async function note(entry) {
    try {
      const ev = getEvents();
      if (ev && typeof ev.log === "function") await ev.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  async function run() {
    const cfg = await effectiveConfig();
    if (!cfg || !cfg.claimAlert || !cfg.claimAlert.enabled) return { due: 0, told: 0 };

    const now = clock();
    const leadHours = leadOf(cfg);
    const rows = await modelOf(deps, "SoopInventoryItem")
      .find(
        { division: "available", expiresAt: { $gt: new Date(now), $lte: new Date(now + leadHours * HOUR_MS) } },
        { loginId: 1, key: 1, kind: 1, gameName: 1, name: 1, nameRaw: 1, expiresAt: 1 },
      )
      .sort({ expiresAt: 1, loginId: 1, key: 1 })
      .lean();

    // Sequential on purpose: a handful of indexed lookups once per tick.
    const fresh = [];
    for (const r of rows) {
      if (!(await getEvents().has(stampKey(r)))) fresh.push(r);
    }
    const out = { due: rows.length, told: 0 };
    if (!fresh.length) return out;

    try {
      const telegram = deps.telegram;
      if (!telegram || typeof telegram.send !== "function") throw new Error("no Telegram sender configured");
      await telegram.send(alertText(fresh, leadHours));
    } catch (err) {
      // Nothing is stamped, so the same rows are reported on the next tick.
      await note({
        level: "warn",
        kind: "claim-alert",
        msg: `Claim alert for ${fresh.length} reward(s) was not sent: ` + text(err && err.message).slice(0, 200),
      });
      return out;
    }

    let stampErrors = 0;
    for (const r of fresh) {
      try {
        await getEvents().stamp(stampKey(r), { kind: "claim-alert", msg: `${oneLine(r.gameName)}: ${oneLine(r.name || r.nameRaw)} on ${oneLine(r.loginId)}` });
      } catch {
        stampErrors += 1;
      }
    }
    if (stampErrors) {
      // The owner was told; at worst these rows are told once more next tick.
      await note({ level: "warn", kind: "claim-alert", msg: `Claim alert sent, but ${stampErrors} stamp(s) were not saved` });
    }
    out.told = fresh.length;
    return out;
  }

  return { run };
}

module.exports = { createClaimAlert, alertText, stampKey };
