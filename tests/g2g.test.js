// G2G is driven through the internal seller API at sls.g2g.com — the same
// shape as ZeusX/Eldorado/PlayerAuctions — and every rule below was learned by
// probing the live seller session on 2026-09-08. None of it is guessable from
// the code, and each one fails silently in a way that costs a real sale, so
// this file is the contract with that session.
//
// The sharpest of them is the authorization header: G2G's own web app sends the
// RAW access token (`headers.authorization = localStorage.accessToken`), so a
// "Bearer " prefix — the thing every reviewer's instinct wants to add — answers
// 401 {"message":"Unauthorized"} on every single call.
//
// No network and no DB: axios, utils/settings and utils/secretBox are replaced
// at require time, so the tests see exactly the requests the connector builds.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const SELLER = "5700688";

// A JWT whose only meaningful claim is exp, which is all g2gTokenMsLeft reads.
function jwt(secondsFromNow) {
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64");
  return "hdr." + body + ".sig";
}

const ACCESS_TOKEN = jwt(3600);
const FRESH_TOKEN = jwt(7200);

// The G2G envelope: 2000 plus a payload, which g2gRequest unwraps.
function okBody(payload) {
  return { data: { code: 2000, payload } };
}

// An axios rejection, shaped the way the real client shapes one.
function httpError(status, data) {
  const e = new Error("Request failed with status code " + status);
  e.response = { status, data };
  return e;
}

