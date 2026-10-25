"use strict";
// Code shop — English labels for rewards whose name is still (partly) Korean.
//
// A label is what the buyer reads for one code ("Blessing Pouch x1 (30 min)").
// texts.defaultLabel takes a reward's stored English `name` as it is, and gives
// "" when that name is not clean ASCII — the case for most CHZZK rewards and for
// SOOP names the glossary only half translated. A draft with an empty label
// cannot be approved, so it waited for the owner to type one.
//
// This module fills that gap, in order, stopping at the first clean answer:
// 1. the stored name, as texts.defaultLabel already does;
// 2. the SOOP glossary (utils/soop/i18n.js) plus the few code-shop rules below,
//    on the stored name, then on the raw name;
// 3. a machine translation (MyMemory, a free public API that needs no key) of
//    the raw name, cached per raw name.
// Before 2 and 3 the platform names are cut out, and a "<campaign reward> -
// <item>" name keeps only the item (and its watch-time tier). Every answer must
// pass `cleanLabel`: printable ASCII, a letter in it, at most 80 characters, and
// no source word in any spelling. Anything else stays "" — the draft then waits
// for the owner, exactly as before. Only names that still carry non-ASCII text
// are ever translated: a clean English name the source-word rule refused is the
// owner's call, never rewritten here.

const i18n = require("../soop/i18n");
const { defaultLabel } = require("./texts");
const { DEFAULTS } = require("./config");

const MT_URL = "https://api.mymemory.translated.net/get";
const MT_TIMEOUT_MS = 8000;
const MT_RETRY_MS = 60 * 60 * 1000; // a failed name is tried again after an hour
const MT_DAILY_CAP = 300; // requests per UTC day, far above a normal day's handful
const MAX_LABEL = 80;

const LABEL_RE = /^[\x20-\x7E]+$/;
const NON_ASCII_RE = /[^\x00-\x7F]/;
// Platform names in Korean and English. Cut out before translating, so they can
// neither be translated nor transliterated into a spelling the source-word list
// does not know ("Chijijik").
const PLATFORM_RE = /치지직|아프리카\s?TV|아프리카티비|아프리카|네이버|카카오|SOOP|CHZZK|afreeca\s?tv|afreeca|naver|kakao/gi;
// Transliterations a translator may produce; refused like a source word.
const TRANSLIT_RE = /\b(chzzk|chijijik|chijik|chi ji jik|soop|afreeca|naver|kakao)\b/i;
// The campaign-prefix words of "<campaign reward> - <item>" names.
const PREFIX_WORD_RE = /드롭스|보상|달성|리워드|주차|미션|drops|reward|mission|week/i;
const TIER_RE = /\(?\s*(\d+)\s?(분|시간|min(?:ute)?s?|hours?)\s*\)?/i;

// Code-shop rules applied after the glossary (SOOP's own translator is left alone).
const EXTRA_RULES = [
  [/(\d+)\s?분/g, "$1 min"],
  [/(\d+)\s?초/g, "$1 sec"],
  [/리워드/g, "Reward"],
];

const text = (v) => (v === undefined || v === null ? "" : String(v));
const tidy = (s) => s.replace(/\s+/g, " ").replace(/^[\s\-:|,.]+|[\s\-:|,]+$/g, "").trim();

function sourceRe(sourceWords) {
  const list = (Array.isArray(sourceWords) ? sourceWords : DEFAULTS.sourceWords).filter((s) => {
    if (typeof s !== "string" || !s) return false;
    try {
      new RegExp(s, "i");
      return true;
    } catch {
      return false;
    }
  });
  return list.length ? new RegExp(list.join("|"), "i") : null;
}

// The label a buyer may read, or "".
function cleanLabel(s, { sourceWords } = {}) {
  const out = tidy(text(s));
  if (!out || out.length > MAX_LABEL || !LABEL_RE.test(out) || !/[A-Za-z]/.test(out)) return "";
  const re = sourceRe(sourceWords);
  if ((re && re.test(out)) || TRANSLIT_RE.test(out)) return "";
  return out;
}

// Platform names out; "<campaign reward> - <item>" down to the item and its tier.
function stripName(s) {
  let out = text(s).replace(PLATFORM_RE, " ");
  const cut = out.lastIndexOf(" - ");
  if (cut > 0) {
    const left = out.slice(0, cut);
    const right = out.slice(cut + 3);
    if (PREFIX_WORD_RE.test(left) && tidy(right)) {
      const tier = left.match(TIER_RE);
      out = right + (tier ? ` (${tier[1]}${/분|min/i.test(tier[2]) ? "분" : "시간"})` : "");
    }
  }
  return tidy(out);
}

