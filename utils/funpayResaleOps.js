// FunPay resale — the owner's hand tools behind the FunPay Resale page
// (routes/funpayResaleRoutes.js): check / save the FunPay login, test a deal signed
// in, "Buy 1 now" (the test purchase that commissions auto-buy), and fix purchases
// by hand (show login, enter login, retry, close).
//
// Same rules and dependencies as the engine: everything comes from
// require("./funpayResale").deps, and the limits and the session are the engine's
// own spentLast24h / buysLastHour / sessionFor. The only thing of our own is
// opsDeps.sleep (the order polling), so tests can make it instant.
//
// Money: a manual buy writes its FunpayPurchase row in "buying" BEFORE any money
// moves, and an attempt whose outcome is unknown ends in "needs_review" — never
// bought again. Nothing here touches Eldorado or pages anyone: the owner is
// watching the page. Secrets: the cookie jar goes only into settings (encrypted
// there), logins only into FunpayPurchase.credentials (encrypted); nothing here
// logs or returns them, except revealCredentials.
//
// Results: manualBuy, testSource and the purchase fixes return { ok, reason, … };
// a refusal carries `status` (400 / 404 / 409) for the route. revealCredentials
// returns the login itself and throws an Error with `status` when there is none.

const resale = require("./funpayResale");
const { parseCookieInput } = require("./funpayClient");
const { singleAccount } = require("./funpayCredentials");

const opsDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// "Buy 1 now" reads the FunPay order up to 6 times, 10 s apart; the first read comes
// straight after paying (FunPay auto-delivery is usually instant).
const POLL_READS = 6;
const POLL_GAP_MS = 10 * 1000;
const LOGIN_RE = /^[A-Za-z0-9_]{3,32}$/; // Twitch logins
const HAND_FIX_STATES = ["bought", "needs_review", "failed"];
const NO_SESSION = "no FunPay login saved — paste your FunPay cookies first";
const SIGNED_OUT = "FunPay says nobody is signed in — paste fresh cookies";

const engineDeps = () => resale.deps; // read on every call: tests swap its fields
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const errText = (e) => String((e && e.message) || e || "unknown error").slice(0, 160);
const at = () => new Date(engineDeps().now());

const refusal = (reason, status = 409) => ({ ok: false, reason, status });

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// findById that answers null for a malformed id instead of throwing.
async function byId(Model, id) {
  if (id == null || id === "") return null;
  try {
    return await Model.findById(id);
  } catch (e) {
    if (e && e.name === "CastError") return null;
    throw e;
  }
}

// The most one unit of this deal may cost: the deal's max and the global per-unit max.
function ceilingFor(source, s) {
  return Math.max(0, round2(Math.min(Number(source.maxBuyPriceUsd) || 0, Number(s.perUnitMaxUsd) || 0)));
}

// ------------------------------------------------------------------ the login

// The FunPay balance as a signed-in buy form shows it (null = not shown).
function balanceFrom(offer) {
  const b = offer && Number(offer.userId) > 0 && offer.buyForm && offer.buyForm.balance;
  if (!b) return null;
  return round2(Number(b.totalUsd) || Number(b.usd) || 0);
}

// One signed-in read of a deal's offer page (one still listed, when there is one).
async function readBalance(session) {
  try {
    const { Source } = engineDeps().models();
    const list = (await Source.find({}, { offerId: 1, missingSince: 1 }).lean()) || [];
    const pick = list.find((x) => x.offerId && !x.missingSince) || list.find((x) => x.offerId);
    if (!pick) return null;
    const page = await session.readOffer(pick.offerId);
    return balanceFrom(page && page.offer);
  } catch (_) {
    return null;
  }
}

// Who FunPay says is signed in. `answered: false` (no answer, an error page) is NOT
// an expired login, so nothing is saved for it.
async function whoIs(session) {
  let r;
  try {
    r = await session.checkSession();
  } catch (e) {
    return { answered: false, ok: false, error: "FunPay did not answer: " + errText(e) };
  }
  if (!r || r.status !== 200) return { answered: false, ok: false, error: "FunPay answered HTTP " + (r && r.status) };
  if (!r.ok || !(Number(r.userId) > 0)) return { answered: true, ok: false, error: SIGNED_OUT };
  return { answered: true, ok: true, user: r.username || "", userId: Number(r.userId), error: "" };
}

