// Route-level tests for the Listings page's fast-load path.
//
// The "Existing listings" list used to ship every bundle's full item array on
// load — a fat response on an archive whose cost is dominated by bytes
// returned. These tests pin the shape of the two endpoints that made it fast:
//
//   GET /drops-archive/sets?light=1  -> rows without item arrays, just thumbs
//   GET /drops-archive/sets/:id      -> one set's full detail, fetched on edit
//
// and that the default (no light) response still carries full items, so nothing
// that relies on the fat shape silently breaks.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "drop-sets-light-test-secret";

const DropSet = require("../models/DropSet");
const dropArchiveRoutes = require("../routes/dropArchiveRoutes");

let mongod;
let server;
let baseUrl;
let cookie; // superadmin session cookie, reused across requests
let setA, setB, setC;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("drop-sets-light-test"));

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  // Seed a superadmin session so requireSuperadmin lets the request through.
  app.get("/test/session", (req, res) => {
    req.session.admin = {
      id: "root",
      username: "root",
      role: "superadmin",
      tfa: true,
    };
    res.json({ success: true });
  });
  app.use(dropArchiveRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  const seed = await fetch(baseUrl + "/test/session");
  cookie = seed.headers.get("set-cookie").split(";")[0];

  // A non-custom bundle with more than four items (to prove thumbs cap at 4).
  setA = await DropSet.create({
    name: "Alpha Bundle",
    note: "alpha note",
    price: 5,
    listed: true,
    sourceType: "",
    items: Array.from({ length: 6 }, (_, i) => ({
      itemKey: "a" + i + "|game",
      name: "Alpha item " + i,
      game: "Overwatch 2",
      image: "https://img/a" + i + ".png",
      qty: 1,
    })),
  });
  // A non-custom, auto-listed draft with two items.
  setB = await DropSet.create({
    name: "Beta Bundle",
    note: "beta searchable note",
    price: 0,
    listed: false,
    sourceType: "radar-event",
    items: [
      {
        itemKey: "b0|game",
        name: "Beta item 0",
        game: "Rocket League",
        image: "https://img/b0.png",
        qty: 2,
      },
      {
        itemKey: "b1|game",
        name: "Beta item 1",
        game: "Rocket League",
        image: "https://img/b1.png",
        qty: 1,
      },
    ],
  });
  // A custom bundle — must be excluded from the regular (non-custom) list.
  setC = await DropSet.create({
    name: "Custom Cover",
    custom: true,
    items: [{ itemKey: "c0|game", name: "Custom item", image: "https://img/c0.png" }],
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function get(path, opts = {}) {
  return fetch(baseUrl + path, {
    headers: {
      Accept: "application/json",
      ...(opts.noAuth ? {} : { Cookie: cookie }),
    },
  });
}

test("light list omits item arrays and returns only thumbnail URLs", async () => {
  const res = await get("/drops-archive/sets?light=1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  // Custom set excluded; both non-custom sets present.
  const ids = body.sets.map((s) => s.id).sort();
  assert.deepEqual(ids, [String(setA._id), String(setB._id)].sort());

  const a = body.sets.find((s) => s.id === String(setA._id));
  // No full item array in light mode...
  assert.equal(a.items, undefined);
  // ...but the count is still exact, and thumbs are the first four images.
  assert.equal(a.itemCount, 6);
  assert.deepEqual(a.thumbs, [
    "https://img/a0.png",
    "https://img/a1.png",
    "https://img/a2.png",
    "https://img/a3.png",
  ]);
  // Row-level fields the list renders/search on are all present.
  assert.equal(a.name, "Alpha Bundle");
  assert.equal(a.note, "alpha note");
  assert.equal(a.price, 5);
  assert.equal(a.listed, true);
  assert.equal(a.sourceType, "");

  const b = body.sets.find((s) => s.id === String(setB._id));
  assert.equal(b.itemCount, 2);
  assert.deepEqual(b.thumbs, ["https://img/b0.png", "https://img/b1.png"]);
  assert.equal(b.sourceType, "radar-event");
  assert.equal(b.listed, false);
});

test("default list still returns full item arrays (back-compat)", async () => {
  const res = await get("/drops-archive/sets");
  assert.equal(res.status, 200);
  const body = await res.json();
  const a = body.sets.find((s) => s.id === String(setA._id));
  assert.ok(Array.isArray(a.items));
  assert.equal(a.items.length, 6);
  assert.equal(a.items[0].name, "Alpha item 0");
  assert.equal(a.items[0].qty, 1);
  // The fat shape has no thumbs field.
  assert.equal(a.thumbs, undefined);
});

test("light payload is much smaller than the full payload", async () => {
  const [lightBody, fullBody] = await Promise.all([
    get("/drops-archive/sets?light=1").then((r) => r.text()),
    get("/drops-archive/sets").then((r) => r.text()),
  ]);
  assert.ok(
    lightBody.length < fullBody.length,
    "light (" + lightBody.length + "B) should be smaller than full (" + fullBody.length + "B)",
  );
});

test("detail endpoint returns one set with its full items", async () => {
  const res = await get("/drops-archive/sets/" + setA._id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.set.id, String(setA._id));
  assert.equal(body.set.items.length, 6);
  assert.equal(body.set.items[5].name, "Alpha item 5");
});

test("detail endpoint 404s on invalid and unknown ids", async () => {
  assert.equal((await get("/drops-archive/sets/not-an-id")).status, 404);
  const missing = new mongoose.Types.ObjectId().toString();
  assert.equal((await get("/drops-archive/sets/" + missing)).status, 404);
});

test("custom+light returns only custom sets", async () => {
  const res = await get("/drops-archive/sets?custom=1&light=1");
  const body = await res.json();
  assert.equal(body.sets.length, 1);
  assert.equal(body.sets[0].id, String(setC._id));
  assert.equal(body.sets[0].items, undefined);
  assert.deepEqual(body.sets[0].thumbs, ["https://img/c0.png"]);
});

test("both endpoints require a superadmin session", async () => {
  assert.equal((await get("/drops-archive/sets?light=1", { noAuth: true })).status, 401);
  assert.equal(
    (await get("/drops-archive/sets/" + setA._id, { noAuth: true })).status,
    401,
  );
});
