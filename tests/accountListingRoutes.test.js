// Route-level tests for the account-listings API (Feature B of
// docs/ACCOUNT-LISTINGS-CONTRACT.md), run against mongodb-memory-server with a
// hand-seeded superadmin session.
//
// Four failures these exist to prevent, every one of which costs real money:
//
//  1. A CREDENTIAL LEAK. GET /account-listings/:id/accounts is the panel's
//     stock table, and the ledger holds real passwords, Twitch tokens and
//     buyer-visible emails. The assertion here is on the SERIALISED body, not
//     on individual fields — a future `$project` key or a stray spread would
//     slip past a field-by-field check and put plaintext credentials into a
//     browser response.
//  2. THE SAME ACCOUNT SOLD TWICE. Supplied stock has no DropLog reservation
//     and no claim tag, so the unique { offer, loginLower } index plus the
//     ingest duplicate report are the ONLY things stopping one login becoming
//     two units of stock and two buyers.
//  3. AN ORPHANED LIVE OFFER. Deleting an offer while a marketplace row is
//     still on sale leaves a live listing whose stock nothing can claim; the
//     route must refuse with 409 instead.
//  4. AN OPEN PANEL. These endpoints hand out the owner's stock ledger, so
//     every one of them must refuse an unauthenticated (and a non-superadmin)
//     caller.
//
// Ingest is pinned too: a paste must report added / duplicates / conflicts /
// badLines rather than silently guessing at a line it could not split.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "account-listing-routes-test-secret";
// secretBox derives its key from CRED_SECRET (falling back to SESSION_SECRET).
// Pin it so ingest encrypts deterministically and without the rotation warning.
process.env.CRED_SECRET ||= "account-listing-routes-test-cred";