async function checkSession() {
  const settings = engineDeps().settings();
  const failed = (error) => ({ ok: false, user: "", userId: 0, balanceUsd: null, error });
  const session = resale.sessionFor();
  if (!session) return failed(NO_SESSION);
  const who = await whoIs(session);
  if (!who.answered) return failed(who.error);
  if (!who.ok) {
    await settings.setFunpaySessionStatus({ ok: false, error: who.error });
    return failed(who.error);
  }
  const balanceUsd = await readBalance(session);
  await settings.setFunpaySessionStatus({ ok: true, user: who.user, userId: who.userId, error: "", balanceUsd });
  return { ok: true, user: who.user, userId: who.userId, balanceUsd, error: "" };
}

// Stores the pasted cookies only once FunPay has shown them signed in.
async function saveSession(cookiesText, { actor } = {}) {
  const d = engineDeps();
  const settings = d.settings();
  const refused = (error) => ({ ok: false, user: "", error: error + " — nothing was saved" });
  const jar = parseCookieInput(cookiesText);
  if (!jar.golden_key) return refused("no golden_key cookie in what was pasted");
  const session = d.clientFactory(jar);
  const who = await whoIs(session);
  if (!who.ok) return refused(who.error);
  const balanceUsd = await readBalance(session);
  // What FunPay left in the jar after the check (it may rotate the other cookies).
  const signedJar = typeof session.cookies === "function" ? session.cookies() : jar;
  if (!signedJar || !signedJar.golden_key) return refused("FunPay dropped the golden_key cookie");
  await settings.setFunpaySessionCookies(signedJar, { actor });
  await settings.setFunpaySessionStatus({ ok: true, user: who.user, userId: who.userId, error: "", balanceUsd });
  return { ok: true, user: who.user, userId: who.userId, balanceUsd, error: "" };
}

// ------------------------------------------------------------------ test a deal

// A signed-in read of the deal's offer page. Buys nothing. ok = a "Buy 1 now" would
// go through to FunPay right now; reason = the first thing in the way.
async function testSource(sourceId) {
  const d = engineDeps();
  const settings = d.settings();
  const out = { ok: false, signedIn: false, user: "", priceUsd: null, balanceUsd: null, buyFormFound: false, maxPriceUsd: 0, reason: "" };
  const { Source } = d.models();
  const source = await byId(Source, sourceId);
  if (!source) return { ...out, reason: "deal not found", status: 404 };
  const s = settings.getFunpayResale();
  out.maxPriceUsd = ceilingFor(source, s);
  const session = resale.sessionFor();
  if (!session) return { ...out, reason: NO_SESSION };
  let page;
  try {
    page = await session.readOffer(source.offerId);
  } catch (e) {
    return { ...out, reason: "FunPay did not answer: " + errText(e) };
  }
  const offer = page && page.offer;
  if (!offer) {
    const code = page && page.status;
    return { ...out, reason: "the offer page answered HTTP " + code + (code === 404 ? " — the offer is gone" : "") };
  }
  out.signedIn = Number(offer.userId) > 0;
  out.buyFormFound = !!offer.buyForm;
  out.priceUsd = offer.priceGuard && Number(offer.priceGuard.usd) > 0 ? Number(offer.priceGuard.usd) : null;
  out.balanceUsd = balanceFrom(offer);
  if (out.signedIn) {
    const same = !Number(s.sessionUserId) || Number(s.sessionUserId) === Number(offer.userId);
    out.user = same ? s.sessionUser || "" : "user #" + offer.userId;
  }
  out.reason = !out.signedIn
    ? SIGNED_OUT
    : !out.buyFormFound
      ? "no buy form on the offer page (offer gone or out of stock)"
      : out.priceUsd == null
        ? "could not read FunPay's price for this offer"
        : !(out.maxPriceUsd > 0)
          ? "this deal has no max buy price — set one first"
          : out.priceUsd > out.maxPriceUsd + 1e-9
            ? "price " + usd(out.priceUsd) + " is above the max " + usd(out.maxPriceUsd) + " — nothing would be bought"
            : out.balanceUsd != null && out.balanceUsd + 1e-9 < out.priceUsd
              ? "FunPay balance " + usd(out.balanceUsd) + " is below the price " + usd(out.priceUsd) + " — top it up first"
              : "";
  out.ok = !out.reason;
  // A signed-in page is the freshest login status (and balance) there is.
  if (!out.signedIn) await settings.setFunpaySessionStatus({ ok: false, error: SIGNED_OUT });
  else await settings.setFunpaySessionStatus({ ok: true, userId: Number(offer.userId), error: "", balanceUsd: out.balanceUsd });
  return out;
}

