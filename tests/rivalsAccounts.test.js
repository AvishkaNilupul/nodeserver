const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const logic = require("../utils/rivalsAccounts");
const presentationLogic = require("../utils/rivalsPresentation");
const { createRouter } = require("../routes/rivalsAccountRoutes");
const {
  importReport,
  reportFromWorker,
} = require("../tools/rivals-claim-worker/import-game-report.cjs");
const prep = () => ({
  _id: "rivals-test-account",
  status: "held",
  holdId: "hold",
  steamId: "steam-id",
  twitchId: "twitch-id",
  twitchLogin: "test",
  expectedRewards: [{ id: "reward", name: "Rogue Costume" }],
  reservedCount: 1,
});
const report = () => ({
  id: "rivals-test-account",
  holdId: "hold",
  steamAccountId: "steam-id",
  twitchAccountId: "twitch-id",
  rivalsUid: "123456789",
  state: "ready",
  phase: "logged-out",
  verifiedRewards: ["reward"],
  verifiedAt: "2026-11-04T05:00:00Z",
  completedAt: "2026-11-04T06:00:00Z",
  proofs: [
    {
      rewardId: "reward",
      hero: "Rogue",
      costume: "Will of Galacta",
      file: "rogue.png",
      sha256: logic.digest(Buffer.from("image")),
    },
  ],
  password: "MUST_NOT_PASS",
});
const steam = {
  stage: "problem",
  notes: "Preparation rivals-test-account",
  soldAt: null,
  signupCountry: "JP",
};
test("completed report strips credentials and rejects pair, reward and path substitutions", () => {
  const p = prep(),
    r = report();
  const valid = logic.validateReport(p, r);
  assert.equal(valid.state, "ready");
  assert.equal(valid.password, undefined);
  for (const change of [
    { holdId: "other" },
    { steamAccountId: "other" },
    { twitchAccountId: "other" },
    { state: "running" },
    { phase: "linked" },
    { verifiedRewards: ["unknown"] },
    { verifiedAt: "invalid" },
    { proofs: [{ ...r.proofs[0], file: "../rogue.png" }] },
  ])
    assert.throws(() => logic.validateReport(p, { ...r, ...change }));
  assert.throws(() =>
    logic.validateReport({ ...p, gameReport: { rivalsUid: "999999999" } }, r),
  );
  assert.throws(() =>
    logic.validateReport(
      { ...p, expectedRewards: [] },
      { ...r, verifiedRewards: [], proofs: [] },
    ),
  );
});
test("worker export cannot substitute another profile or omit actual costume evidence", () => {
  const j = { ...report(), expectedRewards: prep().expectedRewards };
  const m = {
    jobId: j.id,
    rivalsUid: j.rivalsUid,
    verifiedCostumes: [{ ...report().proofs[0], hero: "rogue" }],
  };
  assert.equal(reportFromWorker(j, m).proofs[0].rewardId, "reward");
  assert.throws(() => reportFromWorker(j, { ...m, rivalsUid: "999999" }));
  assert.throws(() => reportFromWorker(j, { ...m, verifiedCostumes: [] }));
});
test("draft uses Fresh PC category, does not infer store country from signup, exposes no secrets", () => {
  const p = {
    ...prep(),
    gameReport: logic.validateReport(prep(), report()),
    password: "PRIVATE",
  };
  const row = logic.publicRow(
    p,
    { ...steam, password: "PRIVATE" },
    { canSell: true },
  );
  assert.equal(row.draft.tradeEnvironmentId, "9-0");
  assert.equal(row.draft.country, null);
  assert.match(row.draft.description, /no ranked-ready/);
  assert.equal(row.draft.estimatedFeeUsd, 0.8);
  assert.equal(row.draft.estimatedNetUsd, 7.19);
  assert.ok(row.blockers.some((b) => b.includes("delivery")));
  assert.ok(!JSON.stringify(row).includes("PRIVATE"));
  assert.ok(
    logic
      .blockers(p, { ...steam, stage: "listed" }, { canSell: true })
      .includes("Steam hold changed"),
  );
});
test("costume names lead the title, and only a game receipt can add received currency", () => {
  const proofs = [
    { hero: "Rogue", costume: "Will of Galacta" },
    { hero: "Storm", costume: "Will of Galacta" },
    { hero: "Daredevil MSF26", costume: "IGNITE Daredevil (2026)" },
  ];
  const p = {
    gameReport: { proofs },
    rewardAudit: { receivedChronoTokens: 1100 },
  };
  const unverified = logic.draft(p, {});
  assert.match(unverified.title, /^Will of Galacta \+ IGNITE Daredevil 2026/);
  assert.ok(unverified.title.length <= 160);
  assert.equal(unverified.description.match(/Will of Galacta/g).length, 1);
  assert.ok(!unverified.description.includes("1,100"));
  const verified = logic.draft(
    {
      ...p,
      rewardAudit: {
        ...p.rewardAudit,
        currencyEvidence: { kind: "game-claim-receipt" },
      },
    },
    {},
  );
  assert.match(verified.description, /1,100 Chrono Tokens received/);
  assert.match(verified.description, /not Units or Lattice/);
});
test("presentation import does not convert Twitch claim history into verified game inventory", () => {
  const p = { ...prep(), gameReport: logic.validateReport(prep(), report()) };
  const receipt = {
    file: "receipt.png",
    sha256: "a".repeat(64),
    kind: "original-receipt",
    label: "Actual receipt",
  };
  const manifest = {
    createdAt: "2026-11-04T07:00:00Z",
    sourceManifestUid: "123456789",
    images: [receipt],
    receiptSha256: receipt.sha256,
    receivedChronoTokens: 1100,
  };
  const audit = {
    rivalsUid: "123456789",
    observedAt: "2026-11-04T07:00:00Z",
    drops: [
      { id: "reward", name: "Rogue Costume", count: 1, state: "connected" },
      {
        id: "other",
        name: "Unverified extra Costume",
        count: 1,
        state: "connected",
      },
    ],
  };
  const result = presentationLogic.validate(p, manifest, audit);
  assert.equal(result.rewardAudit.total, 2);
  assert.equal(result.rewardAudit.groups["Costume rewards"], 2);
  assert.equal(result.gameReport, undefined);
  assert.equal(p.gameReport.proofs.length, 1);
  assert.throws(() =>
    presentationLogic.validate(
      p,
      { ...manifest, sourceManifestUid: "999999" },
      audit,
    ),
  );
  assert.throws(() =>
    presentationLogic.validate(
      p,
      { ...manifest, images: [{ ...receipt, file: "../bad.png" }] },
      audit,
    ),
  );
  assert.throws(() =>
    presentationLogic.validate(p, manifest, { ...audit, drops: [] }),
  );
  assert.throws(() =>
    presentationLogic.validate(
      p,
      { ...manifest, receiptSha256: "b".repeat(64) },
      audit,
    ),
  );
});
async function serve(t, admin, deps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, n) => {
    req.session = { admin };
    n();
  });
  app.use(createRouter(deps));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
