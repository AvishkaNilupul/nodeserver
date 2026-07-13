#!/usr/bin/env node
// Turns a raw FunPay chat export into a JSON array of account objects —
// paste the result into either RedeemHub's drops-archive "Import
// credentials" box, or the Account Pool page's "Import accounts" box
// (the pool accepts the extra clientSecret field too; the drops-archive
// importer just ignores it).
//
// Usage:
//   node scripts/parse-funpay-credentials.js
//     -> prompts you to paste the chat text, press Ctrl+D when done,
//        writes accounts.json in the current folder and opens it.
//   node scripts/parse-funpay-credentials.js chat.txt
//     -> reads from a file instead of prompting.
//
// Handles four delivery formats:
//   1. "login : password"           (most FunPay chat orders)
//   2. "Login....: login" followed by "Password...: password"  (Rust/Kick style)
//   3. Tab-separated table rows: "login<TAB>password<TAB>additional info"
//      (bulk account list exports, header/label rows are skipped automatically)
//   4. "login:password:token"       (three-field sellers, e.g. TwitchSellerX) —
//      the third field is written out as "clientSecret", ready to import
//      straight into the account pool as an auth-ready account.
//   5. "login----password"          (dash-separated sellers, e.g. huahua12138)
//   6. "1️⃣Логин: login" / "2️⃣Пароль: password"  (two-line Cyrillic, e.g. Haldross)
//   7. "Логин(login): x☑️ Пароль(password): y☑️"  (one-line Cyrillic, e.g. saydis)
//
// Review accounts.json before pasting it into the importer — this is a
// best-effort text parser, not a guarantee every line was read correctly.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const OUT_PATH = path.join(process.cwd(), "accounts.json");

