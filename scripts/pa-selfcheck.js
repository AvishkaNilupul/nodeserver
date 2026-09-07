#!/usr/bin/env node
// Read-only end-to-end check of the PlayerAuctions integration.
//
// Run this immediately after pasting the PlayerAuctions cookie into the keys
// modal. Every authenticated call in this integration was verified from a
// browser session; this is what proves the SERVER can make the same calls with
// the credential it was given, before any of it runs unattended against a real
// buyer's order.
//
//   node scripts/pa-selfcheck.js
//   node scripts/pa-selfcheck.js --orders     # also dump the delivery queue
//
// It writes nothing, publishes nothing and delivers nothing.
require("dotenv").config();

const mp = require("../utils/marketplaces");
const copy = require("../utils/playerauctionsCopy");
const proof = require("../utils/playerauctionsProof");

const args = process.argv.slice(2);
const WANT_ORDERS = args.includes("--orders");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === true ? "PASS" : ok === false ? "FAIL" : "WARN";
  console.log(tag.padEnd(5) + name + (detail ? "  — " + detail : ""));
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
    return true;
  } catch (e) {
    record(name, false, e.message);
    return false;
  }
}

async function main() {
  console.log("PlayerAuctions self-check\n" + "=".repeat(60));

  // 1. Things that need no credential at all. If these fail, the problem is
  //    the network or PlayerAuctions itself, not the cookie.
  await step("catalogue reachable without a credential", async () => {
    const games = await mp.playerauctionsGames();
    if (!games.length) throw new Error("game list came back empty");
    const withItem = games.filter((g) =>
      String(g.productType || "").toLowerCase().split(",").includes("item"),
    );
    return games.length + " games, " + withItem.length + " accept Item offers";
  });

  await step("Overwatch resolves to the same taxonomy the live offers use", async () => {
    const g = await mp.playerauctionsResolveGame("Overwatch 2");
    if (!g || g.gameId !== 7097) throw new Error("expected gameId 7097, got " + (g && g.gameId));
    const leaf = await mp.playerauctionsPickItemPath(7097);
    if (!leaf || leaf.itemPath !== "1653|8305") {
      throw new Error("expected itemPath 1653|8305, got " + (leaf && leaf.itemPath));
    }
    return g.gameName + " / " + leaf.rootName + " > " + leaf.itemName;
  });

  await step("the 20-minute delivery tier still exists", async () => {
    const tiers = await mp.playerauctionsDeliveryTimes(7097);
    const fast = tiers.find((t) => t.customId === mp.PA_DELIVERY.min20);
    if (!fast) throw new Error("customId 5 (20 Minutes) is gone from the enum");
    return fast.time + " " + fast.unit;
  });

  // 2. Copy invariants. These are pure and cannot fail at runtime, but a
  //    regression here breaks delivery silently, so check them where the
  //    operator will see it.
  await step("hand-over messages fit the 300-character cap", async () => {
    const mk = (n) =>
      Array.from({ length: n }, (_, i) => ({ login: "login" + i, password: "Passw0rd" + i }));
    let worst = 0;
    for (const n of [1, 2, 5, 10, 25]) {
      for (const kind of ["bundle", "farm"]) {
        for (const m of copy.deliveryMessages(mk(n), { kind, days: 180, game: "Overwatch" })) {
          worst = Math.max(worst, m.length);
          if (m.length > copy.LIMIT) throw new Error(kind + " x" + n + " produced " + m.length);
        }
      }
    }
    return "longest message " + worst + "/" + copy.LIMIT + " chars";
  });

  await step("the delivery-proof image renders", async () => {
    const p = await proof.buildDeliveryProof({
      orderId: "selfcheck",
      offerTitle: "PlayerAuctions self-check",
      accountCount: 1,
    });
    const bytes = require("fs").statSync(p).size;
    await proof.cleanupProof(p);
    if (bytes < 1000) throw new Error("proof image was only " + bytes + " bytes");
    return bytes + " bytes (required: confirm-delivery rejects an empty submission at seller level 0)";
  });

  // 3. Everything below needs the cookie.
  if (!(mp.keyStatus().playerauctions || {}).configured) {
    record(
      "credential installed",
      null,
      "no PlayerAuctions cookie stored — paste it in the listings keys modal, " +
        "then re-run. Everything below is unverified until you do.",
    );
    summary();
    return;
  }

  const authed = await step("session accepted", async () => {
    const r = await mp.playerauctionsTest();
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
  if (!authed) {
    console.log(
      "\nThe stored cookie was rejected. Copy the Cookie header again from a " +
        "signed-in session on member.playerauctions.com (DevTools > Network > " +
        "any request > Request Headers > Cookie) and paste the whole line.",
    );
    summary();
    return;
  }

  await step("seller profile readable", async () => {
    const me = await mp.playerauctionsMe();
    const m = (me && me.members) || {};
    const lvl = m.level;
    return (
      m.nickName + " · memberId " + m.memberId + " · level " + lvl +
      (lvl === 0
        ? " (level 0 → confirm-delivery REQUIRES proof images, which the fulfiller attaches)"
        : "")
    );
  });

  await step("session refresh works", async () => {
    const moved = await mp.playerauctionsRefreshSession();
    return moved ? "cookies rotated and were persisted" : "session already current";
  });

  await step("offers readable", async () => {
    const r = await mp.playerauctionsMyListings(1, 50);
    return r.count + " active offer(s)" +
      (r.items.length ? ": " + r.items.slice(0, 3).map((o) => o.title.slice(0, 40)).join(" | ") : "");
  });

  await step("orders readable", async () => {
    const r = await mp.playerauctionsOrders({ pageSize: 100 });
    const byStatus = {};
    for (const o of r.items) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    return (
      r.count + " lifetime order(s) — " +
      Object.entries(byStatus).map(([k, v]) => v + " " + k).join(", ")
    );
  });

  await step("delivery queue resolves", async () => {
    const pending = await mp.playerauctionsPendingOrders({ pageSize: 100 });
    if (!pending.length) return "nothing waiting on delivery right now";
    return (
      pending.length + " order(s) awaiting delivery: " +
      pending.map((o) => o.orderId).join(", ")
    );
  });

  if (WANT_ORDERS) {
    const pending = await mp.playerauctionsPendingOrders({ pageSize: 100 }).catch(() => []);
    for (const o of pending) {
      console.log(
        "\n  order " + o.orderId + "  " + o.status +
        "\n    title: " + o.orderTitle +
        "\n    buyer: " + o.name + "  price: " + o.price + "  qty: " + o.quantity,
      );
    }
  }

  summary();
}

function summary() {
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const warn = results.filter((r) => r.ok === null).length;
  console.log("=".repeat(60));
  console.log(`pass=${pass} fail=${fail} warn=${warn}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