// ------------------------------------------------------------------ Buy 1 now

const refuseBuy = (reason, status = 409) => ({ ok: false, purchaseId: null, state: null, reason, funpayOrderId: "", trace: [], status });

// One at a time in this process: a double click or a second tab never buys twice.
let manualBuyBusy = false;

async function manualBuy(sourceId, { confirmMaxUsd, actor } = {}) {
  if (manualBuyBusy) return refuseBuy("another Buy 1 now is still running — wait for it to finish");
  manualBuyBusy = true;
  try {
    return await buyByHand(sourceId, confirmMaxUsd, actor);
  } finally {
    manualBuyBusy = false;
  }
}

async function buyByHand(sourceId, confirmMaxUsd, actor) {
  const d = engineDeps();
  const { Source, Purchase } = d.models();
  const settings = d.settings();

  const source = await byId(Source, sourceId);
  if (!source) return refuseBuy("deal not found", 404);
  const dealMax = Number(source.maxBuyPriceUsd) || 0;
  if (!(dealMax > 0)) return refuseBuy("this deal has no max buy price — set one first");
  if (typeof confirmMaxUsd !== "number" || !Number.isFinite(confirmMaxUsd)) return refuseBuy("confirm the max price first", 400);
  if (confirmMaxUsd + 1e-9 < dealMax) {
    return refuseBuy("you confirmed " + usd(confirmMaxUsd) + " but this deal's max buy is " + usd(dealMax) + " — confirm again");
  }
  const s = settings.getFunpayResale();
  const ceiling = ceilingFor(source, s);
  if (!(ceiling > 0)) return refuseBuy("the per-unit max price allows nothing — raise it first");
  const cap = Number(s.dailyCapUsd) || 0;
  const spent = await resale.spentLast24h();
  if (spent + ceiling > cap + 1e-9) {
    return refuseBuy("the 24 h spend cap (" + usd(cap) + ") would be passed: " + usd(spent) + " spent, this buy up to " + usd(ceiling));
  }
  const perHour = Number(s.maxBuysPerHour) || 0;
  if ((await resale.buysLastHour()) >= perHour) return refuseBuy(perHour + " FunPay buys in the last hour already — try again later");
  const session = resale.sessionFor();
  if (!session) return refuseBuy(NO_SESSION);

  // The row first: from here on a crash leaves "buying", which is never bought again.
  const row = await Purchase.create({
    source: source._id,
    offerId: source.offerId,
    kind: "manual",
    state: "buying",
    buyingAt: at(),
    maxPriceUsd: ceiling,
  });
  let trace = [];
  const result = (extra) => ({
    ok: false,
    purchaseId: String(row._id),
    state: row.state,
    reason: row.reason || "",
    funpayOrderId: row.funpayOrderId || "",
    trace,
    ...extra,
  });
  const stop = async (state, reason) => {
    row.state = state;
    row.reason = String(reason).slice(0, 300);
    await row.save();
    return result();
  };

  try {
    let res = null;
    let thrown = null;
    try {
      res = await session.buyOne({ offerId: source.offerId, maxPriceUsd: ceiling });
    } catch (e) {
      thrown = e;
    }
    trace = res && Array.isArray(res.trace) ? res.trace : [];
    row.trace = trace;
    if (thrown) {
      return await stop("needs_review", "the FunPay request failed mid-purchase (" + errText(thrown) + ") — check your FunPay orders before buying again");
    }
    if (!res || (res.ok && !res.orderId)) {
      return await stop("needs_review", "FunPay gave no clear answer to the purchase — check your FunPay orders before buying again");
    }
    if (!res.ok && res.uncertain) {
      // A purchase request went out and FunPay's answer does not say what happened:
      // the money may be gone. Never "failed", never retried (same words as the engine).
      return await stop("needs_review", String(res.reason || "unclear FunPay answer").slice(0, 240) + " — FunPay may have charged; check your FunPay orders");
    }
    if (!res.ok) return await stop("failed", String(res.reason || "purchase refused"));
    row.state = "bought";
    row.funpayOrderId = String(res.orderId);
    row.chargedUsd = round2(res.chargedUsd || 0);
    row.boughtAt = at();
    row.reason = "";
    await row.save();

    for (let i = 0; i < POLL_READS; i++) {
      if (i > 0) await opsDeps.sleep(POLL_GAP_MS);
      let read = null;
      try {
        read = await session.readOrder(row.funpayOrderId);
      } catch (_) {
        continue; // a network blip: the next read tries again
      }
      const secrets = (read && read.order && read.order.secrets) || [];
      if (!secrets.length) continue;
      const acc = singleAccount(secrets.join("\n"));
      if (!acc) return await stop("needs_review", "could not read exactly one login from the seller's delivery — open the FunPay order");
      row.credentials = d.encrypt(JSON.stringify(acc));
      row.login = acc.username;
      row.state = "received";
      row.receivedAt = at();
      row.reason = "";
      await row.save();
      // Exactly one login out of a real purchase: auto-buy may now be switched on.
      try {
        await settings.markFunpayCommissioned({ actor });
        return result({ ok: true, login: row.login, commissioned: true });
      } catch (e) {
        return result({ ok: true, login: row.login, commissioned: false, reason: "login received, but saving the commissioned flag failed: " + errText(e) });
      }
    }
    return await stop("bought", "waiting for the seller — nothing delivered after " + POLL_READS + " checks; open the FunPay order");
  } catch (e) {
    // A save broke after the row was written: never hide a purchase that may be paid.
    row.state = "needs_review";
    row.reason = ("something failed after the purchase started (" + errText(e) + ") — check your FunPay orders").slice(0, 300);
    await Promise.resolve()
      .then(() => row.save())
      .catch(() => {});
    return result();
  }
}

