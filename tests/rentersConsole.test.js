/*
 * rentersConsole.test.js — regression cover for the public/renters/ rebuild
 * (the 8 modules that replaced the single-file public/renters.html).
 *
 * There is no jsdom here and there must not be: this repo runs on a live box
 * and `npm install` on prod is not on the table. So the DOM is a hand-rolled
 * stub, just wide enough for the 8 modules to load and register — the element
 * ids come out of public/renters.html at test time so the stub can never drift
 * from the real page.
 *
 * The regression that matters is "the accounts section copies the REAL
 * credential" (test 5). GET /renter-accounts (the section) and GET /renters/:id
 * (the Manage modal) mint the SAME account id but different fields: only the
 * section payload carries `password` and `token`. accounts.js keeps both arrays
 * (ACCS and ROWS) and ROWS is never cleared, so a lookup that lets ROWS win
 * makes the section's copy buttons emit "login:" and "" — behind a "Copied"
 * toast — while the row on screen still shows the real values. The section's
 * credential reads must resolve through ACCS only. Test 6 pins the other half:
 * a masked row must not leak the secret into markup. Both use values with a
 * quote and a backslash, which is what broke the original's inline onclick
 * handlers in the first place.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "public", "renters");
// Load order is the page's script order; boot.js must stay last.
const ORDER = ["core", "create", "approvals", "bots", "accounts", "drops", "detail", "boot"];
const SRC = {};
for (const m of ORDER) SRC[m] = fs.readFileSync(path.join(DIR, m + ".js"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "renters.html"), "utf8");
// The contract lives OUTSIDE public/ on purpose: express.static serves public/,
// so a doc describing the console's internals (and the injection bug it fixes)
// would be world-readable at /renters/CONTRACT.md if it sat next to the modules.
const CONTRACT = fs.readFileSync(
  path.join(ROOT, "docs", "renters-console-CONTRACT.md"),
  "utf8",
);

const ACC_ID = "acc-1";
// A quote and a backslash in every field: exactly what killed the original's
// esc()-into-JS-source handlers, plus a tag to catch an unescaped render.
const HOSTILE = { login: "o'brien\\x <script>", password: 'p\'a"ss\\', token: "tok'en\\" };
// GET /renter-accounts shape: has the secrets.
const sectionAcc = () => ({
  id: ACC_ID, login: HOSTILE.login, password: HOSTILE.password, token: HOSTILE.token,
  renter: "tenant-a", configFile: "config_09", status: "ok", credSource: "stash",
  dropCount: 3, farmUntil: null, farmEndedAt: null,
});
// GET /renters/:id shape: same id, NO password, NO token.
const modalAcc = () => ({
  id: ACC_ID, login: HOSTILE.login, status: "ok", dropCount: 3,
  farmUntil: null, farmEndedAt: null, lastScanAt: null,
});

// ---- DOM stub ---------------------------------------------------------------

// Every id the real page declares, parsed rather than hardcoded.
function pageIds() {
  const ids = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(PAGE))) ids.add(m[1]);
  return ids;
}

// Only the selector shapes the modules actually use: [data-act] and
// tag[data-x="v"]. Anything else is a no-match, which is the honest answer.
function matchesSel(node, sel) {
  const m = /^([a-zA-Z]*)\[data-([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(String(sel).trim());
  if (!m) return false;
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  const key = m[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const v = node.dataset[key];
  if (v === undefined) return false;
  return m[3] === undefined || String(v) === m[3];
}

function el(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", value: "", textContent: "", disabled: false,
    style: {}, dataset: {}, options: [], children: [], parentNode: null,
    scrollTop: 0, scrollHeight: 0, _html: "", _cls: new Set(), _on: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v == null ? "" : v); },
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute(n) { return n === "id" ? this.id : null; },
    setAttribute() {}, removeAttribute() {}, focus() {}, blur() {}, remove() {},
    closest(sel) { let n = this; while (n) { if (matchesSel(n, sel)) return n; n = n.parentNode; } return null; },
  };
  node.classList = {
    add: (c) => node._cls.add(c),
    remove: (c) => node._cls.delete(c),
    contains: (c) => node._cls.has(c),
    toggle: (c) => (node._cls.has(c) ? (node._cls.delete(c), false) : (node._cls.add(c), true)),
  };
  return node;
}

function makeDoc() {
  const map = new Map();
  for (const id of pageIds()) { const n = el("div"); n.id = id; map.set(id, n); }
  const doc = {
    _on: {},
    getElementById(id) { return map.get(id) || null; },
    createElement(tag) { return el(tag); },
    addEventListener(t, f) { (doc._on[t] = doc._on[t] || []).push(f); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  doc.body = el("body");
  doc.documentElement = el("html");
  return doc;
}

const ROUTES = () => ({
  "/shop/me": { username: "ops" },
  "/bot-configs/hosts": { hosts: [{ id: "local", label: "Server" }] },
  "/renters/bots": { bots: [] },
  "/renters": { renters: [] },
  "/renter-bots": { bots: [] },
  "/renter-bots/live": { live: [] },
  "/renter-scan/progress": { progress: {} },
  "/renter-submissions": { submissions: [] },
  "/renter-accounts": { accounts: [] },
  "/renter-drops": { drops: [], renters: [] },
});

// Boot the 8 modules into a fresh stub context. `overrides` swaps one module's
// source (used to prove test 5 is red against the pre-fix resolver).
function boot(opts) {
  opts = opts || {};
  const doc = makeDoc();
  const copied = [], calls = [], timers = [], errors = [];
  const routes = Object.assign(ROUTES(), opts.routes || {});
  // Fake timers: recorded, never fired. Nothing is left running and no
  // assertion can depend on the clock.
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error(m) { errors.push(String(m)); } },
    navigator: { clipboard: { writeText(t) { copied.push(String(t)); return Promise.resolve(); } } },
    location: { origin: "https://ops.test", href: "https://ops.test/renters.html" },
    setTimeout(fn, ms) { return timers.push({ fn, ms }); },
    setInterval(fn, ms) { return timers.push({ fn, ms, repeat: true }); },
    clearTimeout() {}, clearInterval() {},
    confirm: () => true, prompt: () => null, alert: () => {},
    fetch(p, o) {
      const url = String(p);
      calls.push({ url, method: (o && o.method) || "GET" });
      const hit = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : routes[url.split("?")[0]];
      const payload = Object.assign({ success: true }, hit || {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);

  const registered = [];
  for (const m of ORDER) {
    vm.runInContext(opts.overrides && opts.overrides[m] ? opts.overrides[m] : SRC[m], ctx, {
      filename: "public/renters/" + m + ".js",
    });
    if (m === "core") {
      // Record every registration made from here on. core.js's own
      // "closeModal" is registered through its local `on` before this point —
      // seeded below, and verified live by dispatching it.
      const RT = vm.runInContext("window.RT", ctx);
      const orig = RT.on;
      RT.on = (name, fn) => { registered.push(String(name)); return orig(name, fn); };
    }
  }

  const RT = vm.runInContext("window.RT", ctx);
  return {
    RT, doc, copied, calls, timers, errors, registered,
    toast: () => doc.getElementById("toast").textContent,
    html: (id) => doc.getElementById(id).innerHTML,
    // Flush the microtask queue; the fetch stub resolves synchronously so one
    // macrotask hop settles every pending chain.
    settle: () => new Promise((r) => setImmediate(r)),
    // Build a detached node with a dataset, optionally parented (for the
    // nested-child dispatch case).
    mk(ds, parent) { const n = el("button"); Object.assign(n.dataset, ds); if (parent) parent.appendChild(n); return n; },
    // Dispatch a click through core.js's delegated document listener; returns
    // whether the dispatcher claimed the event (preventDefault).
    click(node) {
      let pd = false;
      for (const f of doc._on.click || []) f({ target: node, preventDefault() { pd = true; } });
      return pd;
    },
  };
}

// Members promised by CONTRACT.md's core.js block, read from the doc itself.
function contractMembers() {
  const sec = CONTRACT.slice(CONTRACT.indexOf("## `core.js`"));
  const open = sec.indexOf("```js") + 5;
  const block = sec.slice(open, sec.indexOf("```", open));
  const names = new Set();
  for (const line of block.split("\n")) {
    const code = line.split("//")[0].split("{")[0]; // drop comments and nested objects
    const re = /([A-Za-z_$][\w$]*)\s*[:(]/g;
    let m;
    while ((m = re.exec(code))) names.add(m[1]);
  }
  return [...names];
}

// data-act values the modules can emit (all are literals in the sources).
function emittedActs() {
  const out = new Set();
  for (const m of ORDER) {
    const re = /data-act="([A-Za-z0-9_-]+)"/g;
    let hit;
    while ((hit = re.exec(SRC[m]))) out.add(hit[1]);
  }
  return out;
}

// ---- 1: every module loads, RT is complete ---------------------------------

test("all 8 modules load and window.RT matches the contract", async () => {
  const env = boot();
  await env.settle();
  assert.deepStrictEqual(env.errors, [], "a module bailed out at load");
  const want = contractMembers();
  assert.ok(want.length >= 20, "contract parse produced only " + want.length + " members");
  for (const k of want) {
    assert.notStrictEqual(env.RT[k], undefined, "RT." + k + " missing");
    if (k !== "state" && k !== "reload") assert.strictEqual(typeof env.RT[k], "function", "RT." + k + " not callable");
  }
  for (const k of ["HOSTS", "BOTS", "CURRENT"]) assert.ok(k in env.RT.state, "RT.state." + k + " missing");
  // Cross-module surfaces the allowlist names.
  for (const p of [["detail", "open"], ["detail", "reopen"], ["accounts", "rowsHtml"], ["accounts", "load"],
    ["drops", "load"], ["bots", "toggleLogs"], ["create", "botOptionLabel"]]) {
    assert.strictEqual(typeof (env.RT[p[0]] || {})[p[1]], "function", "RT." + p[0] + "." + p[1] + " missing");
  }
  // boot.js's first paint, not a hardcoded list of endpoints.
  const urls = env.calls.map((c) => c.url);
  for (const u of ["/shop/me", "/bot-configs/hosts", "/renters", "/renter-bots"]) assert.ok(urls.includes(u), "no first-paint call to " + u);
});

// ---- 2 + 3: registry integrity ---------------------------------------------

test("action names are unique and every emitted data-act resolves", async () => {
  const env = boot();
  await env.settle();
  // core.js registers "closeModal" internally; prove it is really there by
  // dispatching it (closing an unopened modal is a no-op) before seeding it.
  assert.strictEqual(env.click(env.mk({ act: "closeModal" })), true, "closeModal is not registered");
  const all = ["closeModal"].concat(env.registered);
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  assert.deepStrictEqual(dupes, [], "duplicate action names silently overwrite each other");
  assert.ok(all.length >= 25, "only " + all.length + " actions recorded — wrapper missed registrations");
  const registry = new Set(all);
  const missing = [...emittedActs()].filter((a) => !registry.has(a));
  assert.deepStrictEqual(missing, [], "markup emits data-act values with no handler");
  // And nothing is registered that no module can ever emit (dead handler).
  const unreachable = all.filter((a) => !emittedActs().has(a));
  assert.deepStrictEqual(unreachable, [], "registered handler unreachable from any markup");
});

// ---- 4: the delegated dispatcher -------------------------------------------

test("document click dispatch routes the element and a nested child", async () => {
  const env = boot();
  await env.settle();
  const btn = env.mk({ act: "accCopyVal", copy: "PAYLOAD-A" });
  assert.strictEqual(env.click(btn), true, "dispatcher ignored a [data-act] element");
  await env.settle();
  assert.deepStrictEqual(env.copied, ["PAYLOAD-A"]);

  // A click landing on a child inside the button must climb to the button.
  const outer = env.mk({ act: "accCopyVal", copy: "PAYLOAD-B" });
  const inner = el("span");
  outer.appendChild(inner);
  assert.strictEqual(env.click(inner), true, "dispatcher did not walk up to the [data-act] ancestor");
  await env.settle();
  assert.deepStrictEqual(env.copied, ["PAYLOAD-A", "PAYLOAD-B"]);

  // No action, or an unknown one: not claimed, nothing copied.
  assert.strictEqual(env.click(el("div")), false);
  assert.strictEqual(env.click(env.mk({ act: "noSuchAction" })), false);
  await env.settle();
  assert.strictEqual(env.copied.length, 2);
});

// ---- 5: THE regression -----------------------------------------------------

async function loadedSection(overrides) {
  const env = boot({ routes: { "/renter-accounts": { accounts: [sectionAcc()] } }, overrides: overrides });
  await env.settle();
  await env.RT.accounts.load();          // section: has password + token
  env.RT.accounts.rowsHtml([modalAcc()]); // Manage modal: same id, neither field
  env.copied.length = 0;
  return env;
}

test("section copy buttons copy the real credential after a modal render", async () => {
  const env = await loadedSection();
  assert.strictEqual(env.click(env.mk({ act: "accCopyPair", id: ACC_ID })), true);
  await env.settle();
  assert.deepStrictEqual(env.copied, [HOSTILE.login + ":" + HOSTILE.password],
    "copy login:pass was shadowed by the modal payload");
  env.copied.length = 0;
  assert.strictEqual(env.click(env.mk({ act: "accCopyToken", id: ACC_ID })), true);
  await env.settle();
  assert.deepStrictEqual(env.copied, [HOSTILE.token], "copy token was shadowed by the modal payload");
  assert.notStrictEqual(env.toast(), "Account not found");
  // An id in neither array must not copy an empty string behind "Copied".
  env.copied.length = 0;
  env.click(env.mk({ act: "accCopyPair", id: "ghost" }));
  await env.settle();
  assert.deepStrictEqual(env.copied, []);
  assert.strictEqual(env.toast(), "Account not found");
});

test("the pre-fix resolver makes the test above red (mutation guard)", async () => {
  const pre = SRC.accounts.replace(/findSectionAcc\(ds\.id\)/g, "findAcc(ds.id)");
  assert.notStrictEqual(pre, SRC.accounts,
    "accounts.js no longer resolves credential copies through findSectionAcc(ds.id) — re-point this mutation");
  const env = await loadedSection({ accounts: pre });
  env.click(env.mk({ act: "accCopyPair", id: ACC_ID }));
  env.click(env.mk({ act: "accCopyToken", id: ACC_ID }));
  await env.settle();
  assert.deepStrictEqual(env.copied, [HOSTILE.login + ":", ""],
    "the mutant copied the real credentials — the test above proves nothing");
});

// ---- 6: no secret in markup -----------------------------------------------

test("masked account rows leak neither password nor token into markup", async () => {
  const env = await loadedSection();
  const html = env.html("rentAccs") + env.RT.accounts.rowsHtml([modalAcc()]);
  for (const secret of [HOSTILE.password, HOSTILE.token]) {
    assert.ok(!html.includes(secret), "raw secret rendered into markup");
    assert.ok(!html.includes(env.RT.esc(secret)), "escaped secret rendered into markup");
  }
  assert.ok(html.includes("•".repeat(8)), "secrets are not masked at all");
  // The login IS rendered — escaped, with no live tag and no on* attribute.
  assert.ok(html.includes(env.RT.esc(HOSTILE.login)), "login not rendered escaped");
  assert.ok(!html.includes("<script>"), "login rendered unescaped");
  assert.ok(!/\son[a-z]+\s*=/.test(html), "an on* attribute reached the markup");
  // Revealing flips only the display, and only in the section.
  const reveal = env.doc.getElementById("accReveal");
  for (const f of reveal._on.click) f({});
  assert.ok(env.html("rentAccs").includes(env.RT.esc(HOSTILE.password)), "Show secrets did not reveal");
  assert.ok(!env.html("rentAccs").includes(HOSTILE.password), "revealed secret is not escaped");
});

test("bot picker shows dedicated stack capacity and disables full stacks", async () => {
  const env = boot({
    routes: {
      "/renters/bots": {
        bots: [
          {
            host: "pi",
            hostLabel: "Raspberry Pi",
            file: "config_30.json",
            accounts: 7,
            capacity: 10,
            remaining: 3,
            renters: ["tenant-a"],
          },
          {
            host: "pi",
            hostLabel: "Raspberry Pi",
            file: "config_31.json",
            accounts: 10,
            capacity: 10,
            remaining: 0,
            renters: [],
          },
        ],
      },
    },
  });
  await env.settle();
  await env.settle();
  const html = env.html("cBot");
  assert.ok(html.includes("7/10 accounts"), "available stack capacity is missing");
  assert.ok(html.includes("shared with tenant-a"), "stack tenants are missing");
  assert.match(
    html,
    /value="1" disabled[^>]*>[^<]*10\/10 accounts/,
    "a full rental stack remains selectable",
  );
  assert.ok(
    html.includes("Create a dedicated rental stack"),
    "the create action does not describe the isolation boundary",
  );
});

test("no timers are left running", async () => {
  const env = boot();
  await env.settle();
  assert.deepStrictEqual(env.timers.filter((t) => t.repeat), [], "a module started an interval at load");
});

test("Quick farm keeps account lookup and game search compact", () => {
  assert.match(SRC.detail, /id="qUser"/, "Quick farm username field missing");
  assert.match(SRC.detail, /id="qGame"[^>]*list="qGameOptions"/, "Quick farm game typeahead missing");
  assert.match(SRC.detail, /renters\/game-search\?q=/, "Quick farm does not call game search");
  assert.match(SRC.detail, /games\.slice\(0, 20\)/, "game suggestions are not capped");
  assert.match(SRC.detail, /data-act="quickFarm"/, "Quick farm action missing");
});
