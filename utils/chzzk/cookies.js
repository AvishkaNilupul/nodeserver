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
  });

  return { jars, errors };
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

module.exports = { parseImport, toHeader, deviceIdOf, sameLogin, REQUIRED };