test("anonymous and ordinary admins cannot access evidence or selling actions", async (t) => {
  for (const [admin, expected] of [
    [undefined, 401],
    [{ role: "admin" }, 403],
  ]) {
    const url = await serve(t, admin, {
      getDb: () => {
        throw Error("must not touch DB");
      },
    });
    for (const route of [
      "/api/rivals/preparations",
      "/api/rivals/preparations/rivals-test-account/proof/rogue.png",
    ])
      assert.equal((await fetch(url + route)).status, expected);
  }
});
test("cross-origin mutations and malformed prices never reach stock", async (t) => {
  const url = await serve(
    t,
    { role: "superadmin" },
    {
      getDb: () => {
        throw Error("must not touch DB");
      },
    },
  );
  assert.equal(
    (
      await fetch(url + "/api/rivals/eldorado/check", {
        method: "POST",
        headers: { Origin: "https://foreign.example" },
      })
    ).status,
    403,
  );
  for (const priceUsd of [-1, 1.001, "9", null])
    assert.equal(
      (
        await fetch(
          url + "/api/rivals/preparations/rivals-test-account/draft",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ priceUsd }),
          },
        )
      ).status,
      400,
    );
});
test("seller profile errors cannot be promoted to available access", async (t) => {
  let saved;
  const url = await serve(
    t,
    { role: "superadmin" },
    {
      getDb: () => ({
        collection: () => ({
          updateOne: async (_q, u) => {
            saved = u.$set;
          },
        }),
      }),
      eld: () => ({
        epicPermission: async () => ({
          canSell: true,
          epicIsHighRisk: false,
          error: "Authentication failed",
        }),
      }),
    },
  );
  const res = await fetch(url + "/api/rivals/eldorado/check", {
    method: "POST",
  });
  assert.equal(res.status, 200);
  assert.equal(saved.canSell, null);
  assert.match(saved.error, /incomplete/);
});
test("proof import verifies exclusive stock and files, supports identical retry without duplicate writes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rivals-report-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"),
    target = path.join(dir, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "rogue.png"), "image");
  let p = prep(),
    writes = 0,
    conflict = 0,
    held = 1;
  const db = {
    collection: (name) => ({
      findOne: async () => (name === "rivalspreparations" ? p : steam),
      countDocuments: async () => (name === "droplogs" ? held : conflict),
      updateOne: async (q, u) => {
        assert.equal(q.status, "held");
        writes++;
        p = { ...p, ...u.$set };
        return { matchedCount: 1 };
      },
    }),
  };
  assert.equal((await importReport(db, report(), source, target)).verified, 1);
  await importReport(db, report(), source, target);
  assert.equal(writes, 1);
  assert.equal(p.status, "held");
  conflict = 1;
  await assert.rejects(
    importReport(db, report(), source, target),
    /commitment/,
  );
  conflict = 0;
  held = 0;
  await assert.rejects(
    importReport(db, report(), source, target),
    /reservation/,
  );
  held = 1;
  await fs.writeFile(path.join(source, "rogue.png"), "changed");
  await assert.rejects(importReport(db, report(), source, target), /checksum/);
});
