// Code-bundle stock rows hold reward codes, not logins: the account lookup
// (the token-gated external API) must never hand their codes out.
process.env.CRED_SECRET ||= "account-lookup-code-bundle-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SuppliedAccount = require("../models/SuppliedAccount");
const { encrypt } = require("../utils/secretBox");
const { lookupAccountByUsername } = require("../utils/accountLookup");

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("accountlookupcodes"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const offer = new mongoose.Types.ObjectId();
const supplied = (r) => r.sources.find((s) => s.source === "supplied");

test("a code-bundle row (shop unit or hand-made code lines) is withheld", async () => {
  await SuppliedAccount.create({ offer, login: "cs-abc123-1", password: encrypt("1) Spray = AAAA-BBBB-CCCC"), status: "available", note: "code unit" });
  await SuppliedAccount.create({ offer, login: "handbundle-x", password: encrypt("1) Icon = ZZZZ-1111\n2) Spray = YYYY-2222"), status: "sold" });
  for (const login of ["cs-abc123-1", "handbundle-x"]) {
    const r = await lookupAccountByUsername(login, { includeCredentials: true });
    const s = supplied(r);
    assert.ok(s, "found " + login);
    assert.equal(s.credentials.password, "");
    assert.equal(s.credentials.withheld, "code bundle");
    assert.ok(!JSON.stringify(r).includes("AAAA-BBBB") && !JSON.stringify(r).includes("ZZZZ-1111"));
  }
});

test("an ordinary pasted account still returns its password", async () => {
  await SuppliedAccount.create({ offer, login: "plainuser", password: encrypt("hunter2pass"), status: "available" });
  const s = supplied(await lookupAccountByUsername("plainuser", { includeCredentials: true }));
  assert.equal(s.credentials.password, "hunter2pass");
  assert.equal(s.credentials.withheld, undefined);
});
