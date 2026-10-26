// CHZZK cookies (docs/CHZZK-FARM.md §4).
//
// Accepts anything an operator might paste in one go: a Cookie-Editor JSON
// array; several JSON arrays back-to-back (whitespace between); a JSON array
// of arrays; {cookies:[...]}; an object keyed by anything whose values are
// arrays or {cookies:[...]}; or raw "name=value; …" Cookie-header lines (one
// jar per line). Returns parsed jars and plain-English per-jar errors.
//
// Errors never include a cookie value — they go on the admin page.

const REQUIRED = ["NID_AUT", "NID_SES"];

function isCookieLike(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    typeof obj.name === "string" &&
    obj.name.length > 0
  );
}

function sanitizeDomain(d) {
  if (typeof d !== "string") return "";
  const t = d.trim();
  if (!t) return "";
  return t.startsWith(".") ? t.slice(1) : t;
}

// Keep cookies that match the Naver surface. Header-line cookies have no
// domain, so the filter is skipped for them (we trust the pasted line).
function cleanJar(raw) {
  const out = [];
  for (const c of raw) {
    if (!isCookieLike(c)) continue;
    const value = c.value == null ? "" : String(c.value);
    const domain = sanitizeDomain(c.domain);
    if (domain && !domain.endsWith("naver.com")) continue;
    out.push({ name: c.name, value, domain });
  }
  return out;
}

// How long the export says its login lasts, read from NID_AUT. Cookie-Editor
// marks a cookie `session: true` or gives `expirationDate` (epoch seconds).
// Values never leave this function.
function loginInfo(raw) {
  const aut = (Array.isArray(raw) ? raw : []).find((c) => isCookieLike(c) && c.name === "NID_AUT");
  if (!aut) return { kind: "unknown", expiresAt: null };
  const hasMeta = "session" in aut || "expirationDate" in aut || "expires" in aut;
  if (!hasMeta) return { kind: "unknown", expiresAt: null };
  let exp = null;
  if (typeof aut.expirationDate === "number" && aut.expirationDate > 0) exp = aut.expirationDate * 1000;
  else if (aut.expires != null && aut.expires !== "") {
    const n = Number(aut.expires);
    exp = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(aut.expires));
  }
  if (aut.session === true || !Number.isFinite(exp) || !exp) return { kind: "session", expiresAt: null };
  return { kind: "persistent", expiresAt: new Date(exp) };
}

// Split a raw "Cookie:" header line into one jar.
function fromHeaderLine(line) {
  const jar = [];
  for (const part of line.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    jar.push({ name, value, domain: "" });
  }
  return jar;
}

// Scan top-level JSON values back-to-back, with optional whitespace between.
// Yields { ok: true, value } for each parsed JSON, or a single
// { ok: false, rest } when non-JSON text is reached (the rest, for header
// lines downstream).
function* splitJson(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    if (text[i] !== "{" && text[i] !== "[") {
      yield { ok: false, rest: text.slice(start) };
      return;
    }
    const open = text[i];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < n; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const slice = text.slice(start, i);
    try {
      yield { ok: true, value: JSON.parse(slice) };
    } catch {
      yield { ok: false, rest: text.slice(start) };
      return;
    }
  }
}

// Walk a parsed JSON value and push every jar-shaped array into `out`.
function collectJars(value, out) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isCookieLike)) {
      out.push(value);
      return;
    }
    for (const v of value) collectJars(v, out);
    return;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.cookies)) {
      collectJars(value.cookies, out);
      return;
    }
    for (const v of Object.values(value)) collectJars(v, out);
  }
}

function parseImport(input) {
  const errors = [];
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { jars: [], errors };

  const rawJars = [];
  let parsedAny = false;
  let remainder = "";
  for (const r of splitJson(text)) {
    if (r.ok) {
      parsedAny = true;
      collectJars(r.value, rawJars);
    } else {
      remainder = r.rest;
      break;
    }
  }

  // Anything the JSON pass did not consume (or the whole input, when no JSON
  // was found) is treated line-by-line as a Cookie header.
  const headerText = parsedAny ? remainder : text;
  for (const line of headerText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
    const jar = fromHeaderLine(trimmed);
    if (jar.length) rawJars.push(jar);
  }

  const jars = [];
  const infos = []; // infos[i] describes jars[i]: { kind, expiresAt }
  rawJars.forEach((raw, idx) => {
    const cleaned = cleanJar(Array.isArray(raw) ? raw : []);
    const names = new Set(cleaned.map((c) => c.name));
    if (!REQUIRED.every((req) => names.has(req))) {
      errors.push(
        `Jar ${idx + 1} has no NID_AUT/NID_SES — that export is logged out`,
      );
      return;
    }
    jars.push(cleaned);
    infos.push(loginInfo(raw));
  });

  return { jars, errors, infos };
}

