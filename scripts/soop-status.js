#!/usr/bin/env node
// Read-only status of the SOOP farm, for the production box:
//
//   node scripts/soop-status.js [--all]
//
// Connects with MONGO_URI (from .env, the way server.js does) and prints
// accounts by status, bots, remembered campaigns and inventory totals.
// It only runs find / countDocuments on the raw collections: no models are
// loaded (so no index is built), nothing is written, SOOP is never called, and
// cookies and reward codes are never read — every query names its fields.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mongoose = require("mongoose");

const ALL = process.argv.includes("--all");
const CAP = ALL ? Infinity : 25;
const SOON_MS = 72 * 3600 * 1000;

// Titles, nicknames and errors come from SOOP: strip control characters so a
// crafted string cannot drive the terminal.
const clean = (v, max = 60) => {
  // eslint-disable-next-line no-control-regex
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") + "Z" : "—");
const pad = (v, n) => {
  const s = String(v);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
};
const tally = (rows, keyOf) => {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    out.set(k, (out.get(k) || 0) + 1);
  }
  return [...out].sort((a, b) => b[1] - a[1]);
};
const head = (title) => console.log(`\n== ${title} ==`);
const table = (rows) => {
  if (!rows.length) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("  " + r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd());
};
// A long list is cut at CAP rows unless --all was given.
const list = (rows, label, toCells = (r) => r) => {
  table(rows.slice(0, CAP).map(toCells));
  if (rows.length > CAP) console.log(`  … ${rows.length - CAP} more ${label} (run with --all)`);
};

async function accounts(db) {
  const rows = await db
    .collection("soopaccounts")
    .find({}, {
      projection: {
        loginId: 1, nickname: 1, country: 1, status: 1, sold: 1, lastError: 1,
        lastCheckedAt: 1, cookieAt: 1, deadAt: 1, progress: 1,
      },
    })
    .toArray();
  head(`Accounts (${rows.length})`);
  const sold = rows.filter((a) => a.sold);
  const mine = rows.filter((a) => !a.sold);
  table([...tally(mine, (a) => clean(a.status || "untested", 20)), ["sold", sold.length]]);
  const countries = tally(mine, (a) => clean(a.country || "?", 4)).map(([k, n]) => `${k} ${n}`).join(", ");
  if (countries) console.log(`  countries: ${countries}`);
  const withProgress = mine.filter((a) => a.progress && Object.keys(a.progress).length).length;
  console.log(`  with recorded progress: ${withProgress}`);

  const bad = mine.filter((a) => (a.status || "untested") !== "ok");
  if (bad.length) {
    console.log("\n  Needing attention:");
    list(bad, "accounts", (a) => [
      clean(a.loginId, 24), clean(a.nickname, 20), clean(a.status || "untested", 20),
      `checked ${when(a.lastCheckedAt)}`, `cookie ${when(a.cookieAt)}`, clean(a.lastError, 70),
    ]);
  }
  return rows;
}

async function bots(db, accountRows) {
  const rows = await db
    .collection("soopfarmtasks")
    .find({}, {
      projection: {
        label: 1, mode: 1, dropsIdx: 1, gameNo: 1, target: 1, codesOnly: 1,
        accountIds: 1, doneIds: 1, active: 1, startedAt: 1, endedAt: 1,
      },
    })
    .sort({ startedAt: -1 })
    .toArray();
  const active = rows.filter((b) => b.active);
  head(`Bots (${rows.length}, ${active.length} active)`);
  list(active, "bots", (b) => [
    clean(b.label || String(b._id), 28),
    clean(b.mode || "campaign", 10),
    b.dropsIdx ? `campaign ${clean(b.dropsIdx, 12)}` : b.gameNo ? `game ${clean(b.gameNo, 8)}` : "every game",
    `target ${clean(b.target || "all", 8)}${b.codesOnly ? ", codes only" : ""}`,
    `${(b.doneIds || []).length}/${(b.accountIds || []).length} done`,
    `since ${when(b.startedAt)}`,
  ]);
  const inBots = new Set(active.flatMap((b) => b.accountIds || []));
  const usable = accountRows.filter((a) => !a.sold && (a.status || "untested") === "ok");
  const free = usable.filter((a) => !inBots.has(String(a._id)) && !inBots.has(a.loginId));
  console.log(`  accounts in an active bot: ${inBots.size} · usable and free: ${free.length}`);
  const last = rows.find((b) => !b.active);
  if (last) console.log(`  last stopped: ${clean(last.label || String(last._id), 28)} at ${when(last.endedAt)}`);
}

