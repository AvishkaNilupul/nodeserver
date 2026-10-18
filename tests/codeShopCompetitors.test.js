// Code shop — Eldorado same-set competitor scan (utils/codeShop/competitors.js,
// docs/code-shop/03-MARKETS.md).
//
// What the pricing engine trusts from here is ONE number, lowestSameSetUsd.
// It must come only from offers that really sell the same set, never from one
// of our own offers (undercutting ourselves walks the price to the floor one
// cent per run), and never from a half-read market: a failed request keeps the
// previous scan as it was. And only from offers that have stock and ask at
// least 30 % of our base price (05-REVIEW-FIXES.md, R8): an empty or
// bait-priced listing must not drag our price down.
//
// The pure parts run plain. scan() runs against real Mongo (mongodb-memory-
// server) with an injected fetch and sleep, so nothing here reaches the
// internet. All ids, titles and prices are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeProduct = require("../models/CodeProduct");
const MarketplaceListing = require("../models/MarketplaceListing");
const {
  createCompetitors,
  queriesFor,
  scoreOffer,
  phrasesOf,
  deliveryForm,
  parseSearch,
  countsForLowest,
  MIN_PRICE_SHARE,
} = require("../utils/codeShop/competitors");

const slots = (...labels) => labels.map((label, i) => ({ slotKey: "s" + i, label }));

// --- queriesFor ---------------------------------------------------------------

test("queriesFor: the two longest labels and the game's name", () => {
  const product = { slots: slots("Moon Spray", "Sun Tea Player Icon", "Star Banner", "Ana") };
  assert.deepEqual(queriesFor(product, { displayName: "Overwatch 2" }), [
    "Sun Tea Player Icon",
    "Star Banner",
    "Overwatch 2",
  ]);
});

test("queriesFor: equal lengths keep slot order; blanks and duplicates are dropped", () => {
  const product = { slots: slots("", "Aaaa Bbbb", "aaaa-bbbb", "Cccc Dddd") };
  assert.deepEqual(queriesFor(product, { displayName: "Delta Force" }), [
    "Aaaa Bbbb",
    "Cccc Dddd",
    "Delta Force",
  ]);
  assert.deepEqual(queriesFor({ slots: slots("One Label") }, null), ["One Label"]);
  assert.deepEqual(queriesFor({ slots: [] }, { displayName: "" }), []);
  assert.deepEqual(queriesFor({}, { displayName: "Overwatch 2" }), ["Overwatch 2"]);
});

test("queriesFor: saved queries win over the defaults", () => {
  const product = {
    slots: slots("Sun Tea Player Icon", "Star Banner"),
    competitors: { queries: [" spring icons ", "", "Spring Icons", "banner"] },
  };
  assert.deepEqual(queriesFor(product, { displayName: "Overwatch 2" }), ["spring icons", "banner"]);
  // An empty saved list is "not set".
  product.competitors.queries = [];
  assert.equal(queriesFor(product, { displayName: "Overwatch 2" }).length, 3);
});

// --- scoreOffer ---------------------------------------------------------------

test("scoreOffer: a label matches as a substring of the title", () => {
  assert.deepEqual(scoreOffer("Overwatch 2 Sun Tea Player Icon code", ["Sun Tea Player Icon"]), {
    score: 1,
    sameSet: true,
    matches: 1,
    matchedIn: "title",
  });
});

test("scoreOffer: or when the title holds every >=4-letter word of the label", () => {
  // "Sun" and "Tea" are short and may be missing or moved; "player" and "icon" must be there.
  assert.equal(scoreOffer("Player icon bundle", ["Sun Tea Player Icon"]).score, 1);
  assert.equal(scoreOffer("Icon of the player", ["Sun Tea Player Icon"]).score, 1);
  assert.equal(scoreOffer("Player card bundle", ["Sun Tea Player Icon"]).score, 0, "'icon' missing");
});

test("scoreOffer: case and punctuation do not matter", () => {
  assert.equal(scoreOffer("SUN-TEA_player.icon!!", ["Sun Tea: Player Icon"]).score, 1);
  assert.equal(scoreOffer("sun tea player icon", ["SUN/TEA PLAYER-ICON"]).score, 1);
});

