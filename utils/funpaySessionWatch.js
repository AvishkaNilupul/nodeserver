// FunPay login watch (FunPay resale).
//
// A FunPay-backed Eldorado listing can only be filled while the owner's FunPay
// login works. FunPay ends sessions on its own (and the owner signing out in a
// browser can end it too), and nothing would notice until a paid order failed.
// Every 30 minutes this asks FunPay who is signed in:
//   - signed in: status saved; listings THIS module paused are put back on sale;
//   - FunPay answers but nobody is signed in: one page per outage, and every
//     active FunPay-backed listing is paused (when pauseListingWhenSourceDown);
//   - no answer / an error page: nothing is paused (a failed read is not an
//     expired login) — the next tick asks again.
// Pauses carry their own lastError so the deal watcher never resumes them, and
// this module never resumes anything it did not pause.

const PAUSE_REASON = "paused: FunPay login expired";

const deps = {
  settings: () => require("./settings"),
  Listing: () => require("../models/MarketplaceListing"),
  Source: () => require("../models/FunpaySource"),
  mp: () => require("./marketplaces"),
  notify: (text) => require("./telegram").sendTelegram(text),
  sessionFor: () => require("./funpayResale").sessionFor(),
  now: () => Date.now(),
};

const TICK_MS = 30 * 60 * 1000;
const state = { alerted: false, lastCheckAt: null, lastResult: null, started: false };

// The same "down" rule as the deal watcher (contract §7), or "" when healthy.
async function sourceDownReason(sourceId) {
  const src = await deps.Source().findById(sourceId);
  if (!src) return "deal missing";
  if (src.missingSince) return "offer gone";
  if (!src.autoDelivery) return "seller turned auto-delivery off";
  if (!(Number(src.maxBuyPriceUsd) > 0)) return "no max buy price";
  if (src.priceUsd != null && Number(src.priceUsd) > Number(src.maxBuyPriceUsd)) return "price above the max";
  if (src.sellerRating != null && Number(src.sellerRating) < 4.5) return "seller rating below 4.5";
  return "";
}

async function check() {
  const settings = deps.settings();
  const s = settings.getFunpayResale();
  if (!s.sessionConfigured) return (state.lastResult = { skipped: "no FunPay login saved" });
  const session = deps.sessionFor();
  if (!session) return (state.lastResult = { skipped: "no FunPay login saved" });

  let r;
  try {
    r = await session.checkSession();
  } catch (e) {
    return (state.lastResult = { error: "FunPay did not answer: " + String(e.message || e).slice(0, 120) });
  }
  state.lastCheckAt = new Date(deps.now());
  if (!r || r.status !== 200) return (state.lastResult = { error: "FunPay answered HTTP " + (r && r.status) });

  const Listing = deps.Listing();
  const mp = deps.mp();
  await settings.setFunpaySessionStatus({
    ok: !!r.ok,
    user: r.ok ? r.username || "" : undefined,
    userId: r.ok ? r.userId : undefined,
    error: r.ok ? "" : "FunPay says nobody is signed in — paste fresh cookies",
  });

  if (r.ok) {
    const paused = await Listing.find({ marketplace: "eldorado", funpaySource: { $ne: null }, autoPaused: true, lastError: PAUSE_REASON });
    let resumed = 0;
    for (const l of paused) {
      // A deal that is down itself stays paused, handed to the deal watcher
      // (its reason format), which resumes it when the deal is back.
      const down = await sourceDownReason(l.funpaySource);
      if (down) {
        l.lastError = "paused: FunPay source down — " + down;
        await l.save();
        continue;
      }
      try {
        await mp.eldoradoRelist(l.externalId);
        l.autoPaused = false;
        l.lastError = "";
        await l.save();
        resumed++;
      } catch (e) {
        console.error("funpay session watch: resume " + l.externalId + ":", e.message);
      }
    }
    if (state.alerted || resumed) {
      await Promise.resolve(deps.notify("✅ FunPay resale: the FunPay login works again" + (resumed ? " — " + resumed + " listing(s) back on sale." : "."))).catch(() => {});
    }
    state.alerted = false;
    return (state.lastResult = { ok: true, user: r.username || "", resumed });
  }

  // FunPay answered, and nobody is signed in: the login is gone.
  let pausedNow = 0;
  if (s.pauseListingWhenSourceDown) {
    const live = await Listing.find({ marketplace: "eldorado", funpaySource: { $ne: null }, status: "active", autoPaused: { $ne: true } });
    for (const l of live) {
      try {
        await mp.eldoradoDelist(l.externalId);
        l.autoPaused = true;
        l.lastError = PAUSE_REASON;
        await l.save();
        pausedNow++;
      } catch (e) {
        console.error("funpay session watch: pause " + l.externalId + ":", e.message);
      }
    }
  }
  if (!state.alerted) {
    state.alerted = true;
    await Promise.resolve(
      deps.notify(
        "🔑 FunPay resale: your FunPay login has expired, so nothing can be bought." +
          (pausedNow ? " " + pausedNow + " FunPay-backed listing(s) were paused." : "") +
          "\nPaste fresh FunPay cookies on the FunPay Resale page; paused listings come back by themselves.",
      ),
    ).catch(() => {});
  }
  return (state.lastResult = { ok: false, paused: pausedNow });
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await check();
    } catch (e) {
      console.error("funpay session watch:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const first = setTimeout(tick, 3 * 60 * 1000);
  if (first.unref) first.unref();
}

module.exports = { start, check, state, deps, PAUSE_REASON, TICK_MS };
