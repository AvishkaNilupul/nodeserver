// utils/codeShop/eventDates.js: the start date of the event(s) a product's codes
// come from. A buyer reads the date only, never the campaign's title, so this
// returns dates and nothing else. Small fakes stand in for the two models.
const test = require("node:test");
const assert = require("node:assert/strict");

const { eventStarts, campaignStartMs } = require("../utils/codeShop/eventDates");

const NINE_H = 9 * 60 * 60 * 1000;

function fakeCampaigns(docs) {
  const calls = [];
  return {
    calls,
    find(query, projection) {
      calls.push({ query, projection });
      const want = new Set(query.dropsIdx.$in);
      return { lean: async () => docs.filter((d) => want.has(d.dropsIdx)).map((d) => ({ ...d })) };
    },
  };
}

function fakeStock(firstEarned) {
  const calls = [];
  return {
    calls,
    async aggregate(pipeline) {
      calls.push(pipeline);
      const keys = pipeline[0].$match.groupKey.$in;
      return keys.filter((k) => firstEarned[k]).map((k) => ({ _id: k, at: new Date(firstEarned[k]) }));
    },
  };
}

test("campaignStartMs: a v2 row as stored, a v1 row (no titleRaw) nine hours earlier", () => {
  const at = Date.parse("2026-10-11T14:30:00Z");
  assert.equal(campaignStartMs({ startDate: new Date(at), titleRaw: "" }), at);
  assert.equal(campaignStartMs({ startDate: new Date(at) }), at - NINE_H);
  assert.equal(campaignStartMs({ startDate: null, titleRaw: "x" }), null);
  assert.equal(campaignStartMs(null), null);
});

test("eventStarts: campaign start dates, oldest first, one per group", async () => {
  const camps = fakeCampaigns([
    { dropsIdx: "501", startDate: new Date("2026-10-11T08:00:00Z"), titleRaw: "t" },
    { dropsIdx: "502", startDate: new Date("2026-10-02T08:00:00Z"), titleRaw: "t" },
  ]);
  const stock = fakeStock({});
  const out = await eventStarts({ SoopCampaign: camps, CodeStock: stock }, ["12:501", "12:502", "12:501"]);
  assert.deepEqual(out.map((d) => d.toISOString()), ["2026-10-02T08:00:00.000Z", "2026-10-11T08:00:00.000Z"]);
  assert.deepEqual(camps.calls[0].query.dropsIdx.$in.sort(), ["501", "502"]);
  assert.equal(camps.calls[0].projection, "dropsIdx startDate titleRaw", "never reads the campaign's title");
  assert.equal(stock.calls.length, 0, "every group had a campaign row");
});

test("eventStarts: a group with no campaign row is dated by its first earned code", async () => {
  const camps = fakeCampaigns([{ dropsIdx: "1", startDate: new Date("2026-10-08T06:00:00Z") }]); // v1 row
  const stock = fakeStock({ "200:2": "2026-10-09T07:00:00Z", "12:nabc123": "2026-10-05T01:00:00Z" });
  const out = await eventStarts({ SoopCampaign: camps, CodeStock: stock }, ["200:1", "200:2", "12:nabc123", "12:none"]);
  assert.deepEqual(out.map((d) => d.toISOString()), [
    "2026-10-05T01:00:00.000Z", // hashed-title group: no campaign to read
    "2026-10-07T21:00:00.000Z", // v1 row, nine hours back
    "2026-10-09T07:00:00.000Z", // campaign row missing
  ]);
  assert.deepEqual(camps.calls[0].query.dropsIdx.$in.sort(), ["1", "2"], "only numeric groups are looked up");
  assert.deepEqual(stock.calls[0][0].$match.groupKey.$in.sort(), ["12:nabc123", "12:none", "200:2"]);
});

test("eventStarts: nothing to read -> [], and a missing model is skipped", async () => {
  assert.deepEqual(await eventStarts({}, []), []);
  assert.deepEqual(await eventStarts({}, null), []);
  assert.deepEqual(await eventStarts(null, ["12:5"]), []);
  const stock = fakeStock({ "12:5": "2026-10-01T00:00:00Z" });
  const out = await eventStarts({ CodeStock: stock }, ["12:5"]);
  assert.deepEqual(out.map((d) => d.toISOString()), ["2026-10-01T00:00:00.000Z"]);
});
