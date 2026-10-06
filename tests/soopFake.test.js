// The fake SOOP (tests/helpers/soopFake.js) is what every farm and route test
// stands on, so its own rules are pinned here: who gets credited, which error
// code each failure raises, and that the client keeps the contract §7 shape.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createFakeSoop } = require("./helpers/soopFake");

// The normaliser (another agent's module) is the real consumer of the raw rows.
// It is exercised when it loads; the fake's own tests do not depend on it.
let normalize = null;
try {
  normalize = require("../utils/soop/normalize");
} catch {
  normalize = null;
}

const tick = () => new Promise((r) => setImmediate(r));
const NOW = Date.parse("2026-10-06T03:00:00Z");

// One live guaranteed campaign on channel "owcs", one logged-in LK account.
function setup() {
  const world = createFakeSoop({ now: () => NOW });
  const cookies = world.addAccount({ id: "acc1", nick: "One" });
  const camp = world.addCampaign({
    dropsIdx: "100",
    title: "OWCS KOREA 드롭스",
    live: true,
    broadIdList: ["owcs"],
    itemList: [15, 60],
  });
  return { world, cookies, camp, client: world.clientFor(cookies, { id: "acc1" }) };
}

async function join(client, channel = "owcs", events = []) {
  const ch = await client.liveInfo(channel);
  const bridge = client.openBridge(channel, ch, { onEvent: (e) => events.push(e) });
  await tick();
  await tick();
  return bridge;
}

const minutes = async (client, dropsIdx = "100") => {
  const row = (await client.missions()).find((m) => m.dropsIdx === dropsIdx);
  return row ? row.minutes : 0;
};

test("client has the contract shape and addAccount returns an AuthTicket cookie", async () => {
  const { world, cookies, client } = setup();
  assert.deepEqual(Object.keys(cookies[0]), ["name", "value"]);
  assert.equal(cookies[0].name, "AuthTicket");
  assert.equal(client.id, "acc1");
  assert.deepEqual(
    Object.keys(client).filter((k) => typeof client[k] === "function").sort(),
    Object.keys(world.calls()).sort(),
  );
  assert.deepEqual(await client.privateInfo(), { loggedIn: true, loginId: "acc1", nick: "One", country: "LK" });
});

test("campaigns() returns raw rows shaped like SOOP's event list", async () => {
  const { world, client } = setup();
  world.addCampaign({ dropsIdx: "200", filter: "scheduled", cateNo: "00360100", cateName: "명조" });
  const progress = await client.campaigns();
  assert.deepEqual(progress.map((r) => r.dropsIdx), ["100"]);
  const raw = progress[0];
  assert.equal(raw.filter, "progress");
  assert.equal(raw.startDate, "2026-10-05 12:00:00"); // a day before NOW, Korea time
  assert.deepEqual(raw.broadIdList[0], {
    userId: "owcs", userNick: "owcs", broadNo: null, stationNo: null, broadCateNo: null, onAir: true,
  });
  assert.deepEqual(raw.itemList.map((i) => i.giveTerm), ["15", "60"]);

  assert.deepEqual([raw.giveCon, raw.live, raw.title, raw.gameNo], ["term", true, "OWCS KOREA 드롭스", "12"]);
  for (const k of ["image", "ingameGiveYn", "dupFlag", "dropsType", "endDate", "typeNm", "acctConn", "cateNo", "cateName"]) {
    assert.ok(k in raw, k);
  }

  const all = await client.campaignsAll();
  assert.deepEqual(all.map((r) => [r.dropsIdx, r.filter]), [["100", "progress"], ["200", "scheduled"]]);
  assert.deepEqual([all[1].broadIdList, all[1].cateNo, all[1].live], [[], "00360100", false]);
  assert.ok(all[1].startDate > raw.startDate, "a scheduled campaign starts in the future");

  raw.live = false; // rows are copies: a caller cannot edit the world
  assert.equal((await client.campaigns())[0].live, true);
});

