// Hourly complaint sweep — READ ONLY.
//
// Purpose: while the operator sleeps, collect everything across every selling
// surface that is, or is about to become, a buyer complaint, so it can be
// triaged and turned into a labelled support corpus for a future support bot.
//
// ⚠ HARD RULE: this script NEVER sends a message, never mutates a listing,
// never marks anything delivered, and never writes to any marketplace. It only
// reads. A support sweep that replies to a buyer on its own would be sending
// on the operator's behalf without them awake to approve it. Drafts go in the
// notes; a human sends them.
//
// PlayerAuctions note: reads go through paRequest, whose 401 refresh is
// serialised across processes by paRefreshOnce()'s lock file. That is what
// makes it safe to run this in its own process alongside the pm2 fulfiller —
// see project_playerauctions_integration ("one PROCESS may refresh").
//
// Usage:  node scripts/complaint-sweep.js [--out DIR] [--window-hours N] [--quiet]
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT_DIR = path.resolve(arg("out", path.join(__dirname, "..", "support-sweeps")));
const WINDOW_H = Number(arg("window-hours", 24)) || 24;
const QUIET = argv.includes("--quiet");
const SINCE = new Date(Date.now() - WINDOW_H * 3600e3);

const started = Date.now();
const items = [];
const sources = {}; // per-source status: ok / skipped / error

function add(it) {
  // key must be stable across sweeps so the state file can tell new from seen.
  items.push({
    key: it.key,
    severity: it.severity || "info", // urgent | warn | info
    platform: it.platform,
    kind: it.kind, // buyer-message | dispute | late-delivery | undelivered | integrity | error | inquiry
    at: it.at ? new Date(it.at).toISOString() : null,
    subject: it.subject || "",
    body: String(it.body || "").slice(0, 4000),
    meta: it.meta || {},
  });
}

function note(source, status, detail) {
  sources[source] = detail ? { status, detail: String(detail).slice(0, 300) } : { status };
}

const hoursSince = (d) => (d ? Math.round(((Date.now() - new Date(d).getTime()) / 3600e3) * 10) / 10 : null);