test("scoreOffer: a label with no >=4-letter word matches only as a substring", () => {
  assert.equal(scoreOffer("Ana Mei spray", ["Ana"]).score, 1);
  assert.equal(scoreOffer("Mei spray", ["Ana Mei"]).score, 0, "no long word to fall back on");
  assert.equal(scoreOffer("Mei and Ana spray", ["Ana Mei"]).score, 0);
});

test("scoreOffer: score is the fraction of labels matched; sameSet needs 0.8", () => {
  const labels = ["Moon Spray", "Star Banner", "Comet Charm", "Nova Title", "Sun Icon"];
  const r4 = scoreOffer("Moon Spray + Star Banner + Comet Charm + Nova Title", labels);
  assert.equal(r4.score, 0.8);
  assert.equal(r4.matches, 4);
  assert.equal(r4.sameSet, true);
  const r3 = scoreOffer("Moon Spray + Star Banner + Comet Charm", labels);
  assert.equal(r3.score, 0.6);
  assert.equal(r3.sameSet, false);
  const third = scoreOffer("Moon Spray", ["Moon Spray", "Star Banner", "Comet Charm"]);
  assert.equal(third.score, 1 / 3);
  assert.equal(third.sameSet, false);
  assert.deepEqual(scoreOffer("anything", []), { score: 0, sameSet: false, matches: 0, matchedIn: "" });
  assert.deepEqual(scoreOffer("anything", ["", "--"]), { score: 0, sameSet: false, matches: 0, matchedIn: "" });
  assert.equal(scoreOffer(null, ["Moon Spray"]).score, 0);
  assert.equal(scoreOffer(null, ["Moon Spray"]).matchedIn, "");
});

// Most rivals list these rewards as Twitch drops: "19 Rewards" in the title,
// the reward list only in the description.
test("scoreOffer: a description names the rewards the title leaves out", () => {
  const labels = ["Moon Spray", "Star Banner", "Comet Charm", "Nova Title", "Sun Icon"];
  const r = scoreOffer("Space Game Twitch Drops | 19 Rewards", labels, "You get:\n- Moon Spray\n- Star Banner\n- Comet Charm\n- Nova Title");
  assert.equal(r.score, 0.8);
  assert.equal(r.sameSet, true);
  assert.equal(r.matchedIn, "description");
  // The title alone still decides when it names every matched label.
  const t = scoreOffer("Moon Spray + Star Banner + Comet Charm + Nova Title + Sun Icon", labels, "Moon Spray and more");
  assert.equal(t.score, 1);
  assert.equal(t.matchedIn, "title");
  // Title and description together.
  const both = scoreOffer("Moon Spray + Star Banner", labels, "Also: Comet Charm, Nova Title, Sun Icon");
  assert.equal(both.score, 1);
  assert.equal(both.matchedIn, "description");
  assert.equal(scoreOffer("Space Game Twitch Drops", labels, "").score, 0);
});

test("scoreOffer: in a description a label must appear as a phrase, never as loose words", () => {
  // A description lists many OTHER rewards: the title's loose word rule would
  // put "Banana Cat" and "Spray" of two different rewards together.
  const desc = "Rewards: Banana Cat Icon - Prost Spray - Player Card - Sun Tea Icon";
  assert.equal(scoreOffer("Twitch Drops", ["Banana Cat Spray"], desc).score, 0);
  assert.equal(scoreOffer("Twitch Drops", ["Banana Cat Icon"], desc).score, 1);
  assert.equal(scoreOffer("Twitch Drops", ["Protein Drink Player Icon"], desc).score, 0, "'player' and 'icon' alone are not a reward");
  assert.equal(scoreOffer("Twitch Drops", ["Prost Spray"], "Spray: Prost").score, 0, "words out of order");
  // The same words in a title still match by the loose rule.
  assert.equal(scoreOffer("Banana Cat Icon + Prost Spray", ["Banana Cat Spray"]).score, 1);
});

