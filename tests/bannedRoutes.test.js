const test = require("node:test");
const assert = require("node:assert/strict");

const bannedRoutes = require("../routes/bannedRoutes");

test("reseller reservations are not categorized as buyer deliveries", () => {
  assert.deepEqual(bannedRoutes.commitmentOf("reseller:Acme"), {
    kind: "reseller",
    label: "reseller:Acme",
  });
  assert.deepEqual(bannedRoutes.commitmentOf("ReSeLlEr:Partner"), {
    kind: "reseller",
    label: "ReSeLlEr:Partner",
  });
  assert.deepEqual(bannedRoutes.commitmentOf("bulk:1001"), {
    kind: "bulk",
    label: "bulk:1001",
  });
  assert.deepEqual(bannedRoutes.commitmentOf("ordinary-buyer"), {
    kind: "buyer",
    label: "ordinary-buyer",
  });
});
