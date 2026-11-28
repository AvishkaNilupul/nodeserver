const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const express = require("express");
const session = require("express-session");
const { bodyParser, createRouter, MOUNT } = require("../routes/arcadeStudioRoutes");

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("Arcade Studio guards all resources and binds public controls to the current superadmin session", async t => {
  const origin = "https://studio.example.test";
  let upstreamToken = randomBytes(32).toString("base64url");
  let controls = 0, reads = 0;
  const renderer = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.host, "127.0.0.1:" + renderer.address().port);
    if (req.method === "POST") {
      assert.equal(req.headers.origin, "http://" + req.headers.host);
      assert.equal(req.headers["x-studio-token"], upstreamToken);
      assert.equal(req.headers["content-type"], "application/json");
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks));
        assert.deepEqual(body, req.url === "/api/stop" ? {} : { mode: "test", duration: 90 });
        controls++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "idle", csrf: upstreamToken }));
      });
      return;
    }
    reads++;
    if (req.url === "/api/status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "idle", csrf: upstreamToken }));
    if (req.url === "/api/frame") return res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    if (req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<script src="./studio.js"></script>');
    if (req.url === "/images/word.webp") return res.writeHead(200, { "content-type": "image/webp" }).end("image");
    res.writeHead(404).end();
  });
  const port = await listen(renderer);
  const app = express();
  app.use(MOUNT, bodyParser);
  app.use(express.json());
  app.use(session({ secret: randomBytes(32).toString("hex"), resave: false, saveUninitialized: false }));
  // This login exists only on the isolated Express harness.
  app.post("/test-login/:kind", (req, res) => {
    req.session.admin = { role: req.params.kind === "admin" ? "admin" : "superadmin", tfa: req.params.kind !== "unenrolled" };
    res.sendStatus(204);
  });
  app.use(MOUNT, createRouter({ port, origin }));
  const site = http.createServer(app);
  const base = "http://127.0.0.1:" + await listen(site);
  t.after(() => {
    for (const server of [renderer, site]) { server.closeAllConnections(); server.close(); }
  });
  t.mock.method(require("../utils/settings"), "getRequire2fa", () => true);
  const login = async kind => (await fetch(base + "/test-login/" + kind, { method: "POST" })).headers.get("set-cookie").split(";")[0];
  const owner = await login("owner"), second = await login("owner");
  const get = (path, cookie, more = {}) => fetch(base + MOUNT + path, {
    headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...more }, redirect: "manual",
  });
  const action = (path, token, changes = {}, cookie = owner, body = {}) => fetch(base + MOUNT + path, {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
      "X-Studio-Token": token, ...changes }, body: JSON.stringify(body),
  });
  for (const path of ["/", "/studio.js", "/images/word.webp", "/api/status", "/api/frame?t=123"]) {
    assert.equal((await get(path)).status, 401);
  }
  const signedOut = await get("/", null, { Accept: "text/html" });
  assert.equal(signedOut.status, 302);
  assert.match(signedOut.headers.get("location"), /^\/admin-login.html\?next=%2Fadmin%2Farcade-studio%2F$/);
  assert.equal((await get("/api/status", await login("admin"))).status, 403);
  assert.equal((await (await get("/api/status", await login("unenrolled"))).json()).code, "enroll_2fa");
  assert.equal(reads, 0);

  assert.equal((await get("", owner)).headers.get("location"), MOUNT + "/");
  const page = await get("/", owner, { Accept: "text/html" });
  assert.match(await page.text(), /\.\/studio.js/);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const frame = await get("/api/frame?t=12345", owner, { "Sec-Fetch-Site": "same-origin" });
  assert.equal(frame.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await get("/images/word.webp", owner)).status, 200);
  assert.equal((await get("/api/frame?t=12345", owner, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await get("/api/status?unknown=1", owner)).status, 404);
  assert.equal((await get("/api/start", owner)).status, 405);
  const token = (await (await get("/api/status", owner)).json()).csrf;
  assert.match(token, /^[\w-]{43}$/);
  assert.notEqual(token, upstreamToken);
  assert.notEqual((await (await get("/api/status", second)).json()).csrf, token);

  assert.equal((await action("/api/stop", token, {}, second)).status, 403);
  assert.equal((await action("/api/stop", token, { Origin: "https://other.example.test" })).status, 403);
  assert.equal((await action("/api/stop", token, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await action("/api/start", token, {}, owner, { mode: "test", duration: 90, channel: "other" })).status, 400);
  assert.equal((await action("/api/stop", token, {}, owner, { padding: "x".repeat(530) })).status, 413);
  assert.equal(controls, 0);
  const mockStart = await action("/api/start", token, {}, owner, { mode: "test", duration: 90 });
  assert.equal(mockStart.status, 200);
  assert.equal((await mockStart.json()).csrf, token);
  assert.equal((await action("/api/stop", token)).status, 200);
  upstreamToken = randomBytes(32).toString("base64url");
  assert.equal((await action("/api/stop", token)).status, 403);
  assert.equal(controls, 2);
});