const { decrypt } = require("../utils/secretBox");
const SystemEvent = require("../models/SystemEvent");
const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const BotAccount = require("../models/BotAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const accountListingRoutes = require("../routes/accountListingRoutes");

// Distinctive enough that a substring search over the whole response body is a
// real leak test and not a coincidence.
const LEAK = {
  password: "Pw-SENTINEL-7hj3",
  token: "TOK-SENTINEL-9kq1",
  email: "sentinel-8xv2@leak.test",
};

let mongod;
let server;
let baseUrl;
let cookie; // superadmin
let plainCookie; // authenticated, but role !== "superadmin"

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("account-listing-routes-test"));
  // The unique { offer, loginLower } index is under test, so wait for it to be
  // built rather than racing the background creation.
  await SuppliedAccount.init();

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/session", (req, res) => {
    req.session.admin = {
      id: "root",
      username: "root",
      role: "superadmin",
      tfa: true,
    };
    res.json({ success: true });
  });
  app.get("/test/session-plain", (req, res) => {
    req.session.admin = { id: "helper", username: "helper", role: "admin" };
    res.json({ success: true });
  });
  app.use(accountListingRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  cookie = (await fetch(baseUrl + "/test/session")).headers
    .get("set-cookie")
    .split(";")[0];
  plainCookie = (await fetch(baseUrl + "/test/session-plain")).headers
    .get("set-cookie")
    .split(";")[0];

  // A farm account whose login also turns up in a paste below — that is what
  // makes the ingest flag conflict:"in-archive" (the double-sell guard).
  await BotAccount.create({
    clientSecret: "cs-botclash-token",
    login: "botclash",
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // The routes fire logEvent without awaiting it (an audit write must never be
  // able to fail a request), so give those writes a tick to land before the
  // connection goes away — otherwise the last test's log races the disconnect
  // and prints a spurious "client was closed".
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function call(method, path, opts = {}) {
  const headers = { Accept: "application/json" };
  if (!opts.noAuth) headers.Cookie = opts.cookie || cookie;
  const init = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return fetch(baseUrl + path, init);
}

async function json(res) {
  return res.json();
}

async function createOffer(title, extra = {}) {
  const res = await call("POST", "/account-listings", {
    body: { title, game: "Overwatch 2", priceUsd: 12.5, ...extra },
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  return body.offer;
}

test("ingest reports added, duplicates, conflicts and bad lines separately", async () => {
  const offer = await createOffer("Ingest offer");
  const paste = [
    "alpha:alphapw",
    "beta:betapw:beta-token",
    "gamma:gammapw:gamma@mail.test",
    "delta:deltapw:delta-token:delta@mail.test",
    "* epsilon:epspw",
    "alpha:alphapw", // duplicate inside the paste itself
    "notavalidline", // no separator at all
    "zeta:", // second field empty
    "botclash:clashpw", // also a BotAccount -> conflict, not a silent drop
  ].join("\n");

  const res = await call("POST", "/account-listings/" + offer.id + "/accounts", {
    body: { accounts: paste },
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(body.added, 6);
  assert.deepEqual(body.duplicates, ["alpha"]);
  assert.deepEqual(body.conflicts, ["botclash"]);
  // Reported verbatim, never guessed at.
  assert.deepEqual(body.badLines, ["notavalidline", "zeta:"]);

  // The bullet line really did import, and the "@" disambiguation put the
  // address in email rather than inventing a token out of it.
  const gamma = await SuppliedAccount.findOne({
    offer: offer.id,
    loginLower: "gamma",
  });
  assert.equal(decrypt(gamma.email), "gamma@mail.test");
  assert.equal(decrypt(gamma.clientSecret), "");
  assert.ok(await SuppliedAccount.findOne({ offer: offer.id, loginLower: "epsilon" }));

  // The conflicted row is inserted (so the owner can see it) but flagged.
  const clash = await SuppliedAccount.findOne({
    offer: offer.id,
    loginLower: "botclash",
  });
  assert.equal(clash.conflict, "in-archive");

  const detail = await json(await call("GET", "/account-listings/" + offer.id));
  assert.equal(detail.stats.total, 6);
  assert.equal(detail.stats.conflicts, 1);
});

test("a re-pasted login is reported as a duplicate and adds no second row", async () => {
  const offer = await createOffer("Duplicate offer");
  const first = await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: "dupe:pw1" },
    }),
  );
  assert.equal(first.added, 1);

  // Different case, different password: still the same account.
  const second = await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: "DUPE:pw2" },
    }),
  );
  assert.equal(second.added, 0);
  assert.deepEqual(second.duplicates, ["DUPE"]);
  assert.equal(await SuppliedAccount.countDocuments({ offer: offer.id }), 1);
  // The first paste's credentials survived; the second did not overwrite them.
  const row = await SuppliedAccount.findOne({ offer: offer.id });
  assert.equal(decrypt(row.password), "pw1");
});

test("the unique { offer, loginLower } index refuses a second row for one login", async () => {
  const offer = await createOffer("Index offer");
  await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: "indexed:pw" },
    }),
  );
  // Bypassing the ingest's own duplicate check entirely: the DB itself must
  // refuse, because that is the backstop behind a concurrent double-submit.
  const err = await SuppliedAccount.create({
    offer: offer.id,
    login: "INDEXED",
    password: "other",
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "a duplicate login must not be insertable");
  assert.equal(err.code, 11000);
  assert.equal(await SuppliedAccount.countDocuments({ offer: offer.id }), 1);

  // A different offer may hold the same login — the index is per offer.
  const other = await createOffer("Index offer 2");
  const ok = await SuppliedAccount.create({
    offer: other.id,
    login: "indexed",
    password: "pw",
  });
  assert.equal(ok.loginLower, "indexed");
});