test("scoreOffer: accents fold, 'player' / 'code' and our '(...)' notes are optional, spaces inside a name do not count", () => {
  const m = (label, desc) => scoreOffer("Twitch Drops", [label], desc).score;
  assert.equal(m("Skal Spray", "Skål Spray"), 1, "Skål = Skal");
  assert.equal(m("Skål Spray", "skal sprays"), 1);
  assert.equal(m("Sun Tea Player Icon", "Sun Tea Icon"), 1, "rivals drop 'Player'");
  assert.equal(m("Sun Tea Player Icon", "SUN TEA PLAYER ICON"), 1);
  assert.equal(m("Esports Loot Box", "1x Esports Lootbox"), 1);
  assert.equal(m("Autumn Vibes Name Card", "Autumn Vibes Namecard"), 1);
  assert.equal(m("Standard Issue Gear Ticket x1 (2nd code)", "Standard Issue Gear Ticket x1"), 1);
  assert.equal(m("QBZ95-1 - Delta Force (weapon skin)", "QBZ95-1 - Delta Force skin"), 1);
  // A count is part of the reward: x3 and x1 vouchers are different slots.
  assert.equal(m("Logistics Voucher x3", "Logistics Voucher x1"), 0);
  assert.equal(m("Logistics Voucher x3", "Logistics Voucher x3"), 1);
});

test("scoreOffer: a short phrase matches only as whole words", () => {
  const m = (label, desc) => scoreOffer("Twitch Drops", [label], desc).score;
  assert.equal(m("Ana", "Banana Cat Icon"), 0);
  assert.equal(m("Ana", "Ana skin, Mei spray"), 1);
  assert.equal(m("Sun Icon", "Sunset Icons"), 0);
  assert.equal(m("Sun Icon", "a Sun Icon"), 1);
});

test("phrasesOf: the label without '(...)' notes, and without 'player' / 'code' too", () => {
  assert.deepEqual(phrasesOf("Sun Tea Player Icon"), ["sun tea player icon", "sun tea icon"]);
  assert.deepEqual(phrasesOf("Standard Issue Gear Ticket x1 (2nd code)"), ["standard issue gear ticket x1"]);
  assert.deepEqual(phrasesOf("Skål Spray"), ["skal spray"]);
  assert.deepEqual(phrasesOf("(note only)"), []);
  assert.deepEqual(phrasesOf(null), []);
});

// --- deliveryForm -------------------------------------------------------------

// Nearly every rival sells these rewards as a Twitch-drop ACCOUNT (log in,
// link, claim within about two weeks); we sell redeem codes that last months.
// Two different products: only a code seller may set our price (R10).

test("deliveryForm: a code seller saying what it does NOT need is still a code seller", () => {
  const ours =
    "Code Bundle (5 redeem codes)\n- Redeem on your OWN Battle.net account - no account sharing, no login details needed\n" +
    "- No Twitch account or account linking needed - you redeem the codes yourself\n- A code can be used only once";
  assert.equal(deliveryForm("Space Game | 5 Codes Bundle | Redeem Codes", ours), "codes");
  assert.equal(deliveryForm("Space Game codes", "Login is not required. Just redeem the code."), "codes");
  assert.equal(deliveryForm("Space Game Starter Pack KEY", "Digital key, activate it on the store."), "codes");
});

test("deliveryForm: a Twitch-drop account offer is an account, even when it mentions a code", () => {
  assert.equal(
    deliveryForm(
      "Space Game | 13 Twitch Drops Rewards",
      "You get a Twitch account holding the drops. Log in, link your game account and claim every reward. " +
        "Enter the code sent to the email if asked.",
    ),
    "account",
  );
  assert.equal(deliveryForm("TWITCH DROPS SPACE GAME | 6/6 ITEMS", ""), "account", "the title alone says Twitch drops");
});

// 2026-10-18: a real code bundle on another market said once that the buyer
// "receives the codes", but also "linked to your account", "claimed on
// Twitch" and "claim the items" — three account words to one code word, so it
// read as an account offer and could never have set our price.
test("deliveryForm: an offer that says it hands over codes is a code seller, even when it says claim and linked", () => {
  const bundle =
    "Unlock every reward with one purchase: icons, sprays, name cards. Works on any platform you have linked to " +
    "your game account. Boxes may not work if you already claimed them on Twitch or video sites. NOTE: no refunds " +
    "after the customer receives the codes through our service. We are not responsible if you claim the items " +
    "on the wrong account.";
  assert.equal(deliveryForm("Space Game Mega-Bundle | 50 ITEMS | FAST DELIVERY", bundle), "codes");
  for (const said of [
    "Codes are delivered within 24 hours.",
    "You will receive 6 unused redeem codes.",
    "Enter the code on Battle.net to unlock it.",
    "Delivery of the codes by chat right after payment.",
    "The codes will be sent in the order chat.",
  ]) {
    assert.equal(deliveryForm("Space Game Sprays", "Claim them on your linked account. " + said), "codes", said);
  }
  assert.equal(deliveryForm("Space Game Skin (Enter Code on Blizzard Site - No Password)", ""), "codes", "the title alone says so");
});

