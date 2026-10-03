// Safety by scan (the owner's brief §1, §9; docs/LISTING-BRAIN-PLAN.md §7): the listing brain's SOURCE is
// read and checked for everything the brain must never do — write anything but its own two log models,
// call a marketplace, load a connector outside the loader's realDeps(), read the database unbounded or
// unprojected, read a clock or randomness inside the pure model, start a timer on require, or use syntax
// newer than production's Node 20.
//
// Comments are stripped before scanning (a comment may name what the code must not do). Each detector is
// first run against hand-written bad snippets, so a scan that passes is a scan that would have caught it.
//
// Run: CRED_SECRET=x node --test tests/listingBrainSafety.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BRAIN = path.join(ROOT, "utils", "listingBrain");
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
}

// Every file the scan covers: the brain, its routes, its export script.
const BRAIN_FILES = walk(BRAIN);
const FILES = BRAIN_FILES.concat([path.join(ROOT, "routes", "listingBrainRoutes.js"), path.join(ROOT, "scripts", "listing-brain-export.js")]);
// The pure model: model.js and model/*.js.
const PURE_FILES = BRAIN_FILES.filter((f) => f === path.join(BRAIN, "model.js") || path.dirname(f) === path.join(BRAIN, "model"));
// Production syntax (Node 20): what deploys under utils/, models/, routes/.
const MODELS = fs
  .readdirSync(path.join(ROOT, "models"))
  .filter((f) => /^ListingBrain.*\.js$/.test(f))
  .map((f) => path.join(ROOT, "models", f));
const NODE20_FILES = BRAIN_FILES.concat(MODELS, [path.join(ROOT, "routes", "listingBrainRoutes.js")]);

/* ------------------------------------------------------------------------------------------------------ */
/* the scanner                                                                                            */
/* ------------------------------------------------------------------------------------------------------ */

/**
 * The source with every comment replaced by spaces (newlines kept, so offsets and line numbers hold).
 * Strings, template literals and regular-expression literals are kept as they are.
 */
function stripComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = ""; // last significant character outside comments, to tell a regex from a division
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\breturn\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else {
          if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          j++;
        }
      }
      i = j + 1;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/** The index of the bracket matching the one at `open` (strings skipped), or -1. */
function matchBracket(src, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Top-level comma-separated arguments of the call whose "(" is at `open`. */
function argsOf(src, open) {
  const end = matchBracket(src, open);
  const body = src.slice(open + 1, end);
  const args = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === "\\" ? 2 : 1;
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end };
}

/** The methods chained after the call that closes at `end`: `.sort(…).limit(…).lean()` → [sort, limit, lean]. */
function chainAfter(src, end) {
  const names = [];
  let i = end + 1;
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i, i + 200));
    if (!m) break;
    names.push(m[1]);
    const open = i + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) break;
    i = close + 1;
  }
  return names;
}

/** What the call at `dot` (the "." of `.find(`) is made on: "Run()", "MarketplaceListing", "rows", … */
function receiverOf(src, dot) {
  let j = dot - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (src[j] === ")") {
    let depth = 0;
    let k = j;
    for (; k >= 0; k--) {
      if (src[k] === ")") depth++;
      else if (src[k] === "(" && --depth === 0) break;
    }
    const m = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(0, k));
    return m ? m[1] + "()" : "()";
  }
  const m = /([A-Za-z_$][\w$]*)$/.exec(src.slice(0, j + 1));
  return m ? m[1] : "";
}

const CONNECTOR = (spec) => {
  const base = String(spec).split("/").pop().replace(/\.js$/, "");
  return ["marketplaces", "unclaimedAutoList", "unclaimedListingAudit", "autoLister", "g2gGames", "eldoradoFarmService"].includes(base) || /Fulfiller$/.test(base);
};
// Modules that open a connection or a process; the brain makes no network call and opens no SSH.
const NETWORK = new Set(["http", "https", "net", "tls", "dgram", "child_process", "axios", "node-fetch", "got", "undici", "ssh2", "node-ssh"]);