test("GET .../accounts never leaks a password, token or email", async () => {
  const offer = await createOffer("Leak offer");
  const line =
    "leakuser:" + LEAK.password + ":" + LEAK.token + ":" + LEAK.email + ":note-tail";
  const added = await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: line },
    }),
  );
  assert.equal(added.added, 1);

  // Prove the credentials really are in the ledger, or the leak test below
  // would pass trivially on an ingest that stored nothing.
  const row = await SuppliedAccount.findOne({ offer: offer.id });
  assert.equal(decrypt(row.password), LEAK.password);
  assert.equal(decrypt(row.clientSecret), LEAK.token);
  assert.equal(decrypt(row.email), LEAK.email);
  // CHANGED BY F1a — this used to assert row.extra === "note-tail", pinning the
  // one column that was stored in cleartext. A 5-field paste routes real
  // credential material into `extra` (a mail password, a second address), so it
  // is ciphertext at rest now like its three siblings.
  assert.notEqual(row.extra, "note-tail", "extra is not stored in cleartext");
  assert.equal(decrypt(row.extra), "note-tail");

  const res = await call("GET", "/account-listings/" + offer.id + "/accounts");
  assert.equal(res.status, 200);
  const text = await res.text();

  // The whole serialised body, case-insensitively — not field by field.
  const lower = text.toLowerCase();
  for (const secret of [LEAK.password, LEAK.token, LEAK.email, "note-tail"]) {
    assert.equal(
      lower.includes(secret.toLowerCase()),
      false,
      "response body leaked " + secret,
    );
  }
  // Not even the ciphertext: an encrypted password in a browser response is
  // still an exfiltrated password the day the key leaks.
  assert.equal(lower.includes("enc:v1:"), false, "response body leaked ciphertext");

  const body = JSON.parse(text);
  const a = body.accounts[0];
  assert.equal(body.accounts.length, 1);
  assert.equal(a.login, "leakuser");
  // Presence booleans instead of values.
  assert.equal(a.hasPassword, true);
  assert.equal(a.hasToken, true);
  assert.equal(a.hasEmail, true);
  const forbidden = [
    "password",
    "clientSecret",
    "secret",
    "email",
    "token",
    "extra", // holds whatever spilled past field 4 — often a recovery code
    "raw",
  ];
  for (const key of forbidden) {
    assert.equal(key in a, false, "credential-bearing key '" + key + "' in the payload");
  }
});

test("an in-archive conflict is held back until the owner allows it", async () => {
  const offer = await createOffer("Conflict offer");
  await BotAccount.create({
    clientSecret: "cs-held-token",
    login: "heldback",
  });
  const added = await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: "heldback:pw\nclean:pw" },
    }),
  );
  assert.equal(added.added, 2);
  assert.deepEqual(added.conflicts, ["heldback"]);

  const flagged = await json(
    await call("GET", "/account-listings/" + offer.id + "/accounts?status=conflicts"),
  );
  assert.equal(flagged.accounts.length, 1);
  assert.equal(flagged.accounts[0].login, "heldback");
  assert.equal(flagged.accounts[0].conflict, "in-archive");

  const allow = await call(
    "POST",
    "/account-listings/" + offer.id + "/accounts/" + flagged.accounts[0].id + "/allow",
  );
  assert.equal(allow.status, 200);
  const after = await json(
    await call("GET", "/account-listings/" + offer.id + "/accounts?status=conflicts"),
  );
  assert.equal(after.accounts.length, 0);
});

test("a stock row can be removed while available, never once it is fed or sold", async () => {
  const offer = await createOffer("Removal offer");
  await json(
    await call("POST", "/account-listings/" + offer.id + "/accounts", {
      body: { accounts: "freeone:pw\nsoldone:pw" },
    }),
  );
  const rows = await json(
    await call("GET", "/account-listings/" + offer.id + "/accounts"),
  );
  const free = rows.accounts.find((r) => r.login === "freeone");
  const sold = rows.accounts.find((r) => r.login === "soldone");
  await SuppliedAccount.updateOne({ _id: sold.id }, { $set: { status: "sold" } });

  const okRes = await call(
    "DELETE",
    "/account-listings/" + offer.id + "/accounts/" + free.id,
  );
  assert.equal(okRes.status, 200);
  assert.equal(
    (await SuppliedAccount.findById(free.id)).status,
    "removed",
    "an available row is withdrawn, not deleted",
  );

  // A sold row is a buyer's account and stays in the ledger as history.
  const refused = await call(
    "DELETE",
    "/account-listings/" + offer.id + "/accounts/" + sold.id,
  );
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, "not_available");
  assert.equal((await SuppliedAccount.findById(sold.id)).status, "sold");
});