test("deliveryForm: handing over an account (or its login) keeps an offer an account, whatever it says of codes", () => {
  assert.equal(
    deliveryForm("Space Game | 13 Twitch Drops", "You receive a Twitch account. Log in to the account, link and claim. Codes are delivered too."),
    "account",
  );
  assert.equal(
    deliveryForm("Space Game drops", "You get the account details (email and password); you will receive the codes for the login."),
    "account",
  );
  assert.equal(deliveryForm("Space Game drops", "We send you an account. Log in; you receive 3 codes inside it and claim them."), "account");
});

// The independent review of 2026-10-18 found account sellers that the first
// cut of R11 read as code sellers: the account was handed over in the passive
// or "-ing" form, and the code was a login (guard) code.
test("deliveryForm: an offer that hands over an account is an account offer, in every form", () => {
  for (const d of [
    "Account delivered within minutes. If the store asks, the guard code will be sent to you in chat.",
    "Upon receiving the account, enter the code on the official site to finish.",
    "Account will be sent in chat, you will receive the code to log in.",
    "After getting your account, codes are delivered too.",
    "The accounts are provided right after payment; redeem codes inside.",
  ]) {
    assert.equal(deliveryForm("Space Game drops", d), "account", d);
  }
  // Only "codes" can set our price; "unknown" is as safe as "account" here.
  assert.notEqual(
    deliveryForm("Space Game Twitch Drops Account | 13 items", "You will receive the codes for the 13 items."),
    "codes",
    "a title that sells an account or Twitch drops never takes the code shortcut",
  );
});

test("deliveryForm: a login code from the email or 2FA is not the product", () => {
  // Each would read as "codes are sent" or "receive the code" if login codes counted.
  assert.equal(deliveryForm("Space Game Twitch Drops", "Log in and claim. The code is sent to your email when you log in."), "account");
  assert.equal(deliveryForm("Space Game Twitch Drops", "Link your account. You will receive a verification code; claim the drops."), "account");
  assert.equal(deliveryForm("Space Game Twitch Drops", "Claim the drops. The 2FA codes will be sent on request."), "account");
  assert.equal(
    deliveryForm("SPACE GAME | Twitch Drops | 19 Rewards", "Please redeem the drops within the first hour after delivery. Log in, link and claim."),
    "account",
    "redeeming drops is not redeeming a code",
  );
});

test("deliveryForm: a statement does not run across lines", () => {
  // "...FAST DELIVERY" ending one line and "Codes..." starting the next is not "delivery of codes".
  assert.equal(
    deliveryForm("SPACE GAME TWITCH DROPS | FAST DELIVERY", "Codes inside the drops are claimed by you after you log in and link."),
    "account",
  );
});

test("deliveryForm: no wording either way, or a tie, is unknown", () => {
  assert.equal(deliveryForm("Space Game | Rare Icons Bundle", ""), "unknown");
  assert.equal(deliveryForm("", null), "unknown");
  assert.equal(deliveryForm("Space Game code", "log in"), "unknown");
});

// --- parseSearch --------------------------------------------------------------

test("parseSearch: USD price first, else a USD pricePerUnit, else null", () => {
  const json = {
    results: [
      {
        offer: {
          id: "o-1",
          offerTitle: "First",
          userId: "u-1",
          pricePerUnitInUSD: { amount: 1.25 },
          pricePerUnit: { amount: 99, currency: "EUR" },
          quantity: 7,
          description: "Moon Spray and Star Banner",
        },
      },
      { offer: { id: "o-2", offerTitle: "Second", userId: "u-2", pricePerUnit: { amount: 2.5, currency: "USD" }, quantity: 1 } },
      { offer: { id: "o-3", offerTitle: "Third", userId: "u-3", pricePerUnit: { amount: 3, currency: "EUR" }, quantity: 2 } },
      { offer: { id: 4 } },
      { offer: { offerTitle: "no id" } },
      { notAnOffer: true },
      null,
    ],
  };
  assert.deepEqual(parseSearch(json), [
    { id: "o-1", title: "First", description: "Moon Spray and Star Banner", userId: "u-1", priceUsd: 1.25, qty: 7 },
    { id: "o-2", title: "Second", description: "", userId: "u-2", priceUsd: 2.5, qty: 1 },
    { id: "o-3", title: "Third", description: "", userId: "u-3", priceUsd: null, qty: 2 },
    { id: "4", title: "", description: "", userId: "", priceUsd: null, qty: 0 },
  ]);
});