// --- 1. PlayerAuctions -----------------------------------------------------
// Buyer messages, platform notifications, order states, and the delivery clock.
// PA's delivery guarantee is measured in hours and a breach costs real money
// (penalty fee + offers hidden), so an undelivered paid order IS a complaint.
async function sweepPlayerAuctions(mp) {
  if (!(mp.keyStatus().playerauctions || {}).configured) return note("playerauctions", "skipped", "no credential");

  // The message INBOX. Note: mp.playerauctionsMessages() is /User/Messages,
  // which is a BADGE COUNTER endpoint ({messageCount, pendingCount, …}), not a
  // list — reading it as a list silently reports zero buyer messages forever.
  // The list is GET user-api/api/messages/inbox?pageIndex&pageSize, mapped here
  // 2026-09-07. It is called with the stored jar directly rather than through
  // paGet ON PURPOSE: paGet refreshes on 401, and a refresh rotates the whole
  // PlayerAuctions session. This sweep must never be able to log the operator
  // (or the fulfiller) out, so it reads with whatever cookie the server last
  // saved and reports a stale session instead of healing it.
  try {
    const threads = await paInbox();
    let unread = 0;
    let awaiting = 0;
    for (const t of threads) {
      const comments = t.comments || [];
      const last = comments[comments.length - 1];
      if (t.unread) unread++;
      const buyerLast = last && last.who === "buyer";
      if (buyerLast) awaiting++;

      // A buyer who spoke last is waiting on us. Age decides how loud that is.
      if (buyerLast) {
        const age = hoursSince(last.at);
        const stale = age != null && age > 72;
        add({
          key: "pa:thread:" + t.id + ":" + (last.at || ""),
          severity: t.unread || (age != null && age <= 24) ? "urgent" : stale ? "info" : "warn",
          platform: "playerauctions",
          kind: "buyer-message",
          at: last.at,
          subject:
            (t.unread ? "UNREAD " : "") + "buyer waiting — " + (t.buyer || "?") +
            " — order " + (t.orderId || "?") + " (" + age + "h)",
          body: last.text,
          meta: {
            threadId: t.id, orderId: t.orderId, buyer: t.buyer,
            orderStatus: t.orderStatus, unread: t.unread,
            transcript: comments.map((c) => c.who + " @" + c.at + ": " + c.text),
          },
        });
      }

      // Credential hygiene: a credential we sent that carries a %XX escape is a
      // password the buyer cannot type. Two live cases were sent a "%5E" where
      // the pool holds a literal "^". Catch it at send time, not at complaint
      // time. See docs/support-notes/NOTES.md.
      for (const c of comments) {
        if (c.who !== "buyer" && /%[0-9A-Fa-f]{2}/.test(c.text) && /:/.test(c.text) && c.text.length < 140) {
          add({
            key: "pa:badcred:" + t.id + ":" + c.at,
            severity: "urgent",
            platform: "playerauctions",
            kind: "bad-credential",
            at: c.at,
            subject: "Credential sent with a %XX escape — order " + (t.orderId || "?") + " / " + (t.buyer || "?"),
            body: c.text,
            meta: { threadId: t.id, orderId: t.orderId, buyer: t.buyer },
          });
        }
      }
    }
    note("playerauctions.inbox", "ok", threads.length + " threads, " + unread + " unread, " + awaiting + " awaiting reply");
  } catch (e) {
    note("playerauctions.inbox", "error", e.message);
  }

  // Badge counters — cheap corroboration that the inbox read is not missing anything.
  try {
    const c = await mp.playerauctionsMessages();
    note("playerauctions.counters", "ok", JSON.stringify(c || {}).slice(0, 200));
  } catch (e) {
    note("playerauctions.counters", "error", e.message);
  }

  try {
    const n = await mp.playerauctionsNotifications({ pageSize: 30 });
    const list = (n && (n.items || n.list)) || (Array.isArray(n) ? n : []);
    for (const x of list) {
      const at = x.createTime || x.time || x.createdTime;
      if (at && new Date(at) < SINCE) continue;
      const text = String(x.content || x.title || "");
      if (!/dispute|refund|cancel|guarantee|penalt|late|complain|violat|suspend|warn|hidden|expire/i.test(text)) continue;
      add({
        key: "pa:notif:" + (x.id || text.slice(0, 40)),
        severity: /dispute|penalt|violat|suspend/i.test(text) ? "urgent" : "warn",
        platform: "playerauctions",
        kind: "platform-notice",
        at,
        subject: x.title || "PA notification",
        body: text,
        meta: { raw: x },
      });
    }
    note("playerauctions.notifications", "ok", list.length + " in feed");
  } catch (e) {
    note("playerauctions.notifications", "error", e.message);
  }

  try {
    const orders = await mp.playerauctionsOrders({ pageSize: 100 });
    const byStatus = {};
    for (const o of orders.items || []) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    note("playerauctions.orders", "ok", orders.count + " total " + JSON.stringify(byStatus));

    for (const o of orders.items || []) {
      if (!/disput/i.test(String(o.status || ""))) continue;
      const age = hoursSince(o.createTime);
      add({
        // The STATUS is part of the key on purpose. Keyed on orderId alone, a
        // dispute that escalates (Disputing -> Disputed Delivery Not Completed)
        // keeps its old key and is silently reported as "not new" — which is
        // exactly what happened to order 16458589 on 2026-09-08.
        key: "pa:dispute:" + o.orderId + ":" + String(o.status || "").toLowerCase().replace(/\s+/g, "-"),
        severity: age != null && age > 168 ? "warn" : "urgent",
        platform: "playerauctions",
        kind: "dispute",
        at: o.createTime,
        subject: "Disputed order " + o.orderId + " (" + age + "h old)",
        body: (o.orderTitle || "") + " — buyer " + (o.name || "?") + " — $" + (o.price || "?"),
        meta: { orderId: o.orderId, status: o.status },
      });
    }

    const pending = await mp.playerauctionsPendingOrders({ pageSize: 100 });
    for (const o of pending) {
      const age = hoursSince(o.createTime);
      add({
        key: "pa:undelivered:" + o.orderId,
        severity: age != null && age >= 4 ? "urgent" : "warn",
        platform: "playerauctions",
        kind: "undelivered",
        at: o.createTime,
        subject: "Paid, not delivered — " + o.orderId + " (" + age + "h old)",
        body:
          (o.orderTitle || "") + " — buyer " + (o.name || "?") + " — $" + (o.price || "?") +
          " — PA's delivery guarantee is in hours; a breach costs a penalty fee and hides the offers.",
        meta: { orderId: o.orderId, ageHours: age, status: o.status },
      });
    }
    note("playerauctions.pending", "ok", pending.length + " awaiting delivery");
  } catch (e) {
    note("playerauctions.orders", "error", e.message);
  }
}

