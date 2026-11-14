const test = require("node:test");
const assert = require("node:assert/strict");
const panel = require("../public/skin-accounts.js");

function row(overrides = {}) {
  return {
    id: "pair-1",
    gameKey: "rocket-league",
    gameName: "Rocket League",
    state: "listed",
    ownershipStatus: "owned",
    epic: {
      id: "stock-1",
      accountId: "epic-external-1",
      displayName: "Test Driver",
      region: "JP",
    },
    twitch: { id: "bot-1", twitchId: "12345", login: "test_viewer" },
    link: { status: "verified", verifiedAt: "2026-11-14T14:30:00Z" },
    profile: {
      region: "JP",
      platform: "PC",
      rank: "Unranked",
      level: 9,
      credits: 0,
    },
    farm: { enabled: true, allowed: true, status: "Running" },
    inventory: {
      verified: [
        {
          key: "body-1",
          name: "Nemesis",
          count: 1,
          kind: "body",
          paint: "Titanium White",
        },
      ],
      pending: [
        {
          key: "drop-1",
          name: "Tactical Nuke (Painted)",
          count: 1,
          kind: "goal",
        },
      ],
      verifiedAt: "2026-11-14T14:45:00Z",
    },
    listing: {
      id: "offer-1",
      url: "https://www.eldorado.gg/rocket-league-accounts-for-sale/oa/offer-1",
      priceUsd: 4.99,
      status: "active",
    },
    pricing: { mode: "manual", currentUsd: 4.99, floorUsd: 3, ceilingUsd: 12 },
    history: [],
    ...overrides,
  };
}
function reply(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function overview(rows = [row()]) {
  return {
    success: true,
    rows,
    summary: { total: rows.length, listed: 1 },
    worker: { running: true },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("claimed rewards remain separate from observed inventory and unknown paint is not invented", () => {
  const data = row();
  data.inventory.pending[0].paint = "Unverified Red";
  data.inventory.pending[0].certification = "Unverified Striker";
  const html = panel.renderDetails(data, false);
  assert.match(html, /Verified in game/);
  assert.match(html, /Titanium White/);
  assert.match(html, /Awaiting game check · 1/);
  assert.match(html, /Tactical Nuke \(Painted\)/);
  assert.match(html, /expected in Rocket League after the next login/);
  assert.doesNotMatch(html, /Unverified Red|Unverified Striker/);
  assert.match(html, /Level 9 · Unranked · 0 credits/);
});

test("all external content is escaped and unsafe links cannot be activated", () => {
  const data = row({
    epic: { displayName: '<img src=x onerror="bad()">', region: "JP" },
    listing: { url: "javascript:bad()" },
    lastError: "<script>bad()</script>",
    history: [{ message: '<iframe src="x">' }],
  });
  const html = panel.renderDetails(data, false);
  assert.doesNotMatch(html, /<img|<script|<iframe|javascript:/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.equal(panel.safeUrl("https://user:password@example.org/a.png"), "");
  assert.equal(panel.safeUrl("http://example.org/a.png"), "");
  assert.equal(
    panel.safeUrl("https://example.org/a.png"),
    "https://example.org/a.png",
  );
});

test("sold accounts have no link, publish, inventory or farming mutations", () => {
  const html = panel.renderDetails(
    row({ state: "sold", ownershipStatus: "sold" }),
    false,
  );
  assert.match(html, /data-action="refresh-row"/);
  assert.doesNotMatch(
    html,
    /data-action="(?:link|inventory|farm-on|farm-off|pause|resume|pricing|preview)"/,
  );
});

test("quarantined account can stop farming and pause its listing but cannot enable or resume", () => {
  const html = panel.renderDetails(
    row({ ownershipStatus: "quarantined", state: "attention" }),
    false,
  );
  assert.match(html, /data-action="farm-off"/);
  assert.match(html, /data-action="pause"/);
  assert.match(html, /data-action="refresh-row"/);
  assert.doesNotMatch(
    html,
    /data-action="(?:farm-on|resume|pricing|link|inventory)"/,
  );
});

test("publish recovery is available for an ambiguous unsold quarantine but never for sold accounts", () => {
  const recovery = { required: true, listingId: "local-draft" };
  assert.match(
    panel.renderDetails(
      row({ state: "attention", ownershipStatus: "quarantined", recovery }),
      false,
    ),
    /data-action="recover"/,
  );
  assert.doesNotMatch(
    panel.renderDetails(
      row({ state: "sold", ownershipStatus: "sold", recovery }),
      false,
    ),
    /data-action="recover"/,
  );
  assert.doesNotMatch(
    panel.renderDetails(row(), false),
    /data-action="recover"/,
  );
});

test("recovery accepts a real offer ID or official offer URL and rejects foreign URLs", () => {
  const id = "1cac7526-3bb5-49f8-b54e-08df41f90e91";
  assert.equal(panel.recoveryOfferId(id.toUpperCase()), id);
  assert.equal(
    panel.recoveryOfferId(
      "https://www.eldorado.gg/rocket-league-accounts-for-sale/oa/" +
        id +
        "?source=seller",
    ),
    id,
  );
  for (const value of [
    "https://eldorado.gg.example.org/oa/" + id,
    "https://user:secret@www.eldorado.gg/oa/" + id,
    "javascript:alert(1)",
    "https://www.eldorado.gg/seller",
    "invalid-id",
  ])
    assert.throws(
      () => panel.recoveryOfferId(value),
      /existing Eldorado offer/,
    );
});

test("search and status filters preserve selected state without exposing record IDs as visible labels", () => {
  const rows = [
    row(),
    row({
      id: "pair-2",
      state: "sold",
      epic: { displayName: "Second" },
      twitch: { login: "other" },
    }),
  ];
  const html = panel.renderList(rows, "pair-1", "TEST_VIEWER", "listed");
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Test Driver/);
  assert.doesNotMatch(html, /Second|stock-1|epic-external-1/);
  assert.match(
    panel.renderList(rows, "pair-1", "missing", "all"),
    /No matching accounts/,
  );
});

test("private delivery fields are not rendered even when accidentally added to a row", () => {
  const data = row({
    password: "secret-marker",
    token: "token-marker",
    delivery: { message: "private-marker" },
  });
  data.epic.password = "epic-secret-marker";
  const html =
    panel.renderDetails(data, false) +
    panel.renderList([data], data.id, "", "all");
  assert.doesNotMatch(html, /secret-marker|token-marker|private-marker/);
});

test("inventory confirmation requires observed items, unique keys, whole counts and explicit confirmation", () => {
  const items = [
    {
      key: "a",
      name: " Apex Collection ",
      count: "1",
      kind: "reward",
      paint: "",
      certification: "",
    },
  ];
  assert.throws(
    () => panel.validateInventory(items, "Visual game check", false),
    /Confirm/,
  );
  assert.throws(() => panel.validateInventory(items, "", true), /record/);
  assert.throws(
    () => panel.validateInventory([], "Visual check", true),
    /at least one/,
  );
  assert.throws(
    () => panel.validateInventory([items[0], items[0]], "Visual check", true),
    /unique/,
  );
  assert.throws(
    () =>
      panel.validateInventory(
        [{ ...items[0], count: 1.5 }],
        "Visual check",
        true,
      ),
    /whole/,
  );
  assert.deepEqual(
    panel.validateInventory(items, " Visual game check ", true),
    {
      confirm: true,
      items: [
        {
          key: "a",
          name: "Apex Collection",
          count: 1,
          kind: "reward",
          paint: "",
          certification: "",
        },
      ],
      evidence: "Visual game check",
    },
  );
});

test("profile requires actual values and preserves unsupported profiles for server-side review", () => {
  assert.deepEqual(
    panel.validateProfile({
      region: "jp",
      level: "9",
      rank: "Unranked",
      credits: "0",
    }),
    { region: "JP", level: 9, rank: "Unranked", credits: 0, platform: "PC" },
  );
  assert.throws(
    () =>
      panel.validateProfile({
        region: "JP",
        level: "",
        rank: "Unranked",
        credits: "0",
      }),
    /actual/,
  );
  assert.throws(
    () =>
      panel.validateProfile({
        region: "Japan",
        level: 9,
        rank: "Unranked",
        credits: 0,
      }),
    /two-letter/,
  );
  assert.equal(
    panel.validateProfile({
      region: "JP",
      level: 99,
      rank: "Champion",
      credits: 500,
    }).credits,
    500,
  );
});

test("price controls reject missing, nonfinite and inverted bounds", () => {
  assert.deepEqual(
    panel.validatePricing({
      mode: "market",
      floorUsd: "3",
      ceilingUsd: "10",
      basePriceUsd: "4.99",
    }),
    { mode: "market", floorUsd: 3, ceilingUsd: 10, basePriceUsd: 4.99 },
  );
  for (const input of [
    { mode: "manual", floorUsd: "", ceilingUsd: "10", basePriceUsd: "5" },
    { mode: "manual", floorUsd: "3", ceilingUsd: "2", basePriceUsd: "5" },
    {
      mode: "manual",
      floorUsd: "3",
      ceilingUsd: "10",
      basePriceUsd: "Infinity",
    },
  ])
    assert.throws(() => panel.validatePricing(input));
});

test("growth pricing keeps configured additions separate from market valuation", () => {
  const rates = {
    basicDropUsd: 0.1,
    premiumDropUsd: 0.2,
    cosmeticUsd: 0.5,
    duplicateCosmeticUsd: 0.1,
    apexUsd: 1,
  };
  assert.deepEqual(
    panel.validatePricing({
      mode: "growth",
      basePriceUsd: "4.99",
      floorUsd: "4.99",
      ceilingUsd: "50",
      rates,
    }),
    {
      mode: "growth",
      basePriceUsd: 4.99,
      floorUsd: 4.99,
      ceilingUsd: 50,
      rates,
    },
  );
  assert.throws(
    () =>
      panel.validatePricing({
        mode: "growth",
        basePriceUsd: 4.99,
        floorUsd: 4.99,
        ceilingUsd: 50,
        rates: { ...rates, apexUsd: -1 },
      }),
    /non-negative/,
  );
  const html = panel.renderDetails(
    row({
      pricing: {
        mode: "growth",
        basePriceUsd: 4.99,
        proposedUsd: 5.19,
        growthRates: rates,
        growthBaselineAt: "2026-11-14T14:45:00Z",
      },
    }),
    false,
  );
  assert.match(html, /Collection growth pricing/);
  assert.match(html, /Starting price/);
  assert.match(html, /\$5\.19/);
  assert.match(html, /not a market valuation/);
});

test("slow requests cannot overlap polling or explicit mutations", async () => {
  const gate = deferred(),
    calls = [];
  const app = panel.createController({
    fetch: async (...args) => {
      calls.push(args);
      return gate.promise;
    },
  });
  const first = app.refresh();
  assert.equal(app.state.busy, true);
  assert.equal(await app.refresh(), null);
  assert.equal(await app.mutate("farm", { enabled: true }, "pair-1"), null);
  assert.equal(calls.length, 1);
  gate.resolve(reply(overview()));
  await first;
  assert.equal(app.state.busy, false);
  assert.equal(app.state.rows.length, 1);
});

test("authentication failure clears cached rows, selection, pricing preview and stops future requests", async () => {
  let status = 200,
    calls = 0;
  const app = panel.createController({
    fetch: async () => {
      calls++;
      return status === 200
        ? reply(overview())
        : reply({ success: false, message: "Forbidden" }, status);
    },
  });
  await app.refresh();
  app.state.preview = { title: "Private draft", description: "old collection" };
  status = 403;
  await app.refresh();
  assert.equal(app.state.unauthorized, true);
  assert.deepEqual(app.state.rows, []);
  assert.deepEqual(app.state.summary, {});
  assert.equal(app.state.selectedId, null);
  assert.equal(app.state.preview, null);
  assert.equal(await app.mutate("publish", { confirm: true }, "pair-1"), null);
  assert.equal(calls, 2);
});

test("failed update never invents success or changes the current row", async () => {
  let fail = false;
  const app = panel.createController({
    fetch: async () =>
      fail
        ? reply({ success: false, message: "Remote stock is sold" }, 409)
        : reply(overview()),
  });
  await app.refresh();
  fail = true;
  assert.equal(await app.mutate("resume", {}, "pair-1"), null);
  assert.equal(app.state.rows[0].state, "listed");
  assert.equal(app.state.notice, "");
  assert.equal(app.state.error, "Remote stock is sold");
  assert.equal(app.state.busy, false);
});

test("enrollment is a single explicit reservation request and does not link or publish", async () => {
  const calls = [];
  const fresh = row({
    state: "preparing",
    link: { status: "unverified" },
    listing: {},
  });
  const app = panel.createController({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return reply({ success: true, row: fresh });
    },
  });
  await app.mutate("enroll", {
    epicAccountId: "stock-1",
    twitchLogin: "test_viewer",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/skin-accounts/enroll");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    epicAccountId: "stock-1",
    twitchLogin: "test_viewer",
  });
  assert.equal(app.selected().link.status, "unverified");
  assert.match(app.state.notice, /Confirm the link/);
});

test("recover sends only an existing-offer check and never retries creation", async () => {
  const calls = [];
  const app = panel.createController({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return reply({
        success: true,
        row: row({ state: "paused", recovery: { required: false } }),
      });
    },
  });
  await app.mutate(
    "recover",
    { confirm: true, offerId: "1cac7526-3bb5-49f8-b54e-08df41f90e91" },
    "pair-1",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/skin-accounts/pair-1/recover");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    confirm: true,
    offerId: "1cac7526-3bb5-49f8-b54e-08df41f90e91",
  });
  assert.match(app.state.notice, /verified, paused and attached/);
});

test("preview is a separate request and becomes invalid after inventory or profile changes", async () => {
  let currentRow = row();
  const calls = [];
  const app = panel.createController({
    fetch: async (url) => {
      calls.push(url);
      return reply(
        url.endsWith("/preview")
          ? {
              success: true,
              preview: {
                title: "Rocket League",
                description: "Observed items + pending claims",
                priceUsd: 4.99,
                canPublish: true,
                problems: [],
              },
            }
          : overview([currentRow]),
      );
    },
  });
  await app.refresh();
  await app.preview("pair-1");
  assert.equal(app.state.preview.canPublish, true);
  assert.equal(
    calls.some((url) => url.endsWith("/publish")),
    false,
  );
  currentRow = { ...currentRow, profile: { ...currentRow.profile, level: 10 } };
  await app.refresh();
  assert.equal(app.state.preview, null);
});

test("non-JSON server errors remain readable and recoverable", async () => {
  const app = panel.createController({
    fetch: async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("Unexpected token");
      },
    }),
  });
  await app.refresh();
  assert.match(app.state.error, /Could not complete/);
  assert.doesNotMatch(app.state.error, /Unexpected token/);
  assert.equal(app.state.busy, false);
});
