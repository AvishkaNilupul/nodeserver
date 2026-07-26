// Pure-function coverage for the bot consolidation / retirement helpers:
// compose service add->remove roundtrip and seat counting. No docker, no
// Mongo — these are the text/JSON transforms everything else trusts.
const test = require("node:test");
const assert = require("node:assert");

const {
  addServiceToComposeText,
  removeServiceFromComposeText,
  usedSeats,
} = require("../utils/botFactory");

const BASE_COMPOSE = [
  "services:",
  "  twitchbot:",
  "    image: avishkarex/twitchbot:latest",
  "    container_name: twitchbot",
  "    volumes:",
  "      - ./config.json:/app/config.json",
  "",
].join("\n");

test("remove is the inverse of add (roundtrip keeps other services)", () => {
  const added = addServiceToComposeText(
    BASE_COMPOSE,
    "twitchbotx2",
    "config_02.json",
  );
  assert.strictEqual(added.exists, false);
  assert.match(added.text, /twitchbotx2/);

  const removed = removeServiceFromComposeText(added.text, "twitchbotx2");
  assert.strictEqual(removed.existed, true);
  assert.doesNotMatch(removed.text, /twitchbotx2/);
  // The original service must survive the roundtrip untouched.
  assert.match(removed.text, /container_name: twitchbot\b/);
  assert.match(removed.text, /config\.json:\/app\/config\.json/);
});

test("removing a service that is not there is a no-op", () => {
  const r = removeServiceFromComposeText(BASE_COMPOSE, "twitchbotx9");
  assert.strictEqual(r.existed, false);
  assert.strictEqual(r.text, BASE_COMPOSE);
});

test("removing from invalid/empty compose text does not throw", () => {
  const r = removeServiceFromComposeText("", "twitchbot");
  assert.strictEqual(r.existed, false);
});

test("usedSeats counts only enabled TwitchUsers", () => {
  const cfg = {
    TwitchSettings: {
      TwitchUsers: [
        { Login: "a", Enabled: true },
        { Login: "b" }, // Enabled defaults to true
        { Login: "c", Enabled: false }, // disabled = free seat
        null, // junk entries never count
      ],
    },
  };
  assert.strictEqual(usedSeats(cfg), 2);
});

test("usedSeats is 0 for missing/malformed configs", () => {
  assert.strictEqual(usedSeats(null), 0);
  assert.strictEqual(usedSeats({}), 0);
  assert.strictEqual(usedSeats({ TwitchSettings: { TwitchUsers: "x" } }), 0);
});
