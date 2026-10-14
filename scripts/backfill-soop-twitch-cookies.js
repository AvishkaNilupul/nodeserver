#!/usr/bin/env node
// Backfill the TwitchWebCookie collection from the local emailnator-proxy's
// web-twitch-cookies.json dump. Run ONCE on each box that needs the harvested
// jars seeded (dev box first; on prod, scp the file over or re-run after any
// re-harvest). Idempotent — overwrites existing entries by twitchLogin, so
// re-running is safe.
//
// Also optionally backfills SoopAccount.twitchLogin from the embedded
// soop-relogin.user.js RELOGIN_QUEUE (same place the mapping has lived until
// now). Set --no-link to skip that part.
//
// Usage:
//   node scripts/backfill-soop-twitch-cookies.js
//   node scripts/backfill-soop-twitch-cookies.js --file /path/to/web-twitch-cookies.json
//   node scripts/backfill-soop-twitch-cookies.js --no-link
//
// Secrets note: the source JSON file contains Twitch passwords. We DO NOT
// persist them — only cookies. Passwords live in the local file only.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const WEB_COOKIES_DEFAULT =
  "/Users/avishkanilupul/Downloads/web-twitch-cookies.json";
const SOOP_RELOGIN_DEFAULT =
  "/Users/avishkanilupul/Downloads/soop-relogin.user.js";

function parseArgs(argv) {
  const out = { file: WEB_COOKIES_DEFAULT, link: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") out.file = argv[++i];
    else if (argv[i] === "--no-link") out.link = false;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "usage: node scripts/backfill-soop-twitch-cookies.js [--file <path>] [--no-link]",
      );
      process.exit(0);
    }
  }
  return out;
}

// Pull the login→soopId map out of soop-relogin.user.js's RELOGIN_QUEUE
// without eval'ing the whole file.
function parseReloginQueue(userscriptPath) {
  if (!fs.existsSync(userscriptPath)) return [];
  const src = fs.readFileSync(userscriptPath, "utf8");
  const block = src.match(/const RELOGIN_QUEUE = \[([\s\S]*?)\];/);
  if (!block) return [];
  const rows = [];
  const re = /soopId:\s*'([^']+)',\s*login:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1]))) rows.push({ soopId: m[1], login: m[2].toLowerCase() });
  return rows;
}

function cookieExpiryDate(cookies, name) {
  const c = (cookies || []).find((x) => x && x.name === name);
  if (!c || !c.expirationDate) return null;
  return new Date(c.expirationDate * 1000);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  // Load config / connect to Mongo via the same path the app uses.
  const config = require("../config/config");
  const { encrypt } = require("../utils/secretBox");
  const TwitchWebCookie = require("../models/TwitchWebCookie");
  const SoopAccount = require("../models/SoopAccount");

  if (!fs.existsSync(args.file)) {
    console.error(`web-twitch-cookies.json not found: ${args.file}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(args.file, "utf8"));
  const entries = Object.entries(raw);
  console.log(`[backfill] source: ${args.file} (${entries.length} account(s))`);

  const mongoUri = config.mongoURI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGO_URI not set in config/env");
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log("[backfill] mongo connected");

  let ok = 0,
    skipped = 0;
  for (const [login, entry] of entries) {
    const twitchLogin = String(login).trim().toLowerCase();
    const cookies = Array.isArray(entry.cookies) ? entry.cookies : [];
    const twitchOnly = cookies.filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        /twitch\.tv/i.test(String(c.domain || "")),
    );
    const names = new Set(twitchOnly.map((c) => c.name));
    if (!names.has("auth-token")) {
      console.warn(
        `[backfill] skip ${twitchLogin}: no auth-token (incomplete capture)`,
      );
      skipped++;
      continue;
    }
    const shortLived = !names.has("persistent");
    await TwitchWebCookie.findOneAndUpdate(
      { twitchLogin },
      {
        $set: {
          twitchLogin,
          cookies: encrypt(JSON.stringify(twitchOnly)),
          cookieCount: twitchOnly.length,
          shortLived,
          persistentExpiresAt: cookieExpiryDate(twitchOnly, "persistent"),
          authTokenExpiresAt: cookieExpiryDate(twitchOnly, "auth-token"),
          harvestedAt: entry.capturedAt ? new Date(entry.capturedAt) : new Date(),
          source: entry.source || `backfill from ${path.basename(args.file)}`,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    const persistDays = cookieExpiryDate(twitchOnly, "persistent");
    const persistTxt = persistDays
      ? `${((persistDays.getTime() - Date.now()) / 86400000).toFixed(0)}d`
      : "MISSING";
    console.log(
      `[backfill] ${twitchLogin}: ${twitchOnly.length} cookies, persistent=${persistTxt}${shortLived ? " (SHORT-LIVED)" : ""}`,
    );
    ok++;
  }
  console.log(
    `[backfill] TwitchWebCookie: ${ok} upserted, ${skipped} skipped (incomplete).`,
  );

  if (args.link) {
    const queue = parseReloginQueue(SOOP_RELOGIN_DEFAULT);
    if (!queue.length) {
      console.log(
        `[backfill] no RELOGIN_QUEUE found at ${SOOP_RELOGIN_DEFAULT}; skipping soopId↔twitchLogin link.`,
      );
    } else {
      console.log(
        `[backfill] linking soopId→twitchLogin from ${SOOP_RELOGIN_DEFAULT} (${queue.length} rows)`,
      );
      let linked = 0,
        missing = 0;
      for (const row of queue) {
        const r = await SoopAccount.updateOne(
          { loginId: row.soopId },
          { $set: { twitchLogin: row.login } },
        );
        if (r.matchedCount) linked++;
        else {
          missing++;
          console.warn(
            `[backfill] SoopAccount loginId=${row.soopId} not found (import it first).`,
          );
        }
      }
      console.log(
        `[backfill] SoopAccount.twitchLogin: ${linked} linked, ${missing} missing.`,
      );
    }
  }

  await mongoose.disconnect();
  console.log("[backfill] done.");
})().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