// Re-reads a "bought" purchase's FunPay order once — the seller was slower than the
// manual buy's polling (or than an engine tick). Exactly one login → "received"
// (encrypted), and a manual buy then commissions the system; an unreadable delivery →
// needs_review; nothing yet → stays "bought". An order purchase moved to "received"
// here ships on the engine's next Eldorado tick. Buys nothing. Never throws.
async function recheckPurchase(purchaseId) {
  const d = engineDeps();
  try {
    const { Purchase } = d.models();
    const row = await byId(Purchase, purchaseId);
    if (!row) return refusal("purchase not found", 404);
    if (row.state !== "bought" || !row.funpayOrderId) {
      return refusal("only a bought purchase that is waiting for the seller can be checked");
    }
    const session = resale.sessionFor();
    if (!session) return refusal(NO_SESSION);
    let read;
    try {
      read = await session.readOrder(row.funpayOrderId);
    } catch (e) {
      return { ok: false, state: row.state, reason: "FunPay did not answer: " + errText(e) };
    }
    const secrets = (read && read.order && read.order.secrets) || [];
    if (!secrets.length) return { ok: false, state: "bought", reason: "the seller has not delivered yet" };
    const acc = singleAccount(secrets.join("\n"));
    if (!acc) {
      row.state = "needs_review";
      row.reason = "could not read exactly one login from the seller's delivery — open the FunPay order";
      await row.save();
      return { ok: false, state: row.state, reason: row.reason };
    }
    row.credentials = d.encrypt(JSON.stringify(acc));
    row.login = acc.username;
    row.state = "received";
    row.receivedAt = at();
    row.reason = "";
    await row.save();
    let commissioned = false;
    if (row.kind === "manual") {
      try {
        await d.settings().markFunpayCommissioned({ actor: "funpay-resale check" });
        commissioned = true;
      } catch (_) {
        /* the login is safe on the row; the flag can be set by the next check */
      }
    }
    return { ok: true, state: "received", login: row.login, commissioned };
  } catch (e) {
    return { ok: false, state: null, reason: "check failed: " + errText(e) };
  }
}

