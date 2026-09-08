// A paid G2G order that is parked for manual hand-over must SAY SO.
//
// G2G's Twitch-Drops offers live in `Game Items`, a manual-delivery category:
// the bot reserves the account and starts the state machine, but the credential
// reaches the buyer through G2G chat (SendBird). When the SDK cannot send it,
// `deliverOrder` returns `{pending}` and parks the order — deliberately, because
// confirming a delivery the buyer never received is how a dispute starts.
//
// What was missing is that the parking was SILENT. `alertUnshippable` fired only
// on `error` or the one `skipped` shape matching /no listing row/, so a `pending`
// order alerted nobody. Order 1788892037419NTQU (Rocket League Twitch Drops,
// $2.18, reserved 2026-09-08T18:29:30Z) sat unsent with no error, no log line
// and no notification while the fulfiller cheerfully re-parked it every 60
// seconds and the buyer waited.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "g2gFulfiller.js"),
  "utf8",
);

test("REGRESSION: a pending order reaches the operator", () => {
  // The alert condition must cover all three outcomes that leave a PAID order
  // undelivered: a hard error, a skip a human must resolve, and a park.
  const m = SRC.match(/const needsAHuman =([^;]+);/);
  assert.ok(m, "the alert condition should be named, not inlined");
  const cond = m[1];
  for (const term of ["r.error", "alertsOperator(r.skipped)", "r.pending"]) {
    assert.ok(
      cond.includes(term),
      "a paid order left undelivered by `" + term + "` must alert; condition is: " + cond,
    );
  }
});

test("a parked order is not described as unshippable", () => {
  // The two cases need different words because they need different actions:
  // a parked order only needs the credential pasting into chat, and its stock
  // is already reserved. Telling the operator the bot "cannot ship it" would
  // send them hunting for stock that is already set aside.
  assert.match(SRC, /waiting for YOU to hand it over in chat/);
  assert.match(SRC, /already reserved against this order/);
  assert.ok(
    /pending\s*=\s*false/.test(SRC),
    "alertUnshippable should take an explicit pending flag with a safe default",
  );
});

test("the pending flag is only set for a genuine park", () => {
  // An error or an operator-skip must keep the old, blunter wording.
  const m = SRC.match(/\{\s*pending:\s*([^}]+)\}/);
  assert.ok(m, "the call site should pass the pending flag");
  const expr = m[1];
  assert.ok(expr.includes("!r.error"), "an errored order is not a park: " + expr);
  assert.ok(expr.includes("!r.skipped"), "a skipped order is not a park: " + expr);
  assert.ok(expr.includes("r.pending"), "must key off r.pending: " + expr);
});

test("alerts stay deduped so a parked order does not ping every minute", () => {
  // The tick runs every 60s and re-parks the same order every time.
  assert.match(SRC, /const alerted = new Set\(\)/);
  assert.match(SRC, /if \(!id \|\| alerted\.has\(id\)\) return;/);
  assert.match(SRC, /alerted\.add\(id\)/);
});

test("dry-run still never notifies", () => {
  // A dry run is a rehearsal; paging the owner from one would train them to
  // ignore the alert that matters.
  assert.match(SRC, /needsAHuman && !dryRun/);
});