// Load utils/marketplaces with axios + the credential store replaced. `respond`
// receives every request the connector makes and returns (or throws) its answer;
// `keys` overrides the stored session — an empty string means "not stored", the
// same way getKeys reads a blank field.
function loadG2G({ respond, keys } = {}) {
  const calls = [];
  const store = {
    marketplaces: {
      g2g: {
        userId: SELLER,
        accessToken: ACCESS_TOKEN,
        refreshToken: "rt-original",
        activeDeviceToken: "adt-original",
        ...(keys || {}),
      },
    },
  };

  const record = async (call) => {
    calls.push(call);
    if (!respond) return okBody({});
    return respond(call, calls.length);
  };
  // g2gRequest calls axios as a function; g2gRefreshAccess uses axios.post. The
  // verb helpers are here so a stray call is RECORDED rather than blowing up as
  // "axios.delete is not a function" — the delist tests assert on that.
  const fakeAxios = async (cfg) =>
    record({
      method: String(cfg.method || "get").toLowerCase(),
      url: cfg.url,
      params: cfg.params || {},
      body: cfg.data,
      headers: cfg.headers || {},
    });
  for (const verb of ["get", "post", "put", "patch", "delete"]) {
    fakeAxios[verb] = async (url, a, b) => {
      const cfg = (verb === "get" || verb === "delete" ? a : b) || {};
      return record({
        method: verb,
        url,
        params: cfg.params || {},
        body: verb === "get" || verb === "delete" ? undefined : a,
        headers: cfg.headers || {},
      });
    };
  }

  const mpPath = require.resolve("../utils/marketplaces");
  const settingsPath = require.resolve("../utils/settings");
  const secretPath = require.resolve("../utils/secretBox");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios") return fakeAxios;
    try {
      const file = Module._resolveFilename(request, parent, isMain);
      // loadSettings returns the SAME object every time, so setKeys' writes are
      // visible to the next getKeys without a real saveSettings.
      if (file === settingsPath) {
        return { loadSettings: () => store, saveSettings: async () => {} };
      }
      // Identity crypto: the store then holds plaintext, so a test can assert
      // on what was actually written back. decrypt() already passes plain
      // values straight through, so this only neutralises encrypt().
      if (file === secretPath) {
        const same = (v) => (v == null ? "" : String(v));
        return { encrypt: same, decrypt: same, isEncrypted: () => false };
      }
    } catch {
      /* not a resolvable module — fall through */
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[mpPath];
  delete require.cache[settingsPath];
  delete require.cache[secretPath];
  let mp;
  try {
    mp = require(mpPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[mpPath];
    delete require.cache[settingsPath];
    delete require.cache[secretPath];
  }
  return { mp, calls, store, g2g: () => store.marketplaces.g2g };
}

const sellerCalls = (calls) => calls.filter((c) => !/refresh_access/.test(c.url));
const refreshCalls = (calls) => calls.filter((c) => /refresh_access/.test(c.url));

/* -------------------------- 1. the auth header -------------------------- */

test("every seller call sends the RAW access token, never a Bearer prefix", async () => {
  const { mp, calls } = loadG2G({
    respond: () => okBody({ preparing: 1, delivering: 4 }),
  });
  await mp.g2gOrderCounts();

  assert.strictEqual(calls.length, 1);
  const h = calls[0].headers;
  assert.strictEqual(
    h.authorization,
    ACCESS_TOKEN,
    "the header must be the bare token, exactly as G2G's own app sends it",
  );
  // The regression this whole test exists for: "Bearer <tok>" is a guaranteed
  // 401 on sls.g2g.com, and it is the natural thing for a future edit to add.
  assert.ok(
    !/^\s*bearer\b/i.test(String(h.authorization)),
    'a "Bearer " prefix answers 401 {"message":"Unauthorized"} on every call',
  );
  // No capitalised twin either — a second header would shadow the right one.
  assert.ok(!("Authorization" in h), "only the lowercase header is sent");
  assert.strictEqual(calls[0].url, "https://sls.g2g.com/order/count-my-orders");
});

/* --------------------- 2. refresh-and-retry, exactly once --------------- */

test("a 401 refreshes and retries once, with the new token raw", async () => {
  const { mp, calls } = loadG2G({
    respond: (call, n) => {
      if (n === 1) throw httpError(401, { message: "Unauthorized" });
      if (/refresh_access/.test(call.url)) {
        return okBody({ access_token: FRESH_TOKEN });
      }
      return okBody({ preparing: 2 });
    },
  });

  const out = await mp.g2gOrderCounts();
  assert.deepStrictEqual(out, { preparing: 2 });
  assert.strictEqual(calls.length, 3, "expired -> refresh -> retry, nothing more");
  assert.match(calls[1].url, /\/user\/refresh_access$/);
  assert.strictEqual(calls[2].headers.authorization, FRESH_TOKEN);
  assert.ok(!/^\s*bearer\b/i.test(String(calls[2].headers.authorization)));
});

test("a second 401 gives up instead of refreshing forever", async () => {
  const { mp, calls } = loadG2G({
    respond: (call) => {
      if (/refresh_access/.test(call.url)) {
        return okBody({ access_token: FRESH_TOKEN });
      }
      throw httpError(401, { message: "Unauthorized" });
    },
  });

  await assert.rejects(mp.g2gOrderCounts(), /401/);
  // The loop guard: two attempts at the call, one refresh between them.
  assert.strictEqual(sellerCalls(calls).length, 2);
  assert.strictEqual(refreshCalls(calls).length, 1);
  assert.strictEqual(calls.length, 3);
});

test("a refresh that itself fails surfaces the original 401", async () => {
  const { mp, calls } = loadG2G({
    respond: (call) => {
      if (/refresh_access/.test(call.url)) throw httpError(400, { message: "bad" });
      throw httpError(401, { message: "Unauthorized" });
    },
  });
  await assert.rejects(mp.g2gOrderCounts(), /401/);
  assert.strictEqual(sellerCalls(calls).length, 1, "no retry on a dead session");
});

/* ------------------- 3. what a refresh writes back ---------------------- */

test("a rotated refresh trio is written back in full", async () => {
  const { mp, calls, g2g } = loadG2G({
    keys: { longLivedToken: "llt-original" },
    respond: () =>
      okBody({
        access_token: FRESH_TOKEN,
        refresh_token: "rt-rotated",
        active_device_token: "adt-rotated",
        long_lived_token: "llt-rotated",
      }),
  });

  assert.strictEqual(await mp.g2gRefreshAccess(), FRESH_TOKEN);
  // The request must present the CURRENT trio, or G2G has nothing to rotate.
  assert.deepStrictEqual(calls[0].body, {
    user_id: SELLER,
    refresh_token: "rt-original",
    active_device_token: "adt-original",
    long_lived_token: "llt-original",
  });
  assert.strictEqual(g2g().accessToken, FRESH_TOKEN);
  // Losing a rotated refresh token means the next refresh 401s and the operator
  // has to re-paste the whole session by hand.
  assert.strictEqual(g2g().refreshToken, "rt-rotated");
  assert.strictEqual(g2g().activeDeviceToken, "adt-rotated");
  assert.strictEqual(g2g().longLivedToken, "llt-rotated");
});

test("a refresh that rotates nothing leaves the stored trio alone", async () => {
  const { mp, g2g } = loadG2G({
    keys: { longLivedToken: "llt-original" },
    respond: () => okBody({ access_token: FRESH_TOKEN }),
  });

  await mp.g2gRefreshAccess();
  assert.strictEqual(g2g().accessToken, FRESH_TOKEN);
  // Blanking these on a response that simply omitted them would log the server
  // out permanently — the exact opposite of what a refresh is for.
  assert.strictEqual(g2g().refreshToken, "rt-original");
  assert.strictEqual(g2g().activeDeviceToken, "adt-original");
  assert.strictEqual(g2g().longLivedToken, "llt-original");
});

test("refreshing without a stored session says so instead of calling G2G", async () => {
  const { mp, calls } = loadG2G({ keys: { refreshToken: "" } });
  await assert.rejects(mp.g2gRefreshAccess(), /no session stored/);
  assert.strictEqual(calls.length, 0);
});

test("a token is only refreshed early when it is actually near expiry", async () => {
  const fresh = loadG2G({ keys: { accessToken: jwt(3600) } });
  assert.strictEqual(await fresh.mp.g2gEnsureFreshToken(), false);
  assert.strictEqual(fresh.calls.length, 0, "a live token must not be spent");

  const stale = loadG2G({
    keys: { accessToken: jwt(-60) },
    respond: () => okBody({ access_token: FRESH_TOKEN }),
  });
  assert.strictEqual(await stale.mp.g2gEnsureFreshToken(), true);
  assert.strictEqual(refreshCalls(stale.calls).length, 1);

  // A token we cannot parse must read as "unknown", never as "expired": an
  // endless refresh loop would burn the session.
  const { mp } = loadG2G();
  assert.strictEqual(mp.g2gTokenMsLeft("not-a-jwt"), Infinity);
  assert.ok(mp.g2gTokenMsLeft(jwt(-60)) < 0);
});

/* --------------------------- 4. offer updates --------------------------- */

test("stock is written as actual_qty, and price as unit_price", async () => {
  const { mp, calls } = loadG2G({ respond: () => okBody({ offer_id: "G178" }) });
  await mp.g2gSetQuantity("G178", 7);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, "put");
  assert.strictEqual(calls[0].url, "https://sls.g2g.com/offer/G178");
  assert.strictEqual(calls[0].body.actual_qty, 7);
  // available_qty is actual_qty minus what checkout is holding — derived, and
  // not settable. Writing it would either be ignored or fight the reservation.
  assert.ok(!("available_qty" in calls[0].body), "available_qty is derived");
  assert.strictEqual(calls[0].body.seller_id, SELLER);

  const priced = loadG2G({ respond: () => okBody({ offer_id: "G178" }) });
  await priced.mp.g2gReprice("G178", 3.5);
  assert.strictEqual(priced.calls[0].body.unit_price, 3.5);
  assert.ok(!("actual_qty" in priced.calls[0].body), "a reprice touches price only");
});

test("a sold-out offer can be set to zero stock", async () => {
  // 0 is a legitimate write, and the natural falsy check would drop it — which
  // would leave an empty offer advertising stock it cannot deliver.
  const { mp, calls } = loadG2G({ respond: () => okBody({ offer_id: "G178" }) });
  await mp.g2gSetQuantity("G178", 0);
  assert.strictEqual(calls[0].body.actual_qty, 0);
});

test("a price under G2G's floor is refused before it reaches G2G", async () => {
  assert.strictEqual(loadG2G().mp.G2G_MIN_PRICE, 0.5);
  const { mp, calls } = loadG2G();
  await assert.rejects(
    mp.g2gUpdateOffer("G178", { unitPrice: 0.25 }),
    /minimum price is 0\.50/,
  );
  await assert.rejects(mp.g2gUpdateOffer("G178", { unitPrice: 0 }), /above 0/);
  await assert.rejects(mp.g2gUpdateOffer("G178", { unitPrice: -1 }), /above 0/);
  await assert.rejects(mp.g2gUpdateOffer("G178", { stock: -1 }), /0 or more/);
  assert.strictEqual(calls.length, 0, "a rejected price must not be sent");
});

test("an empty patch is refused rather than sent as an empty update", async () => {
  const { mp, calls } = loadG2G();
  await assert.rejects(mp.g2gUpdateOffer("G178", {}), /nothing to change/);
  await assert.rejects(mp.g2gUpdateOffer("G178"), /nothing to change/);
  await assert.rejects(mp.g2gUpdateOffer("", { stock: 1 }), /offer_id is required/);
  assert.strictEqual(calls.length, 0);
});

/* ------------------ 5. delist is reversible, never a delete ------------- */

test("delist and relist are status changes, and issue no DELETE", async () => {
  const { mp, calls } = loadG2G({ respond: () => okBody({ offer_id: "G178" }) });
  await mp.g2gDelist("G178");
  await mp.g2gRelist("G178");

  assert.deepStrictEqual(
    calls.map((c) => c.method),
    ["put", "put"],
  );
  assert.strictEqual(calls[0].body.status, mp.G2G_STATUS.DELISTED);
  assert.strictEqual(calls[1].body.status, mp.G2G_STATUS.LIVE);
  assert.deepStrictEqual(mp.G2G_STATUS, { LIVE: "live", DELISTED: "delisted" });
  // The Open API implementation this replaced DELETED the offer, which throws
  // away its sales history and cannot be undone. A relist must be the exact
  // inverse of a delist, so nothing here may become a delete again.
  assert.ok(!calls.some((c) => c.method === "delete"), "no HTTP DELETE");
  assert.ok(
    !calls.some((c) => /delete|remove/i.test(c.url)),
    "no delete-shaped path either",
  );
  for (const c of calls) assert.strictEqual(c.url, "https://sls.g2g.com/offer/G178");
});

/* ------------------------------ 6. orders ------------------------------- */

// One page of the real shape, from the live seller account (FACTS-3).
const ORDER_ROWS = [
  {
    order_id: "1788804161980Y02Q",
    order_item_id: "1788804161980Y02Q-1",
    offer_id: "G1785763694173IQ",
    offer_title: "Albion Online Twitch Drops (125 Chests)",
    seller_id: SELLER,
    buyer_id: "5443030",
    purchased_qty: 1,
    delivered_qty: 0,
    order_item_status: "preparing",
    seller_sub_status: "to_deliver",
    unit_price: 5,
    amount: "5.00",
    offer_currency: "USD",
  },
  {
    order_id: "1788750070103EDWX",
    order_item_id: "1788750070103EDWX-1",
    offer_title: "Overwatch Twitch Drops",
    purchased_qty: 1,
    delivered_qty: 1,
    order_item_status: "completed",
    seller_sub_status: "completed",
    unit_price: 2,
    amount: "2.00",
  },
  {
    order_id: "1788999999999AAAA",
    order_item_id: "1788999999999AAAA-1",
    offer_title: "Rust Twitch Drops",
    purchased_qty: 3,
    delivered_qty: 1,
    order_item_status: "delivering",
    seller_sub_status: "delivering",
    unit_price: 1,
    amount: "3.00",
  },
  {
    order_id: "1788888888888BBBB",
    order_item_id: "1788888888888BBBB-1",
    offer_title: "Apex Twitch Drops",
    purchased_qty: 2,
    delivered_qty: 2,
    order_item_status: "delivering",
    seller_sub_status: "delivering",
    unit_price: 1,
    amount: "2.00",
  },
];

test("order reads carry seller_id — omitting it asks about the wrong side", async () => {
  const { mp, calls } = loadG2G({ respond: () => okBody({ results: ORDER_ROWS }) });
  await mp.g2gOrders({ page: 1, pageSize: 30 });

  assert.strictEqual(calls[0].url, "https://sls.g2g.com/order/list_my_order");
  // Without seller_id G2G answers 4001 "Missing mandatory parameter: buyer_id",
  // which reads like a bug in our code and is really "you didn't say which side
  // of the trade you are". Verified live.
  assert.strictEqual(calls[0].params.seller_id, SELLER);
  assert.ok(!("buyer_id" in calls[0].params));
  assert.strictEqual(calls[0].params.page, 1);
  assert.strictEqual(calls[0].params.limit, 30);

  const counts = loadG2G({ respond: () => okBody({ preparing: 1 }) });
  await counts.mp.g2gOrderCounts();
  assert.strictEqual(counts.calls[0].params.seller_id, SELLER);

  const one = loadG2G({ respond: () => okBody({ order_item_id: "x" }) });
  await one.mp.g2gOrder("1788804161980Y02Q-1");
  assert.strictEqual(one.calls[0].params.seller_id, SELLER);
});

test("pending orders are the ones still owed a delivery", async () => {
  const { mp, calls } = loadG2G({ respond: () => okBody({ results: ORDER_ROWS }) });
  const pending = await mp.g2gPendingOrders();

  assert.deepStrictEqual(
    pending.map((o) => o.orderItemId),
    ["1788804161980Y02Q-1", "1788999999999AAAA-1"],
  );
  // The paid-but-undelivered order is the one a buyer is waiting on.
  assert.strictEqual(pending[0].status, "preparing");
  assert.strictEqual(pending[0].sellerStatus, "to_deliver");
  assert.strictEqual(pending[0].purchasedQty, 1);
  assert.strictEqual(pending[0].deliveredQty, 0);
  assert.strictEqual(pending[0].amount, 5);
  assert.strictEqual(pending[0].currency, "USD");
  // A completed order must never be re-delivered: that ships a second account
  // for one sale.
  assert.ok(!pending.some((o) => o.status === "completed"));
  // A partially delivered order still owes units; a fully delivered one does not.
  assert.strictEqual(pending[1].deliveredQty, 1);
  assert.strictEqual(pending[1].purchasedQty, 3);
  assert.ok(!pending.some((o) => o.orderItemId === "1788888888888BBBB-1"));

  assert.strictEqual(calls.length, 1, "a short page ends the paging");
  assert.strictEqual(calls[0].params.seller_id, SELLER);
});

/* --------------------------- 7. delivery proofs ------------------------- */

test("no uploaded proof reads as none, not as a failure", async () => {
  // A confirmed order completes with NO proof at all — verified on a real
  // completed order, whose delivery_proofs answers 404 4041. If that reads as
  // an error the delivery loop breaks on the NORMAL, undisputed case: every
  // healthy order looks like a failed one.
  //
  // Both bodies below are the two shapes a G2G error takes (a `messages` array,
  // or a bare `message`), because the recon only recorded the status and text,
  // not the JSON. The guard must therefore not depend on which one arrives —
  // keying on the 404 itself is what makes it shape-proof. Matching the text
  // instead is a trap: every message from this call starts "G2G delivery proofs
  // failed", so a /delivery proof/ test swallows the 500s too. The test below
  // holds that line.
  for (const data of [
    { code: 4041, messages: [{ text: "Could not find any uploaded delivery proof." }] },
    { code: 4041, message: "Could not find any uploaded delivery proof." },
  ]) {
    const { mp } = loadG2G({
      respond: () => {
        throw httpError(404, data);
      },
    });
    assert.deepStrictEqual(
      await mp.g2gDeliveryProofs("1788750070103EDWX-1"),
      [],
      "a 404 4041 is the normal state of an undisputed order: " +
        JSON.stringify(data),
    );
  }
});

test("an uploaded proof is returned, and a real failure still throws", async () => {
  const proofs = loadG2G({
    respond: () => okBody({ results: [{ proof_id: "p1", file_name: "a.png" }] }),
  });
  const got = await proofs.mp.g2gDeliveryProofs("1788750070103EDWX-1");
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].proof_id, "p1");

  // Only the "nothing uploaded" answer is benign; a 500 must not read as "none".
  const broken = loadG2G({
    respond: () => {
      throw httpError(500, { message: "Internal Server Error" });
    },
  });
  await assert.rejects(broken.mp.g2gDeliveryProofs("x"), /500/);
});

