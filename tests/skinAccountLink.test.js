const test = require("node:test");
const assert = require("node:assert/strict");
const { proof } = require("../utils/skinAccountLink");
const link = {
  accountId: "epic",
  type: "twitch",
  externalAuthId: "name",
  externalAuthIdType: "twitch_name",
  externalAuthSecondaryId: "123",
  authIds: [{ id: "123", type: "twitch_id" }],
};
test("exact Epic account and stable numeric Twitch identity are required", () => {
  assert.equal(proof([link], "epic", "123"), true);
  assert.equal(proof([link], "wrong", "123"), false);
  assert.equal(proof([link], "epic", "124"), false);
});
test("display names, duplicate links and inconsistent numeric auth IDs cannot pass", () => {
  assert.equal(
    proof(
      [
        {
          accountId: "epic",
          type: "twitch",
          externalAuthId: "123",
          externalAuthIdType: "twitch_name",
        },
      ],
      "epic",
      "123",
    ),
    false,
  );
  assert.equal(proof([link, link], "epic", "123"), false);
  assert.equal(
    proof([{ ...link, externalAuthSecondaryId: "999" }], "epic", "123"),
    false,
  );
  assert.equal(proof(null, "epic", "123"), false);
});
