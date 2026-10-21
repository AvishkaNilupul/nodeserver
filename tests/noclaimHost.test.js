"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { noclaimHostId, DEFAULT_HOST_ID } = require("../utils/noclaimHost");

test("no-claim host: falls back to the default when NOCLAIM_HOST_ID is unset or blank", () => {
  assert.strictEqual(DEFAULT_HOST_ID, "contabo");
  assert.strictEqual(noclaimHostId({}), "contabo");
  assert.strictEqual(noclaimHostId({ NOCLAIM_HOST_ID: "" }), "contabo");
  assert.strictEqual(noclaimHostId({ NOCLAIM_HOST_ID: "   " }), "contabo");
});

test("no-claim host: NOCLAIM_HOST_ID names the host, trimmed", () => {
  assert.strictEqual(noclaimHostId({ NOCLAIM_HOST_ID: "contabo2" }), "contabo2");
  assert.strictEqual(noclaimHostId({ NOCLAIM_HOST_ID: " contabo2\n" }), "contabo2");
});

test("no-claim host: the fleet, watcher and auto-lister all read the same value", () => {
  const { HOST_ID } = require("../utils/noclaimHost");
  for (const mod of ["../utils/noclaimFleet"]) {
    // noclaimFleet exports HOST_ID; the others keep it module-private, and
    // the source check below covers them.
    assert.strictEqual(require(mod).HOST_ID, HOST_ID);
  }
  const fs = require("fs");
  const path = require("path");
  for (const f of ["noclaimFleet.js", "unclaimedAutoList.js", "noclaimWatcher.js", "systemHealth.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "utils", f), "utf8");
    assert.ok(/require\("\.\/noclaimHost"\)/.test(src), f + " reads utils/noclaimHost");
    assert.ok(!/HOST_ID = "contabo"/.test(src), f + " has no hard-coded host left");
  }
});