test("parseSearch: a description that is not text is empty, a long one is capped", () => {
  const long = "x".repeat(9000);
  const out = parseSearch({
    results: [
      { offer: { id: "a", offerTitle: "A", description: { html: "no" } } },
      { offer: { id: "b", offerTitle: "B", description: long } },
    ],
  });
  assert.equal(out[0].description, "");
  assert.equal(out[1].description.length, 5000);
});

test("parseSearch: anything that is not a results list is an empty list", () => {
  assert.deepEqual(parseSearch(null), []);
  assert.deepEqual(parseSearch({}), []);
  assert.deepEqual(parseSearch({ results: "nope" }), []);
  assert.deepEqual(parseSearch("text"), []);
});

// --- scan (real Mongo, fake market) -------------------------------------------

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopcompetitors"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const NOW = Date.parse("2026-10-15T12:00:00Z");
const LABELS = ["Moon Spray", "Star Banner", "Comet Charm", "Nova Title", "Sun Icon"];
const FULL = LABELS.join(" + ");

function offer(id, title, price, extra = {}) {
  return {
    offer: {
      id,
      offerTitle: title,
      userId: extra.userId || "seller-" + id,
      pricePerUnitInUSD: price === null ? undefined : { amount: price },
      quantity: extra.qty === undefined ? 3 : extra.qty,
      // A code seller unless the test says otherwise: only those set our price.
      description: extra.description === undefined ? "Redeem codes, delivered at once." : extra.description,
    },
  };
}

// Filler that matches no label, to make a page exactly 50 long.
function filler(prefix, n) {
  return Array.from({ length: n }, (_, i) => offer(prefix + "-" + i, "Unrelated gold coins " + i, 0.1));
}

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// pages: { [query]: [page1Results, page2Results, ...] }; anything else is empty.
function fakeMarket(pages, { fail } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const q = u.searchParams.get("searchQuery");
    const page = Number(u.searchParams.get("pageIndex"));
    if (fail) {
      const f = fail(q, page);
      if (f) return f();
    }
    const list = (pages[q] || [])[page - 1] || [];
    return reply({ results: list });
  };
  return { fetch, calls };
}

function harness(market, cfg = {}) {
  const sleeps = [];
  const logged = [];
  const order = [];
  const fetch = async (...a) => {
    order.push("fetch");
    return market.fetch(...a);
  };
  const competitors = createCompetitors({
    models: { CodeProduct, MarketplaceListing },
    fetch,
    sleep: async (ms) => {
      order.push("sleep");
      sleeps.push(ms);
    },
    now: () => NOW,
    config: { get: async () => ({ ownEldoradoUserIds: [], games: {}, ...cfg }) },
    events: { log: async (e) => (logged.push(e), true) },
  });
  return { competitors, sleeps, logged, order };
}

let seq = 0;
async function product(extra = {}) {
  seq += 1;
  return CodeProduct.create({
    name: "Test bundle " + seq,
    gameNo: "12",
    status: "active",
    slots: slots(...LABELS),
    ...extra,
  });
}

