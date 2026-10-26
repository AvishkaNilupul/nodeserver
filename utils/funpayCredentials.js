// Reads Twitch account credentials out of the text a FunPay seller auto-delivers.
//
// Ported from scripts/parse-funpay-credentials.js (removed 2026-09-20, last seen at
// 07c52e9^), which was built against real FunPay deliveries, with three fixes:
// labelled lines ("Login: x") are tried before the bare "a : b" pattern (they used to
// be read as login "Login" and dropped), passwords keep their symbols (the Cyrillic
// patterns used to cut "Pa$$w0rd" to "Pa"), and decoration stripping never eats the
// leading digits of a login. Handles:
//   1. "login : password"                       (most sellers)
//   2. "Login: x" / "Login....: x" then "Password: y" (or both on one line)
//   3. tab / multi-space table rows "login  password  info"
//   4. "login:password:token"                   (three fields; 3rd = OAuth token)
//   5. "login----password"                      (dash separated)
//   6. "1️⃣Логин: x" then "2️⃣Пароль: y"          (two Cyrillic lines)
//   7. "Логин(login): x ☑️ Пароль(password): y"  (one Cyrillic line)
// Best effort: the resale engine delivers ONLY when exactly one account comes out,
// and sends anything else to the owner for review.

const LOGIN = "[A-Za-z0-9_]{3,32}"; // Twitch logins are letters, digits and underscore
const PASS = "\\S{4,64}";
const LABEL_BLOCKLIST = /^(login|password|manual|instructions?|activation|note|format|secret|guide|info|information|username|email|token|account|link)$/i;
const HEADER_WORDS = /^\*?login\b|^password\b|^additional information$|^accounts?$/i;

const tripleRe = new RegExp(`^(${LOGIN}):([^:\\s]{4,64}):(\\S{4,128})$`);
const inlineRe = new RegExp(`^(${LOGIN})\\s*:\\s*(${PASS})$`);
const dashRe = new RegExp(`^(${LOGIN})-{2,}(${PASS})$`);
const L = "(?:login|username|user name|логин)(?:\\s*\\((?:login|логин)\\))?\\.*";
const P = "(?:password|pass|пароль)(?:\\s*\\((?:password|пароль)\\))?\\.*";
const SEP = "\\s*[:\\-–=]\\s*";
const singleLineRe = new RegExp(`${L}${SEP}(${LOGIN})\\b.*?${P}${SEP}(\\S+)`, "i");
const loginLineRe = new RegExp(`^${L}${SEP}(${LOGIN})\\b`, "i");
const passwordLineRe = new RegExp(`^${P}${SEP}(\\S+)`, "i");

// Leading decoration: emoji, symbols, bullets, keycaps ("1️⃣"), never letters/digits/_.
const LEAD = /^(?:[\p{Extended_Pictographic}\p{So}\p{Pd}\p{Po}\p{Ps}\p{Pe}\s>*•]|\d⃣)+/u;
// Trailing decoration glued onto a value ("Zx98765☑️").
const TRAIL = /[\p{Extended_Pictographic}\p{So}⃣]+$/u;

function cleanLine(line) {
  return String(line || "")
    .replace(/[​-‍️]/g, "")
    .replace(LEAD, "")
    .trim();
}

function cleanValue(v) {
  return String(v || "")
    .replace(/[​-‍️]/g, "")
    .replace(TRAIL, "")
    .trim();
}

function tryTableRow(line) {
  if (!line) return null;
  const fields = (line.includes("\t") ? line.split(/\t+/) : line.split(/\s{2,}/)).map((f) => f.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const [user, pass] = fields;
  if (HEADER_WORDS.test(user) || HEADER_WORDS.test(pass)) return null;
  if (!new RegExp(`^${LOGIN}$`).test(user)) return null;
  if (!/^\S{6,64}$/.test(pass)) return null;
  return { username: user, password: pass };
}

function parseCredentials(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map(cleanLine);
  const results = [];
  const seen = new Set();
  function add(username, password, token) {
    username = cleanValue(username);
    password = cleanValue(password);
    if (!username || password.length < 4) return;
    if (LABEL_BLOCKLIST.test(username) || LABEL_BLOCKLIST.test(password)) return;
    if (/^https?:\/\//i.test(password)) return;
    const key = username.toLowerCase() + " " + password;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = { username, password };
    if (token) entry.token = cleanValue(token);
    results.push(entry);
  }
  let pendingLogin = null;
  for (const line of lines) {
    if (!line || /^https?:\/\//i.test(line)) continue;
    let m;
    if ((m = line.match(tripleRe))) {
      add(m[1], m[2], m[3]);
      pendingLogin = null;
    } else if ((m = line.match(singleLineRe))) {
      add(m[1], m[2]);
      pendingLogin = null;
    } else if ((m = line.match(loginLineRe))) {
      pendingLogin = m[1];
    } else if ((m = line.match(passwordLineRe))) {
      if (pendingLogin) add(pendingLogin, m[1]);
      pendingLogin = null;
    } else if ((m = line.match(inlineRe))) {
      add(m[1], m[2]);
      pendingLogin = null;
    } else if ((m = line.match(dashRe))) {
      add(m[1], m[2]);
      pendingLogin = null;
    } else {
      const row = tryTableRow(line);
      if (row) {
        add(row.username, row.password);
        pendingLogin = null;
      }
    }
  }
  return results;
}

// The engine's rule: one purchase = one account. Anything else is not delivered.
function singleAccount(input) {
  const all = parseCredentials(input);
  return all.length === 1 ? all[0] : null;
}

module.exports = { parseCredentials, singleAccount };
