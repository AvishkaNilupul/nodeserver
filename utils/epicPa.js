// Native instant-delivery Epic Accounts on PlayerAuctions. All publish
// outcomes stay reserved until a verified order or operator reconciliation.
const bcrypt = require("bcrypt");
const EpicAccount = require("../models/EpicAccount");
const Unit = require("../models/EpicPaUnit");
const Sale = require("../models/EpicSale");
const Session = require("../models/BuyerMailSession");
const { encrypt, decrypt } = require("./secretBox");
const sales = require("./epicSales");
const pa = require("./playerauctionsAccountOffers");
const mp = require("./marketplaces");
const DAY = 86400000;
let running = false;
let timer;
function fail(message) {
  const e = new Error(message);
  e.status = 400;
  e.user = true;
  return e;
}
function profile(acc) {
  try {
    return JSON.parse(decrypt(acc.accountDetails) || "{}");
  } catch {
    return {};
  }
}
function loginOf(value) {
  return String(
    (value &&
      (value.loginName ||
        value.gameAccount?.loginName ||
        value.autoDelivery?.loginName)) ||
      "",
  )
    .trim()
    .toLowerCase();
}
function eventDate(value) {
  const s = String(value || "");
  const d = new Date(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s) && !/(Z|[+-]\d\d:\d\d)$/.test(s)
      ? s + "Z"
      : s,
  );
  return Number.isFinite(d.getTime()) ? d : null;
}
function payment(detail) {
  const e = (detail?.eventLogs || []).find((x) =>
    /payment settlement completed/i.test(x.content || ""),
  );
  return e ? eventDate(e.dateTime) : null;
}
function orderOffer(order) {
  return (
    String(order.offerId || "") ||
    mp.playerauctionsOfferIdFromUrl(order.detail?.orderInfo?.offerInfo?.link)
  );
}
async function notify(text) {
  try {
    await require("./telegram").sendTelegram(text);
  } catch (e) {
    console.error("[epicPa] notification failed:", e.message);
  }
}
async function alert(unit, note) {
  const changed = await Unit.updateOne(
    { _id: unit._id, alertedAt: null },
    { $set: { alertedAt: new Date(), note } },
  );
  if (changed.modifiedCount)
    await notify(
      "PlayerAuctions Epic account " +
        (unit.offerId || String(unit._id)) +
        ": " +
        note,
    );
}
function defaults(acc) {
  const p = profile(acc);
  return {
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    phone: p.phone || "",
    email: decrypt(acc.email) || "",
    city: p.city || "",
    country: p.country || "",
  };
}
async function preview(accountId, opts = {}) {
  if (!/^[a-f\d]{24}$/i.test(String(accountId)))
    throw fail("Invalid Epic account ID");
  const ctx = await sales.stockContext({
    fresh: true,
    accountIds: [accountId],
  });
  const acc = ctx.accounts[0];
  if (!acc) throw fail("Epic account not found");
  const r = sales.readinessOf(acc, ctx);
  if (r.state !== "ready")
    throw fail(r.blockers.join("; ") || "Account is " + r.state);
  if (!r.titles.length) throw fail("An empty Epic library cannot be listed");
  if (acc.totpSecret)
    throw fail(
      "This account has two-factor authentication; remove it before listing for instant delivery",
    );
  const original = opts.original || defaults(acc);
  const out = {
    accountId: String(acc._id),
    label: acc.label || acc.displayName || acc.accountId,
    games: r.titles,
    title:
      opts.title ||
      (
        r.titles.join(" + ").slice(0, 85) +
        " - Epic Games PC Account - Email Change Supported"
      ).slice(0, 150),
    priceUsd: opts.priceUsd ?? 5,
    original,
    current: opts.current || null,
    characterName: acc.displayName || "",
    warnings: r.warnings,
    providerUrl: sales.providerUrl(),
  };
  if (!out.providerUrl)
    throw fail("PUBLIC_BASE_URL is required for buyer mail access");
  return out;
}
function deliveryText(email, password) {
  return (
    "Epic email: " +
    email +
    ". Email codes: " +
    sales.providerUrl() +
    " Login: " +
    email +
    ". Mail page password: " +
    password +
    ". Mail access lasts 14 days from purchase, or until you change the Epic email. This password works only on our mail page. Change the Epic email to your own; contact us through the order if you need help."
  );
}
function description(games) {
  return (
    "<p>Epic Games PC account with " +
    games
      .map((x) =>
        String(x).replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        ),
      )
      .join(", ") +
    ". Instant delivery through PlayerAuctions.</p><p>Email change supported. Includes access to our Epic-only email viewer for 14 days after purchase, closing when the Epic email changes. Full Outlook inbox access is not included. Change the Epic email to your own address. 14-day after-sale protection.</p>"
  );
}
async function publish(accountId, opts, actor) {
  return sales._internals.withLock(async () => {
    const p = await preview(accountId, opts);
    const acc = await EpicAccount.findById(accountId).lean();
    const email = decrypt(acc.email).trim().toLowerCase();
    const mailPassword = sales.mintPassword();
    const input = {
      ...p,
      login: email,
      password: decrypt(acc.password),
      description: description(p.games),
      instruction: deliveryText(email, mailPassword),
    };
    // Validate before reserving anything. Missing recovery data never produces
    // an offer or a buyer mail session.
    try {
      pa.body(input);
    } catch (e) {
      throw fail(e.message);
    }
    let unit;
    try {
      unit = await Unit.create({
        epicAccountId: acc._id,
        title: p.title,
        priceUsd: p.priceUsd,
        createdBy: actor || "",
      });
    } catch (e) {
      if (e.code === 11000)
        throw fail(
          "This Epic account already has a PlayerAuctions reservation",
        );
      throw e;
    }
    try {
      const session = await Session.create({
        epicAccountId: acc._id,
        inboxAddress: email,
        passwordHash: await bcrypt.hash(mailPassword, 10),
        passwordEnc: encrypt(mailPassword),
        expiresAt: new Date("2100-01-01"),
        stage: "listed",
        marketplace: "playerauctions",
        note: "Epic instant delivery",
        createdByUserId: actor || "",
      });
      unit.sessionId = session._id;
      await unit.save();
      // Durable boundary: a timeout after this point may already have created
      // a live offer. Never publish a second time or release this reservation.
      unit.publishAttemptedAt = new Date();
      await unit.save();
      unit.offerId = await pa.create(input);
      await unit.save();
      await verify(unit, email);
      await notify(
        "PlayerAuctions Epic offer " +
          unit.offerId +
          " is live with instant delivery at $" +
          unit.priceUsd.toFixed(2),
      );
      return view(await Unit.findById(unit._id).lean());
    } catch (e) {
      const rejected = !unit.offerId && e.__pa && e.paCode != null;
      if (!unit.publishAttemptedAt || rejected) {
        if (unit.sessionId)
          await Session.updateOne(
            { _id: unit.sessionId },
            {
              $set: {
                revokedAt: new Date(),
                revokedReason: "unlisted",
                passwordEnc: "",
              },
            },
          );
        await Unit.deleteOne({ _id: unit._id });
      } else {
        // Do not persist the API error: a remote validator can echo secrets.
        unit.state = "error";
        unit.note =
          "Publication could not be confirmed. Check the PA seller offers and reconcile this reservation; do not publish it again.";
        await unit.save();
        await alert(unit, unit.note);
      }
      throw fail(
        rejected
          ? e.paCode === 1
            ? "PlayerAuctions is throttling writes. Wait 26 seconds and try again."
            : "PlayerAuctions rejected the account offer (code " +
              String(e.paCode) +
              "). Review the owner details and seller offer requirements before retrying."
          : unit.publishAttemptedAt
            ? unit.note
            : "Could not prepare buyer mail access",
      );
    }
  });
}
async function matchesSession(unit, offer) {
  const session = await Session.findById(unit.sessionId).lean();
  const pw = session?.passwordEnc ? decrypt(session.passwordEnc) : "";
  const instruction = String(offer?.autoDelivery?.instruction || "");
  return (
    !!pw &&
    !session.revokedAt &&
    session.stage === "listed" &&
    instruction.includes(pw) &&
    instruction.includes(sales.providerUrl()) &&
    instruction.includes(session.inboxAddress)
  );
}
async function verify(unit, expectedLogin) {
  const offer = await pa.read(unit.offerId);
  if (
    !offer ||
    Number(offer.gameId) !== 9310 ||
    offer.isAuto !== true ||
    loginOf(offer) !== expectedLogin ||
    !(await matchesSession(unit, offer))
  ) {
    throw fail(
      "The PlayerAuctions offer did not confirm this Epic account with instant delivery",
    );
  }
  await Unit.updateOne(
    { _id: unit._id, state: { $ne: "sold" } },
    {
      $set: {
        state: "listed",
        note: "",
        alertedAt: null,
        lastCheckedAt: new Date(),
      },
    },
  );
}
async function reconcile(id, offerId) {
  if (!/^\d+$/.test(String(offerId)))
    throw fail("Enter a PlayerAuctions offer ID");
  const unit = await Unit.findById(id);
  if (!unit || unit.state === "sold") throw fail("No unsold reservation found");
  if (await Unit.exists({ _id: { $ne: unit._id }, offerId: String(offerId) }))
    throw fail("That offer is already linked");
  const acc = await EpicAccount.findById(unit.epicAccountId).lean();
  // No local mutation until the remote login, game and delivery mode match.
  const remote = await pa.read(String(offerId));
  if (
    !remote ||
    Number(remote.gameId) !== 9310 ||
    remote.isAuto !== true ||
    loginOf(remote) !== decrypt(acc.email).trim().toLowerCase() ||
    !(await matchesSession(unit, remote))
  )
    throw fail("Offer does not match this Epic account");
  unit.offerId = String(offerId);
  unit.state = "listed";
  unit.note = "";
  unit.alertedAt = null;
  await unit.save();
  return view(unit);
}
async function setPaused(id, paused) {
  const unit = await Unit.findById(id);
  if (!unit || !unit.offerId || !["listed", "paused"].includes(unit.state))
    throw fail("Only confirmed unsold offers can be paused or resumed");
  await (paused
    ? mp.playerauctionsHide(unit.offerId)
    : mp.playerauctionsDisplay(unit.offerId));
  await Unit.updateOne(
    { _id: unit._id, state: { $ne: "sold" } },
    { $set: { state: paused ? "paused" : "listed" } },
  );
  return view(await Unit.findById(id).lean());
}
function view(u) {
  return {
    id: String(u._id),
    accountId: String(u.epicAccountId),
    offerId: u.offerId,
    title: u.title,
    priceUsd: u.priceUsd,
    state: u.state,
    note: u.note,
    orderId: u.orderId,
    url: u.offerId ? mp.playerauctionsOfferUrl(u.offerId) : "",
    soldAt: u.soldAt,
    lastCheckedAt: u.lastCheckedAt,
  };
}
async function overview() {
  return {
    minimumPriceUsd: 5,
    mailDays: 14,
    units: (await Unit.find({}).sort({ createdAt: -1 }).limit(100).lean()).map(
      view,
    ),
  };
}
async function recordOrder(order, unit) {
  const id = String(order.orderId || order.id || "");
  const detail = order.detail || (await mp.playerauctionsOrderDetail(id));
  const paidAt = payment(detail);
  if (!paidAt) return; // unpaid/cancelled-before-payment never starts mail access
  const native = await pa.orderAccount(id);
  const acc = await EpicAccount.findById(unit.epicAccountId).lean();
  const email = decrypt(acc.email).trim().toLowerCase();
  if (loginOf(native) !== email) {
    await alert(
      unit,
      "Paid order " +
        id +
        " did not confirm the reserved Epic login. Check delivery on the order page.",
    );
    return;
  }
  // Preserve the first payment time through retries and disputed/refunded states.
  const sid = "pa:" + id;
  if (unit.orderId && unit.orderId !== sid) {
    await alert(
      unit,
      "A second order appeared for this one-account offer: " + id,
    );
    return;
  }
  const state = String(
    detail.status?.orderStatus ||
      order.status?.orderStatus ||
      order.status ||
      "Paid",
  );
  const bad = /disput|cancel|refund/i.test(state);
  const delivered = (detail.eventLogs || []).some((x) =>
    /delivery.*(claimed|completed|sent)|account.*(delivered|sent)|order completed/i.test(
      x.content || "",
    ),
  );
  await Sale.updateOne(
    { orderId: sid },
    {
      $setOnInsert: {
        market: "playerauctions",
        offerId: unit.offerId,
        title: unit.title,
        priceUsd: unit.priceUsd,
        quantity: 1,
        accounts: [
          {
            epicAccountId: acc._id,
            sessionId: unit.sessionId,
            label: acc.label || acc.displayName,
            login: email,
          },
        ],
        orderCreatedAt: paidAt,
        matchedBy: "pa-account",
        submittedAt: paidAt,
      },
      $set: {
        orderState: state,
        needsAttention: bad || !delivered,
        lastCheckedAt: new Date(),
        note: bad
          ? "Review this account order on PlayerAuctions"
          : delivered
            ? ""
            : "Payment confirmed; awaiting native delivery confirmation",
      },
    },
    { upsert: true },
  );
  // Sale row first; every following write is idempotent and can resume after a crash.
  await EpicAccount.updateOne({ _id: acc._id }, { $set: { sold: true } });
  await Session.updateOne(
    { _id: unit.sessionId },
    {
      $set: {
        stage: "sold",
        soldAt: paidAt,
        expiresAt: new Date(paidAt.getTime() + unit.sessionDays * DAY),
        orderRef: id,
        passwordEnc: "",
      },
    },
  );
  if (delivered)
    await Sale.updateOne(
      { orderId: sid, deliveredAt: null },
      { $set: { deliveredAt: paidAt } },
    );
  const first = await Unit.updateOne(
    { _id: unit._id, state: { $ne: "sold" } },
    {
      $set: {
        state: "sold",
        orderId: sid,
        soldAt: paidAt,
        lastCheckedAt: new Date(),
        note: "",
      },
    },
  );
  if (first.modifiedCount)
    await notify(
      "PlayerAuctions sold Epic account: order " +
        id +
        ", " +
        unit.title +
        ", $" +
        unit.priceUsd.toFixed(2) +
        ". Buyer mail access is active for 14 days from payment.",
    );
  if (bad || !delivered)
    await alert(
      unit,
      "Order " +
        id +
        ": " +
        (bad
          ? state
          : "Native delivery has not been confirmed; check the order page."),
    );
}
async function ownsOrder(order) {
  const offerId = orderOffer(order);
  if (!offerId)
    return !!(await Unit.exists({ title: String(order.orderTitle || "") }));
  const unit = await Unit.findOne({ offerId }).lean();
  if (!unit) return false;
  try {
    await recordOrder(order, unit);
  } catch {
    await alert(
      unit,
      "Could not verify the Epic account delivered on order " +
        String(order.orderId || order.id || "") +
        ". Check PlayerAuctions; credentials stay reserved.",
    );
  }
  return true; // native account delivery must never enter the Item fulfiller
}
async function tick() {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    const units = await Unit.find({ offerId: { $ne: "" } }).lean();
    if (!units.length) return { checked: 0 };
    const byOffer = new Map(units.map((u) => [u.offerId, u]));
    const titles = new Set(units.map((u) => u.title));
    let checked = 0;
    for (let pageIndex = 1; pageIndex <= 20; pageIndex++) {
      const page = await mp.playerauctionsOrders({ pageIndex, pageSize: 100 });
      for (const order of page.items || []) {
        if (
          !byOffer.has(String(order.offerId || "")) &&
          !titles.has(order.orderTitle)
        )
          continue;
        const detail = await mp.playerauctionsOrderDetail(
          order.orderId || order.id,
        );
        const full = { ...order, detail };
        const unit = byOffer.get(orderOffer(full));
        if (!unit) continue;
        await recordOrder(full, unit);
        checked++;
      }
      if (pageIndex * 100 >= page.count || !page.items?.length) break;
      if (pageIndex === 20)
        throw new Error(
          "PlayerAuctions order scan exceeded 2000 orders; older Epic orders require reconciliation",
        );
    }
    return { checked };
  } finally {
    running = false;
  }
}
async function onStockEmailChanged(rows) {
  for (const row of rows || []) {
    const unit = await Unit.findOne({
      sessionId: row.id,
      state: { $ne: "sold" },
    }).lean();
    if (!unit) continue;
    // A native sale may be just ahead of our scan. Pause the offer to stop a
    // second buyer while the order scan settles; never return it to the pool.
    if (unit.offerId) await mp.playerauctionsHide(unit.offerId).catch(() => {});
    await Unit.updateOne(
      { _id: unit._id, state: { $ne: "sold" } },
      { $set: { state: "error" } },
    );
    await alert(
      unit,
      "Epic email changed while listed. Offer pause requested; verify the sale before reconciling.",
    );
  }
}
function start() {
  if (timer) return;
  const run = () =>
    tick().catch((e) => console.error("[epicPa] sale sync:", e.message));
  timer = setInterval(run, 5 * 60000);
  timer.unref?.();
  const first = setTimeout(run, 45000);
  first.unref?.();
}
function stop() {
  clearInterval(timer);
  timer = null;
}
module.exports = {
  preview,
  publish,
  overview,
  reconcile,
  setPaused,
  ownsOrder,
  tick,
  start,
  stop,
  onStockEmailChanged,
  _internals: { loginOf, payment, recordOrder, eventDate, deliveryText },
};
