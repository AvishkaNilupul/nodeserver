// Every login-gated page must stay gated for EVERY spelling of its URL.
//
// 2026-09-30 review: guarded pages are explicit routes ahead of the static
// mount (app.get("/bulk-orders.html", requireSuperadmin, enforce2fa, ...)), but
// Express matches the raw path while express.static decodes and normalises it.
// So /bulk%2Dorders.html and //bulk-orders.html skipped the route and got the
// page from public/ with no session at all. middleware/canonicalPath.js closes
// that; this pins it.
//
// The bug lives in server.js's ROUTING ORDER, so this loads the real server.js
// rather than a copy of its routes — with every I/O dependency stubbed: no
// .env, no Mongo, no session store, no background workers, no listen(). Only
// express, Node built-ins and ./middleware/* (the guards) are real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const Module = require("module");

const { canonicalPath } = require("../middleware/canonicalPath");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const HTML = "text/html,application/xhtml+xml";
const ANY = "*/*"; // what curl sends; the guards answer it with JSON 401

// Every page server.js gates, by who may open it. A new gated page (or a guard
// removed from an existing one) fails "covers every page" below until this
// list is updated — on purpose.
const ADMIN_PAGES = [
  "/admin.html",
  "/ai-chat.html",
  "/settings.html",
  "/marketplace.html",
  "/shop.html",
  "/orders", // admin-pages/, not public/
  "/inventory", // admin-pages/, not public/
];
const SUPERADMIN_PAGES = [
  "/superadmin.html",
  "/twitch-inventory.html",
  "/bots.html",
  "/noclaim-farm.html",
  "/backup.html",
  "/drops-archive.html",
  "/integrity.html",
  "/prime.html",
  "/radar.html",
  "/banned-accounts.html",
  "/epic-accounts.html",
  "/listings.html",
  "/research.html",
  "/bulk-orders.html",
  "/renters.html",
  "/resellers.html",
  "/catalog-admin.html",
  "/activity.html",
  "/ai-proposals.html",
  "/bulk-packs.html",
  "/do-servers.html",
  "/farm-sizing.html",
  "/playerauctions.html",
  "/price-tracker.html",
  "/spent-accounts.html",
  "/unclaimed-farms.html",
];
const LOGIN_PAGE = {
  ...Object.fromEntries(
    [...ADMIN_PAGES, ...SUPERADMIN_PAGES].map((p) => [p, "/admin-login.html"]),
  ),
  "/renter.html": "/renter-login.html",
  "/reseller.html": "/reseller-login.html",
};
const PROTECTED_PAGES = Object.keys(LOGIN_PAGE);

// Signed out, so these must keep answering 200 with no session.
const PUBLIC_URLS = {
  "/": "index.html",
  "/index.html": "index.html",
  "/admin-login.html": "admin-login.html",
  "/renter-login.html": "renter-login.html",
  "/reseller-login.html": "reseller-login.html",
  "/catalog": "catalog.html",
  "/catalog.html": "catalog.html",
  "/app": "app.html",
  "/set/0123abcd": "order-set.html",
  "/order-set.html": "order-set.html",
  "/result.html": "result.html",
  "/style.css": "style.css",
  "/admin-nav.js": "admin-nav.js",
  "/renters/core.js": "renters/core.js",
  // Re-spelt public URLs still reach their file.
  "/admin%2Dlogin.html": "admin-login.html",
  "//renter-login.html": "renter-login.html",
  "/reseller%2dlogin.html": "reseller-login.html",
  "//catalog.html": "catalog.html",
  "/renters/%63ore.js": "renters/core.js",
};

// A fresh session per request, picked by the x-test-as header (read only by
// the stubbed session middleware below — the real one never sees it).
const SESSIONS = {
  superadmin: () => ({
    admin: { id: "t", username: "t", role: "superadmin", tfa: true },
  }),
  admin: () => ({
    admin: { id: "t", username: "t", role: "admin", tfa: true },
  }),
};