function toHeader(jar) {
  if (!Array.isArray(jar)) return "";
  return jar
    .filter((c) => c && typeof c === "object" && c.name)
    .map((c) => `${c.name}=${c.value == null ? "" : String(c.value)}`)
    .join("; ");
}

function deviceIdOf(jar) {
  if (!Array.isArray(jar)) return "";
  for (const c of jar) {
    if (c && c.name === "ba.uuid") return c.value == null ? "" : String(c.value);
  }
  return "";
}

function nidAutOf(jar) {
  if (!Array.isArray(jar)) return null;
  for (const c of jar) {
    if (c && c.name === "NID_AUT") return c.value == null ? "" : String(c.value);
  }
  return null;
}

function sameLogin(a, b) {
  const va = nidAutOf(a);
  const vb = nidAutOf(b);
  return va !== null && vb !== null && va === vb;
}

// ---------------------------------------------------------- Set-Cookie
// docs/CHZZK-COOKIE-KEEPALIVE.md. Naver renews NID_SES through Set-Cookie on
// getUserStatus; the farm keeps what Naver sends, like a browser would.

const isNaver = (d) => d === "naver.com" || d.endsWith(".naver.com");

// One Set-Cookie line -> { name, value, domain, deleted } or null.
// `domain` is "" when the line names none (a host-only cookie).
function parseSetCookie(line, now = Date.now()) {
  if (typeof line !== "string") return null;
  const parts = line.split(";");
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  let domain = "";
  let maxAge = null;
  let expires = null;
  for (const p of parts) {
    const i = p.indexOf("=");
    const key = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : p.slice(i + 1).trim();
    if (key === "domain") domain = sanitizeDomain(val).toLowerCase();
    else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === "expires") {
      const t = Date.parse(val);
      if (Number.isFinite(t)) expires = t;
    }
  }
  // Max-Age wins over Expires (RFC 6265 §5.3).
  const deleted = value === "" || (maxAge != null ? maxAge <= 0 : expires != null && expires <= now);
  return { name, value, domain, deleted };
}

// Merge a response's Set-Cookie lines into a jar. Returns a NEW jar (the old
// one is not touched) plus the names that changed and the names whose
// deletion was refused. Rules:
//   - only from a naver.com response host, and only cookies whose Domain (if
//     any) is naver.com too;
//   - the jar is flat (one cookie per name), so a name's value is replaced;
//   - a deletion drops an ordinary cookie but is refused for NID_AUT/NID_SES:
//     a dead login shows up as AUTH on the next call anyway.
function mergeSetCookies(jar, lines, host, now = Date.now()) {
  const base = Array.isArray(jar) ? jar.map((c) => ({ ...c })) : [];
  const out = { jar: base, changed: [], ignored: [] };
  const h = String(host || "").toLowerCase();
  if (!isNaver(h)) return out;
  const list = Array.isArray(lines) ? lines : lines ? [lines] : [];
  for (const line of list) {
    const c = parseSetCookie(line, now);
    if (!c) continue;
    if (c.domain && !isNaver(c.domain)) continue;
    const at = out.jar.findIndex((x) => x && x.name === c.name);
    if (c.deleted) {
      if (REQUIRED.includes(c.name)) { out.ignored.push(c.name); continue; }
      if (at >= 0) { out.jar.splice(at, 1); out.changed.push(c.name); }
      continue;
    }
    const domain = c.domain || h;
    if (at >= 0) {
      if (out.jar[at].value === c.value) continue;
      out.jar[at] = { ...out.jar[at], value: c.value };
    } else {
      out.jar.push({ name: c.name, value: c.value, domain });
    }
    out.changed.push(c.name);
  }
  // A clear line followed by a new value for the same name (one answer) is
  // a renewal, not a refused deletion.
  out.ignored = out.ignored.filter((n) => !out.changed.includes(n));
  return out;
}

module.exports = {
  parseImport, loginInfo, toHeader, deviceIdOf, sameLogin,
  parseSetCookie, mergeSetCookies, REQUIRED,
};
