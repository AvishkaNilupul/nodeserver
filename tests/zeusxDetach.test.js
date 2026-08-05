// ZeusX was the one live platform detach could not act on: the fallback branch
// only warned, so a suspended account stayed on sale in a coordinated offer's
// quantity (six of them did, across five offers). These pin the decision.
const test = require("node:test");
const assert = require("node:assert");
const { zeusxDetachPlan } = require("../utils/listingDetach");

test("automatic delivery: the offer carries the credential, so it comes down", () => {
  const p = zeusxDetachPlan({
    autoDeliver: true,
    logins: ["deadguy"],
    login: "deadguy",
  });
  assert.strictEqual(p.action, "delist");
  assert.strictEqual(p.reason, "auto-deliver");
});

test("coordinated offer shrinks by one unit and keeps the rest on sale", () => {
  const p = zeusxDetachPlan({
    autoDeliver: false,
    logins: ["alive1", "deadguy", "alive2"],
    login: "deadguy",
  });
  assert.strictEqual(p.action, "shrink");
  assert.strictEqual(p.quantity, 2);
  assert.deepStrictEqual(p.kept, ["alive1", "alive2"]);
});

test("login matching ignores case, as the row's logins are free text", () => {
  const p = zeusxDetachPlan({
    autoDeliver: false,
    logins: ["Alive1", "DeadGuy"],
    login: "deadguy",
  });
  assert.deepStrictEqual(p.kept, ["Alive1"]);
  assert.strictEqual(p.quantity, 1);
});

test("removing the last account takes the offer off sale, not to quantity 0", () => {
  const p = zeusxDetachPlan({
    autoDeliver: false,
    logins: ["deadguy"],
    login: "deadguy",
  });
  assert.strictEqual(p.action, "delist");
  assert.strictEqual(p.reason, "emptied");
});

test("an unrelated login leaves the offer exactly as it was", () => {
  const p = zeusxDetachPlan({
    autoDeliver: false,
    logins: ["alive1", "alive2"],
    login: "someone-else",
  });
  assert.strictEqual(p.action, "shrink");
  assert.strictEqual(p.quantity, 2);
});

// Digiseller's refusal to delete a unit a buyer already took is a success case,
// not a failure: the credentials are spent, so only our tracking needs clearing.
test("Digiseller's sold-content refusal is recognised", () => {
  const { isSoldContentError } = require("../utils/listingDetach");
  const live =
    'Digiseller remove content: {"retval":-1,"retdesc":"Validation error",' +
    '"errors":[{"code":"content-2","message":[{"locale":"en-US","value":' +
    '"Can\'t delete sold content"},{"locale":"ru-RU","value":' +
    '"Нельзя удалять проданное содержимое"}]}],"content":null}';
  assert.ok(isSoldContentError(new Error(live)));
  assert.ok(isSoldContentError("Нельзя удалять проданное содержимое"));
  assert.ok(!isSoldContentError(new Error("Digiseller remove content: 500")));
  assert.ok(!isSoldContentError(null));
});