function requiresOf(src) {
  const out = [];
  for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = /^(["'`])([^"'`]+)\1$/.exec(m[1]);
    out.push({ idx: m.index, spec: lit ? lit[2] : null, raw: m[1] });
  }
  return out;
}

/** The body of `function name(` (between its braces), as [start, end] offsets, or null. */
function functionBody(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return null;
  const paren = src.indexOf("(", m.index);
  const after = matchBracket(src, paren);
  const open = src.indexOf("{", after);
  const close = matchBracket(src, open);
  return open >= 0 && close > open ? [open, close] : null;
}

/** Connector requires outside inputs.realDeps(), dynamic requires, network modules. */
function scanConnectors(file, src) {
  const bad = [];
  const isInputs = rel(file) === "utils/listingBrain/inputs.js";
  const body = isInputs ? functionBody(src, "realDeps") : null;
  for (const r of requiresOf(src)) {
    if (r.spec === null) {
      bad.push({ file: rel(file), line: lineOf(src, r.idx), what: "a require that cannot be audited: require(" + r.raw + ")" });
      continue;
    }
    if (NETWORK.has(r.spec)) bad.push({ file: rel(file), line: lineOf(src, r.idx), what: "requires " + r.spec });
    if (!CONNECTOR(r.spec)) continue;
    const inside = body && r.idx > body[0] && r.idx < body[1];
    if (!inside) bad.push({ file: rel(file), line: lineOf(src, r.idx), what: "connector " + r.spec + " outside realDeps()" });
  }
  return bad;
}

/** Database manners: no allowDiskUse, no skip, never `new: true`. */
function scanManners(file, src) {
  const bad = [];
  for (const [re, what] of [
    [/\ballowDiskUse\b/g, "allowDiskUse"],
    [/\.\s*skip\s*\(/g, ".skip("],
    [/\bnew\s*:\s*true\b/g, "new: true"],
  ])
    for (const m of src.matchAll(re)) bad.push({ file: rel(file), line: lineOf(src, m.index), what });
  return bad;
}

/** Any write but the runner's own two inserts (hooks.Run().create, hooks.Row().insertMany in index.js). */
function scanWrites(file, src) {
  const bad = [];
  const isRunner = rel(file) === "utils/listingBrain/index.js";
  const add = (idx, what) => bad.push({ file: rel(file), line: lineOf(src, idx), what });
  for (const m of src.matchAll(/\.\s*(save|remove)\s*\(/g)) add(m.index, "." + m[1] + "(");
  for (const m of src.matchAll(/\.\s*create\s*\(/g)) if (!(isRunner && receiverOf(src, m.index) === "Run()")) add(m.index, receiverOf(src, m.index) + ".create(");
  for (const m of src.matchAll(/\binsertMany\s*\(/g)) {
    const dot = src.lastIndexOf(".", m.index);
    if (!(isRunner && receiverOf(src, dot) === "Row()")) add(m.index, "insertMany(");
  }
  for (const m of src.matchAll(/\b(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|findOneAndDelete|findByIdAndDelete|findByIdAndRemove|replaceOne|deleteOne|deleteMany|bulkWrite|insertOne|insert)\s*\(/g)) add(m.index, m[1] + "(");
  for (const m of src.matchAll(/\b(saveSettings|setAutoFarm|setSettings|setUnclaimedPricing|setBulkPacks)\b/g)) add(m.index, m[1]);
  for (const m of src.matchAll(/\baxios\b/g)) add(m.index, "axios");
  for (const m of src.matchAll(/\bhttps?\s*\.\s*(request|get)\b/g)) add(m.index, "http." + m[1]);
  for (const m of src.matchAll(/(^|[^.\w$])fetch\s*\(/g)) add(m.index, "fetch(");
  return bad;
}

const PURE_OK = new Set(["priceTracker/stats", "priceTracker/venues", "priceTracker/analyze", "priceTracker/setIdentity", "farmSizing", "marketPricing"]);

/** The pure model: only pure helpers, no clock, no randomness, no environment, no timer. */
function scanPure(file, src) {
  const bad = [];
  const add = (idx, what) => bad.push({ file: rel(file), line: lineOf(src, idx), what });
  const modelDir = path.join(BRAIN, "model");
  for (const r of requiresOf(src)) {
    if (r.spec === null) {
      add(r.idx, "dynamic require");
      continue;
    }
    // the pure model itself (model.js, model/*.js) — never ./inputs or ./index, which do I/O
    const to = path.resolve(path.dirname(file), r.spec).replace(/\.js$/, "");
    if (r.spec.startsWith(".") && (to === modelDir || to.startsWith(modelDir + path.sep))) continue;
    if (r.spec.startsWith("./")) {
      add(r.idx, "requires " + r.spec);
      continue;
    }
    const m = /^(?:\.\.\/){1,2}(.+)$/.exec(r.spec);
    if (!m || !PURE_OK.has(m[1].replace(/\.js$/, ""))) add(r.idx, "requires " + r.spec);
  }
  for (const [re, what] of [
    [/\bDate\s*\.\s*now\s*\(/g, "Date.now("],
    [/\bnew\s+Date\s*\(\s*\)/g, "new Date()"],
    [/\bMath\s*\.\s*random\s*\(/g, "Math.random("],
    [/\bprocess\s*\.\s*env\b/g, "process.env"],
    [/\bprocess\s*\.\s*hrtime\b/g, "process.hrtime"],
    [/\bperformance\s*\.\s*now\b/g, "performance.now"],
    [/\bsetTimeout\b/g, "setTimeout"],
    [/\bsetInterval\b/g, "setInterval"],
  ])
    for (const m of src.matchAll(re)) add(m.index, what);
  for (const m of src.matchAll(/\bsetImmediate\b/g)) {
    const line = src.split("\n")[lineOf(src, m.index) - 1];
    if (!(path.basename(file) === "util.js" && /\bconst\s+yieldNow\s*=/.test(line))) add(m.index, "setImmediate outside util.yieldNow");
  }
  return bad;
}

/** Every database read: projected, and limited in the same chain (findOne excepted); $group bounded. */
function scanReads(file, src) {
  const bad = [];
  const reads = [];
  const add = (idx, what) => bad.push({ file: rel(file), line: lineOf(src, idx), what });
  for (const m of src.matchAll(/\.\s*(find|findOne|aggregate|distinct|countDocuments)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const recv = receiverOf(src, m.index);
    const { args, end } = argsOf(src, open);
    const first = args[0] || "";
    const db = /^[{[]/.test(first) || /^[A-Z]/.test(recv) || recv === "Run()" || recv === "Row()";
    if (!db) continue;
    const chain = chainAfter(src, end);
    reads.push({ method: m[1], recv, chain });
    if (m[1] === "distinct" || m[1] === "countDocuments") {
      add(m.index, recv + "." + m[1] + "( is an unbounded read");
      continue;
    }
    if (m[1] === "aggregate") {
      const pipe = first;
      if (!/\$limit/.test(pipe) && !chain.includes("limit")) add(m.index, recv + ".aggregate( without $limit");
      continue;
    }
    const proj = (args[1] || "").replace(/\s+/g, "");
    if (!proj || proj === "{}" || proj === "null" || proj === "undefined") add(m.index, recv + "." + m[1] + "( without a projection");
    if (m[1] === "find" && !chain.includes("limit")) add(m.index, recv + ".find( without .limit( in its chain");
  }
  for (const m of src.matchAll(/\$group\b/g)) {
    // the pipeline array around it: a $limit must follow the $group inside it
    let depth = 0;
    let k = m.index;
    for (; k >= 0; k--) {
      if (src[k] === "]") depth++;
      else if (src[k] === "[" && depth-- === 0) break;
    }
    const close = k >= 0 ? matchBracket(src, k) : -1;
    if (close < 0 || !/\$limit/.test(src.slice(m.index, close))) add(m.index, "$group without a following $limit");
  }
  return { bad, reads };
}

/** Syntax or built-ins newer than Node 20. */
function scanNode20(file, src) {
  const bad = [];
  for (const [re, what] of [
    [/\bObject\s*\.\s*groupBy\b/g, "Object.groupBy (Node 21)"],
    [/\bMap\s*\.\s*groupBy\b/g, "Map.groupBy (Node 21)"],
    [/\.\s*(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/g, "Set methods (Node 22)"],
    [/\bArray\s*\.\s*fromAsync\b/g, "Array.fromAsync (Node 22)"],
    [/\bPromise\s*\.\s*withResolvers\b/g, "Promise.withResolvers (Node 22)"],
    [/(^|[;{}(\s])(?:await\s+)?using\s+[A-Za-z_$][\w$]*\s*=/gm, "a `using` declaration"],
    [/\.\s*(?:keys|values|entries)\s*\(\s*\)\s*\.\s*(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\s*\(/g, "iterator helpers (Node 22)"],
  ])
    for (const m of src.matchAll(re)) bad.push({ file: rel(file), line: lineOf(src, m.index), what });
  return bad;
}

const read = (f) => stripComments(fs.readFileSync(f, "utf8"));
const report = (bad) => bad.map((b) => b.file + ":" + b.line + " " + b.what).join("\n");

/* ------------------------------------------------------------------------------------------------------ */
/* the scanner, checked first: every detector fires on what it must catch, and not on a comment           */
/* ------------------------------------------------------------------------------------------------------ */

test("the scanner catches every forbidden pattern and ignores comments", () => {
  const F = (name) => path.join(BRAIN, name);
  const strip = stripComments;
  assert.equal(strip('a // x.save()\nb /* .skip( */ c "// kept" /re\\/g/.test(s) // y').includes("save"), false);
  assert.ok(strip('const s = "// kept";').includes("// kept"), "a string is not a comment");
  assert.ok(strip("const r = /a\\/\\/b/;").includes("/a\\/\\/b/"), "a regex is not a comment");
  // manners
  assert.equal(scanManners(F("x.js"), strip("q.aggregate(p, { allowDiskUse: true }); X.find({}).skip(5); X.findOneAndUpdate({}, {}, { new: true });")).length, 3);
  assert.equal(scanManners(F("x.js"), strip("// allowDiskUse .skip( new: true")).length, 0);
  // connectors
  const inputs = F("inputs.js");
  assert.equal(scanConnectors(inputs, strip('function realDeps() { const a = require("../autoLister"); return { a }; }')).length, 0, "inside realDeps is allowed");
  assert.equal(scanConnectors(inputs, strip('const a = require("../autoLister");\nfunction realDeps() { return {}; }')).length, 1);
  assert.equal(scanConnectors(F("index.js"), strip('function realDeps() { require("../marketplaces"); }')).length, 1, "realDeps exists only in the loader");
  for (const spec of ["../ggselFulfiller", "../../utils/unclaimedAutoList", "../unclaimedListingAudit", "../g2gGames", "../eldoradoFarmService", "./marketplaces.js"])
    assert.equal(scanConnectors(F("model.js"), strip('require("' + spec + '")')).length, 1, spec);
  assert.equal(scanConnectors(F("model.js"), strip("require(name)")).length, 1, "a dynamic require cannot be audited");
  assert.equal(scanConnectors(F("model.js"), strip('require("child_process")')).length, 1);
  // writes
  const runner = F("index.js");
  assert.equal(scanWrites(runner, strip("await hooks.Run().create(doc); await hooks.Row().insertMany(rows);")).length, 0, "the runner's own two inserts");
  assert.equal(scanWrites(F("inputs.js"), strip("await hooks.Run().create(doc);")).length, 1, "only in the runner");
  assert.equal(scanWrites(runner, strip("await Listing.create(x); await hooks.Run().insertMany(r);")).length, 2);
  const writes = "x.save(); M.updateOne({}, {}); M.updateMany(); M.findOneAndUpdate(); M.findByIdAndUpdate(); M.replaceOne(); M.deleteOne(); M.deleteMany(); M.bulkWrite([]); x.remove(); settings.saveSettings(s); settings.setAutoFarm(a); axios.get(u); http.request(o); fetch(u);";
  assert.equal(scanWrites(F("x.js"), strip(writes)).length, 15);
  assert.equal(scanWrites(F("x.js"), strip("// x.save() fetch(u)\nconst prefetch = 1; refetch(1);")).length, 0);
  // pure
  const pure = F("model/x.js");
  assert.equal(scanPure(pure, strip('require("./util"); require("../../priceTracker/venues"); require("../../farmSizing");')).length, 0);
  assert.equal(scanPure(F("model.js"), strip('require("./model/util"); require("../priceTracker/setIdentity");')).length, 0);
  for (const s of ['require("../inputs")', 'require("../../settings")', 'require("../../../models/X")', 'require("fs")', 'require("../../priceTracker")', "Date.now()", "new Date()", "Math.random()", "process.env.X", "setTimeout(f, 1)", "setInterval(f, 1)", "setImmediate(f)", "process.hrtime()"])
    assert.equal(scanPure(pure, strip(s)).length, 1, s);
  assert.equal(scanPure(F("model.js"), strip('require("./inputs")')).length, 1, "the loader is not part of the pure model");
  assert.equal(scanPure(pure, strip('require("../inputs")')).length, 1);
  assert.equal(scanPure(pure, strip('require("../model")')).length, 0, "the model's own façade is pure");
  assert.equal(scanPure(pure, strip("const d = new Date(t);")).length, 0);
  assert.equal(scanPure(F("model/util.js"), strip("const yieldNow = () => new Promise((r) => setImmediate(r));")).length, 0);
  // reads
  const ok = 'await d.M.find({ a: 1 }, { ...P }).sort({ _id: -1 }).limit(5).lean(); await hooks.Run().findOne({}, { fc: 0 }).lean(); rows.find((r) => r.a); args.find(same);';
  assert.deepEqual(scanReads(F("inputs.js"), strip(ok)).bad, []);
  assert.equal(scanReads(F("inputs.js"), strip(ok)).reads.length, 2, "array finds are not reads");
  const badReads = "await d.M.find({ a: 1 }, { b: 1 }).lean(); await d.M.find({ a: 1 }).limit(3); await hooks.Row().find(q, {}).limit(1); await hooks.Run().findOne({ a: 1 }); M.aggregate([{ $match: {} }]); M.distinct(\"a\");";
  assert.equal(scanReads(F("inputs.js"), strip(badReads)).bad.length, 6, report(scanReads(F("inputs.js"), strip(badReads)).bad));
  assert.equal(scanReads(F("x.js"), strip("M.aggregate([{ $group: { _id: 1 } }, { $limit: 5 }]);")).bad.length, 0);
  assert.equal(scanReads(F("x.js"), strip("M.aggregate([{ $limit: 5 }, { $group: { _id: 1 } }]);")).bad.length, 1, "a $limit before the $group bounds nothing");
  // Node 20
  for (const s of ["Object.groupBy(a, f)", "Map.groupBy(a, f)", "a.union(b)", "a.intersection(b)", "Array.fromAsync(it)", "Promise.withResolvers()", "{ using res = open(); }", "await using h = x;", "m.values().map((x) => x)"])
    assert.equal(scanNode20(F("x.js"), strip(s)).length, 1, s);
  assert.equal(scanNode20(F("x.js"), strip("a.toSorted(); [...m.values()].map(f); const usingX = 1; a.findLast(f);")).length, 0);
});

/* ------------------------------------------------------------------------------------------------------ */
/* the scan                                                                                               */
/* ------------------------------------------------------------------------------------------------------ */

test("the scan covers the whole brain: its files, its routes, its export script", () => {
  const names = FILES.map(rel);
  for (const f of ["utils/listingBrain/index.js", "utils/listingBrain/inputs.js", "utils/listingBrain/model.js", "utils/listingBrain/model/util.js", "utils/listingBrain/model/evidence.js", "utils/listingBrain/model/ref.js", "utils/listingBrain/model/hazard.js", "utils/listingBrain/model/price.js", "utils/listingBrain/model/place.js", "routes/listingBrainRoutes.js", "scripts/listing-brain-export.js"])
    assert.ok(names.includes(f), f);
  assert.ok(PURE_FILES.length >= 7, PURE_FILES.map(rel).join(", "));
  assert.ok(MODELS.length === 2, MODELS.map(rel).join(", "));
  // realDeps is found, and holds the connectors it is allowed to hold
  const src = read(path.join(BRAIN, "inputs.js"));
  const body = functionBody(src, "realDeps");
  assert.ok(body, "inputs.realDeps() is where the connectors load");
  const inside = requiresOf(src).filter((r) => r.idx > body[0] && r.idx < body[1]).map((r) => r.spec);
  assert.ok(inside.includes("../autoLister") && inside.includes("../settings"), inside.join(", "));
});

test("no allowDiskUse, no .skip(, no new: true anywhere", () => {
  const bad = FILES.flatMap((f) => scanManners(f, read(f)));
  assert.deepEqual(bad, [], report(bad));
});

test("no marketplace connector is required outside the body of inputs.realDeps()", () => {
  const bad = FILES.flatMap((f) => scanConnectors(f, read(f)));
  assert.deepEqual(bad, [], report(bad));
});

test("no write call anywhere but the runner's own two log inserts", () => {
  const bad = FILES.flatMap((f) => scanWrites(f, read(f)));
  assert.deepEqual(bad, [], report(bad));
  // and those two are there, writing only the brain's own log models
  const runner = read(path.join(BRAIN, "index.js"));
  assert.ok(/hooks\s*\.\s*Run\s*\(\s*\)\s*\.\s*create\s*\(/.test(runner));
  assert.ok(/hooks\s*\.\s*Row\s*\(\s*\)\s*\.\s*insertMany\s*\(/.test(runner));
  assert.match(runner, /Run:\s*\(\)\s*=>\s*require\("\.\.\/\.\.\/models\/ListingBrainRun"\)/);
  assert.match(runner, /Row:\s*\(\)\s*=>\s*require\("\.\.\/\.\.\/models\/ListingBrainRow"\)/);
});

test("the pure model files require only pure helpers and read no clock, randomness, environment or timer", () => {
  const bad = PURE_FILES.flatMap((f) => scanPure(f, read(f)));
  assert.deepEqual(bad, [], report(bad));
});

test("every database read in the loader and the runner is projected and limited; no $group without a $limit", () => {
  const all = [];
  for (const f of [path.join(BRAIN, "inputs.js"), path.join(BRAIN, "index.js")]) {
    const { bad, reads } = scanReads(f, read(f));
    assert.deepEqual(bad, [], report(bad));
    all.push(...reads.map((r) => rel(f) + " " + r.recv + "." + r.method));
  }
  // the reads plan §2 lists, and the runner's own log reads, were all seen (the scan is not vacuous)
  for (const m of ["MarketplaceListing.find", "UnclaimedAccount.find", "TwitchCampaign.find", "CampaignDrops.find", "MarketResearch.find", "DemandBrainRow.find", "Run().findOne", "Row().find"])
    assert.ok(all.some((r) => r.endsWith(m)), m + " in " + all.join(", "));
  const groups = FILES.flatMap((f) => scanReads(f, read(f)).bad.filter((b) => /\$group/.test(b.what)));
  assert.deepEqual(groups, [], report(groups));
});

test("requiring the runner loads only the model and the loader shell: no model, settings, marketplace module or timer", () => {
  // every timer call is counted, so an unref()'d one (which neither shows as a handle nor keeps the
  // process alive) is caught too
  const script = `
    const timers = [];
    for (const k of ["setTimeout", "setInterval", "setImmediate"]) {
      const orig = global[k];
      global[k] = function (...a) { timers.push(k); return orig.apply(this, a); };
    }
    const before = new Set(Object.keys(require.cache));
    const res0 = process.getActiveResourcesInfo();
    require(${JSON.stringify(path.join(BRAIN, "index.js"))});
    const added = Object.keys(require.cache).filter((k) => !before.has(k));
    const res1 = process.getActiveResourcesInfo();
    process.stdout.write(JSON.stringify({ added, res0, res1, timers }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { CRED_SECRET: "x" }) });
  assert.equal(r.status, 0, "the child exits by itself (no timer or connection keeps it alive): " + r.stderr);
  const out = JSON.parse(r.stdout);
  const loaded = out.added.map(rel);
  const allowed = (f) =>
    f.startsWith("utils/listingBrain/") ||
    ["utils/priceTracker/stats.js", "utils/priceTracker/venues.js", "utils/priceTracker/analyze.js", "utils/priceTracker/setIdentity.js", "utils/farmSizing.js", "utils/marketPricing.js", "utils/pricing.js"].includes(f);
  const extra = loaded.filter((f) => !allowed(f));
  assert.deepEqual(extra, [], "loaded on require: " + extra.join(", "));
  for (const f of loaded) {
    assert.ok(!f.startsWith("models/") && !f.includes("node_modules/"), f);
    assert.notEqual(f, "utils/settings.js");
    assert.ok(!CONNECTOR(f), f);
  }
  assert.ok(loaded.includes("utils/listingBrain/model.js") && loaded.includes("utils/listingBrain/inputs.js"));
  assert.deepEqual(out.res1, out.res0, "no timer, socket or handle is opened");
  assert.deepEqual(out.timers, [], "no timer is started, not even an unref()'d one");
});

test("Node 20 syntax only: no Object.groupBy, Map.groupBy, Set methods, Array.fromAsync, using, iterator helpers", () => {
  const bad = NODE20_FILES.flatMap((f) => scanNode20(f, read(f)));
  assert.deepEqual(bad, [], report(bad));
});