test("a campaign added later does not change a channel the world already knows", async () => {
  const { world, client } = setup();
  world.addCampaign({ dropsIdx: "101", filter: "scheduled", broadIdList: ["owcs", "fresh"] });
  assert.equal((await client.liveInfo("owcs")).RESULT, 1, "still on air");
  assert.equal((await client.liveInfo("fresh")).RESULT, 0, "a new channel of a campaign that is not live");
  const [next] = await client.campaigns("scheduled");
  assert.deepEqual(next.broadIdList.map((b) => [b.userId, b.onAir]), [["owcs", true], ["fresh", false]]);
  world.addCampaign({ dropsIdx: "102", broadIdList: [{ userId: "owcs", onAir: false }] });
  assert.deepEqual(await client.liveInfo("owcs"), { RESULT: 0 }, "an explicit flag wins");
  assert.equal((await client.campaigns())[0].broadIdList[0].onAir, false, "and every row shows it");
});

test("liveInfo is CHANNEL-like on air and RESULT 0 otherwise", async () => {
  const { world, client } = setup();
  const ch = await client.liveInfo("owcs");
  assert.equal(ch.RESULT, 1);
  for (const k of ["BNO", "CATE", "FTK", "GWIP", "GWPT", "CTIP", "CTPT"]) assert.ok(ch[k], k);
  world.setOnAir("owcs", false);
  assert.deepEqual(await client.liveInfo("owcs"), { RESULT: 0 });
  assert.deepEqual(await client.liveInfo("nobody"), { RESULT: 0 });
  assert.equal((await client.campaigns())[0].broadIdList[0].onAir, false);
});

test("advance credits a joined bridge on an on-air channel of a live campaign", async () => {
  const { world, client } = setup();
  const events = [];
  const bridge = client.openBridge("owcs", await client.liveInfo("owcs"), { onEvent: (e) => events.push(e) });
  assert.equal(bridge.joined, false, "joins on the next macrotask, not synchronously");
  world.advance(5);
  assert.equal(await minutes(client), 0, "not joined yet: nothing credited");
  await tick();
  await tick();
  assert.equal(bridge.joined, true);
  assert.deepEqual(events, ["open", "joined"]);
  assert.deepEqual(world.bridges(), [
    { id: "acc1", clientId: "acc1", channel: "owcs", joined: true, claimedCountry: "LK" },
  ]);

  assert.deepEqual(world.advance(4), [{ id: "acc1", dropsIdx: "100", minutes: 4 }]);
  world.advance(3);
  const items = [{ name: "Reward 1", minutes: 15, viewTime: 7 }, { name: "Reward 2", minutes: 60, viewTime: 7 }];
  assert.deepEqual(await client.missions(), [{ dropsIdx: "100", minutes: 7, items }]);
});

test("advance credits nothing without a bridge, off air, or when the campaign is not live", async () => {
  const { world, client } = setup();
  world.advance(10);
  assert.deepEqual(await client.missions(), [], "no bridge held");

  await join(client);
  world.setLive("100", false);
  assert.deepEqual(world.advance(10), [], "campaign not live");
  world.setLive("100", true);
  world.advance(2);
  assert.equal(await minutes(client), 2);

  const bridge = world.bridges()[0];
  assert.equal(bridge.joined, true);
  world.setOnAir("owcs", false); // broadcast ends: SOOP closes the bridge
  assert.deepEqual(world.bridges(), []);
  world.advance(10);
  assert.equal(await minutes(client), 2, "off air");

  world.setOnAir("owcs", true);
  const stopped = await join(client);
  stopped.stop();
  stopped.stop(); // idempotent
  assert.equal(stopped.closed, true);
  world.advance(10);
  assert.equal(await minutes(client), 2, "stopped bridge");
});

