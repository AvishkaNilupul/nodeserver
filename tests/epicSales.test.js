// Pure parts of the Epic account sales system (utils/epicSales.js and the
// Eldorado Account-offer connector). The flows that need a database live in
// tests/epicSalesFlow.test.js.
//
// What these pin, because each one is a way to lose money or leak something:
//  - what goes into the delivery entry a buyer receives (and that the
//    unencrypted note carries no secret),
//  - the inbox rule: the account's own "epic" use never blocks, SOOP sharing
//    only while that switch is on, any other site always blocks,
//  - listing text never claims "full access" and never carries the rent-farm
//    phrase the farm service keys on.
process.env.CRED_SECRET ||= "epic-sales-unit-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const sales = require("../utils/epicSales");
const eld = require("../utils/eldoradoAccountOffers");
const BuyerMailSession = require("../models/BuyerMailSession");

test("gameKey ignores order, case and duplicates", () => {
  assert.equal(sales.gameKey(["Sker Ritual", "Home - A Unique Horror Adventure"]), sales.gameKey(["home - a unique horror adventure", "SKER RITUAL", "Sker Ritual"]));
  assert.equal(sales.gameKey([]), "");
});

test("gameTitles reads the library, de-duplicated and sorted", () => {
  const acc = { library: [{ title: "Sker Ritual" }, { title: "Home - A Unique Horror Adventure" }, { title: "sker ritual" }, { title: "" }] };
  assert.deepEqual(sales.gameTitles(acc), ["Home - A Unique Horror Adventure", "Sker Ritual"]);
});

test("titles stay within Eldorado's limits and never say full access or Automatic Farming", () => {
  const many = Array.from({ length: 30 }, (_, i) => "A Very Long Game Title Number " + i);
  for (const games of [[], ["Sker Ritual"], ["Sker Ritual", "Home - A Unique Horror Adventure"], many]) {
    const t = sales.suggestTitle(games);
    assert.ok(t.length >= 5 && t.length <= 160, t);
    assert.doesNotMatch(t, /full access/i);
    assert.doesNotMatch(t, /automatic\s+farming/i);
  }
  assert.match(sales.suggestTitle(many), /\+ 27 more/);
});