test("scan: pages until a short page (max 3), paced between every request", async () => {
  const p = await product({ competitors: { queries: ["alpha", "beta", "gamma"] } });
  const market = fakeMarket({
    alpha: [filler("a1", 50), filler("a2", 50), filler("a3", 50), filler("a4", 50)],
    beta: [filler("b1", 50), [offer("b-hit", FULL, 2)]],
    gamma: [],
  });
  const h = harness(market);
  await h.competitors.scan(p);

  const seen = market.calls.map((c) => {
    const u = new URL(c.url);
    return u.searchParams.get("searchQuery") + "#" + u.searchParams.get("pageIndex");
  });
  assert.deepEqual(seen, ["alpha#1", "alpha#2", "alpha#3", "beta#1", "beta#2", "gamma#1"]);
  assert.deepEqual(h.sleeps, [1500, 1500, 1500, 1500, 1500]);
  assert.deepEqual(h.order, ["fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch"]);

  const first = new URL(market.calls[0].url);
  assert.equal(first.origin + first.pathname, "https://www.eldorado.gg/api/v1/item-management/offers");
  assert.equal(first.searchParams.get("gameId"), "235");
  assert.equal(first.searchParams.get("category"), "CustomItem");
  assert.equal(first.searchParams.get("pageSize"), "50");
  const headers = market.calls[0].init.headers;
  assert.equal(headers.accept, "application/json");
  assert.match(headers["user-agent"], /Mozilla\/5\.0/);
});

test("scan: default queries are used and encoded, and not stored as pinned", async () => {
  const p = await product();
  const market = fakeMarket({});
  const h = harness(market);
  const res = await h.competitors.scan(p);
  // Worked-out queries are used but not stored: only pinned ones are kept.
  assert.match(market.calls[0].url, /searchQuery=Star%20Banner$/);
  assert.equal(market.calls.length, 3);
  assert.deepEqual(res.queries, []);
  const saved = await CodeProduct.findById(p._id).lean();
  assert.deepEqual(saved.competitors.queries, []);
  assert.equal(saved.competitors.lowestSameSetUsd, null);
  assert.deepEqual(saved.competitors.offers, []);
  assert.equal(saved.competitors.scannedAt.getTime(), NOW);
});

test("scan: our own offers (seller id or a listing we hold) are not competitors", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  // insertMany: no save hook, so no audit-log write racing the disconnect.
  await MarketplaceListing.insertMany([
    {
      accountOffer: new mongoose.Types.ObjectId(),
      marketplace: "eldorado",
      externalId: "ours-listed",
      status: "delisted",
      price: 1,
    },
  ]);
  const market = fakeMarket({
    set: [
      [
        offer("ours-listed", FULL, 0.6),
        offer("ours-by-seller", FULL, 0.7, { userId: "me-1" }),
        offer("theirs", FULL, 1.8),
      ],
    ],
  });
  const h = harness(market, { ownEldoradoUserIds: ["me-1"] });
  const res = await h.competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["theirs"]);
  assert.equal(res.lowestSameSetUsd, 1.8);
});

test("scan: top 15 by score then price; lowest same-set price only from same-set offers", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const fullSet = Array.from({ length: 12 }, (_, i) => offer("full-" + i, FULL, 3 + i * 0.1));
  const fourOfFive = [offer("four-a", "Moon Spray Star Banner Comet Charm Nova Title", 2.4), offer("four-b", "Moon Spray Star Banner Comet Charm Sun Icon", 2.2)];
  const threeOfFive = Array.from({ length: 4 }, (_, i) => offer("three-" + i, "Moon Spray Star Banner Comet Charm", 0.9 + i * 0.01));
  const unpriced = [offer("full-no-price", FULL, null)];
  const noMatch = [offer("junk", "Gold coins", 0.05)];
  // Same offer found twice (another page / query) counts once.
  const market = fakeMarket({
    set: [[...fullSet, ...fourOfFive, ...threeOfFive, ...unpriced, ...noMatch, offer("full-0", FULL, 3)]],
  });
  const h = harness(market);
  const res = await h.competitors.scan(p);

  assert.equal(res.offers.length, 15);
  const ids = res.offers.map((o) => o.id);
  assert.deepEqual(ids.slice(0, 12), fullSet.map((o) => o.offer.id), "full sets first, cheapest first");
  assert.deepEqual(ids.slice(12), ["four-b", "four-a", "three-0"]);
  assert.ok(!ids.includes("junk"), "no-match offers are not competitors");
  assert.ok(!ids.includes("full-no-price"), "an offer without a dollar price is skipped");
  assert.equal(res.offers[12].score, 0.8);
  assert.equal(res.offers[12].sameSet, true);
  assert.equal(res.offers[14].sameSet, false);
  // The 3-of-5 offers are far cheaper, but they are not the same set.
  assert.equal(res.lowestSameSetUsd, 2.2);

  const saved = await CodeProduct.findById(p._id).lean();
  assert.equal(saved.competitors.offers.length, 15);
  assert.equal(saved.competitors.lowestSameSetUsd, 2.2);
  assert.equal(saved.competitors.offers[0].id, "full-0");
  assert.equal(saved.competitors.offers[0].qty, 3);
});