// The inbox reader. Read-only, never refreshes — see the note in
// sweepPlayerAuctions for why that restraint is deliberate.
async function paInbox({ pages = 3, pageSize = 25 } = {}) {
  const axios = require("axios");
  const { loadSettings } = require("../utils/settings");
  const { decrypt } = require("../utils/secretBox");
  const USER = "https://user-api.playerauctions.com/api";
  const SITE = "https://my.playerauctions.com";
  const headers = () => ({
    Accept: "application/json, text/plain, */*",
    Origin: SITE,
    Referer: SITE + "/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    Cookie: decrypt(((loadSettings().marketplaces || {}).playerauctions || {}).cookie || ""),
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const strip = (h) =>
    String(h || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim();

  const heads = [];
  for (let p = 1; p <= pages; p++) {
    const r = await axios.get(USER + "/messages/inbox?pageIndex=" + p + "&pageSize=" + pageSize, {
      headers: headers(),
      timeout: 30000,
    });
    const d = (r.data && r.data.data) || {};
    heads.push(...(d.items || []));
    if (heads.length >= (d.count || 0)) break;
    await sleep(300);
  }

  const out = [];
  for (const h of heads) {
    if (h.isFromSystem) continue;
    // Only open threads that could still be live. An old, fully-answered thread
    // costs a request per sweep for nothing.
    const headAge = hoursSince(h.sendTimeString);
    if (!h.unRead && headAge != null && headAge > 24 * 14) continue;
    try {
      const r = await axios.get(
        USER + "/messages/detail?id=" + encodeURIComponent(h.id) + "&isFromSystem=false",
        { headers: headers(), timeout: 30000 },
      );
      const d = (r.data && r.data.data) || {};
      out.push({
        id: h.id,
        unread: !!h.unRead,
        subject: h.subject,
        orderId: d.orderId,
        buyer: d.buyerName,
        orderStatus: d.orderStatus,
        comments: (d.comments || []).map((c) => ({
          who: c.memberName === d.sellerName ? "seller" : "buyer",
          at: c.sendTimeString,
          text: strip(c.content),
        })),
      });
    } catch (e) {
      note("playerauctions.thread." + h.id, "error", e.message);
    }
    await sleep(250);
  }
  return out;
}

// --- 2. Eldorado -----------------------------------------------------------
// Chat is TalkJS and we only have the SEND half mapped, so buyer chat cannot be
// read here yet (gap recorded in the report). Order state is readable and
// Disputed / undelivered-Paid are the two states that mean trouble.
async function sweepEldorado(mp) {
  if (!(mp.keyStatus().eldorado || {}).configured) return note("eldorado", "skipped", "no credential");
  try {
    const counts = await mp.eldoradoOrderStateCounts();
    note("eldorado.stateCounts", "ok", JSON.stringify(counts || {}).slice(0, 200));
  } catch (e) {
    note("eldorado.stateCounts", "error", e.message);
  }
  try {
    const disputed = (await mp.eldoradoOrders({ orderState: "Disputed" })) || [];
    for (const o of disputed) {
      add({
        key: "eld:dispute:" + (o.id || o.orderId),
        severity: "urgent",
        platform: "eldorado",
        kind: "dispute",
        at: o.createdAt || o.orderDate,
        subject: "Disputed order " + (o.id || o.orderId),
        body: (o.offerTitle || o.title || "") + " — buyer " + (o.buyerName || o.buyerId || "?"),
        meta: { raw: o },
      });
    }
    note("eldorado.disputed", "ok", disputed.length + " disputed");
  } catch (e) {
    note("eldorado.disputed", "error", e.message);
  }
  try {
    const paid = (await mp.eldoradoPaidOrders()) || [];
    for (const o of paid) {
      const age = hoursSince(o.createdAt || o.orderDate);
      add({
        key: "eld:undelivered:" + (o.id || o.orderId),
        severity: age != null && age >= 2 ? "urgent" : "warn",
        platform: "eldorado",
        kind: "undelivered",
        at: o.createdAt || o.orderDate,
        subject: "Paid, not delivered — " + (o.id || o.orderId) + " (" + age + "h old)",
        body: (o.offerTitle || o.title || "") + " — buyer " + (o.buyerName || "?"),
        meta: { orderId: o.id || o.orderId, ageHours: age },
      });
    }
    note("eldorado.paid", "ok", paid.length + " paid awaiting delivery");
  } catch (e) {
    note("eldorado.paid", "error", e.message);
  }
  note("eldorado.chat", "gap", "TalkJS read side not implemented — buyer chat messages are invisible to this sweep");
}

// --- 3. Own storefront chat + catalog inquiries ----------------------------
async function sweepOwnSurfaces() {
  try {
    const Message = require("../models/Message");
    const unread = await Message.find({ sender: "user", readByAdmin: false })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    for (const m of unread) {
      // Age decides loudness: this collection carries months of never-opened
      // chat, and marking a 45-day-old "ok thanks" urgent buries the live ones.
      const age = hoursSince(m.createdAt);
      add({
        key: "shop:msg:" + m._id,
        severity: age != null && age <= 24 ? "urgent" : age != null && age <= 168 ? "warn" : "info",
        platform: "storefront",
        kind: "buyer-message",
        at: m.createdAt,
        subject: "Unread buyer message (" + age + "h)",
        body: m.message,
        meta: { userId: m.userId, sellerId: m.sellerId },
      });
    }
    note("storefront.chat", "ok", unread.length + " unread");
  } catch (e) {
    note("storefront.chat", "error", e.message);
  }
  try {
    const CatalogInquiry = require("../models/CatalogInquiry");
    const news = await CatalogInquiry.find({ status: "new" }).sort({ createdAt: -1 }).limit(100).lean();
    for (const q of news) {
      add({
        key: "catalog:inq:" + q._id,
        severity: hoursSince(q.createdAt) > 12 ? "urgent" : "warn",
        platform: "catalog",
        kind: "inquiry",
        at: q.createdAt,
        subject: "Catalog inquiry — " + (q.listingTitle || q.category),
        body: "qty " + q.quantity + " @ $" + q.unitPrice + " — contact " + q.contact + " — " + (q.note || ""),
        meta: { id: String(q._id), kind: q.kind, preorder: q.preorder },
      });
    }
    note("catalog.inquiries", "ok", news.length + " new");
  } catch (e) {
    note("catalog.inquiries", "error", e.message);
  }
}

// --- 4. Complaints in waiting ---------------------------------------------
// A guardian finding, a stuck farm-service order or a delivery error is a
// complaint the buyer has not written yet. Same corpus, different lead time.
async function sweepInternal() {
  try {
    const AuditFinding = require("../models/AuditFinding");
    const open = await AuditFinding.find({ status: { $in: ["open", "needs-human"] } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    const bySeverity = {};
    for (const f of open) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      if (f.severity === "low" || f.severity === "info") continue;
      add({
        key: "audit:" + f.dedupeKey,
        severity: f.severity === "high" ? "urgent" : "warn",
        platform: f.marketplace || "internal",
        kind: "integrity",
        at: f.updatedAt || f.createdAt,
        subject: f.type + " — " + (f.accountLogin || f.accountId || ""),
        body: f.message,
        meta: { status: f.status, listing: String(f.listing || ""), healLastError: f.healLastError },
      });
    }
    note("guardian.findings", "ok", open.length + " open " + JSON.stringify(bySeverity));
  } catch (e) {
    note("guardian.findings", "error", e.message);
  }

  try {
    const FarmServiceOrder = require("../models/FarmServiceOrder");
    const stuck = await FarmServiceOrder.find({ state: { $in: ["claimed", "provisioned", "sent", "failed"] } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    for (const o of stuck) {
      const age = hoursSince(o.createdAt);
      if (age != null && age < 1 && o.state !== "failed") continue; // still in flight
      add({
        key: "farmorder:" + o.orderId,
        severity: o.state === "failed" || (age != null && age >= 6) ? "urgent" : "warn",
        platform: o.market || "eldorado",
        kind: "undelivered",
        at: o.createdAt,
        subject: "Farm-service order " + o.orderId + " stuck at '" + o.state + "' (" + age + "h)",
        body: (o.offerTitle || "") + " — " + (o.lastError || "no error recorded") + " — attempts " + o.attempts,
        meta: { orderId: o.orderId, state: o.state, game: o.game, days: o.days },
      });
    }
    note("farmservice.orders", "ok", stuck.length + " not delivered");
  } catch (e) {
    note("farmservice.orders", "error", e.message);
  }

  try {
    const SystemEvent = require("../models/SystemEvent");
    const errs = await SystemEvent.find({ at: { $gte: SINCE }, severity: "error" })
      .sort({ at: -1 })
      .limit(300)
      .lean();
    // Roll up by category+action so one broken thing is one corpus row.
    const groups = new Map();
    for (const e of errs) {
      const k = (e.category || "?") + "/" + (e.action || "?");
      const g = groups.get(k) || { n: 0, last: e.at, sample: e.detail || "", meta: e.meta };
      g.n++;
      if (new Date(e.at) > new Date(g.last)) g.last = e.at;
      groups.set(k, g);
    }
    for (const [k, g] of groups) {
      // Known-noisy: campaignWatcher integrity chatter (documented as routine).
      if (/campaignWatcher/i.test(k) && /integrity/i.test(String(g.sample))) continue;
      add({
        key: "syserr:" + k + ":" + new Date(g.last).toISOString().slice(0, 13),
        severity: g.n >= 10 ? "urgent" : "warn",
        platform: "internal",
        kind: "error",
        at: g.last,
        subject: k + " × " + g.n + " in " + WINDOW_H + "h",
        body: String(g.sample || "").slice(0, 800),
        meta: { count: g.n, meta: g.meta },
      });
    }
    note("systemevents", "ok", errs.length + " errors in " + WINDOW_H + "h, " + groups.size + " groups");
  } catch (e) {
    note("systemevents", "error", e.message);
  }
}

// --- Platforms with no readable complaint channel --------------------------
// Recorded so the report is honest about what it cannot see.
function noteBlindSpots(mp) {
  const st = mp.keyStatus();
  const blind = {
    gameflip: "no order/chat reader in utils/marketplaces.js — buyer messages and disputes invisible",
    digiseller: "no dispute/message API wired — Digiseller claims invisible",
    ggsel: "no message API wired",
    g2g: "no order/chat reader wired",
    zeusx: "no order/chat reader wired",
  };
  for (const [k, why] of Object.entries(blind)) {
    if ((st[k] || {}).configured) note(k, "gap", why);
    else note(k, "skipped", "no credential");
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const mp = require("../utils/marketplaces");

  await sweepOwnSurfaces();
  await sweepInternal();
  await sweepPlayerAuctions(mp);
  await sweepEldorado(mp);
  noteBlindSpots(mp);

  // Dedupe against previous sweeps so the digest can show only what is NEW.
  const statePath = path.join(OUT_DIR, "seen.json");
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {}
  const now = new Date().toISOString();
  let fresh = 0;
  for (const it of items) {
    if (seen[it.key]) {
      it.firstSeenAt = seen[it.key];
      it.isNew = false;
    } else {
      seen[it.key] = now;
      it.firstSeenAt = now;
      it.isNew = true;
      fresh++;
    }
  }
  // Forget keys not seen for 30 days so the file cannot grow forever.
  const live = new Set(items.map((i) => i.key));
  for (const [k, t] of Object.entries(seen)) {
    if (!live.has(k) && Date.now() - new Date(t).getTime() > 30 * 864e5) delete seen[k];
  }
  fs.writeFileSync(statePath, JSON.stringify(seen, null, 1));

  const order = { urgent: 0, warn: 1, info: 2 };
  items.sort((a, b) => (order[a.severity] - order[b.severity]) || String(b.at).localeCompare(String(a.at)));

  const report = {
    at: now,
    windowHours: WINDOW_H,
    tookMs: Date.now() - started,
    counts: {
      total: items.length,
      new: fresh,
      urgent: items.filter((i) => i.severity === "urgent").length,
      warn: items.filter((i) => i.severity === "warn").length,
    },
    sources,
    items,
  };

  const stamp = now.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(OUT_DIR, "sweep-" + stamp + ".json"), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "latest.json"), JSON.stringify(report, null, 1));
  // Append only what is new to the training corpus.
  const jsonl = items.filter((i) => i.isNew).map((i) => JSON.stringify({ sweptAt: now, ...i })).join("\n");
  if (jsonl) fs.appendFileSync(path.join(OUT_DIR, "corpus.jsonl"), jsonl + "\n");

  if (!QUIET) console.log(JSON.stringify(report, null, 1));
  else console.log(`[sweep] ${now} total=${items.length} new=${fresh} urgent=${report.counts.urgent}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("[sweep] FAILED", e);
  process.exit(1);
});
