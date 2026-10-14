// Which stream a SOOP account joins (utils/soopWorker.js pickChannel). No
// network and no database: a stub client answers the player info of each
// channel.
//
// Pinned here is what went wrong on 2026-10-13: the farm had lost sight of the
// Overwatch campaign in SOOP's list, took it for delisted, and joined the first
// of its channels that was on air — a co-streamer playing ranked games, whose
// stream said IS_DROPS 0. 29 accounts, 725 joins in six hours, no minute counted.
const test = require("node:test");
const assert = require("node:assert/strict");

const { pickChannel, carriesDrops, channelMemo } = require("../utils/soopWorker");

const DROPS = { RESULT: 1, IS_DROPS: 1 };
const NO_DROPS = { RESULT: 1, IS_DROPS: 0 };
const UNSTATED = { RESULT: 1 }; // an older reply shape
const OFF_AIR = { RESULT: 0 };

// streams: { [channel]: player info | Error }; a channel not named is off air.
function stubClient(streams, { category = [] } = {}) {
  const asked = [];
  return {
    asked,
    async liveInfo(bj) {
      asked.push(bj);
      const s = streams[bj];
      if (s instanceof Error) throw s;
      return s || OFF_AIR;
    },
    async categoryChannels() {
      return category;
    },
  };
}

const channels = (...ids) => ids.map((id) => ({ id, nick: id, onAir: false }));
// As the campaign store hands a campaign out: one SOOP no longer lists has no
// live flag at all.
const delisted = (...ids) => ({ dropsIdx: "13787", live: false, filter: "unlisted", categoryWide: false, channels: channels(...ids) });
const listedLive = (...ids) => ({ ...delisted(...ids), live: true, filter: "progress" });

let clock = 1_000_000;
const now = () => clock;
test.beforeEach(() => {
  channelMemo.clear();
  clock = 1_000_000;
});

test("carriesDrops reads SOOP's flag in the spellings it uses, and anything else is 'does not say'", () => {
  for (const v of [1, "1", true, "Y", "y"]) assert.equal(carriesDrops({ RESULT: 1, IS_DROPS: v }), true, JSON.stringify(v));
  for (const v of [0, "0", false, "N", "n"]) assert.equal(carriesDrops({ RESULT: 1, IS_DROPS: v }), false, JSON.stringify(v));
  // A value never seen from SOOP must not be read as "no drops": that would
  // keep an account off a stream for a reason nobody measured.
  for (const v of [undefined, null, "", "true", "on", 2, "maybe", {}]) {
    assert.equal(carriesDrops({ RESULT: 1, IS_DROPS: v }), null, JSON.stringify(v));
  }
  assert.equal(carriesDrops(UNSTATED), null);
  assert.equal(carriesDrops(null), null);
});

test("a campaign SOOP no longer lists is not joined on a stream that carries no drops", async () => {
  const camp = delisted("owesports", "costream1", "costream2", "costream3");
  const client = stubClient({ costream2: NO_DROPS, costream3: NO_DROPS });
  assert.equal(await pickChannel(client, camp, now), null);
  assert.deepEqual(client.asked, ["owesports", "costream1", "costream2", "costream3"], "every channel was looked at once");

  clock += 60_000;
  assert.equal(await pickChannel(client, camp, now), null);
  assert.equal(client.asked.length, 4, "and not again for 90 s: the other accounts share the answer");
  clock += 31_000;
  await pickChannel(client, camp, now);
  assert.equal(client.asked.length, 8, "then it looks again");
});

test("the stream that carries the drops wins, wherever it is in the list and whatever was joined last", async () => {
  const camp = delisted("costream", "owesports");
  const client = stubClient({ costream: NO_DROPS, owesports: DROPS });
  assert.equal(await pickChannel(client, camp, now), "owesports");
  assert.equal(channelMemo.get("13787").bj, "owesports");

  // The co-streamer was the last channel on air before the broadcast began.
  channelMemo.set("13787", { bj: "costream", at: clock });
  assert.equal(await pickChannel(client, camp, now), "owesports");
  assert.equal(channelMemo.get("13787").bj, "owesports", "the memo follows the drops, not the last join");

  // The same for a campaign SOOP lists as live.
  channelMemo.set("13787", { bj: "costream", at: clock });
  assert.equal(await pickChannel(client, listedLive("costream", "owesports"), now), "owesports");
});