test("scan: no same-set offer means lowestSameSetUsd is null", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const market = fakeMarket({ set: [[offer("partial", "Moon Spray Star Banner", 0.9)]] });
  const res = await harness(market).competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["partial"]);
  assert.equal(res.lowestSameSetUsd, null);
});

test("scan: a rival naming the set only in its description counts; the description is never stored", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 1 } });
  const list = "Rewards:\n- " + LABELS.join("\n- ");
  const market = fakeMarket({
    set: [
      [
        offer("drops-desc", "Space Game Code Bundle | 19 Rewards", 0.8, { description: "Redeem codes. " + list }),
        offer("title-full", FULL, 1.5),
        offer("drops-loose", "Space Game Code Bundle", 0.6, { description: "Redeem codes: Moon Charm, Star Icon, Comet Banner" }),
      ],
    ],
  });
  const h = harness(market);
  const res = await h.competitors.scan(p);

  assert.deepEqual(res.offers.map((o) => [o.id, o.sameSet, o.matchedIn]), [
    ["drops-desc", true, "description"],
    ["title-full", true, "title"],
  ]);
  assert.equal(res.lowestSameSetUsd, 0.8, "the description-only rival is the lowest same-set price");

  const saved = await CodeProduct.findById(p._id).lean();
  assert.equal(saved.competitors.offers[0].matchedIn, "description");
  assert.ok(!("description" in saved.competitors.offers[0]), "the rival's text is read, not kept");
  const ev = h.logged.find((e) => e.kind === "competitors");
  assert.equal(ev.data.byDescription, 1);
  assert.match(ev.msg, /1 named in the description only/);
});

test("scan: only code sellers set the lowest price; Twitch-drop accounts and unclear offers are only listed (R10)", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 1 } });
  const accountText = "A Twitch account with the drops: log in, link your game account and claim. " + FULL;
  const market = fakeMarket({
    set: [
      [
        offer("acct-cheap", "Space Game Twitch Drops | 19 Rewards", 0.4, { description: accountText }),
        offer("unclear", FULL, 0.5, { description: "" }),
        offer("codes", FULL, 0.9),
      ],
    ],
  });
  const h = harness(market);
  const res = await h.competitors.scan(p);

  assert.deepEqual(
    res.offers.map((o) => [o.id, o.sameSet, o.form]).sort(),
    [
      ["acct-cheap", true, "account"],
      ["codes", true, "codes"],
      ["unclear", true, "unknown"],
    ],
  );
  assert.equal(res.lowestSameSetUsd, 0.9, "the cheaper account and unclear offers never set our price");
  const saved = await CodeProduct.findById(p._id).lean();
  assert.deepEqual(saved.competitors.offers.map((o) => o.form).sort(), ["account", "codes", "unknown"]);
  const ev = h.logged.find((e) => e.kind === "competitors");
  assert.deepEqual(ev.data.byForm, { codes: 1, account: 1, unknown: 1 });
  assert.match(ev.msg, /they sell codes 1, Twitch accounts 1, unclear 1; 1 same-set code seller counts/);

  // Only account sellers: nothing to follow.
  const q = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 1 } });
  const res2 = await harness(fakeMarket({ set: [[offer("acct", FULL, 0.4, { description: accountText })]] })).competitors.scan(q);
  assert.equal(res2.lowestSameSetUsd, null);
});