test("delete is refused while a listing is active, and archives once it is not", async () => {
  const offer = await createOffer("Live offer", { status: "active" });
  const listing = await MarketplaceListing.create({
    accountOffer: offer.id,
    marketplace: "ggsel",
    externalId: "ggsel-live-1",
    origin: "manual",
    status: "active",
  });

  const refused = await call("DELETE", "/account-listings/" + offer.id);
  assert.equal(refused.status, 409);
  const body = await json(refused);
  assert.equal(body.code, "listing_active");
  assert.equal(body.listings[0].externalId, "ggsel-live-1");
  assert.equal(
    (await AccountOffer.findById(offer.id)).status,
    "active",
    "a refused delete must not have archived the offer anyway",
  );

  // Delisted on the marketplace — now the offer can be put away.
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $set: { status: "delisted" } },
  );
  const ok = await call("DELETE", "/account-listings/" + offer.id);
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).archived, true);
  assert.equal((await AccountOffer.findById(offer.id)).status, "archived");

  // Archived offers drop out of the default list but stay reachable.
  const list = await json(await call("GET", "/account-listings"));
  assert.equal(
    list.offers.some((o) => o.id === offer.id),
    false,
  );
  const all = await json(await call("GET", "/account-listings?status=all"));
  assert.equal(
    all.offers.some((o) => o.id === offer.id),
    true,
  );
});

test("a raw text/plain paste ingests, and the audit log records counts only", async () => {
  const offer = await createOffer("Paste offer");
  const secret = "Pw-PASTE-SENTINEL-4tb8";
  const res = await fetch(baseUrl + "/account-listings/" + offer.id + "/accounts", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      // The UI posts a big list this way on purpose: express.json is capped at
      // 100kb app-wide and the audit middleware stores the first 40 chars of
      // every string body value — which for a JSON paste is a login:password.
      "Content-Type": "text/plain",
    },
    body: "pasted-one:" + secret + "\npasted-two:" + secret,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 2);
  const first = await SuppliedAccount.findOne({
    offer: offer.id,
    loginLower: "pasted-one",
  });
  assert.equal(decrypt(first.password), secret);

  // Give the fire-and-forget audit write a moment, then prove no event carries
  // the paste. A credential in SystemEvent is a credential in every log viewer.
  await new Promise((r) => setTimeout(r, 50));
  const events = await SystemEvent.find({ action: "account_offer_stock_added" }).lean();
  assert.ok(events.length, "the ingest must still be audited");
  assert.equal(
    JSON.stringify(events).includes(secret),
    false,
    "the audit log recorded the pasted credentials",
  );
});

test("every account-listings route requires a superadmin session", async () => {
  const offer = await createOffer("Auth offer");
  const accId = new mongoose.Types.ObjectId().toString();
  const routes = [
    ["GET", "/account-listings"],
    ["POST", "/account-listings"],
    ["GET", "/account-listings/" + offer.id],
    ["PUT", "/account-listings/" + offer.id],
    ["DELETE", "/account-listings/" + offer.id],
    ["GET", "/account-listings/" + offer.id + "/accounts"],
    ["POST", "/account-listings/" + offer.id + "/accounts"],
    ["DELETE", "/account-listings/" + offer.id + "/accounts/" + accId],
    ["POST", "/account-listings/" + offer.id + "/accounts/" + accId + "/allow"],
    ["POST", "/account-listings/" + offer.id + "/cover-preview"],
  ];
  for (const [method, path] of routes) {
    const body = method === "GET" ? undefined : {};
    const anon = await call(method, path, { noAuth: true, body });
    assert.equal(anon.status, 401, method + " " + path + " must 401 when signed out");
    const plain = await call(method, path, { cookie: plainCookie, body });
    assert.equal(
      plain.status,
      403,
      method + " " + path + " must 403 for a non-superadmin",
    );
  }
  // Nothing above was allowed to mutate anything.
  assert.equal((await AccountOffer.findById(offer.id)).status, "draft");
});

