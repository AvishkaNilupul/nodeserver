const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapWithConcurrency,
  createSeatCounter,
  buildDecisionHostState,
} = require("../utils/autoFarmer");
const hosts = require("../utils/botHosts");

test("mapWithConcurrency preserves ordering and respects the concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  const delays = [30, 5, 20, 1, 10, 2];
  const out = await mapWithConcurrency(delays, 3, async (delay, index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return index * 10;
  });

  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
  assert.equal(peak, 3);
});

test("seat counter never exposes capacity beyond maxAutoBots", () => {
  const seats = createSeatCounter({
    maxAutoBots: 2,
    accountsPerBot: 5,
    activeContainers: 9,
    freeSeats: 100,
  });

  assert.equal(seats.activeContainers(), 9);
  assert.equal(seats.slotsFree(), 0);
  assert.equal(seats.freeSeats(), 10);
  assert.equal(seats.capacity(), 10);
  assert.equal(seats.addContainer(1, 5), 0);
  assert.equal(seats.capacity(), 10);
});

test("seat counter tracks existing-seat use and successful new containers", () => {
  const seats = createSeatCounter({
    maxAutoBots: 3,
    accountsPerBot: 5,
    activeContainers: 1,
    freeSeats: 2,
  });

  assert.equal(seats.capacity(), 12);
  seats.consumeExisting(1);
  assert.equal(seats.freeSeats(), 1);
  assert.equal(seats.capacity(), 11);

  assert.equal(seats.addContainer(1, 2), 1);
  assert.equal(seats.activeContainers(), 2);
  assert.equal(seats.freeSeats(), 3);
  assert.equal(seats.capacity(), 8);

  // Failed creates do not call addContainer, so capacity remains unchanged.
  assert.equal(seats.capacity(), 8);
  seats.consumeExisting(3);
  assert.equal(seats.capacity(), 5);
});

test("host state derives cached existence and seat capacity from one batch", async (t) => {
  const originalResolveHost = hosts.resolveHost;
  const originalDockerPs = hosts.dockerPs;
  const originalReadFiles = hosts.readFiles;
  const calls = { docker: 0, files: 0 };
  hosts.resolveHost = (id) => ({ id, transport: "local", dir: "/tmp" });
  hosts.dockerPs = async () => {
    calls.docker++;
    return { twitchbotx1: { state: "running", status: "Up" } };
  };
  hosts.readFiles = async (_host, files) => {
    calls.files++;
    assert.deepEqual(files, ["config_01.json"]);
    return {
      "config_01.json": {
        ok: true,
        text: JSON.stringify({
          TwitchSettings: {
            TwitchUsers: [
              { Login: "one", Enabled: true },
              { Login: "two", Enabled: false },
            ],
          },
        }),
      },
    };
  };
  t.after(() => {
    hosts.resolveHost = originalResolveHost;
    hosts.dockerPs = originalDockerPs;
    hosts.readFiles = originalReadFiles;
  });

  const state = await buildDecisionHostState(
    [
      {
        status: "active",
        bots: [
          {
            host: "pi",
            file: "config_01.json",
            container: "twitchbotx1",
          },
        ],
      },
    ],
    { maxAutoBots: 2, accountsPerBot: 3, consolidate: true },
    { id: "pi" },
  );

  assert.deepEqual(calls, { docker: 1, files: 1 });
  assert.equal(state.hostCalls, 2);
  assert.equal(state.hasFile("pi", "config_01.json", "twitchbotx1"), true);
  assert.equal(state.seatCounter.activeContainers(), 1);
  assert.equal(state.seatCounter.freeSeats(), 2);
  assert.equal(state.seatCounter.capacity(), 5);
});
