const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCredentials, singleAccount } = require("../utils/funpayCredentials");

// All logins and passwords below are made up.
const one = (text) => singleAccount(text);

test("plain 'login : password' with a guide link around it", () => {
  assert.deepEqual(one("Your account:\nfakeuser_01 : Pa55word!x\nInstructions: https://example.com/guide"), {
    username: "fakeuser_01",
    password: "Pa55word!x",
  });
});

test("three fields keep the OAuth token apart from the password", () => {
  assert.deepEqual(one("fake_login22:pw12345:abcdefghijklmnop0123"), {
    username: "fake_login22",
    password: "pw12345",
    token: "abcdefghijklmnop0123",
  });
});

test("labelled lines are read before the bare 'a : b' pattern", () => {
  assert.deepEqual(one("✅ Login: fakeuser_77\n✅ Password: s3cret$PW!"), { username: "fakeuser_77", password: "s3cret$PW!" });
  assert.deepEqual(one("Login....: fakeuser_78\nPassword...: s3cretPW2"), { username: "fakeuser_78", password: "s3cretPW2" });
  assert.deepEqual(one("Login: fakeuser_79 | Password: Pw$12345"), { username: "fakeuser_79", password: "Pw$12345" });
});

test("Cyrillic labels keep symbols in the password and drop glued emoji", () => {
  assert.deepEqual(one("1️⃣Логин: fakeuser_88\n2️⃣Пароль: Pa$$w0rd!"), { username: "fakeuser_88", password: "Pa$$w0rd!" });
  assert.deepEqual(one("Twitch☑️Логин(login): fakeuser_99☑️ Пароль(password): Zx98765☑️"), {
    username: "fakeuser_99",
    password: "Zx98765",
  });
});

test("dash separated and logins that start with digits", () => {
  assert.deepEqual(one("fakeuser_55----passW0rd99"), { username: "fakeuser_55", password: "passW0rd99" });
  assert.deepEqual(one("🔹123fakeuser : Secret999"), { username: "123fakeuser", password: "Secret999" });
});

test("table rows skip their header", () => {
  const rows = parseCredentials("Login\tPassword\tInfo\nfakeuser_31\tTablePass1\tnone");
  assert.deepEqual(rows, [{ username: "fakeuser_31", password: "TablePass1" }]);
});

test("more than one account, or none, is never a single delivery", () => {
  assert.equal(one("fakeuser_01 : Pa55word!x\nfakeuser_02 : Pa55word!y"), null);
  assert.equal(one("Thanks for the purchase! Link the account and enjoy."), null);
  assert.equal(one("Guide: https://telegra.ph/x\nhttps://imgur.com/a/b"), null);
  assert.equal(one(""), null);
});

test("label words and links are never taken as credentials", () => {
  assert.deepEqual(parseCredentials("Manual: https://example.com/a\nInstructions: https://example.com/b"), []);
  assert.deepEqual(parseCredentials("Password: hunter22"), []); // no login line before it
});
