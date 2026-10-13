// Guards for scripts/reprice-eldorado-farm.js — the tool that moves the price
// of every rent-farm offer on Eldorado in one run, beside the live server and
// on its login. The tests are about which offers it may touch, what counts as
// "done", when it must stop, and that it can never move the login.
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const tool = require("../scripts/reprice-eldorado-farm");
const { parseLadder, ladderDoubts, gameList, gameOf, usdOf, buildPlan, applyPlan, installSessionGuards, summary } = tool;
const farm = require("../utils/eldoradoFarmService");

const T = (game, term) => game + " Twitch Drops Automatic Farming " + term;
const offer = (id, title, usd, extra = {}) => ({
  id,
  offerTitle: title,
  offerState: "Active",
  pricePerUnit: { amount: usd, currency: "USD" },
  ...extra,
});
const OLD = parseLadder("30:2,120:3,365:7");
const NEW = parseLadder("30:2.5,120:3.99,365:8.99");
const plan = (offers, opts = {}) => buildPlan(offers, { ladder: NEW, ...opts }, farm);
const act = (rows) => rows.map((r) => r.action + (r.why ? " (" + r.why + ")" : ""));

/* ------------------------------ the ladder ------------------------------- */

test("a ladder reads as days and prices", () => {
  assert.deepEqual([...parseLadder("30:2.49, 120:3.99,365=8.99")], [[30, 2.49], [120, 3.99], [365, 8.99]]);
  assert.equal(parseLadder("").size, 0);
});

test("a ladder it cannot read is refused whole", () => {
  for (const bad of ["30", "30:", "abc:2", "30:2.499", "30:-1", "0:2", "731:2", "30:0.49", "30:2,30:3", "30:2;120:3"])
    assert.throws(() => parseLadder(bad), /--ladder/, bad);
});

test("a price far from the one it replaces is flagged as a likely typo", () => {
  assert.deepEqual(ladderDoubts(parseLadder("120:39.9"), parseLadder("120:3")), ["120 days: $3.00 -> $39.90"]);
  assert.deepEqual(ladderDoubts(parseLadder("120:0.5"), parseLadder("120:3")), ["120 days: $3.00 -> $0.50"]);
  assert.deepEqual(ladderDoubts(NEW, OLD), []);
  assert.deepEqual(ladderDoubts(NEW, null), []);
});

/* --------------------------- reading an offer ---------------------------- */

test("the game is the title up to 'Twitch Drops'", () => {
  assert.equal(gameOf(T("Halo: The Master Chief Collection", "1 Year")), "Halo: The Master Chief Collection");
  assert.equal(gameOf("Tom Clancy's Rainbow Six Siege X Twitch Drops Automatic farming 180 days"), "Tom Clancy's Rainbow Six Siege X");
});

test("a price in another currency is never taken for dollars", () => {
  assert.equal(usdOf({ pricePerUnit: { amount: 7, currency: "USD" } }), 7);
  assert.equal(usdOf({ pricePerUnit: { amount: 7 } }), 7);
  assert.equal(usdOf({ pricePerUnit: { amount: 1141.66, currency: "JPY" }, pricePerUnitInUSD: { amount: 7, currency: "USD" } }), 7);
  assert.equal(usdOf({ pricePerUnit: { amount: 1141.66, currency: "JPY" } }), null);
  assert.equal(usdOf({}), null);
  assert.equal(usdOf(null), null);
});

/* ------------------------- which offers it touches ----------------------- */

test("each term goes to its own price, whatever the game", () => {
  const rows = plan([
    offer("a", T("Rust", "30 Days"), 2),
    offer("b", T("Rust", "120 Days"), 3),
    offer("c", T("Apex Legends", "1 Year"), 7),
    { offer: offer("d", "Overwatch Twitch Drops Automatic farming 120 days", 3) },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.days, r.from, r.to, r.action]), [
    ["c", 365, 7, 8.99, "reprice"],
    ["d", 120, 3, 3.99, "reprice"],
    ["a", 30, 2, 2.5, "reprice"],
    ["b", 120, 3, 3.99, "reprice"],
  ]);
});

test("the term comes from the parser a real order goes through", () => {
  for (const [term, days] of [["30 Days", 30], ["120 Days", 120], ["180 Days", 180], ["1 Year", 365], ["2 Years", 730]])
    assert.equal(farm.termToDays(T("Rust", term)), days);
  const rows = buildPlan([offer("a", T("Rust", "2 Years"), 12)], { ladder: parseLadder("730:14") }, farm);
  assert.equal(rows[0].days, 730);
  assert.equal(rows[0].action, "reprice");
});