test("a bridge on an off-air channel never joins", async () => {
  const { world, client } = setup();
  world.setOnAir("owcs", false);
  const events = [];
  const bridge = await join(client, "owcs", events);
  assert.deepEqual([bridge.joined, bridge.closed, events], [false, true, ["open", "closed"]]);
});

test("advance credits only when the claimed country is the egress country and it pays", async () => {
  const world = createFakeSoop();
  world.addCampaign({ dropsIdx: "100", live: true, broadIdList: ["owcs"] });
  const jp = world.clientFor(world.addAccount({ id: "jp", country: "JP" }), { id: "jp" });
  const us = world.clientFor(world.addAccount({ id: "us", country: "US" }), { id: "us" });
  await join(jp);
  await join(us);
  assert.deepEqual(world.bridges().map((b) => [b.id, b.claimedCountry]), [["jp", "JP"], ["us", "US"]]);

  world.advance(5);
  assert.equal(await minutes(jp), 5, "JP is credited");
  assert.equal(await minutes(us), 0, "US matches its claim but is not a credited country");

  // The tunnel moves to the US: both bridges keep the claim they joined with.
  world.setEgress({ country: "US" });
  world.advance(5);
  assert.equal(await minutes(jp), 5, "claimed JP, seen from US");

  // Back to a credited country that is not the one claimed.
  world.setEgress({ country: "LK" });
  world.advance(5);
  assert.equal(await minutes(jp), 5, "claimed JP, seen from LK");

  // A bridge opened now claims what SOOP reports for the connection.
  const again = await join(jp);
  assert.equal(again.joined, true);
  assert.equal((await jp.privateInfo()).country, "LK");
  world.advance(5);
  assert.equal(await minutes(jp), 10);
});

test("the bridge claims the country a geo resolver returns, and fails closed without one", async () => {
  const { world, cookies } = setup();
  const lookups = [];
  const geo = {
    get: async (fetchCountry) => {
      lookups.push(await fetchCountry());
      return { cc: "JP", joinCc: "392", geoRc: "13" };
    },
  };
  const stale = world.clientFor(cookies, { id: "acc1", geo });
  await join(stale);
  assert.deepEqual(lookups, ["LK"]);
  assert.equal(world.bridges()[0].claimedCountry, "JP");
  world.advance(5);
  assert.equal(await minutes(stale), 0, "claims JP while SOOP sees LK");

  const broken = world.clientFor(cookies, {
    id: "acc1",
    geo: { get: async () => { throw new Error("country unknown"); } },
  });
  const events = [];
  const bridge = await join(broken, "owcs", events);
  assert.deepEqual([bridge.joined, bridge.closed, bridge.error], [false, true, "geo"]);
  assert.ok(events.includes("error:geo"));
});

test("logout: privateInfo says logged out, missions and inventory throw AUTH", async () => {
  const { world, client } = setup();
  const events = [];
  await join(client, "owcs", events);
  world.advance(3);
  world.logout("acc1");

  assert.deepEqual(await client.privateInfo(), { loggedIn: false, loginId: "", nick: "", country: "LK" });
  for (const call of [() => client.missions(), () => client.inventory("available"), () => client.inventoryCounts()]) {
    await assert.rejects(call, (e) => e.name === "SoopError" && e.code === "AUTH");
  }
  assert.equal((await client.campaigns()).length, 1, "the event list needs no login");
  assert.deepEqual(world.bridges(), [], "its bridge is closed");
  assert.equal(events.at(-1), "closed");
  assert.deepEqual(world.advance(5), []);

  const stranger = world.clientFor([{ name: "AuthTicket", value: "never-issued" }]);
  assert.equal((await stranger.privateInfo()).loggedIn, false);
  await assert.rejects(() => stranger.missions(), { code: "AUTH" });
  assert.throws(() => world.clientFor([{ name: "_au", value: "x" }]), /AuthTicket/);
});