// S8. Both stock syncs pause an offer-backed row (Eldorado pause, PA hide, G2G
// delist, Z2U off_line) by setting autoPaused + lastError and LEAVING
// status:"active". Without these two fields the panel draws a hidden offer as a
// green live chip, so the owner keeps thinking they are on sale on a market
// that has stopped showing them.
test("a paused marketplace row reports autoPaused and lastError, not just active", async () => {
  const offer = await createOffer("Paused offer", { status: "active" });
  await MarketplaceListing.create({
    accountOffer: offer.id,
    marketplace: "eldorado",
    externalId: "eldo-paused-1",
    origin: "manual",
    status: "active",
    autoPaused: true,
    lastError: "paused: no claimable stock",
  });
  await MarketplaceListing.create({
    accountOffer: offer.id,
    marketplace: "ggsel",
    externalId: "ggsel-fine-1",
    origin: "manual",
    status: "active",
  });

  const detail = await json(await call("GET", "/account-listings/" + offer.id));
  const byMarket = new Map(detail.listings.map((r) => [r.marketplace, r]));
  assert.equal(byMarket.get("eldorado").status, "active");
  assert.equal(byMarket.get("eldorado").autoPaused, true);
  assert.equal(byMarket.get("eldorado").lastError, "paused: no claimable stock");
  // A healthy row must still read as plainly healthy — no chip may turn amber
  // because the field merely exists now.
  assert.equal(byMarket.get("ggsel").autoPaused, false);
  assert.equal(byMarket.get("ggsel").lastError, "");

  // The rows list is the page the owner actually looks at.
  const list = await json(await call("GET", "/account-listings"));
  const row = list.offers.find((o) => o.id === offer.id);
  const paused = row.listings.find((r) => r.externalId === "eldo-paused-1");
  assert.equal(paused.autoPaused, true);
  assert.equal(paused.lastError, "paused: no claimable stock");
});

// S7 (route half). offerStats owns what "claimable" means; these routes must
// hand its object to the browser whole. Pinned with a stub so the test still
// passes before utils/suppliedStock grows claimable/heldBack and keeps passing
// after, and so a future edit that whitelists fields here fails loudly.
test("offerStats keys reach the browser verbatim, including new ones", async () => {
  const offer = await createOffer("Stats passthrough offer");
  const stock = require("../utils/suppliedStock");
  const real = stock.offerStats;
  stock.offerStats = async () => ({
    available: 10,
    fed: 0,
    sold: 0,
    removed: 0,
    conflicts: 4,
    total: 10,
    claimable: 7,
    heldBack: 3,
    somethingAddedLater: 1,
  });
  try {
    const detail = await json(await call("GET", "/account-listings/" + offer.id));
    assert.equal(detail.stats.claimable, 7);
    assert.equal(detail.stats.heldBack, 3);
    assert.equal(detail.stats.somethingAddedLater, 1);
    const list = await json(await call("GET", "/account-listings"));
    const row = list.offers.find((o) => o.id === offer.id);
    assert.equal(row.stats.claimable, 7);
    assert.equal(row.stats.heldBack, 3);
    assert.equal(row.stats.somethingAddedLater, 1);
  } finally {
    stock.offerStats = real;
  }
});