test("an offer that is not a rent-farm offer is not even listed", () => {
  assert.deepEqual(plan([offer("a", "Overwatch 2 — 24 Items — Twitch Drops", 1.29), offer("b", "", 3), { offerTitle: T("Rust", "30 Days") }]), []);
});

test("an offer already at the new price is left as it is", () => {
  assert.deepEqual(act(plan([offer("a", T("Rust", "120 Days"), 3.99)])), ["already"]);
});

test("a game left out on purpose keeps its price, however it is spelt", () => {
  const rows = plan([offer("a", T("Albion Online", "30 Days"), 2), offer("b", T("Rust", "30 Days"), 2)], {
    except: gameList(" albion   online ,Nothing"),
  });
  assert.deepEqual(act(rows), ["skip (game left out on purpose)", "reprice"]);
});

test("--only narrows the run to the games named", () => {
  const rows = plan([offer("a", T("Rust", "30 Days"), 2), offer("b", T("Ragnarok Online", "30 Days"), 2)], {
    only: gameList("ragnarok online"),
  });
  assert.deepEqual(act(rows), ["reprice", "skip (not one of the games asked for)"]);
});

test("what it cannot price or should not price is left alone, with the reason", () => {
  const rows = plan([
    offer("a", T("Rust", "180 Days"), 4),
    offer("b", "Rust Twitch Drops Automatic Farming", 3),
    offer("c", T("Rust", "120 Days") + " — PACK OF 5 ACCOUNTS", 14),
    offer("d", T("Rust", "120 Days"), 3, { offerState: "Closed" }),
    offer("e", T("Rust", "1 Year"), 1141, { pricePerUnit: { amount: 1141, currency: "JPY" } }),
    offer("f", T("Rust", "30 Days"), 2, { offerState: "Paused" }),
  ]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.action + (r.why ? ": " + r.why : "")])), {
    a: "skip: no price given for 180 days",
    b: "skip: no term in the title",
    c: "skip: a bulk pack, priced per pack",
    d: "skip: offer is Closed",
    e: "skip: current price could not be read",
    f: "reprice",
  });
});

test("with --expect a price somebody set by hand is reported, not replaced", () => {
  const rows = plan([offer("a", T("Rust", "120 Days"), 3), offer("b", T("Apex Legends", "120 Days"), 5.5), offer("c", T("Rust", "30 Days"), 2)], {
    expect: parseLadder("120:3"),
  });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.action + (r.why ? ": " + r.why : "")])), {
    a: "reprice",
    b: "skip: unexpected price $5.50 (expected $3.00)",
    c: "skip: unexpected price $2.00 (no expected price for this term)",
  });
});

test("--limit caps the offers repriced and says so for the rest", () => {
  const rows = plan(
    [offer("a", T("Rust", "30 Days"), 2), offer("b", T("Rust", "120 Days"), 3.99), offer("c", T("Rust", "1 Year"), 7), offer("d", T("Warframe", "30 Days"), 2)],
    { limit: 2 },
  );
  assert.deepEqual(act(rows), ["reprice", "already", "reprice", "skip (over the --limit)"]);
});

test("the summary counts offers per step of the ladder", () => {
  const rows = plan([offer("a", T("Rust", "30 Days"), 2), offer("b", T("Apex Legends", "30 Days"), 2), offer("c", T("Rust", "1 Year"), 7)]);
  assert.deepEqual(summary(rows), [
    { days: 30, from: 2, to: 2.5, n: 2 },
    { days: 365, from: 7, to: 8.99, n: 1 },
  ]);
});

/* ------------------------------- the run --------------------------------- */

// A fake Eldorado: prices by id, and a script of what each call does.
function fakeIo({ prices = {}, onReprice = null, onRead = null } = {}) {
  const io = { calls: [], slept: [], kept: [], lines: [], prices: { ...prices } };
  io.reprice = async (id, usd) => {
    io.calls.push("reprice " + id + " " + usd);
    if (onReprice) await onReprice(id, usd, io);
    else io.prices[id] = usd;
  };
  io.read = async (id) => {
    io.calls.push("read " + id);
    if (onRead) return onRead(id, io);
    return { id, pricePerUnit: { amount: io.prices[id], currency: "USD" } };
  };
  io.confirmed = async (row, usd) => io.kept.push(row.id + " " + usd);
  io.sleep = async (ms) => io.slept.push(ms);
  io.log = (line) => io.lines.push(line);
  return io;
}
const three = () => plan([offer("a", T("Rust", "30 Days"), 2), offer("b", T("Rust", "120 Days"), 3), offer("c", T("Rust", "1 Year"), 7)]);
const FAST = { gapMs: 5, settleMs: 1, lapseWaitMs: 9, lapseTries: 3 };
const httpError = (status, message) => Object.assign(new Error(message || "HTTP " + status), { status });