test("description lists the games, states the mail page window, fits 2000 chars", () => {
  const d = sales.suggestDescription(["Sker Ritual", "Home - A Unique Horror Adventure"], 7);
  assert.match(d, /• Sker Ritual/);
  assert.match(d, /for 7 days/);
  assert.match(d, /change the account email to your own/i);
  assert.doesNotMatch(d, /full access/i);
  assert.doesNotMatch(d, /https?:\/\//i, "no links to our own site in the public description");
  assert.ok(sales.suggestDescription(Array.from({ length: 300 }, (_, i) => "Game " + i), 7).length <= 2000);
});

test("the unencrypted delivery note carries no secret and fits 1000 chars", () => {
  const note = sales.additionalInfoText(7);
  assert.ok(note.length <= eld.MAX_ADDITIONAL_INFO);
  assert.match(note, /7 days/);
  const e = sales.entryFor({
    email: "buyer.test@outlook.com",
    epicPassword: "EpicPw-123",
    mailPassword: "MailPw-456",
    purl: "https://example.test/mail/",
    days: 7,
  });
  assert.equal(e.accountLogin, "buyer.test@outlook.com");
  assert.equal(e.accountPassword, "EpicPw-123");
  assert.equal(e.emailProviderUrl, "https://example.test/mail/");
  assert.equal(e.emailLogin, "buyer.test@outlook.com");
  assert.equal(e.emailPassword, "MailPw-456");
  assert.ok(!e.additionalInfo.includes("EpicPw-123") && !e.additionalInfo.includes("MailPw-456"));
});

test("inboxVerdict: own epic use never blocks; SOOP only while allowed; anything else blocks", () => {
  const allow = { allowSharedInbox: true };
  const deny = { allowSharedInbox: false };
  // Old proxy answer (counts "epic" as sharing) and new proxy answer.
  assert.equal(sales.inboxVerdict({ status: "live", sharedWith: ["epic"] }, deny).ok, true);
  assert.equal(sales.inboxVerdict({ status: "live", sharedWith: [] }, deny).ok, true);
  const soopOk = sales.inboxVerdict({ status: "live", sharedWith: ["soop", "epic"] }, allow);
  assert.equal(soopOk.ok, true);
  assert.match(soopOk.warn, /SOOP/);
  assert.equal(sales.inboxVerdict({ status: "live", sharedWith: ["soop"] }, deny).ok, false);
  const twitch = sales.inboxVerdict({ status: "live", sharedWith: ["soop", "twitch"] }, allow);
  assert.equal(twitch.ok, false);
  assert.match(twitch.text, /twitch/);
  assert.equal(sales.inboxVerdict({ status: "unknown", sharedWith: [] }, allow).code, "unknown_inbox");
  assert.equal(sales.inboxVerdict(null, allow).code, "proxy");
  assert.equal(sales.inboxVerdict({ error: "proxy_unconfigured" }, allow).code, "proxy");
});

test("readinessOf: sold, listed, blocked and ready, with the reasons", () => {
  const { encrypt } = require("../utils/secretBox");
  const base = {
    _id: "0123456789abcdef01234567",
    status: "ok",
    library: [{ title: "Sker Ritual" }],
    email: encrypt("a.test@outlook.com"),
    password: encrypt("pw"),
  };
  const ctx = {
    cfg: { allowSharedInbox: true },
    listingByAccount: new Map(),
    checks: new Map([["a.test@outlook.com", { status: "live", sharedWith: ["soop", "epic"] }]]),
    freebies: [{ title: "Sker Ritual", endDate: new Date(Date.now() + 3600e3) }],
    buyerInboxes: new Set(),
    now: Date.now(),
  };
  const ready = sales.readinessOf(base, ctx);
  assert.equal(ready.state, "ready");
  assert.ok(ready.warnings.some((w) => /still free on Epic/.test(w)));
  assert.equal(sales.readinessOf({ ...base, sold: true }, ctx).state, "sold");
  const listedCtx = { ...ctx, listingByAccount: new Map([[base._id, { id: "x", title: "T" }]]) };
  assert.equal(sales.readinessOf(base, listedCtx).state, "listed");
  const noPw = sales.readinessOf({ ...base, password: "" }, ctx);
  assert.equal(noPw.state, "blocked");
  assert.ok(noPw.blockers.includes("No Epic password saved"));
  const open = sales.readinessOf(base, { ...ctx, buyerInboxes: new Set(["a.test@outlook.com"]) });
  assert.equal(open.state, "blocked");
});

test("deriveStatus follows Eldorado's state and the stock", () => {
  const l = (offerState, entries, status = "active") => ({ status, remote: { offerState, entries } });
  const a = l("Active", 2);
  sales.deriveStatus(a);
  assert.equal(a.status, "active");
  const p = l("Paused", 2);
  sales.deriveStatus(p);
  assert.equal(p.status, "paused");
  const s = l("Active", 0);
  sales.deriveStatus(s);
  assert.equal(s.status, "sold_out");
  const r = l("Active", 3, "removed");
  sales.deriveStatus(r);
  assert.equal(r.status, "removed", "a removed listing stays removed");
});

test("Epic CDN art is asked for at a sane size; other links untouched", () => {
  assert.match(sales.sizedEpicImage("https://cdn1.epicgames.com/x/y.jpg"), /\?h=720&quality=high&resize=1&w=1280$/);
  assert.equal(sales.sizedEpicImage("https://cdn1.epicgames.com/x/y.jpg?w=10"), "https://cdn1.epicgames.com/x/y.jpg?w=10");
  assert.equal(sales.sizedEpicImage("https://example.com/a.png"), "https://example.com/a.png");
});

test("mail-page passwords: 16 characters from the unambiguous alphabet, different every time", () => {
  const a = sales.mintPassword();
  const b = sales.mintPassword();
  assert.equal(a.length, 16);
  assert.match(a, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
  assert.notEqual(a, b);
});

test("mailCutoff: the sale time when known, else the session's creation", () => {
  const created = new Date("2026-10-28T00:00:00Z");
  const sold = new Date("2026-10-29T12:00:00Z");
  assert.equal(BuyerMailSession.mailCutoff({ createdAt: created }).toISOString(), created.toISOString());
  assert.equal(BuyerMailSession.mailCutoff({ createdAt: created, soldAt: sold }).toISOString(), sold.toISOString());
});

test("Eldorado entry: shape, limits, and email details only when given", () => {
  const e = eld.toEntry({ accountLogin: " a@b.c ", accountPassword: "p", emailProviderUrl: "https://x/mail/", emailLogin: "a@b.c", emailPassword: "m", additionalInfo: " note " });
  assert.deepEqual(e, {
    id: null,
    accountDetails: { accountLogin: "a@b.c", accountPassword: "p" },
    emailDetails: { emailProviderUrl: "https://x/mail/", emailLogin: "a@b.c", emailPassword: "m" },
    mfaDetails: null,
    additionalInfo: "note",
  });
  assert.equal(eld.toEntry({ accountLogin: "a", accountPassword: "p" }).emailDetails, null);
  assert.throws(() => eld.toEntry({ accountLogin: "", accountPassword: "p" }));
  assert.throws(() => eld.toEntry({ accountLogin: "x".repeat(101), accountPassword: "p" }));
  assert.throws(() => eld.toEntry({ accountLogin: "a", accountPassword: "p", additionalInfo: "x".repeat(1001) }));
});

test("Eldorado entries read back from every shape the API has used", () => {
  const raw = { id: 7, structuredDetails: { accountDetails: { accountLogin: "A@B.C", accountPassword: "p" }, emailDetails: { emailProviderUrl: "u", emailLogin: "l", emailPassword: "m" }, additionalInfo: "n" } };
  for (const body of [{ accountDeliveryDetails: [raw] }, [raw], { results: [raw] }, raw]) {
    const [e] = eld.entryList(body).map(eld.fromEntry);
    assert.equal(e.id, "7");
    assert.equal(e.accountLogin, "A@B.C");
    assert.equal(e.emailPassword, "m");
    assert.equal(e.additionalInfo, "n");
  }
  assert.deepEqual(eld.entryList(null), []);
  assert.deepEqual(eld.entryList({ nothing: true }), []);
});

test("Eldorado create payload: Instant delivery, quantity = entries, original email off by default", () => {
  const dto = eld.offerDto({
    title: "Epic Games Account | Sker Ritual",
    description: "d",
    priceUsd: 0.494,
    mainOfferImage: { largeImage: "l.png", smallImage: "s.png", originalSizeImage: "o.png" },
    entries: [
      { accountLogin: "a", accountPassword: "p" },
      { accountLogin: "b", accountPassword: "q" },
    ],
  });
  assert.equal(dto.augmentedGame.gameId, "108");
  assert.equal(dto.augmentedGame.category, "Account");
  assert.equal(dto.details.guaranteedDeliveryTime, "Instant");
  assert.equal(dto.details.pricing.quantity, 2);
  assert.equal(dto.details.pricing.pricePerUnit.amount, 0.49);
  assert.equal(dto.details.hasOriginalEmail, false);
  assert.equal(dto.accountDeliveryDetails.length, 2);
  assert.throws(() => eld.offerDto({ title: "ok title", priceUsd: 1, mainOfferImage: { largeImage: "l" }, entries: [] }));
  assert.throws(() => eld.offerDto({ title: "ok title", priceUsd: 0.01, mainOfferImage: { largeImage: "l" }, entries: [{ accountLogin: "a", accountPassword: "p" }] }));
  assert.throws(() => eld.offerDto({ title: "ok title", priceUsd: 1, mainOfferImage: null, entries: [{ accountLogin: "a", accountPassword: "p" }] }));
});

test("the public offer link uses Eldorado's account route", () => {
  assert.equal(eld.offerUrl("abc-123"), "https://www.eldorado.gg/epic-games-accounts/oa/abc-123");
  assert.equal(eld.offerUrl(""), "");
});

test("Eldorado dates without a zone are read as UTC", () => {
  assert.equal(sales.parseEldDate("2026-11-12T18:00:00"), Date.parse("2026-11-12T18:00:00Z"));
  assert.equal(sales.parseEldDate("2026-11-12T18:00:00+00:00"), Date.parse("2026-11-12T18:00:00Z"));
  assert.ok(Number.isNaN(sales.parseEldDate("")));
});
