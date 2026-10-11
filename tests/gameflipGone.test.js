// utils/gameflipGone.js — the one question every hand-back of an account turns
// on: has Gameflip itself said it no longer has the listing?
const test = require("node:test");
const assert = require("node:assert");
const { gameflipGone } = require("../utils/gameflipGone");

const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});
// Gameflip's answer for a deleted listing and for an id that never existed,
// as utils/marketplaces throws it (read live 2026-10-11).
const REAL =
  'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}';

test("gameflipGone: Gameflip's own 404 — the status AND its error envelope", () => {
  assert.strictEqual(gameflipGone(err(REAL, 404)), true);
  // The same answer from another call of the client.
  assert.strictEqual(gameflipGone(err(REAL.replace("listing status", "end listing (confirm)"), 404)), true);
  assert.strictEqual(gameflipGone(err('x: {"error":{"http_status" : 404}}', 404)), true, "spacing is not the point");
});

test("gameflipGone: nothing else is an answer about the listing", () => {
  for (const [what, e] of [
    ["the envelope with another status on the error", err(REAL, 500)],
    ["the envelope with no status at all", err(REAL)],
    ["a refused key that says 'not found'", err('Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Api key not found","code":401,"http_status":401}}', 401)],
    ["a proxy's 404 page", err('Gameflip listing status: "<html><h1>404 Not Found</h1><hr>nginx</html>"', 404)],
    ["a bare 404 with no body", err("Gameflip listing status: Request failed with status code 404", 404)],
    ["the limiter", err('Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Too many attempts - Retry later","code":429,"http_status":429}}', 429)],
    ["a timeout", err("Gameflip listing status: timeout of 20000ms exceeded")],
    ["words alone", err("listing not found")],
    ["a string status", Object.assign(new Error(REAL), { status: "404" })],
    ["nothing", null],
    ["not an error", "404"],
  ]) {
    assert.strictEqual(gameflipGone(e), false, what);
  }
});