test("each offer is written, read back, and only then counted", async () => {
  const io = fakeIo({ prices: { a: 2, b: 3, c: 7 } });
  const out = await applyPlan(three(), io, FAST);
  assert.deepEqual(io.calls, ["reprice a 2.5", "read a", "reprice b 3.99", "read b", "reprice c 8.99", "read c"]);
  assert.deepEqual(io.kept, ["a 2.5", "b 3.99", "c 8.99"]);
  assert.deepEqual(out.done.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual([out.failed.length, out.stopped, out.left], [0, "", 0]);
  // settle after each write, a gap between offers, none after the last
  assert.deepEqual(io.slept, [1, 5, 1, 5, 1]);
});

test("rows that are not to be repriced are never sent", async () => {
  const rows = plan([offer("a", T("Rust", "120 Days"), 3.99), offer("b", T("Albion Online", "30 Days"), 2), offer("c", T("Rust", "30 Days"), 2)], {
    except: gameList("Albion Online"),
  });
  const io = fakeIo({ prices: { a: 3.99, b: 2, c: 2 } });
  await applyPlan(rows, io, FAST);
  assert.deepEqual(io.calls, ["reprice c 2.5", "read c"]);
});

test("a write Eldorado does not show afterwards is not counted", async () => {
  // The price call answers 2xx with what it was sent; the offer keeps its price.
  const io = fakeIo({ prices: { a: 2, b: 3, c: 7 }, onReprice: async (id, usd, io) => void (id === "b" ? 0 : (io.prices[id] = usd)) });
  const out = await applyPlan(three(), io, FAST);
  assert.deepEqual(out.done.map((r) => r.id), ["a", "c"]);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /^sent, not confirmed: Eldorado still shows \$3\.00 after the write$/);
  assert.deepEqual(io.kept, ["a 2.5", "c 8.99"]);
});

test("a read-back with no dollar price is not taken as agreement", async () => {
  const io = fakeIo({ onRead: () => ({ pricePerUnit: { amount: 400, currency: "JPY" } }) });
  const out = await applyPlan(three().slice(0, 1), io, FAST);
  assert.equal(out.done.length, 0);
  assert.match(out.failed[0].error, /could not be read back/);
});

test("'quota exceeded' stops the run at once, the rest untouched", async () => {
  const io = fakeIo({
    prices: { a: 2, b: 3, c: 7 },
    onReprice: async (id, usd, io) => {
      if (id === "b") throw httpError(429, "Eldorado reprice failed (HTTP 429): Whoa! Calm down, cowboy! Quota exceeded.");
      io.prices[id] = usd;
    },
  });
  const out = await applyPlan(three(), io, FAST);
  assert.deepEqual(io.calls, ["reprice a 2.5", "read a", "reprice b 3.99"]);
  assert.match(out.stopped, /quota exceeded/);
  assert.equal(out.left, 1);
  assert.deepEqual(out.done.map((r) => r.id), ["a"]);
});