test("scan: a failed request keeps the old scan and logs a warning", async () => {
  const old = {
    scannedAt: new Date(NOW - 86400000),
    queries: ["set"],
    lowestSameSetUsd: 1.5,
    offers: [{ id: "prev", title: FULL, priceUsd: 1.5, qty: 1, score: 1, sameSet: true }],
  };
  const failures = {
    "HTTP 500": () => reply({ error: "boom" }, 500),
    "network error": () => {
      throw new Error("socket hang up");
    },
    "bad JSON": () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }),
    "no results list": () => reply({ message: "maintenance" }),
  };
  for (const [what, fail] of Object.entries(failures)) {
    const p = await product({ competitors: old });
    // Page 1 is fine and full; page 2 fails: nothing from page 1 may be saved.
    const market = fakeMarket(
      { set: [[offer("cheap", FULL, 0.7), ...filler("f", 49)]] },
      { fail: (q, page) => (page === 2 ? fail : null) },
    );
    const h = harness(market);
    const res = await h.competitors.scan(p);
    assert.equal(market.calls.length, 2, what);
    assert.equal(res.lowestSameSetUsd, 1.5, what);
    const saved = await CodeProduct.findById(p._id).lean();
    assert.equal(saved.competitors.lowestSameSetUsd, 1.5, what);
    assert.equal(saved.competitors.scannedAt.getTime(), old.scannedAt.getTime(), what);
    assert.deepEqual(saved.competitors.offers.map((o) => o.id), ["prev"], what);
    assert.equal(h.logged.length, 1, what);
    assert.equal(h.logged[0].level, "warn", what);
    assert.equal(h.logged[0].kind, "competitors", what);
    assert.equal(String(h.logged[0].product), String(p._id), what);
  }
});

test("scan: loads the product by id too", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const market = fakeMarket({ set: [[offer("x", FULL, 1.1)]] });
  const res = await harness(market).competitors.scan(String(p._id));
  assert.equal(res.lowestSameSetUsd, 1.1);
});

// ── R8: which same-set offers set the lowest price ─────────────────────────

test("countsForLowest: same set, at least one in stock, at least 30 % of our base price", () => {
  const o = (fields) => ({ sameSet: true, qty: 2, priceUsd: 1, form: "codes", ...fields });
  assert.equal(MIN_PRICE_SHARE, 0.3);
  assert.equal(countsForLowest(o({}), 2), true);
  assert.equal(countsForLowest(o({ form: "account" }), 2), false, "a Twitch-drop account is another product");
  assert.equal(countsForLowest(o({ form: "unknown" }), 2), false);
  assert.equal(countsForLowest(o({ form: undefined }), 2), false);
  assert.equal(countsForLowest(o({ sameSet: false }), 2), false);
  assert.equal(countsForLowest(o({ qty: 0 }), 2), false);
  assert.equal(countsForLowest(o({ priceUsd: 0.6 }), 2), true, "exactly 30 % counts");
  assert.equal(countsForLowest(o({ priceUsd: 0.59 }), 2), false);
  assert.equal(countsForLowest(o({ priceUsd: null }), 2), false);
  // No usable base price: only the stock rule applies.
  assert.equal(countsForLowest(o({ priceUsd: 0.01 }), 0), true);
  assert.equal(countsForLowest(o({ priceUsd: 0.01 }), null), true);
});

test("scan: an out-of-stock or bait-priced same-set offer is listed but does not set the lowest price", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 4 } });
  const market = fakeMarket({
    set: [
      [
        offer("empty", FULL, 1.5, { qty: 0 }),
        offer("bait", FULL, 1.19),
        offer("floor", FULL, 1.2),
        offer("real", FULL, 3.5),
      ],
    ],
  });
  const res = await harness(market).competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["bait", "floor", "empty", "real"]);
  assert.equal(res.lowestSameSetUsd, 1.2, "30 % of $4 is $1.20: the first offer that counts");
  const saved = await CodeProduct.findById(p._id).lean();
  assert.equal(saved.competitors.lowestSameSetUsd, 1.2);

  // Nothing that counts: no lowest price at all.
  const q = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 10 } });
  const none = await harness(fakeMarket({ set: [[offer("cheap", FULL, 2.5), offer("gone", FULL, 4, { qty: 0 })]] })).competitors.scan(q);
  assert.equal(none.offers.length, 2);
  assert.equal(none.lowestSameSetUsd, null);
});

test("scan: a product passed without its pricing has its base price read", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 5 } });
  const partial = { _id: p._id, name: p.name, gameNo: p.gameNo, slots: p.slots, competitors: p.competitors };
  const res = await harness(fakeMarket({ set: [[offer("bait", FULL, 1), offer("real", FULL, 2)]] })).competitors.scan(partial);
  assert.equal(res.lowestSameSetUsd, 2);
});
