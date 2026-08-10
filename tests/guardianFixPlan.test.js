// Coverage for which findings offer a one-click fix. The Digiseller dead-token
// branch is the interesting one: the platform CAN delete a single delivery
// unit, but only by a content_id we captured when we fed it — there is no
// endpoint that lists a product's existing content (verified live 2026-07-29).
// So the button must appear only when we actually recorded that unit, or the
// operator is offered a fix that cannot run.
const test = require("node:test");
const assert = require("node:assert");

const { fixPlanFor } = require("../utils/guardianFixes");

const DS = (units = []) => ({
  _id: "l1", marketplace: "digiseller", externalId: "5972936",
  status: "active", qtyTarget: 10, units,
});
const finding = (over = {}) => ({
  status: "open", type: "dead-token", accountId: "acc1", ...over,
});

test("dead-token on Digiseller offers a fix when the unit was recorded", () => {
  const plan = fixPlanFor(finding(), DS([{ accountId: "acc1", contentId: "299264577" }]));
  assert.ok(plan);
  assert.strictEqual(plan.action, "replace");
  assert.strictEqual(plan.label, "Replace unit");
});

test("dead-token on Digiseller offers NOTHING when the unit was never recorded", () => {
  // The 36 units already live on prod are in this state — unreachable.
  assert.strictEqual(fixPlanFor(finding(), DS([])), null);
  assert.strictEqual(
    fixPlanFor(finding(), DS([{ accountId: "someone-else", contentId: "1" }])),
    null,
  );
});

test("a recorded unit with no content_id is not targetable", () => {
  assert.strictEqual(fixPlanFor(finding(), DS([{ accountId: "acc1", contentId: "" }])), null);
});

test("GGSel dead-token never offers a fix — its API rejects every delete", () => {
  const gg = { _id: "l2", marketplace: "ggsel", externalId: "102582094",
    status: "active", qtyTarget: 10, units: [{ accountId: "acc1", contentId: "15450067" }] };
  assert.strictEqual(fixPlanFor(finding(), gg), null);
});

test("FunPay dead-token keeps its existing replace path", () => {
  const fp = { _id: "l3", marketplace: "funpay", externalId: "73358473", status: "active" };
  const plan = fixPlanFor(finding(), fp);
  assert.ok(plan);
  assert.strictEqual(plan.action, "replace");
  assert.strictEqual(plan.label, "Replace account");
});

test("an inactive listing is never fixed, however well recorded", () => {
  const lst = DS([{ accountId: "acc1", contentId: "299264577" }]);
  lst.status = "delisted";
  assert.strictEqual(fixPlanFor(finding(), lst), null);
});

test("a finding that is not open is never fixed", () => {
  const lst = DS([{ accountId: "acc1", contentId: "299264577" }]);
  assert.strictEqual(fixPlanFor(finding({ status: "resolved" }), lst), null);
});

test("duplicate-account offers the dedupe fix", () => {
  // Used to need a human to pick which side to drop; pickDuplicateLoser now
  // makes that call (see guardianAutoHeal.test.js), so the button exists.
  const plan = fixPlanFor(finding({ type: "duplicate-account" }), DS([]));
  assert.ok(plan);
  assert.strictEqual(plan.action, "dedupe");
});

test("duplicate-account with no account at all is still not actionable", () => {
  const plan = fixPlanFor(
    { status: "open", type: "duplicate-account" },
    DS([]),
  );
  assert.strictEqual(plan, null);
});
