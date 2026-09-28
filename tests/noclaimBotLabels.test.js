/* global fetch */
// The no-claim page says WHY a bot is not farming (owner, 2026-09-28 — review
// "honest labels"). Before, a bot read "stopped" whether auto power parked it,
// the operator stopped it or it crashed, and "building…" forever when its
// container was gone (CoD bot 10).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("module");
const express = require("express");

function pageBotStatus(provisioning) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "noclaim-farm.html"), "utf8");
  const src = html.slice(html.indexOf("function botStatus(b){"), html.indexOf("\n}\n", html.indexOf("function botStatus(b){")) + 3);
  const ctx = { PROVISIONING: provisioning };
  vm.runInNewContext(src + "\nthis.botStatus = botStatus;", ctx);
  return ctx.botStatus;
}

test("page: each down bot is labelled by why it is down", () => {
  const s = pageBotStatus(false);
  assert.strictEqual(s({ running: true, containerState: "running" }), "running");
  assert.strictEqual(s({ containerState: "exited", autoStopped: true }), "parked");
  assert.strictEqual(s({ containerState: "exited", operatorOff: true }), "stopped");
  assert.strictEqual(s({ containerState: "exited", operatorOff: true, autoStopped: true }), "stopped", "your stop wins");
  assert.strictEqual(s({ containerState: "exited" }), "crashed");
  assert.strictEqual(s({ containerState: "none", operatorOff: true }), "nocontainer", "bot 10");
  assert.strictEqual(s({ containerState: "none" }), "nocontainer", "no build in flight");
  assert.strictEqual(pageBotStatus(true)({ containerState: "none" }), "building");
});

test("state route: reports the stop and park markers per bot", async () => {
  const out = [
    "prov=no",
    "img=yes",
    "PS_START",
    "noclaim-bot-3|exited|Exited (0) 2 hours ago",
    "noclaim-bot-4|exited|Exited (137) 5 minutes ago",
    "PS_END",
    "BOTS_START",
    "3|Overwatch|40|no|no|yes",
    "4|Overwatch|20|no|no|no",
    "10|Call of Duty: Black Ops 7|10|no|yes|no",
    "BOTS_END",
  ].join("\n");
  const hosts = {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s) + "'",
    async readFiles() {
      return {};
    },
    async runShell() {
      return { stdout: out };
    },
  };
  const stubs = new Map([[require.resolve("../utils/botHosts"), hosts]]);
  const paths = [require.resolve("../routes/noclaimFarmRoutes"), require.resolve("../utils/noclaimFleet")];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  for (const p of paths) delete require.cache[p];
  let server;
  try {
    const app = express();
    app.use((req, _res, next) => {
      req.session = { admin: { id: "root", username: "root", role: "superadmin", tfa: true } };
      next();
    });
    app.use(require("../routes/noclaimFarmRoutes"));
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const j = await (await fetch("http://127.0.0.1:" + server.address().port + "/api/noclaim-farm/state")).json();
    const by = Object.fromEntries(j.bots.map((b) => [b.id, [b.containerState, !!b.operatorOff, !!b.autoStopped]]));
    assert.deepStrictEqual(by, {
      3: ["exited", false, true],
      4: ["exited", false, false],
      10: ["none", true, false],
    });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Module._load = origLoad;
    for (const p of paths) delete require.cache[p];
  }
});
