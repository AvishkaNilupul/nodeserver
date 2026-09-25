// The auto-farm's three recycle paths (task retirement, the retro-reaper, probe
// expiry) hand a task's accounts back to the pool. They used to flip ANY claimed
// pool row among those logins to "available", so rows other subsystems hold on
// purpose were released too. The retro-reaper re-runs over every completed task
// on every tick, which turned that into a loop on prod (2026-09-18 → 09-25):
// held "unclaimed stock" accounts were released and re-held every ~23 minutes,
// a Telegram each time, and backfill claimed 16 of them into claiming bots in
// the gap, destroying ~14 unsold Rainbow Six / Overwatch drops per account.
const test = require("node:test");
const assert = require("node:assert");

const {
  isAutoFarmClaimNote,
  recyclableClaimQuery,
  readyPoolQuery,
} = require("../utils/autoFarmer");

test("only the auto-farm's own claim notes are recyclable", () => {
  for (const note of [
    "auto-farm: CONTROL Resonant (84f27bd4-9c9f-4a03-acc5-096b84081db8)",
    "auto-farm backfill: Rainbow Six Siege (0a24bd2b)",
    "Auto-Farm: Fortnite (x)",
  ]) {
    assert.equal(isAutoFarmClaimNote(note), true, note);
  }
  // Every claim note measured on prod that belongs to someone else.
  for (const note of [
    "unclaimed stock — 14 drop(s) (Rainbow Six Siege, Overwatch) held out of the pool until sold",
    "unclaimed stock was claimed — probably sold by hand; check before reusing",
    "noclaim-farm:Overwatch",
    "noclaim-farm:Rainbow Six Siege",
    "spent — no-claim removed Overwatch",
    "spent — manual no-claim listing (gameflip order 123)",
    "rented to bulkfarmall",
    "quarantined by audit: sold/listed/still farming",
    "deployed to twitchbotx44 [contabo]",
    "sold — token reclaimed by buyer",
    "recycled by retro-reaper",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isAutoFarmClaimNote(note), false, String(note));
  }
});

test("the recycle filter matches claimed auto-farm rows only, case-folded", () => {
  const q = recyclableClaimQuery(["OdmpWSAI602mj", "odmpwsai602mj", "rvay429wt"]);
  assert.deepEqual(q.usernameLower, { $in: ["odmpwsai602mj", "rvay429wt"] });
  assert.equal(q.status, "claimed");
  assert.deepEqual(q.manualSold, { $ne: true });
  assert.ok(q.claimedNote instanceof RegExp);
  assert.equal(q.claimedNote.test("auto-farm: REMATCH (828ae239)"), true);
  assert.equal(
    q.claimedNote.test("unclaimed stock — 12 drop(s) (Rainbow Six Siege)"),
    false,
  );
  assert.deepEqual(recyclableClaimQuery([]).usernameLower, { $in: [] });
  assert.deepEqual(recyclableClaimQuery(undefined).usernameLower, { $in: [] });
});

test("an account holding unclaimed drops is never ready supply", () => {
  const q = readyPoolQuery();
  assert.equal(q.status, "available");
  assert.deepEqual(q.manualSold, { $ne: true });
  // $not/$gt keeps rows with no count (never checked) and rows with 0.
  assert.deepEqual(q.unclaimedDropCount, { $not: { $gt: 0 } });
});