// The glossary's English, plus the code-shop rules.
function glossaryLabel(s) {
  let out = i18n.translate(stripName(s));
  for (const [re, to] of EXTRA_RULES) out = out.replace(re, to);
  return tidy(out);
}

// A machine translation tidied the way the glossary's output reads.
function tidyMachine(s) {
  let out = text(s).replace(/^["'`]+|["'`]+$/g, "");
  out = out.replace(/(\d+)\s*minutes?\b/gi, "$1 min").replace(/(\d+)\s*seconds?\b/gi, "$1 sec");
  out = tidy(out).replace(/\.$/, "");
  return out ? out[0].toUpperCase() + out.slice(1) : "";
}

// Needs an answer from this module at all: the stored or raw name still has
// non-ASCII text (a clean English name refused for a source word is not ours).
function wantsTranslation(row) {
  const name = text(row && row.name);
  const raw = text(row && row.nameRaw);
  return NON_ASCII_RE.test(name || raw) || (!name && NON_ASCII_RE.test(raw));
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// `fetch` absent = no machine translation (tests, and any caller that wants the
// offline steps only). `log(entry)` records each machine label once per process.
function createLabeler({ fetch = null, now = Date.now, log = null } = {}) {
  const cache = new Map(); // raw name -> { label, retryAt }
  let day = "";
  let used = 0;
  let pausedUntil = 0;

  async function machine(raw) {
    const t = now();
    const hit = cache.get(raw);
    if (hit && (hit.label || t < hit.retryAt)) return hit.label;
    if (typeof fetch !== "function" || t < pausedUntil) return "";
    if (utcDay(t) !== day) {
      day = utcDay(t);
      used = 0;
    }
    if (used >= MT_DAILY_CAP) return "";
    used += 1;
    let label = "";
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), MT_TIMEOUT_MS) : null;
    try {
      const url = `${MT_URL}?langpair=ko%7Cen&q=${encodeURIComponent(stripName(raw))}`;
      const res = await fetch(url, { headers: { accept: "application/json" }, ...(ac ? { signal: ac.signal } : {}) });
      const json = res && typeof res.json === "function" ? await res.json() : null;
      const said = text(json && json.responseData && json.responseData.translatedText);
      if (json && json.quotaFinished === true) {
        pausedUntil = t + 6 * MT_RETRY_MS;
      } else if (/MYMEMORY WARNING|INVALID|QUERY LENGTH/i.test(said)) {
        pausedUntil = t + 6 * MT_RETRY_MS;
      } else if (res && res.ok !== false) {
        label = tidyMachine(said);
      }
    } catch {
      label = "";
    } finally {
      if (timer) clearTimeout(timer);
    }
    cache.set(raw, { label, retryAt: t + MT_RETRY_MS });
    return label;
  }

  // -> { label, how: "name" | "glossary" | "machine" | "" }
  async function labelOf(row, { sourceWords, machineOk = true } = {}) {
    const own = defaultLabel(row, { sourceWords });
    if (own) return { label: own, how: "name" };
    if (!wantsTranslation(row)) return { label: "", how: "" };
    for (const s of [row && row.name, row && row.nameRaw]) {
      if (!text(s)) continue;
      const g = cleanLabel(glossaryLabel(s), { sourceWords });
      if (g) return { label: g, how: "glossary" };
    }
    const raw = text(row && row.nameRaw) || text(row && row.name);
    if (!machineOk || !raw) return { label: "", how: "" };
    const before = cache.has(raw) && cache.get(raw).label;
    const m = cleanLabel(await machine(raw), { sourceWords });
    if (!m) return { label: "", how: "" };
    if (!before && typeof log === "function") {
      try {
        await log({ kind: "label", msg: `Labelled a reward "${m}" (machine translation of its Korean name)`, data: { label: m } });
      } catch {
        /* the label stands without its event */
      }
    }
    return { label: m, how: "machine" };
  }

  return { labelOf, _cache: cache };
}

module.exports = { createLabeler, cleanLabel, stripName, glossaryLabel, tidyMachine, wantsTranslation, MT_URL };
