/* Kanji trainer: swipe cards, quizzes and spaced review for the owner's own kanji list.
 *
 * Everything runs in the browser. The list ships in deck.json; progress and any
 * edits made on the page live in this browser's localStorage, so the page needs
 * no server code and keeps working offline (sw.js caches it for the train).
 * Settings → Backup moves progress between devices.
 */
(function () {
  "use strict";

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const now = () => Date.now();
  const uniq = (a) => Array.from(new Set(a));
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }
  const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/;
  const isKanji = (ch) => KANJI_RE.test(ch);
  const kanjiChars = (s) => Array.from(String(s || "")).filter((c) => isKanji(c) && c !== "々");
  const hasKana = (s) => /[぀-ヿ]/.test(s);
  const hasLatin = (s) => /[a-z]/i.test(s);
  const toHira = (s) => String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const toKata = (s) => String(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const normReading = (s) => toHira(String(s || "").trim().toLowerCase()).replace(/[.\-・\s'’]/g, "");
  function dayKey(t) {
    const d = new Date(t == null ? now() : t);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDur(ms) {
    if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + "m";
    if (ms < DAY) return Math.round(ms / HOUR) + "h";
    if (ms < 45 * DAY) return Math.round(ms / DAY) + "d";
    return Math.round(ms / (30 * DAY)) + "mo";
  }
  const vibrate = (ms) => {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {
      /* not supported */
    }
  };

  const I = {
    speak: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 3c.6 3 4.5 5 4.5 10a4.5 4.5 0 0 1-9 0c0-2 .8-3.3 2-4.5 0 1.8.8 2.8 2 3.2-.5-3 0-6 .5-8.7z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
    quiz: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6"/><path d="M12 17.2h.01"/></svg>',
    cards: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="12" height="14" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v12"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
    paste: '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 3h14"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
  };

  // ---------- storage ----------
  const NS = "kanjiTrainer.v1.";
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(NS + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(NS + k, JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
  let warnedStorage = false;
  function persist(k, v) {
    if (!store.set(k, v) && !warnedStorage) {
      warnedStorage = true;
      toast("This browser is not saving progress (private mode?)");
    }
  }

  const DEFAULTS = {
    direction: "recog", // recog: kanji → meaning · recall: meaning → kanji · mixed
    showReadingFront: false,
    autoSpeak: false,
    sessionSize: 20,
    newPerDay: 25,
    font: "serif",
    theme: "auto",
    quizCount: 15,
    quizAutoNext: true,
    quizTypes: { k2m: true, m2k: true, k2r: true, w2r: true, w2m: true, m2w: true, gap: true, build: true, type: true },
    scope: "all",
    tag: "",
  };
  const savedSettings = store.get("settings", {}) || {};
  const settings = Object.assign({}, DEFAULTS, savedSettings);
  settings.quizTypes = Object.assign({}, DEFAULTS.quizTypes, savedSettings.quizTypes || {});
  const saveSettings = () => persist("settings", settings);

  let baseRaw = store.get("base", null); // last deck.json seen
  let custom = store.get("custom", null) || { items: {}, removed: {} }; // edits made on this page
  let progress = store.get("progress", null) || {};
  let log = store.get("log", null) || {}; // { "2026-10-30": { n, ok, nw } }
  const saveProgress = () => {
    persist("progress", progress);
    persist("log", log);
  };

  // ---------- romaji → kana (for typing answers and searching) ----------
  const ROMA = (function () {
    const m = {};
    const base =
      "a:あ i:い u:う e:え o:お ka:か ki:き ku:く ke:け ko:こ ga:が gi:ぎ gu:ぐ ge:げ go:ご " +
      "sa:さ si:し shi:し su:す se:せ so:そ za:ざ zi:じ ji:じ zu:ず ze:ぜ zo:ぞ " +
      "ta:た ti:ち chi:ち tu:つ tsu:つ te:て to:と da:だ di:ぢ du:づ de:で do:ど " +
      "na:な ni:に nu:ぬ ne:ね no:の ha:は hi:ひ hu:ふ fu:ふ he:へ ho:ほ " +
      "ba:ば bi:び bu:ぶ be:べ bo:ぼ pa:ぱ pi:ぴ pu:ぷ pe:ぺ po:ぽ ma:ま mi:み mu:む me:め mo:も " +
      "ya:や yu:ゆ yo:よ ra:ら ri:り ru:る re:れ ro:ろ wa:わ wi:うぃ we:うぇ wo:を " +
      "va:ゔぁ vi:ゔぃ vu:ゔ ve:ゔぇ vo:ゔぉ fa:ふぁ fi:ふぃ fe:ふぇ fo:ふぉ ye:いぇ " +
      "she:しぇ je:じぇ che:ちぇ tsa:つぁ thi:てぃ dhi:でぃ " +
      "xa:ぁ xi:ぃ xu:ぅ xe:ぇ xo:ぉ la:ぁ li:ぃ lu:ぅ le:ぇ lo:ぉ xya:ゃ xyu:ゅ xyo:ょ lya:ゃ lyu:ゅ lyo:ょ " +
      "xtu:っ xtsu:っ ltu:っ ltsu:っ xwa:ゎ nn:ん n':ん xn:ん -:ー";
    base.split(" ").forEach((p) => {
      const i = p.indexOf(":");
      m[p.slice(0, i)] = p.slice(i + 1);
    });
    const yo = { k: "き", g: "ぎ", n: "に", h: "ひ", b: "び", p: "ぴ", m: "み", r: "り", d: "ぢ" };
    Object.keys(yo).forEach((c) => {
      m[c + "ya"] = yo[c] + "ゃ";
      m[c + "yu"] = yo[c] + "ゅ";
      m[c + "yo"] = yo[c] + "ょ";
    });
    [["sh", "し"], ["sy", "し"], ["ch", "ち"], ["ty", "ち"], ["cy", "ち"], ["j", "じ"], ["jy", "じ"], ["zy", "じ"]].forEach((pair) => {
      m[pair[0] + "a"] = pair[1] + "ゃ";
      m[pair[0] + "u"] = pair[1] + "ゅ";
      m[pair[0] + "o"] = pair[1] + "ょ";
    });
    return m;
  })();
  const ROMA_PREFIX = new Set();
  Object.keys(ROMA).forEach((k) => {
    for (let i = 1; i <= k.length; i++) ROMA_PREFIX.add(k.slice(0, i));
  });
  // final=false keeps an unfinished tail ("k", "ky", a lone "n") as typed.
  function romaToKana(input, final) {
    const s = String(input || "");
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const lo = ch.toLowerCase();
      if (!/[a-z'\-]/.test(lo)) {
        out += ch;
        i++;
        continue;
      }
      const rest = s.slice(i).toLowerCase();
      if (lo === "n") {
        const nx = rest[1];
        if (nx === undefined) {
          out += final ? "ん" : ch;
          i++;
          continue;
        }
        if (nx === "'") {
          out += "ん";
          i += 2;
          continue;
        }
        if (nx === "n") {
          out += "ん";
          i += /[aiueoy]/.test(rest[2] || "") ? 1 : 2;
          continue;
        }
        if (!/[aiueoy]/.test(nx)) {
          out += "ん";
          i++;
          continue;
        }
      }
      if (/[bcdfghjkmpqrstvwxyz]/.test(lo) && rest[1] === lo) {
        out += "っ";
        i++;
        continue;
      }
      if (lo === "t" && rest[1] === "c" && rest[2] === "h") {
        out += "っ";
        i++;
        continue;
      }
      let hit = false;
      for (let L = 4; L >= 1; L--) {
        const k = rest.slice(0, L);
        if (k.length === L && ROMA[k]) {
          out += ROMA[k];
          i += L;
          hit = true;
          break;
        }
      }
      if (hit) continue;
      if (!final && ROMA_PREFIX.has(rest)) {
        out += s.slice(i);
        break;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // ---------- deck: normalise whatever shape the list arrives in ----------
  const MEANING_SPLIT = /\s*[,;、，；]\s*/;
  const READING_SPLIT = /[\s,、，・;；／/]+/;
  function splitList(v, re) {
    if (v == null || v === "") return [];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v).split(re).map((x) => x.trim()).filter(Boolean);
  }
  const kanaOf = (r) => (hasLatin(r) ? romaToKana(r, true) : r);
  function tagsOf(o) {
    if (o.lesson != null && o.lesson !== "" && o.tags == null && o.tag == null) {
      return [typeof o.lesson === "number" ? "Lesson " + o.lesson : String(o.lesson).trim()];
    }
    return splitList(o.tags != null ? o.tags : o.tag, /\s*,\s*/);
  }
  function normKanji(o) {
    const raw = String(o.kanji != null ? o.kanji : o.k != null ? o.k : o.char || "").trim();
    const ch = Array.from(raw)[0];
    if (!ch || !isKanji(ch)) return null;
    return {
      id: "k:" + ch,
      type: "k",
      kanji: ch,
      meanings: splitList(o.meanings != null ? o.meanings : o.meaning != null ? o.meaning : o.en, MEANING_SPLIT),
      on: uniq(splitList(o.on != null ? o.on : o.onyomi, READING_SPLIT).map((r) => toKata(kanaOf(r)))),
      kun: uniq(splitList(o.kun != null ? o.kun : o.kunyomi, READING_SPLIT).map((r) => toHira(kanaOf(r)))),
      tags: tagsOf(o),
      note: String(o.note || o.mnemonic || "").trim(),
    };
  }
  function normWord(o) {
    const w = String(o.word != null ? o.word : o.w || "").trim();
    if (!w || !/[぀-ヿ㐀-鿿々]/.test(w)) return null;
    const r = o.readings != null ? o.readings : o.reading != null ? o.reading : o.kana;
    return {
      id: "w:" + w,
      type: "w",
      word: w,
      readings: uniq(splitList(r, READING_SPLIT).map(kanaOf)),
      meanings: splitList(o.meanings != null ? o.meanings : o.meaning != null ? o.meaning : o.en, MEANING_SPLIT),
      tags: tagsOf(o),
      note: String(o.note || "").trim(),
    };
  }
  function mergeInto(a, b) {
    ["meanings", "on", "kun", "readings", "tags"].forEach((k) => {
      if (b[k] && b[k].length) a[k] = uniq((a[k] || []).concat(b[k]));
    });
    if (!a.note && b.note) a.note = b.note;
  }
  function dedupe(items) {
    const byBase = new Map(); // id -> every card with that spelling
    const out = [];
    items.forEach((it) => {
      const list = byBase.get(it.id);
      if (!list) {
        byBase.set(it.id, [it]);
        out.push(it);
        return;
      }
      if (it.type === "w") {
        // Same spelling, different reading (一日 いちにち / ついたち): keep both cards;
        // the same word listed again under another kanji merges into its card.
        const r = it.readings[0] ? normReading(it.readings[0]) : "";
        const match = list.find((p) => !r || !p.readings.length || p.readings.some((x) => normReading(x) === r));
        if (match) {
          mergeInto(match, it);
          return;
        }
        it.id = it.id + "#" + (list.length + 1);
        list.push(it);
        out.push(it);
        return;
      }
      mergeInto(list[0], it);
    });
    return out;
  }
  function parseDeck(src) {
    const out = [];
    let list = [];
    if (Array.isArray(src)) list = src;
    else if (src && typeof src === "object") {
      list = (src.kanji || [])
        .map((o) => (typeof o === "string" ? { kanji: o, _t: "k" } : Object.assign({ _t: "k" }, o)))
        .concat((src.words || src.vocab || []).map((o) => (typeof o === "string" ? o : Object.assign({ _t: "w" }, o))));
    }
    list.forEach((o) => {
      if (typeof o === "string") {
        (parseLine(o, "") || []).forEach((x) => out.push(x));
        return;
      }
      if (!o || typeof o !== "object") return;
      const t = o._t || (o.word || o.w ? "w" : "k");
      if (t === "k") {
        const k = normKanji(o);
        if (k) out.push(k);
        const nested = o.words || o.vocab || o.examples;
        if (Array.isArray(nested)) {
          nested.forEach((w) => {
            if (typeof w === "string") (parseLine(w, (k && k.tags[0]) || "") || []).forEach((x) => out.push(x));
            else {
              const nw = normWord(Object.assign({ tags: k ? k.tags : [] }, w));
              if (nw) out.push(nw);
            }
          });
        }
      } else {
        const w = normWord(o);
        if (w) out.push(w);
      }
    });
    return dedupe(out);
  }

  // One pasted line → items. Forms understood (any separator: | tab " - " = ：):
  //   日 | sun, day | ニチ ジツ | ひ か          kanji, meanings, on, kun
  //   日本 | にほん | Japan                      word, reading, meaning
  //   日本 (にほん) Japan   ·   日本【にほん】Japan
  //   日 月 火 水                                bare kanji to fill in later
  function parseLine(line, tag) {
    const tags = tag ? [tag] : [];
    line = String(line).trim();
    const br = line.match(/^([^\s(（【\[|｜]+)\s*[(（【\[]\s*([^)）】\]]+)[)）】\]]\s*(?:[-–—:=|｜：]\s*)?(.*)$/);
    if (br && hasKana(br[2])) {
      const w = normWord({ word: br[1], reading: br[2], meaning: br[3], tags });
      return w ? [w] : null;
    }
    let parts = line
      .split(/\s*(?:\t|[|｜]|\s[-–—]\s|=|：|:(?=\s))\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) {
      const only = parts[0].replace(/[\s,、，・]/g, "");
      if (only && Array.from(only).every((c) => isKanji(c) && c !== "々")) {
        return Array.from(only).map((c) => normKanji({ kanji: c, tags }));
      }
      // Spaces only: "日本 にほん Japan" or "日 ニチ ひ sun, day".
      const toks = parts[0].split(/\s+/);
      if (toks.length > 1 && /[぀-ヿ㐀-鿿]/.test(toks[0]) && !hasLatin(toks[0])) {
        const kanaToks = toks.slice(1).filter((t) => hasKana(t) && !hasLatin(t));
        const latin = toks.slice(1).filter((t) => hasLatin(t)).join(" ");
        parts = [toks[0]].concat(kanaToks.length ? [kanaToks.join(" ")] : [], latin ? [latin] : []);
      }
      if (parts.length === 1) {
        const w = normWord({ word: parts[0], tags });
        return w ? [w] : null;
      }
    }
    const first = parts[0];
    const rest = parts.slice(1);
    const kanaParts = rest.filter((p) => hasKana(p) && !hasLatin(p));
    const latinParts = rest.filter((p) => hasLatin(p));
    const single = Array.from(first).length === 1 && isKanji(first);
    if (single) {
      let on = [];
      let kun = [];
      if (kanaParts.length >= 2) {
        on = kanaParts[0];
        kun = kanaParts[1];
        if (!/[゠-ヿ]/.test(on) && /[゠-ヿ]/.test(kun)) {
          const t = on;
          on = kun;
          kun = t;
        }
      } else if (kanaParts.length === 1) {
        splitList(kanaParts[0], READING_SPLIT).forEach((tk) => (/[゠-ヿ]/.test(tk) ? on : kun).push(tk));
      } else if (latinParts.length >= 3) {
        on = latinParts[1];
        kun = latinParts[2];
        return [normKanji({ kanji: first, meanings: latinParts[0], on, kun, tags })];
      }
      return [normKanji({ kanji: first, meanings: latinParts.join(", "), on, kun, tags })];
    }
    const w = normWord({ word: first, reading: kanaParts[0] || "", meaning: latinParts.join(", "), tags });
    return w ? [w] : null;
  }
  function parseText(text) {
    text = String(text || "").trim();
    if (!text) return { items: [], bad: [] };
    if (/^[[{]/.test(text)) {
      try {
        return { items: parseDeck(JSON.parse(text)), bad: [] };
      } catch (e) {
        return { items: [], bad: ["That looks like JSON but could not be read: " + e.message] };
      }
    }
    const items = [];
    const bad = [];
    let tag = "";
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const head = line.match(/^#+\s*(.*)$/);
      if (head) {
        tag = head[1].trim();
        return;
      }
      const got = parseLine(line, tag);
      if (got && got.length) got.forEach((x) => items.push(x));
      else bad.push(line);
    });
    return { items: dedupe(items), bad };
  }

  // ---------- the effective deck = deck.json + edits made here ----------
  let D = null;
  function rebuild() {
    const baseItems = baseRaw ? parseDeck(baseRaw) : [];
    const baseIds = new Set(baseItems.map((it) => it.id));
    const items = [];
    baseItems.forEach((it) => {
      if (custom.removed[it.id]) return;
      items.push(Object.assign({}, custom.items[it.id] || it));
    });
    Object.keys(custom.items).forEach((id) => {
      if (!baseIds.has(id)) items.push(Object.assign({}, custom.items[id]));
    });
    const d = { items, kanji: [], words: [], byId: {}, byChar: {}, wordsByChar: {}, wordByText: {}, spelling: {}, tags: [], baseIds };
    const kIndex = {};
    items.forEach((it, i) => {
      it.order = i;
      d.byId[it.id] = it;
      if (it.type === "k") {
        kIndex[it.kanji] = d.kanji.length;
        d.kanji.push(it);
        d.byChar[it.kanji] = it;
      } else {
        d.words.push(it);
        if (!d.wordByText[it.word]) d.wordByText[it.word] = it;
        d.spelling[it.word] = (d.spelling[it.word] || 0) + 1;
        uniq(kanjiChars(it.word)).forEach((c) => (d.wordsByChar[c] = d.wordsByChar[c] || []).push(it));
      }
      it.tags.forEach((t) => d.tags.push(t));
    });
    // New cards come in list order, and a word only after the kanji it uses.
    items.forEach((it) => {
      if (it.type === "k") {
        it.pos = kIndex[it.kanji];
        return;
      }
      const ks = kanjiChars(it.word).filter((c) => c in kIndex);
      it.pos = ks.length ? Math.max.apply(null, ks.map((c) => kIndex[c])) + 0.5 : d.kanji.length + it.order / 1e4;
    });
    d.tags = uniq(d.tags).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (settings.tag && d.tags.indexOf(settings.tag) === -1) settings.tag = "";
    D = d;
  }
  const bySeq = (a, b) => a.pos - b.pos || (a.type === b.type ? 0 : a.type === "k" ? -1 : 1) || a.order - b.order;
  const meaningText = (it, n) => (it.meanings.slice(0, n || 3).join(", ") || "—");
  // Another card is written the same way (一日 = いちにち or ついたち), so prompts show which one is meant.
  const sharedSpelling = (it) => it.type === "w" && (D.spelling[it.word] || 0) > 1;
  const label = (it) => (it.type === "k" ? it.kanji : it.word);
  function fmtReading(r) {
    const i = r.indexOf(".");
    const html = i >= 0 ? esc(r.slice(0, i)) + '<span class="okuri">' + esc(r.slice(i + 1)) + "</span>" : esc(r);
    return html.replace(/-/g, '<span class="okuri">-</span>');
  }
  const readingsInline = (k) =>
    [k.on.map(esc).join("・"), k.kun.map(fmtReading).join("・")].filter(Boolean).join('<span class="muted"> ／ </span>');
  const readingsPlain = (k) => [k.on.join("・"), k.kun.map((r) => r.replace(".", "")).join("・")].filter(Boolean).join(" ／ ");

  // ---------- spaced review ----------
  // Stage → wait before the next review. Wrong drops 3 stages; the session
  // also shows a forgotten card again a few cards later.
  const STEPS = [0, 10 * MIN, 4 * HOUR, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY, 80 * DAY, 180 * DAY];
  const LEVELS = ["New", "Learning", "Familiar", "Known", "Mastered"];
  const stageOf = (id) => (progress[id] && progress[id].s) || 0;
  const levelOf = (id) => {
    const s = stageOf(id);
    return s === 0 ? 0 : s <= 2 ? 1 : s <= 4 ? 2 : s <= 6 ? 3 : 4;
  };
  const isDue = (id, t) => {
    const p = progress[id];
    return !!p && p.s > 0 && p.due <= t;
  };
  function schedule(old, g, t, fuzz) {
    const p = old ? Object.assign({}, old) : { s: 0, due: 0, n: 0, ok: 0, bad: 0, lapses: 0 };
    const isNew = !p.s;
    const learning = p.s > 0 && p.s <= 2;
    const due = isNew || p.due <= t;
    p.n = (p.n || 0) + 1;
    if (g === 0) {
      p.bad = (p.bad || 0) + 1;
      if (!isNew) p.lapses = (p.lapses || 0) + 1;
      p.s = Math.max(1, p.s - 3);
      p.due = t + STEPS[1];
    } else {
      p.ok = (p.ok || 0) + 1;
      if (isNew) p.s = g >= 3 ? 3 : g === 2 ? 2 : 1;
      // Early practice of a card that isn't due yet doesn't push it further out.
      else if (due || learning) p.s = Math.min(STEPS.length - 1, p.s + (g >= 3 ? 2 : g === 2 ? 1 : 0));
      let iv = g === 1 ? Math.max(STEPS[1], STEPS[p.s] * 0.5) : STEPS[p.s];
      if (fuzz && iv >= DAY) iv *= 0.92 + Math.random() * 0.16;
      p.due = t + iv;
    }
    p.last = t;
    return p;
  }
  function grade(id, g) {
    const t = now();
    const day = dayKey(t);
    const snap = { id, prev: progress[id] ? Object.assign({}, progress[id]) : null, day, logPrev: log[day] ? Object.assign({}, log[day]) : null };
    const wasNew = !stageOf(id);
    progress[id] = schedule(progress[id], g, t, true);
    const L = log[day] || { n: 0, ok: 0, nw: 0 };
    L.n++;
    if (g > 0) L.ok++;
    if (wasNew) L.nw = (L.nw || 0) + 1;
    log[day] = L;
    saveProgress();
    return snap;
  }
  function undoGrade(snap) {
    if (snap.prev) progress[snap.id] = snap.prev;
    else delete progress[snap.id];
    if (snap.logPrev) log[snap.day] = snap.logPrev;
    else delete log[snap.day];
    saveProgress();
  }
  const ivLabel = (id, g) => fmtDur(schedule(progress[id], g, now(), false).due - now());
  function weakScore(id) {
    const p = progress[id];
    if (!p || !p.n) return 0;
    return (1 - p.ok / p.n) * 2 + (p.lapses || 0) * 0.5 + (p.s <= 2 ? 0.5 : 0);
  }
  function weakList(P) {
    return P.filter((it) => {
      const p = progress[it.id];
      return p && p.bad > 0 && (p.s <= 4 || p.ok / p.n < 0.8);
    }).sort((a, b) => weakScore(b.id) - weakScore(a.id));
  }
  function streak() {
    const d = new Date();
    let n = 0;
    if (!(log[dayKey(d.getTime())] || {}).n) d.setDate(d.getDate() - 1);
    while ((log[dayKey(d.getTime())] || {}).n) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  const newLeftToday = () => (settings.newPerDay ? Math.max(0, settings.newPerDay - ((log[dayKey()] || {}).nw || 0)) : Infinity);
  const pool = () =>
    D.items.filter((it) => (settings.scope === "all" || it.type === settings.scope) && (!settings.tag || it.tags.indexOf(settings.tag) !== -1));

  function buildQueue(mode, ids) {
    const t = now();
    const P = pool();
    const size = settings.sessionSize || Infinity;
    let items;
    if (mode === "list") items = ids.map((id) => D.byId[id]).filter(Boolean);
    else if (mode === "review") {
      const over = (it) => (t - progress[it.id].due) / Math.max(STEPS[progress[it.id].s], MIN);
      const due = P.filter((it) => isDue(it.id, t)).sort((a, b) => over(b) - over(a));
      const fresh = P.filter((it) => !stageOf(it.id)).sort(bySeq).slice(0, newLeftToday());
      items = [];
      let j = 0;
      due.forEach((it, i) => {
        items.push(it);
        if ((i + 1) % 3 === 0 && j < fresh.length) items.push(fresh[j++]);
      });
      while (j < fresh.length) items.push(fresh[j++]);
      items = items.slice(0, size);
    } else if (mode === "new") items = P.filter((it) => !stageOf(it.id)).sort(bySeq).slice(0, size);
    else if (mode === "weak") items = weakList(P).slice(0, size);
    else items = shuffle(P).slice(0, size);
    return items.map((it) => it.id);
  }

  // ---------- speech ----------
  let jaVoices = [];
  function loadVoices() {
    try {
      jaVoices = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
    } catch (e) {
      jaVoices = [];
    }
  }
  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  function speakText(text) {
    if (!("speechSynthesis" in window) || !text) {
      toast("This device has no speech voice");
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    const v = jaVoices.find((x) => /Kyoko|O-ren|Otoya|Hattori|Google/i.test(x.name)) || jaVoices[0];
    if (v) u.voice = v;
    u.rate = 0.85;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  function speakItem(id) {
    const it = D.byId[id];
    if (!it) return;
    if (it.type === "w") speakText(it.readings[0] || it.word);
    else speakText(it.on.concat(it.kun).map((r) => r.replace(/[.\-]/g, "")).join("、") || it.kanji);
  }

  // ---------- shell: tabs, sheet, toast ----------
  let tab = "home";
  const TABS = ["home", "cards", "quiz", "deck"];
  function view(fill) {
    const v = $("#view");
    v.className = fill ? "fill" : "";
    return v;
  }
  function go(t) {
    if (tab === t) {
      render();
      $("#view").scrollTop = 0;
    } else location.hash = t;
  }
  function route() {
    const h = (location.hash || "#home").slice(1);
    tab = TABS.indexOf(h) !== -1 ? h : "home";
    closeSheet();
    render();
    $("#view").scrollTop = 0;
  }
  function render() {
    $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
    const due = D.items.filter((it) => isDue(it.id, now())).length;
    const cardsTab = $('.tabs a[data-tab="cards"]');
    let badge = $(".badge", cardsTab);
    if (due) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "badge";
        cardsTab.appendChild(badge);
      }
      badge.textContent = due > 99 ? "99+" : String(due);
    } else if (badge) badge.remove();
    $("#brandSub").textContent = D.items.length ? D.kanji.length + " kanji · " + D.words.length + " words" : "";
    ({ home: renderHome, cards: renderCards, quiz: renderQuiz, deck: renderDeck })[tab]();
  }

  function openSheet(html, onMount) {
    const sh = $("#sheet");
    sh.innerHTML = '<div class="grab"></div>' + html;
    $("#sheetWrap").hidden = false;
    sh.scrollTop = 0;
    if (onMount) onMount(sh);
  }
  function closeSheet() {
    $("#sheetWrap").hidden = true;
    $("#sheet").innerHTML = "";
  }
  const sheetOpen = () => !$("#sheetWrap").hidden;

  let toastTimer = null;
  function toast(html, opts) {
    opts = opts || {};
    const el = $("#toast");
    el.innerHTML = "<span>" + html + "</span>" + (opts.undo ? '<button type="button" data-act="undo">Undo</button>' : "");
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), opts.ms || 2600);
  }
  const hideToast = () => $("#toast").classList.remove("show");

  function scopeChips() {
    const ch = (v, name, n) =>
      '<button class="chip ' + (settings.scope === v ? "on" : "") + '" data-act="scope" data-v="' + v + '">' + name + "<small>" + n + "</small></button>";
    let h = '<div class="chips">' + ch("all", "Everything", D.items.length) + ch("k", "Kanji", D.kanji.length) + ch("w", "Words", D.words.length) + "</div>";
    if (D.tags.length) {
      h +=
        '<div class="chips" style="margin-top:6px"><button class="chip ' + (!settings.tag ? "on" : "") + '" data-act="tag" data-v="">All lessons</button>' +
        D.tags.map((t) => '<button class="chip ' + (settings.tag === t ? "on" : "") + '" data-act="tag" data-v="' + esc(t) + '">' + esc(t) + "</button>").join("") +
        "</div>";
    }
    return h;
  }
  function emptyDeckHtml() {
    return (
      '<div class="empty"><div class="big">字</div><h3>Your deck is empty</h3>' +
      "<p>Add the kanji and words you are learning: one at a time, or paste a whole list at once.</p>" +
      '<div class="row wrap" style="justify-content:center"><button class="btn primary" data-act="add" data-kind="paste">' + I.paste + " Paste a list</button>" +
      '<button class="btn" data-act="add" data-kind="k">' + I.plus + " Add a kanji</button></div></div>"
    );
  }

  // ---------- home ----------
  function renderHome() {
    const v = view(false);
    if (!D.items.length) {
      v.innerHTML = emptyDeckHtml();
      return;
    }
    const t = now();
    const P = pool();
    const due = P.filter((it) => isDue(it.id, t)).length;
    const fresh = P.filter((it) => !stageOf(it.id)).length;
    const newToday = Math.min(fresh, newLeftToday());
    const today = log[dayKey()] || { n: 0, ok: 0 };
    const sk = streak();
    const weak = weakList(P);
    const dateTxt = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

    let start;
    if (due + newToday > 0) {
      start = '<button class="btn primary block" data-act="start" data-mode="review">' + I.cards + " Start review · " + Math.min(due + newToday, settings.sessionSize || Infinity) + " cards</button>";
    } else {
      const next = P.map((it) => progress[it.id]).filter((p) => p && p.due > t).sort((a, b) => a.due - b.due)[0];
      start =
        '<div class="muted" style="margin-bottom:10px">All caught up' + (next ? " · next review in " + fmtDur(next.due - t) : "") + ".</div>" +
        '<button class="btn block" data-act="start" data-mode="all">' + I.shuffle + " Practice anyway</button>";
    }

    const levels = [0, 0, 0, 0, 0];
    P.forEach((it) => levels[levelOf(it.id)]++);
    const colors = ["var(--lv0)", "var(--lv1)", "var(--lv2)", "var(--lv3)", "var(--lv4)"];
    const bar = levels.map((n, i) => (n ? '<i style="width:' + (n / P.length) * 100 + "%;background:" + colors[i] + '"></i>' : "")).join("");
    const legend = levels.map((n, i) => '<span class="lvl l' + i + '">' + LEVELS[i] + "<b>" + n + "</b></span>").join("");

    const days = [];
    const d = new Date();
    d.setDate(d.getDate() - 13);
    for (let i = 0; i < 14; i++) {
      const k = dayKey(d.getTime());
      days.push({ n: (log[k] || {}).n || 0, ok: (log[k] || {}).ok || 0, l: d.toLocaleDateString(undefined, { weekday: "narrow" }) });
      d.setDate(d.getDate() + 1);
    }
    const max = Math.max(10, ...days.map((x) => x.n));
    const weekTotal = days.slice(7).reduce((s, x) => s + x.n, 0);
    const weekOk = days.slice(7).reduce((s, x) => s + x.ok, 0);

    v.innerHTML =
      '<section class="hero">' +
      '<div class="hero-top"><span>' + esc(dateTxt) + "</span>" + (sk ? '<span class="streak">' + I.flame + sk + (sk === 1 ? " day" : " days") + "</span>" : "") + "</div>" +
      '<div class="hero-nums"><div class="due"><b>' + due + "</b><span>due now</span></div><div><b>" + newToday + "</b><span>new today</span></div><div><b>" + today.n + "</b><span>reviewed today</span></div></div>" +
      start +
      "</section>" +
      '<div class="tiles">' +
      '<button class="tile" data-act="start" data-mode="new" ' + (fresh ? "" : "disabled") + ">" + I.sparkle + "<b>Learn new</b><span>" + fresh + " not studied yet</span></button>" +
      '<button class="tile" data-act="go-quiz">' + I.quiz + "<b>Quiz me</b><span>Pick the answer, build words</span></button>" +
      '<button class="tile" data-act="start" data-mode="weak" ' + (weak.length ? "" : "disabled") + ">" + I.target + "<b>Weak spots</b><span>" + (weak.length ? weak.length + " you keep missing" : "None yet") + "</span></button>" +
      '<button class="tile" data-act="start" data-mode="all">' + I.shuffle + "<b>Shuffle all</b><span>Random practice</span></button>" +
      "</div>" +
      "<h2>Studying</h2>" + scopeChips() +
      "<h2>How well you know them</h2>" +
      '<div class="panel"><div class="mastery-bar">' + bar + '</div><div class="legend">' + legend + "</div></div>" +
      "<h2>Last 14 days</h2>" +
      '<div class="panel"><div class="week">' +
      days.map((x) => '<div><i class="' + (x.n ? "" : "zero") + '" style="height:' + (x.n ? Math.max(6, (x.n / max) * 100) : 4) + '%" title="' + x.n + ' reviews"></i><span>' + esc(x.l) + "</span></div>").join("") +
      '</div><div class="week-sum"><span>This week: ' + weekTotal + " reviews</span><span>" + (weekTotal ? Math.round((weekOk / weekTotal) * 100) + "% right" : "") + "</span></div></div>" +
      (weak.length
        ? "<h2>Keep forgetting</h2><div class=\"weak-list\">" +
          weak.slice(0, 10).map((it) => '<button class="weak-chip" data-act="open" data-id="' + esc(it.id) + '"><span class="jp">' + esc(label(it)) + "</span><small>" + esc(meaningText(it, 2)) + "</small></button>").join("") +
          "</div>"
        : "");
  }

  // ---------- cards ----------
  let cs = store.get("cards", null);
  let undoStack = [];
  let lastShown = null;
  let suppressClick = false;
  const saveCs = () => persist("cards", cs);

  function startCards(mode, ids) {
    const q = buildQueue(mode, ids);
    if (!q.length) {
      toast(mode === "weak" ? "No weak cards — nice." : mode === "new" ? "No new cards left here." : "Nothing to study here.");
      return;
    }
    cs = { mode, queue: q, i: 0, res: {}, rep: {}, revealed: false, forced: null, dirs: {}, started: now() };
    undoStack = [];
    lastShown = null;
    saveCs();
    closeSheet();
    go("cards");
  }
  function dirFor(id) {
    if (settings.direction === "recall") return "p";
    if (settings.direction === "mixed") {
      if (cs && !cs.dirs[id]) cs.dirs[id] = Math.random() < 0.5 ? "r" : "p";
      return cs ? cs.dirs[id] : "r";
    }
    return "r";
  }

  function renderCards() {
    if (!cs) return renderCardChooser();
    while (cs.i < cs.queue.length && !D.byId[cs.queue[cs.i]]) cs.queue.splice(cs.i, 1);
    if (cs.i >= cs.queue.length) return renderCardResult();
    const v = view(true);
    const id = cs.queue[cs.i];
    const it = D.byId[id];
    const nextIt = D.byId[cs.queue[cs.i + 1]];
    const fresh = lastShown !== cs.i + ":" + id;
    lastShown = cs.i + ":" + id;
    const pct = (cs.i / cs.queue.length) * 100;
    v.innerHTML =
      '<div class="session-bar">' +
      '<button class="icon-btn ghost" data-act="end-cards" aria-label="End session" title="End session">' + I.close + "</button>" +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
      '<span class="count">' + (cs.i + 1) + "/" + cs.queue.length + "</span>" +
      '<button class="icon-btn ghost" data-act="undo" aria-label="Undo last card" title="Undo (Z)" ' + (undoStack.length ? "" : "disabled") + ">" + I.undo + "</button>" +
      "</div>" +
      '<div class="stack">' + (nextIt ? cardHtml(nextIt, dirFor(nextIt.id), false, "next") : "") + cardHtml(it, dirFor(id), cs.revealed, "cur" + (fresh ? " enter" : "")) + "</div>" +
      gradesHtml(id) +
      '<div class="swipe-hint"><span>← forgot</span><span>tap card to flip</span><span>got it →</span></div>';
    bindCard($(".card.cur", v));
  }

  function cardHtml(it, dir, revealed, cls) {
    const isCur = cls.indexOf("cur") === 0;
    const lv = levelOf(it.id);
    const head =
      '<div class="card-head"><span class="kind">' + (it.type === "k" ? "Kanji" : "Word") + "</span>" +
      (it.tags[0] ? '<span class="tag">' + esc(it.tags[0]) + "</span>" : "") +
      '<span class="spacer"></span><span class="lvl l' + lv + '">' + LEVELS[lv] + "</span>" +
      '<button class="icon-btn ghost" data-act="speak" data-id="' + esc(it.id) + '" aria-label="Play the reading">' + I.speak + "</button></div>";
    const showGlyph = dir === "r" || revealed;
    let body;
    if (it.type === "k") {
      body = showGlyph
        ? '<div class="paper"><span class="glyph">' + esc(it.kanji) + "</span></div>"
        : '<div class="prompt-meaning">' + esc(meaningText(it, 4)) + "</div>" + (it.on.length || it.kun.length ? '<div class="prompt-sub">' + readingsInline(it) + "</div>" : "");
      body += revealed ? kanjiAnswer(it) : hintHtml(it, dir);
    } else {
      const n = Math.min(5, Array.from(it.word).length);
      body = showGlyph
        ? '<div class="word-glyph n' + n + '">' + esc(it.word) + "</div>" +
          (!revealed && dir === "r" && settings.showReadingFront && it.readings.length ? '<div class="front-reading">' + esc(it.readings.join("・")) + "</div>" : "") +
          (!revealed && dir === "r" && sharedSpelling(it) ? '<div class="prompt-sub">the one meaning “' + esc(meaningText(it, 2)) + "”</div>" : "")
        : '<div class="prompt-meaning">' + esc(meaningText(it, 4)) + "</div>" + (it.readings.length ? '<div class="prompt-sub">' + esc(it.readings.join("・")) + "</div>" : "");
      body += revealed ? wordAnswer(it) : hintHtml(it, dir);
    }
    const stamps = isCur && cs.forced == null ? '<div class="stamp good">覚えた<small>GOT IT</small></div><div class="stamp bad">もう一回<small>AGAIN</small></div>' : "";
    return (
      '<article class="card ' + cls + (revealed ? " revealed" : "") + (isCur && cs.forced === 0 ? " forced" : "") + '" data-id="' + esc(it.id) + '">' +
      stamps + head + '<div class="card-body">' + body + "</div></article>"
    );
  }
  function hintHtml(it, dir) {
    if (dir === "r") return '<div class="hint">Tap to see the answer</div>';
    return '<div class="hint">' + (it.type === "k" ? "Picture the kanji (or write it with a finger), then tap" : "How is it written? Picture it, then tap") + "</div>";
  }
  function kanjiAnswer(it) {
    let h = '<div class="answer"><div class="ans-meaning">' + esc(meaningText(it, 6)) + "</div>" + readingsBlock(it);
    if (it.note) h += '<div class="note">' + esc(it.note) + "</div>";
    const ws = (D.wordsByChar[it.kanji] || []).slice(0, 8);
    if (ws.length) h += '<div class="sub-h">Words with ' + esc(it.kanji) + '</div><div class="words">' + ws.map(wordRow).join("") + "</div>";
    return h + "</div>";
  }
  function readingsBlock(it) {
    if (!it.on.length && !it.kun.length) return "";
    let h = '<div class="readings">';
    if (it.on.length) h += '<div><span class="rl">音 on</span><span>' + it.on.map(esc).join("、") + "</span></div>";
    if (it.kun.length) h += '<div><span class="rl">訓 kun</span><span>' + it.kun.map(fmtReading).join("、") + "</span></div>";
    return h + "</div>";
  }
  const wordRow = (w) =>
    '<button class="wrow" data-act="open" data-id="' + esc(w.id) + '"><span class="jp">' + esc(w.word) + "</span><b>" + esc(w.readings.join("・")) + "</b><span>" + esc(meaningText(w, 3)) + "</span></button>";
  function partChip(c) {
    const k = D.byChar[c];
    if (!k) return '<span class="part missing"><span class="jp">' + esc(c) + "</span><small>not in your deck</small></span>";
    return (
      '<button class="part" data-act="open" data-id="' + esc(k.id) + '"><span class="jp">' + esc(c) + "</span><span><small>" + esc(meaningText(k, 2)) + "</small><small>" +
      esc([k.on[0], k.kun[0] && k.kun[0].replace(".", "")].filter(Boolean).join(" ・ ")) + "</small></span></button>"
    );
  }
  function wordAnswer(it) {
    let h = '<div class="answer">';
    if (it.readings.length) h += '<div class="ans-reading">' + esc(it.readings.join("・")) + "</div>";
    h += '<div class="ans-meaning">' + esc(meaningText(it, 6)) + "</div>";
    if (it.note) h += '<div class="note">' + esc(it.note) + "</div>";
    const ks = uniq(kanjiChars(it.word));
    if (ks.length) h += '<div class="sub-h">Kanji in this word</div><div class="parts">' + ks.map(partChip).join("") + "</div>";
    return h + "</div>";
  }
  function gradesHtml(id) {
    if (cs.forced === 0) return '<div class="grades one"><button class="grade bad" data-act="grade" data-g="0">Next<small>marked as forgot · back in ' + ivLabel(id, 0) + "</small></button></div>";
    if (!cs.revealed) return '<div class="grades"><button class="grade show" data-act="reveal">Show answer<small>or swipe if you already know</small></button></div>';
    return (
      '<div class="grades">' +
      '<button class="grade bad" data-act="grade" data-g="0">Forgot<small>' + ivLabel(id, 0) + "</small></button>" +
      '<button class="grade hard" data-act="grade" data-g="1">Hard<small>' + ivLabel(id, 1) + "</small></button>" +
      '<button class="grade good" data-act="grade" data-g="2">Got it<small>' + ivLabel(id, 2) + "</small></button></div>"
    );
  }

  function bindCard(card) {
    if (!card) return;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    let pid = null;
    let drag = false;
    let moved = false;
    let t0 = 0;
    const good = $(".stamp.good", card);
    const bad = $(".stamp.bad", card);
    const resetStamps = () => {
      if (good) good.style.opacity = 0;
      if (bad) bad.style.opacity = 0;
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pid = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      dx = dy = 0;
      drag = moved = false;
      t0 = performance.now();
    });
    card.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      dx = e.clientX - sx;
      dy = e.clientY - sy;
      if (!drag) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          drag = moved = true;
          card.style.transition = "none";
          try {
            card.setPointerCapture(pid);
          } catch (err) {
            /* capture is optional */
          }
        } else {
          if (Math.abs(dy) > 10) moved = true;
          return;
        }
      }
      card.style.transform = "translateX(" + dx + "px) rotate(" + dx / 20 + "deg)";
      const f = Math.min(1, Math.abs(dx) / (card.offsetWidth * 0.3));
      if (good) good.style.opacity = dx > 0 ? f : 0;
      if (bad) bad.style.opacity = dx < 0 ? f : 0;
    });
    const finish = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (!drag) {
        if (e.type === "pointerup" && !moved && !e.target.closest("[data-act]")) reveal();
        return;
      }
      drag = false;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 350);
      card.style.transition = "";
      const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (Math.abs(dx) > card.offsetWidth * 0.3 || (speed > 0.5 && Math.abs(dx) > 50)) swipeOut(dx > 0 ? 1 : -1);
      else {
        card.style.transform = "";
        resetStamps();
      }
    };
    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", finish);
  }

  function reveal() {
    if (!cs || cs.revealed || cs.i >= cs.queue.length) return;
    cs.revealed = true;
    saveCs();
    renderCards();
    if (settings.autoSpeak) speakItem(cs.queue[cs.i]);
  }
  let flying = false;
  function swipeOut(dir) {
    if (!cs || cs.i >= cs.queue.length || flying) return;
    const card = $(".card.cur");
    // Swiping "forgot" before looking: show the answer first, then move on.
    if (dir < 0 && !cs.revealed && cs.forced == null) {
      cs.revealed = true;
      cs.forced = 0;
      saveCs();
      renderCards();
      vibrate(25);
      if (settings.autoSpeak) speakItem(cs.queue[cs.i]);
      return;
    }
    const g = cs.forced === 0 ? 0 : dir > 0 ? 2 : 0;
    if (card) {
      const st = $(dir > 0 ? ".stamp.good" : ".stamp.bad", card);
      if (st) st.style.opacity = 1;
      card.style.transition = "transform .26s ease, opacity .26s ease";
      card.style.transform = "translateX(" + dir * 130 + "%) rotate(" + dir * 18 + "deg)";
      card.style.opacity = "0";
    }
    flying = true;
    setTimeout(() => {
      flying = false;
      commit(g);
    }, card ? 170 : 0);
  }
  function commit(g) {
    if (!cs || cs.i >= cs.queue.length || flying) return;
    const id = cs.queue[cs.i];
    const before = JSON.stringify(cs);
    const wasRevealed = cs.revealed;
    const snap = grade(id, g);
    undoStack.push({ snap, cs: before });
    if (undoStack.length > 40) undoStack.shift();
    if (!(id in cs.res)) cs.res[id] = g;
    if (g === 0 && (cs.rep[id] || 0) < 2) {
      cs.rep[id] = (cs.rep[id] || 0) + 1;
      cs.queue.splice(Math.min(cs.i + 4, cs.queue.length), 0, id);
    }
    cs.i++;
    cs.revealed = false;
    cs.forced = null;
    saveCs();
    renderCards();
    if (!wasRevealed && g > 0) {
      const it = D.byId[id];
      toast('<span class="jp">' + esc(label(it)) + "</span> " + esc(it.type === "w" && it.readings[0] ? it.readings[0] + " · " : "") + esc(meaningText(it, 2)), { undo: true });
    }
  }
  function undo() {
    const u = undoStack.pop();
    if (!u) return;
    undoGrade(u.snap);
    cs = JSON.parse(u.cs);
    lastShown = null;
    saveCs();
    hideToast();
    if (tab !== "cards") go("cards");
    else renderCards();
  }
  function endCards() {
    if (!cs) return;
    if (!Object.keys(cs.res).length) {
      cs = null;
      saveCs();
      render();
      return;
    }
    cs.queue = cs.queue.slice(0, cs.i);
    saveCs();
    renderCards();
  }

  function ring(pct, sub) {
    const C = 2 * Math.PI * 62;
    return (
      '<div class="ring"><svg viewBox="0 0 150 150"><circle class="bg" cx="75" cy="75" r="62"/><circle class="fg" cx="75" cy="75" r="62" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - pct / 100)).toFixed(1) + '"/></svg>' +
      '<div class="mid"><b>' + pct + "%</b><span>" + sub + "</span></div></div>"
    );
  }
  function itemChips(ids) {
    return (
      '<div class="weak-list" style="justify-content:center">' +
      ids.map((id) => D.byId[id]).filter(Boolean).map((it) => '<button class="weak-chip" data-act="open" data-id="' + esc(it.id) + '"><span class="jp">' + esc(label(it)) + "</span><small>" + esc(meaningText(it, 2)) + "</small></button>").join("") +
      "</div>"
    );
  }
  function renderCardResult() {
    const v = view(false);
    const ids = Object.keys(cs.res).filter((id) => D.byId[id]);
    const good = ids.filter((id) => cs.res[id] > 0).length;
    const missed = ids.filter((id) => cs.res[id] === 0);
    const pct = ids.length ? Math.round((good / ids.length) * 100) : 0;
    const mins = Math.max(1, Math.round((now() - cs.started) / MIN));
    v.innerHTML =
      '<div class="result">' + ring(pct, "remembered") +
      "<h3>" + (pct >= 90 ? "Excellent! よくできました" : pct >= 70 ? "Nice work" : pct >= 40 ? "Getting there" : "These need more time") + "</h3>" +
      "<p>You knew " + good + " of " + ids.length + " · " + mins + " min</p>" +
      (missed.length ? '<h2 style="text-align:center">To go over again</h2>' + itemChips(missed) : "") +
      '<div class="actions">' +
      (missed.length ? '<button class="btn primary block" data-act="cards-list" data-ids="' + esc(missed.join("\n")) + '">' + I.cards + " Go over the " + missed.length + " you missed</button>" : "") +
      (ids.length > 1 ? '<button class="btn block" data-act="quiz-list" data-ids="' + esc(ids.join("\n")) + '">' + I.quiz + " Quiz me on these</button>" : "") +
      '<button class="btn block" data-act="cards-done">Done</button></div></div>';
  }
  function renderCardChooser() {
    const v = view(false);
    if (!D.items.length) {
      v.innerHTML = emptyDeckHtml();
      return;
    }
    const t = now();
    const P = pool();
    const due = P.filter((it) => isDue(it.id, t)).length;
    const fresh = P.filter((it) => !stageOf(it.id)).length;
    const weak = weakList(P).length;
    const dir = (val, name) => '<button class="' + (settings.direction === val ? "on" : "") + '" data-act="set" data-k="direction" data-v="' + val + '">' + name + "</button>";
    v.innerHTML =
      "<h2>Study with cards</h2>" + scopeChips() +
      '<div class="tiles">' +
      '<button class="tile" data-act="start" data-mode="review" ' + (due + Math.min(fresh, newLeftToday()) ? "" : "disabled") + ">" + I.cards + "<b>Review</b><span>" + due + " due · " + Math.min(fresh, newLeftToday()) + " new</span></button>" +
      '<button class="tile" data-act="start" data-mode="new" ' + (fresh ? "" : "disabled") + ">" + I.sparkle + "<b>Learn new</b><span>" + fresh + " not studied yet</span></button>" +
      '<button class="tile" data-act="start" data-mode="weak" ' + (weak ? "" : "disabled") + ">" + I.target + "<b>Weak spots</b><span>" + (weak || "None") + "</span></button>" +
      '<button class="tile" data-act="start" data-mode="all">' + I.shuffle + "<b>Shuffle all</b><span>" + P.length + " cards</span></button>" +
      "</div>" +
      "<h2>Card front shows</h2>" +
      '<div class="seg">' + dir("recog", "Kanji first") + dir("recall", "Meaning first") + dir("mixed", "Mixed") + "</div>" +
      '<p class="muted" style="font-size:13px;margin:12px 2px">Swipe right if you knew it, left if you didn\'t. Missed cards come back a few cards later, and again in 10 minutes.</p>';
  }

  // ---------- quiz ----------
  const QTYPES = [
    ["k2m", "Kanji → meaning", "k", "日→sun"],
    ["m2k", "Meaning → kanji", "k", "sun→日"],
    ["k2r", "Kanji → reading", "k", "日→ニチ"],
    ["w2r", "Word → reading", "w", "日本→にほん"],
    ["w2m", "Word → meaning", "w", "日本→Japan"],
    ["m2w", "Meaning → word", "w", "Japan→日本"],
    ["gap", "Missing kanji", "w", "□本"],
    ["build", "Build the word", "w", "日+本"],
    ["type", "Type the reading", "kw", "nihon→にほん"],
  ];
  const mset = (it) =>
    new Set(it.meanings.map((m) => m.toLowerCase().replace(/\(.*?\)/g, "").replace(/^(to|a|an|the) /, "").trim()).filter(Boolean));
  const overlaps = (a, b) => {
    for (const x of a) if (b.has(x)) return true;
    return false;
  };
  function kin(a, b) {
    if (!a || !b) return 0;
    let s = 0;
    if (a.tags.length && b.tags.some((t) => a.tags.indexOf(t) !== -1)) s += 1;
    const ca = kanjiChars(label(a));
    const cb = kanjiChars(label(b));
    if (ca.some((c) => cb.indexOf(c) !== -1)) s += 2;
    if (Array.from(label(a)).length === Array.from(label(b)).length) s += 0.5;
    return s;
  }
  // Mostly "close" wrong answers (same lesson, shared kanji), with some randomness.
  function pickDistractors(cands, n, it) {
    const seen = new Set();
    const list = [];
    cands.forEach((c) => {
      if (!c.v || seen.has(c.v)) return;
      seen.add(c.v);
      list.push(c);
    });
    const scored = list.map((c) => ({ c, s: kin(it, c.o) + (c.bonus || 0) + Math.random() * 1.5 }));
    scored.sort((a, b) => b.s - a.s);
    return shuffle(scored.slice(0, n + 2)).slice(0, n).map((x) => x.c);
  }
  function mcq(type, it, ask, prompt, rightV, cands, fmt, layout) {
    const ds = pickDistractors(cands.filter((c) => c.v !== rightV), 3, it);
    if (!ds.length) return null;
    const vals = [rightV].concat(ds.map((d) => d.v));
    if (layout === "auto") layout = Math.max.apply(null, vals.map((x) => Array.from(x).length)) > 6 ? "list" : "grid";
    const options = shuffle([{ h: fmt(rightV), ok: true }].concat(ds.map((d) => ({ h: fmt(d.v), ok: false }))));
    return { type, id: it.id, ask, prompt, layout, options };
  }
  const glyphPrompt = (s) => '<div class="q-glyph jp n' + Math.min(5, Array.from(s).length) + '">' + esc(s) + "</div>";
  const fmtText = (v) => esc(v);
  const fmtJp = (v) => '<span class="jp">' + esc(v) + "</span>";
  const fmtWord = (v) => '<span class="jpw">' + esc(v) + "</span>";
  const fmtKana = (v) => '<span class="kana">' + fmtReading(v) + "</span>";

  // Wrong-but-plausible readings built from the kanji's own readings: 日本 → にちほん.
  function synthReadings(it) {
    const parts = [];
    const chars = Array.from(it.word);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (!isKanji(ch)) {
        parts.push([toHira(ch)]);
        continue;
      }
      const k = D.byChar[ch];
      if (!k) return [];
      const rs = uniq(k.on.map(toHira).concat(k.kun.map((r) => r.split(".")[0])).map((r) => r.replace(/-/g, "")).filter(Boolean));
      if (!rs.length) return [];
      parts.push(rs.slice(0, 4));
    }
    let combos = [""];
    parts.forEach((p) => {
      const next = [];
      combos.forEach((a) => p.forEach((b) => next.push(a + b)));
      combos = next.slice(0, 80);
    });
    return shuffle(uniq(combos)).slice(0, 8);
  }

  const GEN = {
    k2m(it) {
      if (!it.meanings.length) return null;
      const ms = mset(it);
      const c = D.kanji.filter((o) => o !== it && o.meanings.length && !overlaps(mset(o), ms)).map((o) => ({ v: meaningText(o, 3), o }));
      return mcq("k2m", it, "What does this kanji mean?", glyphPrompt(it.kanji), meaningText(it, 3), c, fmtText, "list");
    },
    m2k(it) {
      if (!it.meanings.length) return null;
      const ms = mset(it);
      const c = D.kanji.filter((o) => o !== it && !overlaps(mset(o), ms)).map((o) => ({ v: o.kanji, o }));
      return mcq("m2k", it, "Which kanji means…", '<div class="q-meaning">' + esc(meaningText(it, 4)) + "</div>", it.kanji, c, fmtJp, "grid");
    },
    k2r(it) {
      const all = it.on.map((r) => ({ r, on: true })).concat(it.kun.map((r) => ({ r, on: false })));
      if (!all.length) return null;
      const tgt = pick(all);
      const mine = new Set();
      all.forEach((x) => {
        mine.add(normReading(x.r));
        mine.add(normReading(x.r.split(".")[0]));
      });
      const c = [];
      D.kanji.forEach((o) => {
        if (o === it) return;
        (tgt.on ? o.on : o.kun).forEach((r) => {
          if (!mine.has(normReading(r)) && !mine.has(normReading(r.split(".")[0]))) c.push({ v: r, o });
        });
      });
      return mcq("k2r", it, tgt.on ? "Which is its on’yomi (音読み)?" : "Which is its kun’yomi (訓読み)?", glyphPrompt(it.kanji), tgt.r, c, fmtKana, "grid");
    },
    w2r(it) {
      if (!it.readings.length || !kanjiChars(it.word).length) return null;
      // Readings of every card spelled like this one are right answers too, so never offer them as wrong ones.
      const mine = new Set(D.words.filter((o) => o.word === it.word).flatMap((o) => o.readings).map(normReading));
      const c = D.words.filter((o) => o !== it && o.readings.length).map((o) => ({ v: o.readings[0], o })).filter((x) => !mine.has(normReading(x.v)));
      synthReadings(it).forEach((v) => {
        if (!mine.has(normReading(v))) c.push({ v, o: null, bonus: 2.2 });
      });
      const hint = sharedSpelling(it) ? '<div class="muted" style="margin-top:4px">the one meaning “' + esc(meaningText(it, 2)) + "”</div>" : "";
      return mcq("w2r", it, "How do you read this word?", glyphPrompt(it.word) + hint, it.readings[0], c, fmtKana, "auto");
    },
    w2m(it) {
      if (!it.meanings.length) return null;
      const ms = mset(it);
      const c = D.words.filter((o) => o !== it && o.word !== it.word && o.meanings.length && !overlaps(mset(o), ms)).map((o) => ({ v: meaningText(o, 3), o }));
      const hint = sharedSpelling(it) && it.readings.length ? '<div class="q-reading">' + esc(it.readings.join("・")) + "</div>" : "";
      return mcq("w2m", it, "What does this word mean?", glyphPrompt(it.word) + hint, meaningText(it, 3), c, fmtText, "list");
    },
    m2w(it) {
      if (!it.meanings.length) return null;
      const ms = mset(it);
      const c = D.words.filter((o) => o !== it && o.word !== it.word && !overlaps(mset(o), ms)).map((o) => ({ v: o.word, o }));
      const q = mcq("m2w", it, "Which word means…", '<div class="q-meaning">' + esc(meaningText(it, 4)) + "</div>", it.word, c, fmtWord, "auto");
      if (q) q.layout = Math.max.apply(null, [it.word].concat(c.map((x) => x.v)).map((x) => Array.from(x).length)) > 4 ? "list" : "grid";
      return q;
    },
    gap(it) {
      const chars = Array.from(it.word);
      if (chars.length < 2) return null;
      const kpos = chars.map((c, i) => (isKanji(c) && c !== "々" ? i : -1)).filter((i) => i >= 0);
      if (!kpos.length) return null;
      const inDeck = kpos.filter((i) => D.byChar[chars[i]]);
      const pos = pick(inDeck.length ? inDeck : kpos);
      const right = chars[pos];
      const c = D.kanji
        .filter((o) => o.kanji !== right)
        .filter((o) => {
          const alt = chars.slice();
          alt[pos] = o.kanji;
          return !D.wordByText[alt.join("")];
        })
        .map((o) => ({ v: o.kanji, o }));
      const prompt =
        '<div class="q-glyph jp n' + Math.min(5, chars.length) + '">' + chars.map((ch, i) => (i === pos ? '<span class="blank">？</span>' : esc(ch))).join("") + "</div>" +
        (it.readings.length ? '<div class="q-reading">' + esc(it.readings.join("・")) + "</div>" : "") +
        '<div class="muted" style="margin-top:4px">' + esc(meaningText(it, 3)) + "</div>";
      return mcq("gap", it, "Fill in the missing kanji", prompt, right, c, fmtJp, "grid");
    },
    build(it) {
      const chars = Array.from(it.word);
      if (chars.indexOf("々") !== -1) return null;
      const ks = kanjiChars(it.word);
      if (ks.length < 2) return null;
      const want = Math.min(8, Math.max(ks.length + 2, 6));
      const others = D.kanji.filter((o) => ks.indexOf(o.kanji) === -1).map((o) => ({ v: o.kanji, o }));
      const extra = pickDistractors(others, want - ks.length, it).map((x) => x.v);
      return {
        type: "build",
        id: it.id,
        ask: "Build the word: tap the kanji in order",
        prompt: '<div class="q-meaning">' + esc(meaningText(it, 3)) + "</div>" + (it.readings.length ? '<div class="q-reading">' + esc(it.readings.join("・")) + "</div>" : ""),
        layout: "build",
        segs: chars.map((c) => (isKanji(c) ? { k: 1 } : { t: c })),
        tiles: shuffle(ks.concat(extra)),
        answer: ks.join(""),
      };
    },
    type(it) {
      if (it.type === "w") {
        if (!it.readings.length || !kanjiChars(it.word).length) return null;
        return {
          type: "type",
          id: it.id,
          ask: "Type the reading",
          prompt: glyphPrompt(it.word) + '<div class="muted" style="margin-top:6px">' + esc(meaningText(it, 3)) + "</div>",
          layout: "type",
          accept: uniq(it.readings.map(normReading)),
        };
      }
      const rs = it.on.concat(it.kun);
      if (!rs.length) return null;
      return {
        type: "type",
        id: it.id,
        ask: "Type any reading of this kanji",
        prompt: glyphPrompt(it.kanji),
        layout: "type",
        accept: uniq(rs.map(normReading).concat(rs.map((r) => normReading(r.split(".")[0])))).filter(Boolean),
      };
    },
  };

  function makeQuiz(count, ids) {
    const P = ids ? ids.map((id) => D.byId[id]).filter(Boolean) : pool();
    const types = QTYPES.filter((q) => settings.quizTypes[q[0]]);
    if (!P.length || !types.length) return [];
    const t = now();
    const weight = (it) => {
      const p = progress[it.id];
      if (!p) return 1.4;
      let w = 1 + weakScore(it.id);
      if (isDue(it.id, t)) w += 1.5;
      if (p.s >= 5) w *= 0.5;
      return w;
    };
    const order = () => P.map((it) => ({ it, k: Math.pow(Math.random(), 1 / weight(it)) })).sort((a, b) => b.k - a.k).map((x) => x.it);
    const out = [];
    const used = new Set();
    let bag = [];
    let last = "";
    let tries = 0;
    while (out.length < count && tries++ < count * 15) {
      if (!bag.length) bag = order();
      const it = bag.shift();
      const opts = shuffle(types.filter((q) => q[2].indexOf(it.type) !== -1).map((q) => q[0])).sort((a, b) => (a === last) - (b === last));
      for (let i = 0; i < opts.length; i++) {
        const tp = opts[i];
        if (used.has(it.id + tp) && tries < count * 8) continue;
        const q = GEN[tp](it);
        if (q) {
          out.push(q);
          used.add(it.id + tp);
          last = tp;
          break;
        }
      }
    }
    return out;
  }

  let qz = store.get("quiz", null);
  let autoTimer = null;
  const saveQz = () => persist("quiz", qz);
  function startQuiz(ids) {
    const qs = makeQuiz(ids ? Math.max(5, Math.min(30, ids.length * 2)) : settings.quizCount, ids);
    if (!qs.length) {
      toast("Add a few more kanji or words for a quiz.");
      return;
    }
    qz = { qs, i: 0, ans: [], combo: 0, best: 0, graded: {}, state: null, started: now() };
    saveQz();
    closeSheet();
    go("quiz");
  }
  function renderQuiz() {
    clearTimeout(autoTimer);
    if (!qz) return renderQuizSetup();
    if (qz.i >= qz.qs.length) return renderQuizResult();
    const v = view(false);
    const q = qz.qs[qz.i];
    const s = qz.state || (qz.state = { picks: [] });
    const last = qz.i === qz.qs.length - 1;
    let body = "";
    if (q.options) {
      body =
        '<div class="opts ' + (q.layout === "list" ? "list" : "") + '">' +
        q.options
          .map((o, i) => {
            let cls = "";
            if (s.answered) cls = o.ok ? "right" : i === s.chosen ? "wrong" : "dim";
            return '<button class="opt ' + cls + '" data-act="opt" data-i="' + i + '"' + (s.answered ? ' aria-disabled="true"' : "") + '><span class="key">' + (i + 1) + "</span>" + o.h + "</button>";
          })
          .join("") +
        "</div>";
    } else if (q.layout === "build") {
      let n = 0;
      const got = s.picks.map((i) => q.tiles[i]);
      const slots = q.segs
        .map((sg) => {
          if (!sg.k) return '<span class="slot-kana">' + esc(sg.t) + "</span>";
          const idx = n++;
          const ch = got[idx];
          let cls = ch ? "filled" : "";
          if (s.answered) cls = Array.from(q.answer)[idx] === ch ? "right" : "wrong";
          return '<button class="slot ' + cls + '" data-act="slot" data-i="' + idx + '">' + esc(ch || "") + "</button>";
        })
        .join("");
      body =
        '<div class="slots">' + slots + "</div>" +
        (s.answered ? "" : '<div class="tiles-pick">' + q.tiles.map((c, i) => '<button class="tile-k ' + (s.picks.indexOf(i) !== -1 ? "used" : "") + '" data-act="tile" data-i="' + i + '">' + esc(c) + "</button>").join("") + "</div>");
    } else if (q.layout === "type") {
      body =
        '<form class="type-box" id="typeForm"><input id="typeIn" lang="ja" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="romaji or kana" ' +
        (s.answered ? 'readonly class="' + (s.ok ? "right" : "wrong") + '" value="' + esc(s.typed || "") + '"' : "") + ">" +
        (s.answered ? "" : '<button class="btn primary" type="submit">Check</button>') + "</form>" +
        (s.answered ? "" : '<div class="row" style="justify-content:space-between"><div class="type-help">Romaji turns into kana as you type: nihon → にほん</div><button class="btn small" data-act="type-skip">Show me</button></div>');
    }
    v.innerHTML =
      '<div class="session-bar"><button class="icon-btn ghost" data-act="end-quiz" aria-label="End quiz" title="End quiz">' + I.close + "</button>" +
      '<div class="progress"><i style="width:' + (qz.i / qz.qs.length) * 100 + '%"></i></div>' +
      '<span class="count">' + (qz.i + 1) + "/" + qz.qs.length + "</span>" +
      '<span class="combo">' + (qz.combo >= 2 ? qz.combo + "連続" : "") + "</span></div>" +
      '<div class="q-card"><div class="q-ask">' + esc(q.ask) + "</div>" + q.prompt + "</div>" +
      body +
      (s.answered ? feedbackHtml(q, s, last) : "");
    if (q.layout === "type" && !s.answered) {
      const inp = $("#typeIn");
      inp.addEventListener("input", (e) => {
        if (e.isComposing) return;
        const val = romaToKana(inp.value, false);
        if (val !== inp.value) inp.value = val;
      });
      $("#typeForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const typed = romaToKana(inp.value, true).trim();
        if (!typed) return;
        answerQuiz(q.accept.indexOf(normReading(typed)) !== -1, { typed });
      });
      setTimeout(() => inp.focus({ preventScroll: true }), 30);
    }
    if (s.answered) {
      const fb = $(".feedback", v);
      if (fb) fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  function feedbackHtml(q, s, last) {
    const it = D.byId[q.id];
    let info = "";
    if (it && it.type === "k") {
      info = '<span class="jp big">' + esc(it.kanji) + '</span><div class="info"><b>' + esc(meaningText(it, 4)) + '</b><div class="jpr">' + readingsInline(it) + "</div></div>";
    } else if (it) {
      const n = Array.from(it.word).length;
      info =
        '<span class="jp big" style="font-size:' + (n > 3 ? 26 : n > 2 ? 32 : 40) + 'px">' + esc(it.word) + '</span><div class="info"><div class="jpr">' + esc(it.readings.join("・")) + "</div><b>" + esc(meaningText(it, 4)) + "</b></div>";
    }
    return (
      '<div class="feedback ' + (s.ok ? "ok" : "no") + '"><div class="fb-title">' + (s.ok ? I.check + " Correct" : I.close + (s.skipped ? " Here it is" : " Not quite")) + "</div>" +
      '<div class="fb-body" data-act="open" data-id="' + esc(q.id) + '">' + info + '<button class="icon-btn ghost" data-act="speak" data-id="' + esc(q.id) + '" aria-label="Play the reading">' + I.speak + "</button></div></div>" +
      '<button class="btn primary block" data-act="q-next" style="margin-top:12px">' + (last ? "See results" : "Next") + " " + I.next + "</button>"
    );
  }
  function answerQuiz(ok, extra) {
    const s = qz.state;
    if (!s || s.answered) return;
    Object.assign(s, extra || {}, { answered: true, ok });
    const q = qz.qs[qz.i];
    qz.ans[qz.i] = { id: q.id, ok };
    // An item asked twice in one quiz only moves its schedule once (a miss always counts).
    if (!ok || !qz.graded[q.id]) {
      grade(q.id, ok ? 2 : 0);
      qz.graded[q.id] = 1;
    }
    qz.combo = ok ? qz.combo + 1 : 0;
    qz.best = Math.max(qz.best, qz.combo);
    saveQz();
    renderQuiz();
    if (!ok) vibrate(60);
    if (settings.autoSpeak) speakItem(q.id);
    const nb = $('[data-act="q-next"]');
    if (nb && q.layout === "type") nb.focus({ preventScroll: true });
    if (ok && settings.quizAutoNext) autoTimer = setTimeout(nextQuestion, 1200);
  }
  function nextQuestion() {
    clearTimeout(autoTimer);
    if (!qz) return;
    qz.i++;
    qz.state = null;
    saveQz();
    if (tab === "quiz") {
      render();
      $("#view").scrollTop = 0;
    }
  }
  function chooseOpt(i) {
    const q = qz && qz.qs[qz.i];
    if (!q || !q.options || !q.options[i] || (qz.state && qz.state.answered)) return;
    answerQuiz(!!q.options[i].ok, { chosen: i });
  }
  function pickTile(i) {
    const q = qz && qz.qs[qz.i];
    const s = qz && qz.state;
    if (!q || q.layout !== "build" || !s || s.answered || i >= q.tiles.length || s.picks.indexOf(i) !== -1) return;
    s.picks.push(i);
    const need = Array.from(q.answer).length;
    if (s.picks.length >= need) {
      const got = s.picks.map((x) => q.tiles[x]).join("");
      answerQuiz(got === q.answer, {});
    } else {
      saveQz();
      renderQuiz();
    }
  }
  function renderQuizSetup() {
    const v = view(false);
    if (!D.items.length) {
      v.innerHTML = emptyDeckHtml();
      return;
    }
    const counts = [10, 15, 25, 40];
    v.innerHTML =
      "<h2>Quiz yourself</h2>" + scopeChips() +
      "<h2>Questions</h2>" +
      '<div class="seg">' + counts.map((n) => '<button class="' + (settings.quizCount === n ? "on" : "") + '" data-act="set" data-k="quizCount" data-v="' + n + '">' + n + "</button>").join("") + "</div>" +
      "<h2>Question types</h2>" +
      '<div class="types">' +
      QTYPES.map((q) => '<button class="chip ' + (settings.quizTypes[q[0]] ? "on" : "") + '" data-act="qtype" data-v="' + q[0] + '">' + esc(q[1]) + ' <span class="ex">' + esc(q[3]) + "</span></button>").join("") +
      "</div>" +
      '<p class="muted" style="font-size:13px;margin:12px 2px 16px">Only uses your own kanji and words. Questions lean toward the ones you get wrong and the ones due for review.</p>' +
      '<button class="btn primary block" data-act="quiz-start">' + I.quiz + " Start quiz</button>";
  }
  function renderQuizResult() {
    const v = view(false);
    const total = qz.ans.filter(Boolean).length;
    const right = qz.ans.filter((a) => a && a.ok).length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    const missed = uniq(qz.ans.filter((a) => a && !a.ok).map((a) => a.id)).filter((id) => D.byId[id]);
    const seal = pct >= 90 ? "優" : pct >= 75 ? "良" : pct >= 50 ? "可" : "もう少し";
    const word = pct >= 90 ? "Excellent" : pct >= 75 ? "Good" : pct >= 50 ? "Pass" : "Almost there";
    v.innerHTML =
      '<div class="result"><div class="grade-seal ' + (seal.length > 1 ? "long" : "") + '">' + seal + "</div>" +
      "<h3>" + word + " · " + right + " / " + total + "</h3>" +
      "<p>" + pct + "% right" + (qz.best >= 3 ? " · best run " + qz.best + " in a row" : "") + "</p>" +
      (missed.length ? '<h2 style="text-align:center">Missed</h2>' + itemChips(missed) : "") +
      '<div class="actions">' +
      (missed.length ? '<button class="btn primary block" data-act="quiz-list" data-ids="' + esc(missed.join("\n")) + '">' + I.quiz + " Retry the " + missed.length + " missed</button>" : "") +
      (missed.length ? '<button class="btn block" data-act="cards-list" data-ids="' + esc(missed.join("\n")) + '">' + I.cards + " Study them with cards</button>" : "") +
      '<button class="btn block" data-act="quiz-new">New quiz</button></div></div>';
  }

  // ---------- deck ----------
  let deckTab = "k";
  let deckQuery = "";
  function itemMatches(it, q) {
    if (!q) return true;
    const ql = q.toLowerCase().trim();
    if (!ql) return true;
    const hay = [label(it)].concat(it.meanings, it.tags).join(" ").toLowerCase();
    if (hay.indexOf(ql) !== -1) return true;
    const qk = normReading(romaToKana(ql, true));
    if (!qk || hasLatin(qk)) return false;
    const rs = (it.type === "k" ? it.on.concat(it.kun) : it.readings).map(normReading);
    return rs.some((r) => r.indexOf(qk) !== -1);
  }
  function renderDeck() {
    const v = view(false);
    if (!D.items.length) {
      v.innerHTML = emptyDeckHtml();
      return;
    }
    v.innerHTML =
      '<div class="deck-tools"><label class="search">' + I.search +
      '<input type="search" id="deckSearch" placeholder="Search: 日, nichi, sun…" value="' + esc(deckQuery) + '" autocomplete="off" autocapitalize="none" spellcheck="false"></label>' +
      '<div class="seg"><button class="' + (deckTab === "k" ? "on" : "") + '" data-act="deck-tab" data-v="k">Kanji · ' + D.kanji.length + '</button><button class="' + (deckTab === "w" ? "on" : "") + '" data-act="deck-tab" data-v="w">Words · ' + D.words.length + "</button></div>" +
      (D.tags.length ? '<div class="chips"><button class="chip ' + (!settings.tag ? "on" : "") + '" data-act="tag" data-v="">All lessons</button>' + D.tags.map((t) => '<button class="chip ' + (settings.tag === t ? "on" : "") + '" data-act="tag" data-v="' + esc(t) + '">' + esc(t) + "</button>").join("") + "</div>" : "") +
      '</div><div id="deckList"></div><button class="fab" data-act="add-menu" aria-label="Add kanji or words">' + I.plus + "</button>";
    $("#deckSearch").addEventListener("input", (e) => {
      deckQuery = e.target.value;
      renderDeckList();
    });
    renderDeckList();
  }
  function renderDeckList() {
    const list = (deckTab === "k" ? D.kanji : D.words).filter((it) => (!settings.tag || it.tags.indexOf(settings.tag) !== -1) && itemMatches(it, deckQuery));
    const el = $("#deckList");
    if (!list.length) {
      el.innerHTML = '<p class="muted" style="text-align:center;padding:30px 0">' + (deckQuery ? "No matches." : deckTab === "k" ? "No kanji here yet." : "No words here yet.") + "</p>";
      return;
    }
    if (deckTab === "k") {
      el.innerHTML =
        '<div class="kgrid">' +
        list.map((it) => '<button class="ktile l' + levelOf(it.id) + '" data-act="open" data-id="' + esc(it.id) + '"><span class="jp">' + esc(it.kanji) + "</span><small>" + esc(meaningText(it, 2)) + "</small></button>").join("") +
        "</div>";
    } else {
      el.innerHTML =
        '<div class="wlist">' +
        list
          .map((it) => '<button class="witem" data-act="open" data-id="' + esc(it.id) + '"><span class="jp">' + esc(it.word) + '</span><span class="mid"><b>' + esc(it.readings.join("・")) + "</b><span>" + esc(meaningText(it, 3)) + '</span></span><span class="lvl l' + levelOf(it.id) + '"></span></button>')
          .join("") +
        "</div>";
    }
  }

  function openDetail(id) {
    const it = D.byId[id];
    if (!it) return;
    const p = progress[id];
    const lv = levelOf(id);
    const t = now();
    const acc = p && p.n ? Math.round((p.ok / p.n) * 100) + "%" : "—";
    const dueTxt = !p ? "Not yet" : p.due <= t ? "Now" : "in " + fmtDur(p.due - t);
    let top;
    let more = "";
    if (it.type === "k") {
      top =
        '<div class="detail-top"><div class="paper"><span class="glyph">' + esc(it.kanji) + '</span></div><div class="meta"><b>' + esc(meaningText(it, 6)) + "</b>" +
        '<span class="lvl l' + lv + '">' + LEVELS[lv] + "</span> " + it.tags.map((x) => '<span class="tag">' + esc(x) + "</span>").join(" ") + "</div></div>";
      more = readingsBlock(it);
      if (it.note) more += '<div class="note">' + esc(it.note) + "</div>";
      const ws = D.wordsByChar[it.kanji] || [];
      if (ws.length) more += '<div class="sub-h">Words with ' + esc(it.kanji) + '</div><div class="words">' + ws.map(wordRow).join("") + "</div>";
    } else {
      top =
        '<div class="detail-top"><div class="meta"><div class="wbig">' + esc(it.word) + '</div><div class="ans-reading" style="text-align:left">' + esc(it.readings.join("・")) + "</div><b>" + esc(meaningText(it, 6)) + "</b>" +
        '<span class="lvl l' + lv + '">' + LEVELS[lv] + "</span> " + it.tags.map((x) => '<span class="tag">' + esc(x) + "</span>").join(" ") + "</div></div>";
      if (it.note) more += '<div class="note">' + esc(it.note) + "</div>";
      const ks = uniq(kanjiChars(it.word));
      if (ks.length) more += '<div class="sub-h">Kanji in this word</div><div class="parts" style="justify-content:flex-start">' + ks.map(partChip).join("") + "</div>";
    }
    const related = it.type === "k" ? [it.id].concat((D.wordsByChar[it.kanji] || []).map((w) => w.id)) : [it.id].concat(uniq(kanjiChars(it.word)).map((c) => D.byChar[c] && D.byChar[c].id).filter(Boolean));
    openSheet(
      '<div class="sheet-head"><h3>' + (it.type === "k" ? "Kanji" : "Word") + '</h3><button class="icon-btn ghost" data-act="speak" data-id="' + esc(id) + '" aria-label="Play the reading">' + I.speak + '</button><button class="icon-btn ghost" data-close aria-label="Close">' + I.close + "</button></div>" +
      top + more +
      '<div class="stats"><div><b>' + ((p && p.n) || 0) + "</b><span>times seen</span></div><div><b>" + acc + "</b><span>right</span></div><div><b>" + dueTxt + "</b><span>next review</span></div></div>" +
      '<div class="sheet-actions">' +
      '<button class="btn primary" data-act="cards-list" data-ids="' + esc(related.join("\n")) + '">' + I.cards + " Study" + (related.length > 1 ? " +" + (related.length - 1) : "") + "</button>" +
      '<button class="btn" data-act="edit" data-id="' + esc(id) + '">' + I.edit + " Edit</button></div>"
    );
  }

  function openAddMenu() {
    openSheet(
      '<div class="sheet-head"><h3>Add to your deck</h3><button class="icon-btn ghost" data-close aria-label="Close">' + I.close + "</button></div>" +
      '<div class="tiles" style="grid-template-columns:1fr">' +
      '<button class="tile" data-act="add" data-kind="paste">' + I.paste + "<b>Paste a list</b><span>Many kanji and words at once, from notes or a chat</span></button>" +
      '<button class="tile" data-act="add" data-kind="k"><span class="jp" style="font-size:22px;color:var(--accent)">漢</span><b>One kanji</b><span>Meaning, on’yomi, kun’yomi</span></button>' +
      '<button class="tile" data-act="add" data-kind="w"><span class="jp" style="font-size:22px;color:var(--accent)">語</span><b>One word</b><span>Word, reading, meaning</span></button>' +
      "</div>"
    );
  }
  const field = (name, lab, val, extra) =>
    '<div class="field"><label for="f_' + name + '">' + lab + "</label>" + '<input id="f_' + name + '" name="' + name + '" value="' + esc(val || "") + '" ' + (extra || "") + ">" + "</div>";
  function openEditor(kind, id) {
    const it = id ? D.byId[id] : null;
    if (it) kind = it.type;
    const k = kind === "k";
    const val = (f, j) => (it ? (Array.isArray(it[f]) ? it[f].join(j || ", ") : it[f]) : "");
    const lastTag = settings.tag;
    openSheet(
      '<div class="sheet-head"><h3>' + (it ? "Edit " : "Add ") + (k ? "kanji" : "word") + '</h3><button class="icon-btn ghost" data-close aria-label="Close">' + I.close + "</button></div>" +
      '<form id="editForm" autocomplete="off">' +
      (k
        ? field("kanji", "Kanji", val("kanji"), 'class="jp-in" maxlength="2" lang="ja" placeholder="日" required') +
          field("meanings", "Meanings", val("meanings"), 'placeholder="sun, day"') +
          field("on", "On’yomi 音 (katakana or romaji)", val("on", "、"), 'lang="ja" placeholder="ニチ、ジツ  or  nichi, jitsu"') +
          field("kun", "Kun’yomi 訓 (dot before the okurigana: た.べる)", val("kun", "、"), 'lang="ja" placeholder="ひ、か"')
        : field("word", "Word", val("word"), 'class="jp-in" lang="ja" placeholder="日本" required') +
          field("readings", "Reading (kana or romaji)", val("readings", "、"), 'lang="ja" placeholder="にほん  or  nihon"') +
          field("meanings", "Meaning", val("meanings"), 'placeholder="Japan"')) +
      field("tags", "Lesson / tag", it ? val("tags") : lastTag, 'placeholder="Lesson 3" list="tagList"') +
      '<datalist id="tagList">' + D.tags.map((t) => '<option value="' + esc(t) + '">').join("") + "</datalist>" +
      '<div class="field"><label for="f_note">Note or memory trick</label><textarea id="f_note" name="note" placeholder="optional">' + esc(it ? it.note : "") + "</textarea></div>" +
      '<div class="sheet-actions">' + (it ? '<button type="button" class="btn danger" data-act="delete" data-id="' + esc(id) + '">' + I.trash + " Delete</button>" : '<button type="button" class="btn" data-close>Cancel</button>') +
      '<button type="submit" class="btn primary">' + I.check + " Save</button></div></form>",
      (sh) => {
        const f = $("#editForm", sh);
        f.addEventListener("submit", (e) => {
          e.preventDefault();
          const data = {};
          new FormData(f).forEach((x, key) => (data[key] = String(x)));
          const n = k ? normKanji(data) : normWord(data);
          if (!n) {
            toast(k ? "Type one kanji character" : "Type the word in Japanese");
            return;
          }
          if (!it && D.byId[n.id] && !confirm(label(n) + " is already in your deck. Replace it?")) return;
          saveItem(n, it ? it.id : null);
          closeSheet();
          toast(esc(label(n)) + " saved");
        });
        if (!it) setTimeout(() => $("input", f).focus(), 60);
      }
    );
  }
  const strip = (n) =>
    n.type === "k"
      ? { id: n.id, type: "k", kanji: n.kanji, meanings: n.meanings, on: n.on, kun: n.kun, tags: n.tags, note: n.note }
      : { id: n.id, type: "w", word: n.word, readings: n.readings, meanings: n.meanings, tags: n.tags, note: n.note };
  function saveItem(n, oldId) {
    if (oldId && oldId !== n.id) {
      removeItem(oldId);
      if (progress[oldId] && !progress[n.id]) {
        progress[n.id] = progress[oldId];
        delete progress[oldId];
        saveProgress();
      }
    }
    custom.items[n.id] = strip(n);
    delete custom.removed[n.id];
    persist("custom", custom);
    rebuild();
    render();
  }
  function removeItem(id) {
    delete custom.items[id];
    if (D.baseIds.has(id)) custom.removed[id] = true;
    persist("custom", custom);
  }

  function openImport() {
    openSheet(
      '<div class="sheet-head"><h3>Paste a list</h3><button class="icon-btn ghost" data-close aria-label="Close">' + I.close + "</button></div>" +
      '<p class="muted" style="margin:0 0 8px;font-size:13px">One per line. Separate parts with | or a tab or " - ".</p>' +
      '<pre class="fmt"># Lesson 5          ← lines below get this lesson\n日 | sun, day | ニチ ジツ | ひ か\n日本 | にほん | Japan\n毎日 (まいにち) every day\n月 火 水           ← just the kanji</pre>' +
      '<div class="field"><textarea class="paste" id="pasteIn" lang="ja" placeholder="Paste here…" spellcheck="false"></textarea></div>' +
      '<div class="preview" id="pastePrev">Nothing yet.</div>' +
      '<button class="btn primary block" id="pasteGo" disabled>' + I.plus + " Add to deck</button>",
      (sh) => {
        const ta = $("#pasteIn", sh);
        const prev = $("#pastePrev", sh);
        const goBtn = $("#pasteGo", sh);
        let parsed = { items: [], bad: [] };
        const update = () => {
          parsed = parseText(ta.value);
          const k = parsed.items.filter((x) => x.type === "k").length;
          const w = parsed.items.length - k;
          const existing = parsed.items.filter((x) => D.byId[x.id]).length;
          let h = parsed.items.length ? "Found <b>" + k + " kanji</b> and <b>" + w + " words</b>." : "Nothing recognised yet.";
          if (existing) h += " " + existing + " already in your deck will be updated.";
          if (parsed.bad.length) h += '<div class="bad" style="margin-top:6px">Skipped ' + parsed.bad.length + ": " + parsed.bad.slice(0, 4).map(esc).join(" · ") + (parsed.bad.length > 4 ? " …" : "") + "</div>";
          const sample = parsed.items.slice(0, 6).map((x) => esc(label(x)) + " " + esc(x.type === "k" ? meaningText(x, 2) : (x.readings[0] || "") + " " + meaningText(x, 1))).join(" · ");
          if (sample) h += '<div style="margin-top:6px">' + sample + (parsed.items.length > 6 ? " …" : "") + "</div>";
          prev.innerHTML = h;
          goBtn.disabled = !parsed.items.length;
        };
        ta.addEventListener("input", update);
        goBtn.addEventListener("click", () => {
          let added = 0;
          parsed.items.forEach((n) => {
            const cur = D.byId[n.id];
            const merged = cur ? Object.assign(strip(cur), Object.fromEntries(Object.entries(strip(n)).filter((e) => (Array.isArray(e[1]) ? e[1].length : e[1])))) : strip(n);
            if (!cur) added++;
            custom.items[n.id] = merged;
            delete custom.removed[n.id];
          });
          persist("custom", custom);
          rebuild();
          closeSheet();
          toast("Added " + added + ", updated " + (parsed.items.length - added));
          render();
        });
        setTimeout(() => ta.focus(), 60);
      }
    );
  }

  // ---------- settings & backup ----------
  function openSettings() {
    const seg = (k, opts) =>
      '<div class="seg">' + opts.map((o) => '<button class="' + (String(settings[k]) === String(o[0]) ? "on" : "") + '" data-act="set" data-k="' + k + '" data-v="' + o[0] + '">' + o[1] + "</button>").join("") + "</div>";
    const sw = (k, lab, sub) =>
      '<div class="set-row"><span class="lbl">' + lab + (sub ? "<small>" + sub + "</small>" : "") + '</span><label class="switch"><input type="checkbox" data-bool="' + k + '" ' + (settings[k] ? "checked" : "") + "><span></span></label></div>";
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    openSheet(
      '<div class="sheet-head"><h3>Settings</h3><button class="icon-btn ghost" data-close aria-label="Close">' + I.close + "</button></div>" +
      '<div class="set-group">' +
      '<div class="set-row col"><span class="lbl">Card front</span>' + seg("direction", [["recog", "Kanji first"], ["recall", "Meaning first"], ["mixed", "Mixed"]]) + "</div>" +
      '<div class="set-row col"><span class="lbl">Cards per session</span>' + seg("sessionSize", [[10, "10"], [20, "20"], [30, "30"], [0, "All"]]) + "</div>" +
      '<div class="set-row col"><span class="lbl">New cards per day</span>' + seg("newPerDay", [[10, "10"], [25, "25"], [50, "50"], [100, "100"], [0, "All"]]) + "</div>" +
      sw("showReadingFront", "Show the reading on word cards", "Kana under the word before you flip") +
      sw("autoSpeak", "Read aloud", "Says the reading when you flip or answer") +
      sw("quizAutoNext", "Quiz: next question after a right answer") +
      "</div>" +
      '<div class="set-group">' +
      '<div class="set-row col"><span class="lbl">Kanji font</span>' + seg("font", [["serif", '<span style="font-family:var(--jp-serif)">明朝 Serif</span>'], ["sans", '<span style="font-family:var(--jp-sans)">ゴシック Sans</span>']]) + "</div>" +
      '<div class="set-row col"><span class="lbl">Theme</span>' + seg("theme", [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]) + "</div>" +
      '<div class="set-row"><span class="lbl">Test the voice</span><button class="btn small" data-act="test-voice">' + I.speak + " にほんご</button></div>" +
      "</div>" +
      '<div class="set-group">' +
      '<div class="set-row col"><span class="lbl">Backup<small>Progress and edits are saved in this browser only. Save a backup to move them to another phone or computer.</small></span>' +
      '<div class="row wrap"><button class="btn small" data-act="export">' + I.download + ' Save backup</button><button class="btn small" data-act="import">' + I.upload + ' Restore</button><button class="btn small" data-act="export-list">' + I.paste + " Copy word list</button></div></div>" +
      '<div class="set-row"><span class="lbl">Reset progress<small>Keeps your kanji and words, clears what you have learned</small></span><button class="btn small danger" data-act="reset">Reset</button></div>' +
      "</div>" +
      (standalone ? "" : '<p class="muted" style="font-size:13px;margin:0 4px">Tip: on iPhone tap Share → <b>Add to Home Screen</b>. It then opens like an app, works with no signal, and keeps your progress safer.</p>') +
      '<input type="file" id="importFile" accept="application/json,.json" hidden>'
    );
  }
  function exportBackup() {
    const data = { app: "kanji-trainer", v: 1, at: new Date().toISOString(), custom, progress, log, settings };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kanji-backup-" + dayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
    toast("Backup saved");
  }
  function importBackup(file) {
    const r = new FileReader();
    r.onload = () => {
      let data;
      try {
        data = JSON.parse(r.result);
      } catch (e) {
        toast("That file is not a backup");
        return;
      }
      if (!data || data.app !== "kanji-trainer") {
        toast("That file is not a kanji backup");
        return;
      }
      if (!confirm("Merge the backup from " + String(data.at || "").slice(0, 10) + " into this device? For each card the newer progress wins.")) return;
      const bp = data.progress || {};
      Object.keys(bp).forEach((id) => {
        if (!progress[id] || (bp[id].last || 0) > (progress[id].last || 0)) progress[id] = bp[id];
      });
      const bl = data.log || {};
      Object.keys(bl).forEach((d) => {
        if (!log[d] || (bl[d].n || 0) > (log[d].n || 0)) log[d] = bl[d];
      });
      const bc = data.custom || {};
      Object.assign(custom.items, bc.items || {});
      Object.assign(custom.removed, bc.removed || {});
      saveProgress();
      persist("custom", custom);
      rebuild();
      closeSheet();
      render();
      toast("Backup restored");
    };
    r.readAsText(file);
  }
  function copyList() {
    const lines = [];
    D.kanji.forEach((k) => lines.push([k.kanji, k.meanings.join(", "), k.on.join(" "), k.kun.join(" ")].join(" | ")));
    D.words.forEach((w) => lines.push([w.word, w.readings.join(" "), w.meanings.join(", ")].join(" | ")));
    const text = lines.join("\n");
    const done = () => toast("Copied " + lines.length + " lines");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast("Could not copy"));
    else toast("Copy is not available here");
  }
  function applyLook() {
    const r = document.documentElement;
    if (settings.theme === "auto") r.removeAttribute("data-theme");
    else r.dataset.theme = settings.theme;
    r.dataset.font = settings.font;
    const dark = settings.theme === "dark" || (settings.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    $('meta[name="theme-color"]').setAttribute("content", dark ? "#141210" : "#f5f1e8");
  }

  // ---------- events ----------
  document.addEventListener(
    "click",
    (e) => {
      if (suppressClick && e.target.closest(".card")) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) {
      closeSheet();
      return;
    }
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const a = el.dataset.act;
    const id = el.dataset.id;
    const ids = () => (el.dataset.ids || "").split("\n").filter(Boolean);
    switch (a) {
      case "start":
        startCards(el.dataset.mode);
        break;
      case "go-quiz":
        go("quiz");
        break;
      case "scope":
        settings.scope = el.dataset.v;
        saveSettings();
        render();
        break;
      case "tag":
        settings.tag = el.dataset.v;
        saveSettings();
        render();
        break;
      case "open":
        if (e.target.closest('[data-act="speak"]')) return;
        openDetail(id);
        break;
      case "speak":
        e.stopPropagation();
        speakItem(id);
        break;
      case "reveal":
        reveal();
        break;
      case "grade":
        swipeOutGrade(+el.dataset.g);
        break;
      case "undo":
        undo();
        break;
      case "end-cards":
        endCards();
        break;
      case "cards-done":
        cs = null;
        saveCs();
        go("home");
        break;
      case "cards-list":
        startCards("list", ids());
        break;
      case "quiz-list":
        startQuiz(ids());
        break;
      case "quiz-start":
        startQuiz();
        break;
      case "quiz-new":
        qz = null;
        saveQz();
        render();
        break;
      case "end-quiz":
        if (qz && qz.ans.filter(Boolean).length) {
          qz.qs = qz.qs.slice(0, qz.ans.length);
          qz.i = qz.qs.length;
        } else qz = null;
        saveQz();
        render();
        break;
      case "opt":
        chooseOpt(+el.dataset.i);
        break;
      case "tile":
        pickTile(+el.dataset.i);
        break;
      case "slot": {
        const s = qz && qz.state;
        if (s && !s.answered && s.picks.length > +el.dataset.i) {
          s.picks.splice(+el.dataset.i, 1);
          saveQz();
          renderQuiz();
        }
        break;
      }
      case "type-skip":
        answerQuiz(false, { skipped: true, typed: "" });
        break;
      case "q-next":
        nextQuestion();
        break;
      case "qtype": {
        const k = el.dataset.v;
        settings.quizTypes[k] = !settings.quizTypes[k];
        if (!QTYPES.some((q) => settings.quizTypes[q[0]])) settings.quizTypes[k] = true;
        saveSettings();
        render();
        break;
      }
      case "set": {
        const k = el.dataset.k;
        const raw = el.dataset.v;
        settings[k] = /^\d+$/.test(raw) ? +raw : raw;
        saveSettings();
        applyLook();
        if (sheetOpen()) $$('[data-act="set"][data-k="' + k + '"]').forEach((b) => b.classList.toggle("on", b.dataset.v === raw));
        if (cs && k === "direction") cs.dirs = {};
        render();
        break;
      }
      case "deck-tab":
        deckTab = el.dataset.v;
        render();
        break;
      case "add-menu":
        openAddMenu();
        break;
      case "add":
        if (el.dataset.kind === "paste") openImport();
        else openEditor(el.dataset.kind);
        break;
      case "edit":
        openEditor(null, id);
        break;
      case "delete": {
        const it = D.byId[id];
        if (it && confirm("Delete " + label(it) + " from your deck?")) {
          removeItem(id);
          rebuild();
          closeSheet();
          render();
          toast(esc(label(it)) + " deleted");
        }
        break;
      }
      case "test-voice":
        speakText("にほんご");
        if (!jaVoices.length) setTimeout(() => !jaVoices.length && toast("No Japanese voice found on this device"), 600);
        break;
      case "export":
        exportBackup();
        break;
      case "import":
        $("#importFile").click();
        break;
      case "export-list":
        copyList();
        break;
      case "reset":
        if (confirm("Clear all progress on this device? Your kanji and words stay.")) {
          progress = {};
          log = {};
          cs = null;
          qz = null;
          saveProgress();
          saveCs();
          saveQz();
          closeSheet();
          render();
          toast("Progress cleared");
        }
        break;
      default:
        break;
    }
  });
  function swipeOutGrade(g) {
    if (!cs) return;
    if (g === 1) {
      commit(1);
      return;
    }
    swipeOut(g > 0 ? 1 : -1);
  }
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.bool) {
      settings[t.dataset.bool] = t.checked;
      saveSettings();
      render();
    } else if (t.id === "importFile" && t.files && t.files[0]) importBackup(t.files[0]);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetOpen()) {
      closeSheet();
      return;
    }
    const tgt = e.target;
    if ((tgt && tgt.matches && tgt.matches("input, textarea, select")) || sheetOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (tab === "cards" && cs && cs.i < cs.queue.length) {
      const key = e.key.toLowerCase();
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (cs.forced === 0) commit(0);
        else if (!cs.revealed) reveal();
        else swipeOut(1);
      } else if (e.key === "ArrowRight") swipeOut(1);
      else if (e.key === "ArrowLeft") swipeOut(-1);
      else if (e.key === "ArrowDown" && cs.revealed && cs.forced == null) {
        e.preventDefault();
        commit(1);
      } else if (key === "z" || e.key === "Backspace") undo();
      else if (key === "s") speakItem(cs.queue[cs.i]);
    } else if (tab === "quiz" && qz && qz.i < qz.qs.length) {
      const s = qz.state || {};
      if (s.answered && (e.key === "Enter" || e.key === " " || e.key === "ArrowRight")) {
        e.preventDefault();
        nextQuestion();
      } else if (!s.answered && /^[1-9]$/.test(e.key)) {
        const q = qz.qs[qz.i];
        if (q.options) chooseOpt(+e.key - 1);
        else if (q.layout === "build") pickTile(+e.key - 1);
      }
    }
  });
  window.addEventListener("hashchange", route);
  $("#btnSettings").addEventListener("click", openSettings);
  const netState = () => ($("#net").hidden = navigator.onLine !== false);
  window.addEventListener("online", netState);
  window.addEventListener("offline", netState);
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLook);
  } catch (e) {
    /* old Safari */
  }

  // ---------- start ----------
  async function loadDeck() {
    try {
      const r = await fetch("deck.json", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (JSON.stringify(j) !== JSON.stringify(baseRaw)) {
        baseRaw = j;
        persist("base", j);
        rebuild();
        if (!sheetOpen() && !(document.activeElement && document.activeElement.matches("input, textarea"))) render();
      }
    } catch (e) {
      /* offline: keep the copy saved last time */
    }
  }
  applyLook();
  rebuild();
  netState();
  route();
  loadDeck();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Small hook for checks in the browser console.
  window.__kanji = { parseText, romaToKana, makeQuiz: (n) => makeQuiz(n || 20), deck: () => D, schedule };
})();