test("a lapsed token is waited out and that same call tried again", async () => {
  let lapses = 2;
  const io = fakeIo({
    prices: { a: 2, b: 3, c: 7 },
    onReprice: async (id, usd, io) => {
      if (id === "b" && lapses-- > 0) throw new Error("Eldorado session refresh failed: this script never renews the Eldorado login — the live server does");
      io.prices[id] = usd;
    },
  });
  const out = await applyPlan(three(), io, FAST);
  assert.deepEqual(out.done.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(io.calls.filter((c) => c.startsWith("reprice b")).length, 3);
  assert.deepEqual(io.slept.filter((ms) => ms === 9).length, 2);
});

test("a token that lapses on the read-back does not send the price twice", async () => {
  let lapsed = false;
  const io = fakeIo({
    prices: { a: 2 },
    onRead: (id, io) => {
      if (!lapsed) {
        lapsed = true;
        throw httpError(401, "Eldorado offer failed (HTTP 401)");
      }
      return { pricePerUnit: { amount: io.prices[id], currency: "USD" } };
    },
  });
  const out = await applyPlan(three().slice(0, 1), io, FAST);
  assert.deepEqual(io.calls, ["reprice a 2.5", "read a", "read a"]);
  assert.equal(out.done.length, 1);
});

test("a token that never comes back stops the run", async () => {
  const io = fakeIo({ onReprice: async () => { throw httpError(401, "Eldorado reprice failed (HTTP 401)"); } });
  const out = await applyPlan(three(), io, FAST);
  assert.deepEqual(io.calls, ["reprice a 2.5", "reprice a 2.5", "reprice a 2.5"]);
  assert.match(out.stopped, /token did not come back/);
  assert.equal(out.left, 2);
});

test("three failures in a row stop the run; one success in between does not", async () => {
  const rows = plan(["a", "b", "c", "d", "e", "f"].map((id) => offer(id, T("Game " + id, "30 Days"), 2)));
  const failing = (bad) =>
    fakeIo({
      prices: Object.fromEntries(rows.map((r) => [r.id, 2])),
      onReprice: async (id, usd, io) => {
        if (bad.includes(id)) throw httpError(400, "Eldorado reprice failed (HTTP 400): no");
        io.prices[id] = usd;
      },
    });
  const stop = await applyPlan(rows, failing(["b", "c", "d"]), FAST);
  assert.match(stop.stopped, /3 failures in a row/);
  assert.deepEqual([stop.done.length, stop.failed.length, stop.left], [1, 3, 2]);
  const go = await applyPlan(rows, failing(["a", "b", "d", "e"]), FAST);
  assert.equal(go.stopped, "");
  assert.deepEqual(go.done.map((r) => r.id), ["c", "f"]);
});

/* ------------------------------ the login -------------------------------- */

// A real axios instance, so the headers are the ones the real module reads.
function guarded(respond) {
  const instance = axios.create({ adapter: async (config) => ({ data: {}, status: 200, statusText: "OK", config, ...respond(config) }) });
  const settings = { saveSettings: async () => "saved for real" };
  const seen = installSessionGuards({ axios: instance, settings });
  return { instance, settings, seen };
}

test("this process cannot renew the Eldorado login", async () => {
  let reached = 0;
  const { instance, seen } = guarded(() => (reached++, { headers: {} }));
  await assert.rejects(
    instance({ method: "POST", url: "https://www.eldorado.gg/api/authentication/refreshTokens", data: {} }),
    /never renews the Eldorado login/,
  );
  assert.equal(reached, 0);
  assert.equal(seen.refreshRefused, 1);
  await instance({ method: "GET", url: "https://www.eldorado.gg/api/authentication/claims" });
  assert.equal(reached, 1);
});

test("cookies an Eldorado response carries never reach the code that stores them", async () => {
  const { instance, seen } = guarded(() => ({ headers: { "set-cookie": ["__Host-EldoradoIdToken=new; Path=/"], "content-type": "application/json" } }));
  const r = await instance({ method: "PUT", url: "https://www.eldorado.gg/api/v1/item-management/me/offers/x/price", data: {} });
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(seen.cookiesDropped, 1);
  const other = await instance({ method: "GET", url: "https://app.talkjs.com/api/v0/x" });
  assert.deepEqual(other.headers["set-cookie"], ["__Host-EldoradoIdToken=new; Path=/"]);
  const lookalike = await instance({ method: "GET", url: "https://noteldorado.gg.example.com/x" });
  assert.notEqual(lookalike.headers["set-cookie"], undefined);
  assert.equal(seen.cookiesDropped, 1);
});

test("this process cannot save settings", async () => {
  const { settings, seen } = guarded(() => ({ headers: {} }));
  assert.equal(await settings.saveSettings({ marketplaces: {} }), undefined);
  assert.equal(seen.savesRefused, 1);
});

test("loading the tool does nothing by itself", () => {
  // It is required by this test file; the marketplace module must only load
  // from main(), after the guards. (utils/eldoradoFarmService above loads it
  // for the parser — so ask a fresh process.)
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    process.execPath,
    ["-e", 'require("./scripts/reprice-eldorado-farm.js");console.log(Object.keys(require.cache).filter((k)=>/utils\\/(marketplaces|settings)\\.js$|node_modules\\/axios\\//.test(k)).length)'],
    { cwd: require("node:path").join(__dirname, ".."), encoding: "utf8" },
  );
  assert.equal(out.trim().split("\n").pop(), "0");
});