async function campaigns(db) {
  const rows = await db
    .collection("soopcampaigns")
    .find({}, {
      projection: {
        dropsIdx: 1, title: 1, giveCon: 1, gameNo: 1, live: 1, lastLiveAt: 1,
        filter: 1, startDate: 1, endDate: 1, seenAt: 1,
      },
    })
    .sort({ endDate: -1 })
    .toArray();
  const now = Date.now();
  const open = rows.filter((c) => !c.endDate || new Date(c.endDate).getTime() > now);
  const live = rows.filter((c) => c.live);
  head(`Remembered campaigns (${rows.length})`);
  console.log(
    `  flagged live: ${live.length} · not ended: ${open.length} · ` +
      `guaranteed: ${rows.filter((c) => c.giveCon === "term").length}`,
  );
  const newest = rows.reduce((m, c) => Math.max(m, c.seenAt ? new Date(c.seenAt).getTime() : 0), 0);
  console.log(`  last seen by a scan: ${when(newest || null)}`);
  const shown = ALL ? rows : open;
  if (shown.length) console.log(ALL ? "\n  All:" : "\n  Not ended:");
  list(shown, "campaigns", (c) => [
    clean(c.dropsIdx, 12), clean(c.giveCon || "?", 8), c.live ? "LIVE" : "-", `game ${clean(c.gameNo || "?", 8)}`,
    `${when(c.startDate)} → ${when(c.endDate)}`, clean(c.title, 50),
  ]);
}

async function inventory(db) {
  const col = db.collection("soopinventoryitems");
  const rows = await col
    .find({}, {
      projection: {
        loginId: 1, division: 1, gameNo: 1, gameName: 1, kind: 1,
        expiresAt: 1, hasCode: 1, syncedAt: 1,
      },
    })
    .toArray();
  const now = Date.now();
  const count = (d) => rows.filter((i) => i.division === d).length;
  const soon = rows.filter((i) => {
    const t = i.expiresAt ? new Date(i.expiresAt).getTime() : 0;
    return i.division === "available" && t > now && t - now <= SOON_MS;
  });
  head(`Inventory (${rows.length} items on ${new Set(rows.map((i) => i.loginId)).size} accounts)`);
  table([
    ["available (unclaimed)", count("available")],
    ["  expiring within 72 h", soon.length],
    ["acquired (claimed)", count("acquired")],
    ["expired", count("expired")],
    ["with a stored code", rows.filter((i) => i.hasCode).length],
  ]);
  const lastSync = rows.reduce((m, i) => Math.max(m, i.syncedAt ? new Date(i.syncedAt).getTime() : 0), 0);
  console.log(`  last sync: ${when(lastSync || null)}`);
  const games = tally(rows.filter((i) => i.division === "available"), (i) =>
    clean(i.gameName || (i.gameNo ? `Game #${i.gameNo}` : "Other"), 32),
  );
  if (games.length) {
    console.log("\n  Available by game:");
    list(games, "games");
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set (expected in .env next to server.js).");
    process.exit(1);
  }
  // autoIndex / autoCreate off: connecting must not create anything.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log(`SOOP farm status · database "${db.databaseName}" · ${when(new Date())}`);
  const accountRows = await accounts(db);
  await bots(db, accountRows);
  await campaigns(db);
  await inventory(db);
  console.log("");
}

main()
  .catch((err) => {
    // The message of a connection error can quote the URI, which holds the password.
    console.error("soop-status failed:", String(err.message || err).replace(/\/\/[^@/\s]+@/g, "//***@"));
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