test("when SOOP lists the campaign as live, a stream that says no drops is still joined if no other is on air", async () => {
  // SOOP's own word that the campaign is running outweighs one stream's flag:
  // this is the stream the farm joined before it read the flag at all.
  const client = stubClient({ costream: NO_DROPS });
  assert.equal(await pickChannel(client, listedLive("owesports", "costream"), now), "costream");
  assert.equal(channelMemo.get("13787").bj, "costream");
  // With several of them on air it is the FIRST in the old order — the stream
  // the farm joined before it read the flag at all.
  channelMemo.clear();
  const two = stubClient({ costream1: NO_DROPS, costream2: NO_DROPS });
  assert.equal(await pickChannel(two, listedLive("owesports", "costream1", "costream2"), now), "costream1");
  assert.deepEqual(two.asked, ["owesports", "costream1", "costream2"], "after every channel was given the chance to carry drops");

  // Listed but not live is not SOOP calling it live.
  channelMemo.clear();
  const notLive = { ...listedLive("owesports", "costream"), live: false };
  assert.equal(await pickChannel(client, notLive, now), null);
  assert.ok(channelMemo.get("13787").noneAt, "remembered as nobody to join");
  // Nor is a live flag left over on a campaign that is no longer on the list.
  channelMemo.clear();
  assert.equal(await pickChannel(client, { ...delisted("owesports", "costream"), live: true }, now), null);
});

test("a stream that does not say whether it carries drops is joined as before", async () => {
  const client = stubClient({ old: UNSTATED });
  assert.equal(await pickChannel(client, delisted("off", "old"), now), "old");
  channelMemo.clear();
  assert.equal(await pickChannel(client, listedLive("off", "old"), now), "old");
  channelMemo.clear();
  const odd = stubClient({ odd: { RESULT: 1, IS_DROPS: "maybe" } });
  assert.equal(await pickChannel(odd, delisted("off", "odd"), now), "odd", "an unknown value is not a 'no'");
});

test("at most twelve channels of a campaign are looked at", async () => {
  const ids = Array.from({ length: 14 }, (_, i) => `ch${i + 1}`);
  const twelfth = stubClient({ ch12: DROPS });
  assert.equal(await pickChannel(twelfth, delisted(...ids), now), "ch12");
  channelMemo.clear();
  const thirteenth = stubClient({ ch13: DROPS });
  assert.equal(await pickChannel(thirteenth, delisted(...ids), now), null);
  assert.equal(thirteenth.asked.length, 12);
});

test("a channel whose player info cannot be read is passed over, not joined and not fatal", async () => {
  const client = stubClient({ broken: new Error("timeout"), good: DROPS });
  assert.equal(await pickChannel(client, delisted("broken", "good"), now), "good");
  assert.deepEqual(client.asked, ["broken", "good"]);
});

test("a category-wide campaign joins a stream of its category that carries drops", async () => {
  const camp = { dropsIdx: "13897", live: true, filter: "progress", categoryWide: true, cateNo: "00360141", channels: [] };
  const client = stubClient({ s1: NO_DROPS, s2: DROPS }, { category: ["s1", "s2"] });
  assert.equal(await pickChannel(client, camp, now), "s2");
  assert.deepEqual(client.asked, ["s1", "s2"]);
});

test("the channel joined last is looked at first", async () => {
  const client = stubClient({ a: DROPS, c: DROPS });
  channelMemo.set("13787", { bj: "c", at: clock });
  assert.equal(await pickChannel(client, listedLive("a", "b", "c"), now), "c");
  assert.deepEqual(client.asked, ["c"], "and nothing else when it carries the drops");
});

test("'nobody to join', reached by passing over a stream that says no drops, does not bind once SOOP lists the campaign as live", async () => {
  const client = stubClient({ owesports: NO_DROPS });
  assert.equal(await pickChannel(client, delisted("owesports"), now), null);
  clock += 30_000;
  assert.equal(await pickChannel(client, delisted("owesports"), now), null);
  assert.equal(client.asked.length, 1, "for a delisted campaign the note stands");
  // The list is read again and SOOP calls the campaign live: the stream that
  // was passed over is the one to join, now — not when the note runs out.
  assert.equal(await pickChannel(client, listedLive("owesports"), now), "owesports");

  // A note that passed over nothing — nobody was on air — binds either way.
  channelMemo.clear();
  const quiet = stubClient({});
  assert.equal(await pickChannel(quiet, delisted("owesports"), now), null);
  clock += 30_000;
  assert.equal(await pickChannel(quiet, listedLive("owesports"), now), null);
  assert.equal(quiet.asked.length, 1);
});