function parse(input) {
  const lines = input.split(/\r?\n/).map((l) => l.trim());
  const results = [];
  const seen = new Set();

  // Chat auto-replies are full of "Label: value" lines that aren't accounts
  // at all — "Instructions: https://...", "Manual: https://...", etc. A real
  // password is never a URL, and a real username is never one of these label
  // words, so both are rejected as a belt-and-suspenders guard.
  const LABEL_BLOCKLIST = /^(login|password|manual|instructions?|activation|note|format|secret|guide|info|information)$/i;
  function add(username, password, clientSecret) {
    username = username.trim();
    password = password.trim();
    if (!username || !password) return;
    if (LABEL_BLOCKLIST.test(username)) return;
    if (/^https?:\/\//i.test(password)) return;
    const key = username.toLowerCase() + " " + password;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = { username, password };
    if (clientSecret) entry.clientSecret = clientSecret.trim();
    results.push(entry);
  }

  const inlineRe = /^([A-Za-z0-9_]{4,32})\s*:\s*(\S{4,64})$/;
  const tripleRe = /^([A-Za-z0-9_]{4,32}):([^:\s]{4,64}):(\S{4,128})$/;
  const dashRe = /^([A-Za-z0-9_]{4,32})-{2,}(\S{4,64})$/;
  const labelLoginRe = /^login\.*\s*:\s*(\S+)$/i;
  const labelPasswordRe = /^password\.*\s*:\s*(\S+)$/i;
  // Cyrillic-labeled sellers. Unanchored (not `^...`) since these lines often
  // have an emoji/word prefix before the label ("1️⃣Логин: ...",
  // "Twitch☑️Логин(login): ..."). Values are captured by character class
  // rather than \S+ so a trailing checkbox emoji glued directly onto the
  // value (no space) never gets swept into it.
  const cyrillicSingleLineRe =
    /логин(?:\(login\))?\s*:\s*([A-Za-z0-9_]+).*?пароль(?:\(password\))?\s*:\s*([A-Za-z0-9_]+)/i;
  const cyrillicLoginLineRe = /логин\s*:\s*([A-Za-z0-9_]+)/i;
  const cyrillicPasswordLineRe = /пароль\s*:\s*([A-Za-z0-9_]+)/i;

  // Tab-separated (or 2+-space-separated) table rows, e.g. a bulk account
  // list export with columns like "Login Account / Login Password / ...".
  // Header rows, section labels, and blank rows are filtered out below.
  const HEADER_WORDS = /^\*?login\b|^password\b|^additional information$|^accounts?$/i;
  function tryTableRow(line) {
    if (!line) return null;
    const fields = (line.includes("\t") ? line.split(/\t+/) : line.split(/\s{2,}/))
      .map((f) => f.trim())
      .filter(Boolean);
    if (fields.length < 2) return null;
    const [user, pass] = fields;
    if (HEADER_WORDS.test(user) || HEADER_WORDS.test(pass)) return null;
    if (!/^[A-Za-z0-9_]{3,32}$/.test(user)) return null;
    if (!/^\S{6,64}$/.test(pass)) return null;
    return { username: user, password: pass };
  }

  let pendingLogin = null;
  for (const line of lines) {
    // A bare URL line ("https://saydis.pro/...") structurally looks just
    // like "username: value" to inlineRe (the "https" becomes the username,
    // "//saydis.pro/..." the password) — skip it outright before trying
    // anything else.
    if (/^https?:\/\//i.test(line)) continue;
    // Tried before the 2-field pattern — otherwise "user:pass:token" gets
    // misread as username "user" + password "pass:token".
    const triple = line.match(tripleRe);
    if (triple) {
      add(triple[1], triple[2], triple[3]);
      pendingLogin = null;
      continue;
    }
    const inline = line.match(inlineRe);
    if (inline) {
      add(inline[1], inline[2]);
      pendingLogin = null;
      continue;
    }
    const dash = line.match(dashRe);
    if (dash) {
      add(dash[1], dash[2]);
      pendingLogin = null;
      continue;
    }
    // Single line carrying both fields (saydis style) — check before the
    // separate-line label patterns so it isn't half-consumed by those first.
    const cyrillicSingle = line.match(cyrillicSingleLineRe);
    if (cyrillicSingle) {
      add(cyrillicSingle[1], cyrillicSingle[2]);
      pendingLogin = null;
      continue;
    }
    const loginMatch = line.match(labelLoginRe);
    if (loginMatch) {
      pendingLogin = loginMatch[1];
      continue;
    }
    const passMatch = line.match(labelPasswordRe);
    if (passMatch && pendingLogin) {
      add(pendingLogin, passMatch[1]);
      pendingLogin = null;
      continue;
    }
    const cyrillicLoginMatch = line.match(cyrillicLoginLineRe);
    if (cyrillicLoginMatch) {
      pendingLogin = cyrillicLoginMatch[1];
      continue;
    }
    const cyrillicPassMatch = line.match(cyrillicPasswordLineRe);
    if (cyrillicPassMatch && pendingLogin) {
      add(pendingLogin, cyrillicPassMatch[1]);
      pendingLogin = null;
      continue;
    }
    const row = tryTableRow(line);
    if (row) {
      add(row.username, row.password);
      pendingLogin = null;
      continue;
    }
  }
  return results;
}

function finish(input) {
  const results = parse(input);
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + "\n", "utf8");
  console.error(`\nParsed ${results.length} account(s) -> ${OUT_PATH}`);
  console.error("Review it, then paste its contents into the Import box on either the Account Pool or Drops Archive page.");
  if (process.platform === "darwin") {
    spawnSync("open", [OUT_PATH]);
  }
}

const fileArg = process.argv[2];
if (fileArg) {
  if (!fs.existsSync(fileArg)) {
    console.error(`No such file: ${fileArg}`);
    process.exit(1);
  }
  finish(fs.readFileSync(fileArg, "utf8"));
} else if (process.stdin.isTTY) {
  console.error("Paste the FunPay chat text below, then press Enter and Ctrl+D to finish:\n");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (buf += chunk));
  process.stdin.on("end", () => finish(buf));
} else {
  // Piped input, e.g. `pbpaste | node scripts/parse-funpay-credentials.js`
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (buf += chunk));
  process.stdin.on("end", () => finish(buf));
}