// Spellings that decode/normalise to exactly the page's own name, so each must
// get exactly the canonical URL's answer.
function spellings(page) {
  const name = page.slice(1);
  const esc = (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase();
  // Encode the dash (the review's /bulk%2Dorders.html), else the dot, else the
  // first letter — every page has at least one of those.
  const i = [name.indexOf("-"), name.indexOf(".")].find((n) => n >= 0) ?? 0;
  const encodeAt = (at, e) => "/" + name.slice(0, at) + e + name.slice(at + 1);
  return {
    canonical: page,
    "percent-encoded": encodeAt(i, esc(name[i])),
    "double slash": "//" + name,
    "upper-case": page.toUpperCase(),
    "lower-case hex escape": encodeAt(i, esc(name[i]).toLowerCase()),
    "encoded first letter": encodeAt(0, esc(name[0])),
    "dot segment": "/./" + name,
    "parent segment": "/renters/../" + name,
    "encoded slash": "/%2F" + name,
    "trailing slash": page + "/",
  };
}

// Spellings whose answer depends on the filesystem: a case-insensitive one
// (macOS) opens the page for them, a case-sensitive one (Linux) finds nothing,
// and only macOS resolves "page.html/" to the file. Either way the page itself
// must never come back.
function filesystemDependentSpellings(page) {
  const name = page.slice(1);
  const out = {
    "upper-case + escape": "/" + name.toUpperCase().replace(".", "%2E"),
    "encoded trailing slash": page + "%2F",
  };
  // Unicode case folding: KELVIN SIGN folds to "k", LONG S to "s".
  if (name.includes("k"))
    out["kelvin sign"] = "/" + name.replace("k", "%E2%84%AA");
  if (name.includes("s")) out["long s"] = "/" + name.replace("s", "%C5%BF");
  return out;
}

// ---------------------------------------------------------------- harness --

function anyStub() {
  const cache = new Map();
  const target = function stub(req, res, next) {
    if (typeof next === "function") return next(); // mounted as middleware
    return proxy; // called as a factory: helmet({...}), upload.single(...)
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      // Never look like a promise, or like an express sub-app to app.use().
      if (prop === "then" || prop === "handle" || prop === "set")
        return undefined;
      if (typeof prop === "symbol" || prop in t) return t[prop];
      if (!cache.has(prop)) cache.set(prop, anyStub());
      return cache.get(prop);
    },
    construct: () => proxy,
  });
  return proxy;
}

function loadServerApp() {
  const serverFile = path.join(ROOT, "server.js");
  let app = null;
  const stubs = {
    http: { createServer: (a) => ((app = a), anyStub()) },
    mongoose: { connect: () => new Promise(() => {}), connection: {} },
    "express-session": () => (req, _res, next) => {
      const as = req.get("x-test-as");
      req.session = Object.hasOwn(SESSIONS, as) ? SESSIONS[as]() : {};
      next();
    },
  };
  const realLoad = Module._load;
  const handlersBefore = process.listeners("uncaughtException");
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === serverFile) {
      if (Object.hasOwn(stubs, request)) return stubs[request];
      const real =
        Module.isBuiltin(request) ||
        request === "express" ||
        request.startsWith("./middleware/");
      if (!real) return anyStub();
    }
    return realLoad.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[serverFile];
    require(serverFile);
  } finally {
    Module._load = realLoad;
    delete require.cache[serverFile];
    // server.js installs a process-wide exit-on-crash handler; not in tests.
    for (const h of process.listeners("uncaughtException")) {
      if (!handlersBefore.includes(h))
        process.removeListener("uncaughtException", h);
    }
  }
  assert.ok(app, "server.js did not create its HTTP server");
  return app;
}

// res.sendFile(absolutePath) answers 404 when any directory above the file
// starts with "." (send's dotfiles:"ignore") — e.g. a checkout under
// .claude/worktrees/. That is about where the repo sits, not about the
// request, so let the page routes read their files wherever this runs from.
const express = require("express");
const sendFile = express.response.sendFile;
express.response.sendFile = function (file, options, callback) {
  if (typeof options === "function") [callback, options] = [options, {}];
  return sendFile.call(this, file, { dotfiles: "allow", ...options }, callback);
};

let app;
let server;
let port;

test.before(async () => {
  app = loadServerApp();
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// Raw request: the path goes on the wire exactly as written (fetch would
// normalise dot segments away).
function get(rawPath, { accept = HTML, as, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { accept };
    if (as) headers["x-test-as"] = as;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method,
        headers,
        agent: false,
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`timed out: GET ${rawPath}`)),
    );
    req.on("error", reject);
    req.end();
  });
}

const answer = ({ status, location }) => ({ status, location });
const publicFile = (page) => path.join(PUBLIC, page.slice(1));
const inPublic = (page) => fs.existsSync(publicFile(page));

// ------------------------------------------------------------------ tests --

