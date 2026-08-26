"use strict";

// Guard against the regression fixed in commit 4ae6329 (2026-08-27).
//
// Mongoose 9 (kareem 3) REMOVED callback-style middleware: pre/post hooks are no
// longer passed a `next` callback — a hook must be synchronous (return undefined)
// or async (return a promise). A leftover `function (next) { …; next(); }` hook
// throws `TypeError: next is not a function` on EVERY save()/create(). On prod
// this silently broke ALL MarketplaceListing writes (auto-listing publishes +
// post-event reprices) for ~2 days, while query updates kept working and hid it.
//
// These two tests make that class of bug fail loudly in CI / `npm test` instead.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const MODELS_DIR = path.join(__dirname, "..", "models");

test("no model registers a callback-style (next) mongoose hook", () => {
  const offenders = [];
  for (const file of fs.readdirSync(MODELS_DIR)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(MODELS_DIR, file), "utf8");
    // Find `.pre(...)` / `.post(...)` registrations and inspect the handler's
    // parameter list for a `next` param (the dead callback style).
    const re = /\.(?:pre|post)\s*\([^,]+,\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const params = m[1].split(",").map((s) => s.trim().replace(/=.*$/, ""));
      if (params.includes("next")) {
        offenders.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 70)}…`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "Callback-style mongoose middleware is dead in Mongoose 9 (no `next` is " +
      "passed, so next() throws). Rewrite as sync (return undefined) or async " +
      "(return a promise):\n  " + offenders.join("\n  "),
  );
});

test("MarketplaceListing save hooks run under the real Mongoose 9 path", async () => {
  const MarketplaceListing = require("../models/MarketplaceListing");
  const hooks = MarketplaceListing.schema.s.hooks;
  const doc = new MarketplaceListing({
    marketplace: "gameflip",
    origin: "auto",
    status: "error",
    game: "__hooktest__",
    externalId: "__hooktest__",
    price: 0.75,
    set: new mongoose.Types.ObjectId(),
  });
  // This is exactly how Mongoose 9 invokes pre('save') — with NO `next` arg. A
  // callback-style hook throws "next is not a function" here.
  await hooks.execPre("save", doc, [doc]);
  assert.equal(doc.$locals.wasNew, true, "pre-save hook must stash isNew");
});