test("the delivery verbs are PUTs against the order item, with seller_id", async () => {
  const { mp, calls } = loadG2G({ respond: () => okBody({}) });
  const id = "1788804161980Y02Q-1";
  await mp.g2gStartDeliver(id);
  await mp.g2gMarkDelivering(id);
  await mp.g2gSetDeliveredQty(id, 1);

  assert.deepStrictEqual(
    calls.map((c) => c.method),
    ["put", "put", "put"],
  );
  assert.deepStrictEqual(
    calls.map((c) => c.url.replace("https://sls.g2g.com/order/item/", "")),
    [
      id + "/start_deliver",
      id + "/mark_as_delivering",
      id + "/delivered_qty",
    ],
  );
  for (const c of calls) assert.strictEqual(c.body.seller_id, SELLER);
  assert.strictEqual(calls[2].body.delivery_qty, 1);
});

/* ------------------- 8. required vs optional credentials ---------------- */

test("g2g is registered with the seller-session credential trio plus the id", () => {
  const { mp } = loadG2G();
  assert.ok(mp.MARKETPLACES.includes("g2g"));
  assert.deepStrictEqual(mp.FIELDS.g2g, [
    "userId",
    "accessToken",
    "refreshToken",
    "activeDeviceToken",
  ]);
});

test("a missing longLivedToken does not make the session unconfigured", async () => {
  // Only a "remember me" session ever has a long_lived_token; the refresh works
  // without one. Treating it as required would lock a working session out.
  const { mp, calls } = loadG2G({ respond: () => okBody({ preparing: 0 }) });
  assert.strictEqual(mp.keyStatus().g2g.configured, true);
  await mp.g2gOrderCounts(); // requireKeys("g2g") must pass
  assert.strictEqual(calls.length, 1);

  // ...but it IS stored and sent when the operator does supply one.
  const withIt = loadG2G({ respond: () => okBody({ access_token: FRESH_TOKEN }) });
  await withIt.mp.setKeys("g2g", { longLivedToken: "llt-pasted" });
  assert.strictEqual(withIt.g2g().longLivedToken, "llt-pasted");
  await withIt.mp.g2gRefreshAccess();
  assert.strictEqual(withIt.calls[0].body.long_lived_token, "llt-pasted");
});

test("a missing REQUIRED credential still stops the call", async () => {
  // The counterweight to the test above: the optional-field mechanism must not
  // have quietly made everything optional.
  for (const field of ["userId", "accessToken", "refreshToken", "activeDeviceToken"]) {
    const { mp, calls } = loadG2G({ keys: { [field]: "" } });
    assert.strictEqual(
      mp.keyStatus().g2g.configured,
      false,
      field + " is required",
    );
    await assert.rejects(mp.g2gOrderCounts(), /not configured/);
    assert.strictEqual(calls.length, 0);
  }
});