// ------------------------------------------------------------------ purchases by hand

async function revealCredentials(purchaseId) {
  const d = engineDeps();
  const { Purchase } = d.models();
  const row = await byId(Purchase, purchaseId);
  if (!row) throw httpError(404, "purchase not found");
  if (!row.credentials) throw httpError(409, "no login is stored for this purchase");
  let acc = null;
  try {
    acc = JSON.parse(d.decrypt(row.credentials) || "null");
  } catch (_) {
    acc = null;
  }
  if (!acc || typeof acc !== "object" || !acc.username || !acc.password) throw httpError(409, "the stored login could not be read back");
  const out = { username: String(acc.username), password: String(acc.password) };
  if (acc.token) out.token = String(acc.token);
  return out;
}

// The owner got the login some other way (the seller's chat, another seller): it
// ships with the Eldorado order on the engine's next tick.
async function setManualCredential(purchaseId, { login, password } = {}) {
  const d = engineDeps();
  const { Purchase } = d.models();
  const row = await byId(Purchase, purchaseId);
  if (!row) return refusal("purchase not found", 404);
  if (row.kind !== "order") return refusal("only a purchase for an Eldorado order takes a login by hand");
  if (!HAND_FIX_STATES.includes(row.state)) {
    return refusal('a purchase in "' + row.state + '" cannot take a login by hand (only bought, needs review or failed)');
  }
  const user = typeof login === "string" ? login.trim() : "";
  const pass = typeof password === "string" ? password.trim() : "";
  if (!LOGIN_RE.test(user)) return refusal("the login must be 3–32 letters, digits or underscores", 400);
  if (pass.length < 4) return refusal("the password must be at least 4 characters", 400);
  if (pass.length > 128) return refusal("the password is longer than 128 characters", 400);
  row.credentials = d.encrypt(JSON.stringify({ username: user, password: pass }));
  row.login = user;
  row.state = "received";
  row.receivedAt = at();
  row.reason = "entered by hand";
  await row.save();
  return { ok: true, purchaseId: String(row._id), state: row.state, reason: row.reason, login: user };
}

// Back to "new": the engine buys it again on its next tick. A unit that was already
// bought (a row the owner closed after paying) is refused: the retry would pay twice
// and overwrite that purchase's record.
async function retryPurchase(purchaseId) {
  const { Purchase } = engineDeps().models();
  const row = await byId(Purchase, purchaseId);
  if (!row) return refusal("purchase not found", 404);
  if (row.kind !== "order") return refusal("only a purchase for an Eldorado order can be retried");
  if (row.state !== "failed") return refusal('only a failed purchase can be retried (this one is "' + row.state + '")');
  if (row.funpayOrderId || Number(row.chargedUsd) > 0) {
    return refusal("this unit was already bought on FunPay (order " + (row.funpayOrderId || "?") + ") — a retry would buy a second one; deliver it by hand");
  }
  row.state = "new";
  row.reason = "";
  row.alerted = []; // a fresh attempt pages afresh
  await row.save();
  return { ok: true, purchaseId: String(row._id), state: row.state, reason: "" };
}

async function closePurchase(purchaseId, { note } = {}) {
  const { Purchase } = engineDeps().models();
  const row = await byId(Purchase, purchaseId);
  if (!row) return refusal("purchase not found", 404);
  if (row.state === "delivered") return refusal("this purchase was delivered already — nothing to close");
  const text = String(note == null ? "" : note)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  row.state = "failed";
  row.reason = text ? "closed by owner: " + text : "closed by owner";
  await row.save();
  return { ok: true, purchaseId: String(row._id), state: row.state, reason: row.reason };
}

module.exports = {
  checkSession,
  saveSession,
  testSource,
  manualBuy,
  revealCredentials,
  setManualCredential,
  retryPurchase,
  closePurchase,
  recheckPurchase,
  opsDeps,
  // The engine's own deps object: this module has no second one.
  get deps() {
    return resale.deps;
  },
};