test("the list above covers every page server.js gates", async () => {
  const literalGetPaths = app.router.stack
    .filter((layer) => layer.route && layer.route.methods.get)
    .flatMap((layer) => [].concat(layer.route.path))
    .filter((p) => typeof p === "string" && !/[:*{(]/.test(p));
  const gated = [];
  for (const p of literalGetPaths) {
    const r = await get(p);
    if (
      r.status === 401 ||
      (r.status === 302 && /-login\.html$/.test(r.location))
    ) {
      gated.push(p);
    }
  }
  assert.deepEqual(
    gated.sort(),
    [...PROTECTED_PAGES].sort(),
    "server.js gates a different set of pages than PROTECTED_PAGES lists — " +
      "add/remove the page there so every spelling of it is tested",
  );
});

for (const page of PROTECTED_PAGES) {
  test(`signed out, every spelling of ${page} is refused like the plain URL`, async () => {
    const login = LOGIN_PAGE[page];
    const plainHtml = answer(await get(page));
    const plainApi = answer(await get(page, { accept: ANY }));
    assert.deepEqual(plainHtml, { status: 302, location: login });
    assert.deepEqual(plainApi, { status: 401, location: undefined });

    for (const [kind, url] of Object.entries(spellings(page))) {
      assert.deepEqual(
        answer(await get(url)),
        plainHtml,
        `${kind}: GET ${url}`,
      );
      assert.deepEqual(
        answer(await get(url, { accept: ANY })),
        plainApi,
        `${kind}: GET ${url} (API client)`,
      );
      // The static mount answers HEAD too (headers only, no body).
      assert.deepEqual(
        answer(await get(url, { method: "HEAD" })),
        plainHtml,
        `${kind}: HEAD ${url}`,
      );
    }

    const file = inPublic(page) ? fs.readFileSync(publicFile(page)) : null;
    for (const [kind, url] of Object.entries(
      filesystemDependentSpellings(page),
    )) {
      const r = await get(url);
      assert.notEqual(r.status, 200, `${kind}: GET ${url} answered 200`);
      if (file)
        assert.ok(!r.body.equals(file), `${kind}: GET ${url} served the page`);
    }
  });
}

test("a signed-in superadmin still opens every page under any spelling", async () => {
  for (const page of [...ADMIN_PAGES, ...SUPERADMIN_PAGES].filter(inPublic)) {
    const file = fs.readFileSync(publicFile(page));
    for (const [kind, url] of Object.entries(spellings(page))) {
      const r = await get(url, { as: "superadmin" });
      assert.equal(r.status, 200, `${kind}: GET ${url}`);
      assert.ok(r.body.equals(file), `${kind}: GET ${url} served another body`);
    }
  }
});

test("a plain admin is still bounced from superadmin pages under any spelling", async () => {
  // A page with no file in public/ is a 404 under every spelling (nothing to
  // leak); the staging run on the production box, where every page exists,
  // covers them all.
  for (const page of SUPERADMIN_PAGES.filter(inPublic)) {
    for (const [kind, url] of Object.entries(spellings(page))) {
      assert.deepEqual(
        answer(await get(url, { as: "admin" })),
        { status: 302, location: "/admin.html" },
        `${kind}: GET ${url}`,
      );
    }
  }
  for (const page of ADMIN_PAGES.filter(inPublic)) {
    const r = await get(spellings(page)["percent-encoded"], { as: "admin" });
    assert.equal(r.status, 200, `plain admin, re-spelt ${page}`);
  }
});

test("public pages and assets stay public, however they are spelt", async () => {
  for (const [url, file] of Object.entries(PUBLIC_URLS)) {
    const r = await get(url);
    assert.equal(r.status, 200, `GET ${url}`);
    assert.ok(
      r.body.equals(fs.readFileSync(path.join(PUBLIC, file))),
      `GET ${url} should serve public/${file}`,
    );
  }
});

// ------------------------------------------- the middleware on its own --

function run(req) {
  const mw = canonicalPath(PUBLIC);
  return new Promise((resolve) => mw(req, {}, () => resolve(req.url)));
}
const reqFor = (url, method = "GET") => ({
  method,
  url,
  path: url.split("?")[0],
});

test("canonicalPath rewrites a re-spelt file URL to the file's real name", async () => {
  assert.equal(
    await run(reqFor("/bulk%2Dorders.html?x=1")),
    "/bulk-orders.html?x=1",
  );
  assert.equal(
    await run(reqFor("//bulk-orders.html", "HEAD")),
    "/bulk-orders.html",
  );
  assert.equal(await run(reqFor("//renters//")), "/renters/");
  assert.equal(await run(reqFor("/%2E")), "/");
});

test("canonicalPath leaves everything that is not a re-spelt public file alone", async () => {
  // Already canonical, not a GET, or not a file in public/ (API params keep
  // their encoded slash; send itself refuses bad escapes, NUL and "..").
  for (const url of [
    "/bulk-orders.html",
    "/BULK-ORDERS.HTML", // Express routing already ignores case
    "/bulk-orders/portal/abc%2Fdef",
    "/accounts/lookup/some%20user",
    "/%E0%A4%A",
    "/bulk-orders.html%00",
    "/..%2Fserver.js",
  ]) {
    assert.equal(await run(reqFor(url)), url, url);
  }
  assert.equal(
    await run(reqFor("/bulk%2Dorders.html", "POST")),
    "/bulk%2Dorders.html",
  );
});