test("egress down: every call throws EGRESS and bridges drop; up again recovers", async () => {
  const { world, client } = setup();
  const held = await join(client);
  world.advance(2);
  world.setEgress({ down: true });

  assert.equal(held.closed, true);
  assert.equal(held.error, "egress");
  for (const call of [
    () => client.privateInfo(), () => client.missions(), () => client.campaigns(),
    () => client.campaignsAll(), () => client.liveInfo("owcs"),
    () => client.categoryChannels("1"), () => client.inventoryCounts(), () => client.inventory("available"),
  ]) {
    await assert.rejects(call, (e) => e.name === "SoopError" && e.code === "EGRESS");
  }
  const dead = client.openBridge("owcs", { RESULT: 1 });
  assert.deepEqual([dead.joined, dead.closed, dead.error], [false, true, "egress"]);
  dead.stop();
  assert.deepEqual(world.advance(5), []);

  world.setEgress({ down: false });
  assert.equal(await minutes(client), 2, "progress survived the outage");
  await join(client);
  world.advance(1);
  assert.equal(await minutes(client), 3);
});

test("delist removes the campaign from the list but its missions keep counting", async () => {
  const { world, client } = setup();
  await join(client);
  world.advance(4);
  assert.equal(world.delist("100"), true);

  assert.deepEqual(await client.campaigns(), []);
  assert.deepEqual(await client.campaignsAll(), []);
  world.advance(6);
  assert.equal(await minutes(client), 10);
  assert.equal(world.delist("nope"), false);
});

test("category-wide campaigns are farmed through any on-air channel of the category", async () => {
  const world = createFakeSoop();
  world.addCampaign({ dropsIdx: "300", live: true, cateNo: "00360100", cateChannels: ["wuwa1", "wuwa2"] });
  world.addCampaign({ dropsIdx: "301", live: true, broadIdList: ["other"] });
  world.setOnAir("late", true, { cateNo: "00360100" });
  const client = world.clientFor(world.addAccount({ id: "a" }), { id: "a" });

  assert.deepEqual((await client.campaigns())[0].broadIdList, []);
  assert.deepEqual(await client.categoryChannels("00360100"), ["wuwa1", "wuwa2", "late"]);
  assert.deepEqual(await client.categoryChannels("00360100", 1), ["wuwa1"]);
  world.setOnAir("wuwa1", false);
  assert.deepEqual(await client.categoryChannels("00360100"), ["wuwa2", "late"]);
  assert.equal((await client.liveInfo("wuwa2")).CATE, "00360100");

  await join(client, "wuwa2");
  assert.deepEqual(world.advance(3), [{ id: "a", dropsIdx: "300", minutes: 3 }]);
});

test("inventory returns raw rows per division and counts as numbers", async () => {
  const { world, client } = setup();
  world.addInventory("acc1", { itemName: "문화상품권 5천원", itemCode: "SECRET-1" }, "available");
  world.addInventory("acc1", { itemName: "Skin", itemType: "4", ingameGiveYn: "Y" }, "acquired");
  world.addInventory("acc1", { itemName: "Old" }, "expired");
  world.addInventory("acc1", { itemName: "Box" });

  assert.deepEqual(await client.inventoryCounts(), { available: 2, acquired: 1, expired: 1 });
  const available = await client.inventory("available");
  assert.deepEqual(available.map((r) => r.itemName), ["문화상품권 5천원", "Box"]);
  assert.equal(available[0].division, undefined, "SOOP does not label rows with their division");
  assert.equal((await client.inventory()).length, 4);

  const [box] = available.slice(1);
  assert.deepEqual(
    [box.itemType, box.useFlag, box.ingameGiveYn, box.acctConn, box.sendDate, box.expDate, box.receiveDate],
    ["1", "N", "N", false, "2026-10-05 12:00:00", "2026-10-20 12:00:00", null],
  );
  assert.ok(box.idx && box.idx !== available[0].idx, "every row has its own id");
  assert.equal(available[0].itemCode, "SECRET-1");
  assert.ok((await client.inventory("acquired"))[0].receiveDate);
  assert.ok((await client.inventory("expired"))[0].expDate < "2026-10-06");
  assert.throws(() => world.addInventory("ghost", {}), /no account/);
});

test("raw rows go through the real normaliser", { skip: !normalize && "utils/soop/normalize not loadable yet" }, async () => {
  const { world, client } = setup();
  world.addCampaign({ dropsIdx: "200", filter: "scheduled", cateNo: "00360100", cateName: "명조" });
  const [a, b] = (await client.campaignsAll()).map((r) => normalize.normalizeCampaign(r));
  assert.deepEqual([a.guaranteed, a.live, a.filter, a.steps], [true, true, "progress", [15, 60]]);
  assert.deepEqual(a.channels, [{ id: "owcs", nick: "owcs", onAir: true }]);
  assert.equal(a.startAt.toISOString(), "2026-10-05T03:00:00.000Z");
  assert.deepEqual([b.categoryWide, b.filter], [true, "scheduled"]);

  world.addInventory("acc1", { itemName: "Code", itemCode: "SECRET-1" });
  world.addInventory("acc1", { itemName: "Skin", itemType: "4", ingameGiveYn: "Y" }, "acquired");
  const raw = (await client.inventory("available"))[0];
  const item = normalize.normalizeInventoryItem(raw, "available");
  assert.deepEqual([item.code, item.key, item.raw.itemCode], ["SECRET-1", raw.idx, undefined]);
  assert.ok(item.expiresAt > new Date(NOW));
  const skin = normalize.normalizeInventoryItem((await client.inventory("acquired"))[0], "acquired");
  assert.deepEqual([skin.kind, skin.needsLink, skin.receivedAt !== null], ["ingame", true, true]);
});

test("calls() counts every client method, including the ones that throw", async () => {
  const { world, client } = setup();
  const zero = world.calls();
  assert.equal(Object.keys(zero).length, 9);
  assert.ok(Object.values(zero).every((n) => n === 0));

  await client.campaignsAll();
  await client.campaignsAll();
  await client.campaigns("scheduled");
  await client.missions();
  await join(client);
  world.setEgress({ down: true });
  await client.missions().catch(() => {});
  const calls = world.calls();
  assert.deepEqual(
    [calls.campaignsAll, calls.campaigns, calls.missions, calls.liveInfo, calls.openBridge, calls.privateInfo],
    [2, 1, 2, 1, 1, 0],
  );
  calls.missions = 99; // a snapshot, not the live counters
  assert.equal(world.calls().missions, 2);
});

test("bridges() lists open bridges per account and forgets stopped ones", async () => {
  const world = createFakeSoop();
  world.addCampaign({ dropsIdx: "100", live: true, broadIdList: ["owcs", "sub"] });
  const a = world.clientFor(world.addAccount({ id: "a" }), { id: "task-a" });
  const b = world.clientFor(world.addAccount({ id: "b", country: "JP" }), { id: "task-b" });
  const first = a.openBridge("owcs", {});
  assert.deepEqual(world.bridges(), [
    { id: "a", clientId: "task-a", channel: "owcs", joined: false, claimedCountry: null },
  ]);
  await tick();
  const second = await join(b, "sub");
  assert.deepEqual(world.bridges().map((x) => [x.id, x.channel, x.joined, x.claimedCountry]), [
    ["a", "owcs", true, "LK"],
    ["b", "sub", true, "JP"],
  ]);
  world.advance(1);
  world.advance(1);
  assert.deepEqual([await minutes(a), await minutes(b)], [2, 2]);

  const events = [];
  const third = a.openBridge("owcs", {}, { onEvent: (e) => events.push(e) });
  third.stop(); // stopped before it could join: never joins, never credited
  await tick();
  await tick();
  assert.equal(third.joined, false);
  assert.deepEqual(events, ["closed"]);

  first.stop();
  second.stop();
  assert.deepEqual(world.bridges(), []);
  assert.deepEqual(world.advance(1), []);
});
