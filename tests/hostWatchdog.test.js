// utils/hostWatchdog.js — the pure parts, fed with what the Pi actually showed on
// 2026-09-11: 13 bots killed at 05:00:45 JST (exit 128), a containerd shim that
// `dpkg --verify` flagged, and 19 bots the app had parked on purpose.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const w = require("../utils/hostWatchdog");

const NOW = Date.parse("2026-09-11T01:00:00Z");
const CRASH = "2026-09-10T20:00:45.53Z";

function inspectLine(name, policy, running, restarting, exit, finished) {
  return "/" + [name, policy, running, restarting, exit, finished].join("|");
}

test("probe output parses to a boot id and an uptime", () => {
  const p = w.parseProbe("274506ad-5e1e-4ec0-8e05-7110d5cc429b\n15066.21\n");
  assert.equal(p.bootId, "274506ad-5e1e-4ec0-8e05-7110d5cc429b");
  assert.equal(p.uptimeS, 15066.21);
  assert.deepEqual(w.parseProbe("garbage"), { bootId: "", uptimeS: null });
  assert.deepEqual(w.parseProbe(""), { bootId: "", uptimeS: null });
});

test("the dpkg --verify filter catches the corrupted shim and ignores edited config", () => {
  // Real dpkg --verify shapes: a damaged binary, an edited conffile, a missing file.
  const sample = [
    "??5??????   /usr/bin/containerd-shim-runc-v2",
    "??5?????? c /etc/containerd/config.toml",
    "missing     /usr/bin/ctr",
    "missing   c /etc/docker/daemon.json",
    "",
  ].join("\n");
  const out = execFileSync("awk", ["-v", "p=containerd.io", w.VERIFY_AWK], { input: sample, encoding: "utf8" });
  assert.deepEqual(w.parseVerify("PKGS\t containerd.io\n" + out + "SHIM\tfail\n"), {
    packages: ["containerd.io"],
    damaged: [
      { pkg: "containerd.io", path: "/usr/bin/containerd-shim-runc-v2" },
      { pkg: "containerd.io", path: "/usr/bin/ctr" },
    ],
    shimOk: false,
  });
});

test("a clean verify is healthy; a damaged file or a panicking shim is not", () => {
  assert.equal(w.runtimeHealthy(w.parseVerify("PKGS\tcontainerd.io runc\nSHIM\tok\n")), true);
  assert.equal(w.runtimeHealthy(w.parseVerify("PKGS\tcontainerd.io\nSHIM\tfail\n")), false);
  assert.equal(
    w.runtimeHealthy(w.parseVerify("BAD\tcontainerd.io\t/usr/bin/containerd-shim-runc-v2\nSHIM\tok\n")),
    false,
  );
  // No shim on the host (not a docker host) is not a failure.
  assert.equal(w.runtimeHealthy(w.parseVerify("PKGS\t\n")), true);
});

test("exactly the bots that DIED are restarted — never a parked or stopped one", () => {
  const rows = w.parseInspect(
    [
      // the 05:00 crash: always + killed
      inspectLine("twitchbotx31", "always", "false", "false", 128, CRASH),
      inspectLine("twitchbotx24", "always", "false", "false", 128, CRASH),
      // no-claim bots run unless-stopped and died the same way
      inspectLine("noclaim-bot-17", "unless-stopped", "false", "false", 128, CRASH),
      // parked by the app: policy flipped to "no" first (x4/x13 really exit 128)
      inspectLine("twitchbotx4", "no", "false", "false", 128, "2026-09-10T16:48:04Z"),
      // a manual `docker stop` keeps restart=always but exits 143
      inspectLine("twitchbotx8", "always", "false", "false", 143, "2026-09-10T15:13:41Z"),
      // parked no-claim bot (auto-power watcher)
      inspectLine("noclaim-bot-13", "unless-stopped", "false", "false", 143, CRASH),
      // an empty config exits 0
      inspectLine("twitchbotx9", "always", "false", "false", 0, "2026-09-11T00:55:00Z"),
      // crash loop — Docker is handling it
      inspectLine("twitchbotx40", "always", "false", "true", 133, "2026-09-11T00:59:30Z"),
      // died a minute ago: Docker's own restart gets the first go
      inspectLine("twitchbotx42", "always", "false", "false", 137, "2026-09-11T00:59:00Z"),
      // healthy
      inspectLine("twitchbotx30", "always", "true", "false", 0, CRASH),
      // created but never ran (zero time)
      inspectLine("twitchbotx6", "always", "false", "false", 128, "0001-01-01T00:00:00Z"),
      // not a bot
      inspectLine("redis", "always", "false", "false", 1, CRASH),
    ].join("\n"),
  );
  assert.equal(rows.length, 12);
  assert.deepEqual(
    w.deadBots(rows, NOW).map((r) => r.name),
    ["twitchbotx31", "twitchbotx24", "noclaim-bot-17", "twitchbotx6"],
  );
});

test("this morning's real Pi state yields the 13 crashed bots and none of the parked ones", () => {
  const crashed = [
    "twitchbotx10", "twitchbotx15", "twitchbotx24", "twitchbotx30", "twitchbotx31", "twitchbotx34",
    "twitchbotx35", "twitchbotx37", "twitchbotx42", "twitchbotx6", "twitchbotx7",
  ];
  const parked = [
    ["twitchbotx11", 143], ["twitchbotx12", 143], ["twitchbotx13", 128], ["twitchbotx14", 143],
    ["twitchbotx16", 143], ["twitchbotx17", 143], ["twitchbotx18", 143], ["twitchbotx19", 143],
    ["twitchbotx20", 143], ["twitchbotx2", 143], ["twitchbotx32", 255], ["twitchbot", 255],
    ["twitchbotx36", 143], ["twitchbotx3", 143], ["twitchbotx40", 143], ["twitchbotx41", 143],
    ["twitchbotx43", 143], ["twitchbotx4", 128], ["twitchbotx8", 143], ["twitchbotx9", 0],
  ];
  const lines = [
    ...crashed.map((n) => inspectLine(n, "always", "false", "false", 128, CRASH)),
    inspectLine("noclaim-bot-17", "unless-stopped", "false", "false", 128, CRASH),
    inspectLine("noclaim-bot-18", "unless-stopped", "false", "false", 128, CRASH),
    ...parked.map(([n, code]) => inspectLine(n, "no", "false", "false", code, "2026-09-10T09:52:58Z")),
    ...[3, 4, 5, 10, 13, 14, 15, 16].map((i) =>
      inspectLine("noclaim-bot-" + i, "unless-stopped", "false", "false", 143, "2026-09-08T00:00:00Z"),
    ),
  ];
  const dead = w.deadBots(w.parseInspect(lines.join("\n")), NOW).map((r) => r.name).sort();
  assert.deepEqual(dead, [...crashed, "noclaim-bot-17", "noclaim-bot-18"].sort());
});

test("repair lines parse into what was fixed and why the rest was not", () => {
  const r = w.parseRepair(
    [
      "FIXED\t/usr/bin/containerd-shim-runc-v2",
      "NODEB\trunc\t/var/cache/apt/archives/runc_1.3.6_arm64.deb",
      "MISMATCH\t/usr/bin/ctr",
      "FAIL\t/usr/bin/dockerd",
      "noise",
    ].join("\n"),
  );
  assert.deepEqual(r.fixed, ["/usr/bin/containerd-shim-runc-v2"]);
  assert.deepEqual(r.noDeb, ["runc (/var/cache/apt/archives/runc_1.3.6_arm64.deb)"]);
  assert.deepEqual(r.mismatch, ["/usr/bin/ctr"]);
  assert.deepEqual(r.failed, ["/usr/bin/dockerd"]);
});

test("the repair script only installs a file whose checksum matches dpkg's record", () => {
  const s = w.repairScript([
    { pkg: "containerd.io", path: "/usr/bin/containerd-shim-runc-v2" },
    { pkg: "containerd.io", path: "/usr/bin/ctr" },
    { pkg: "runc", path: "/usr/sbin/runc" },
  ]);
  // One extraction per package, one guarded install per file.
  assert.equal((s.match(/dpkg-deb -x/g) || []).length, 2);
  assert.equal((s.match(/ install -m /g) || []).length, 3);
  assert.equal((s.match(/\[ "\$want" = "\$got" \]/g) || []).length, 3);
  // Every install sits inside the checksum branch: nothing is ever installed
  // before the comparison that guards it.
  for (const block of s.split("want=$(").slice(1)) {
    assert.ok(block.indexOf('[ "$want" = "$got" ]') < block.indexOf(" install -m "));
  }
  // The version in the cache file name is the INSTALLED one (epoch ':' → %3a).
  assert.match(s, /sed 's\/:\/%3a\/'/);
  // It parses as shell.
  execFileSync("sh", ["-n", "-c", s]);
});

test("the verify and inspect scripts parse as shell", () => {
  execFileSync("sh", ["-n", "-c", w.VERIFY_SCRIPT]);
  execFileSync("sh", ["-n", "-c", w.INSPECT_SCRIPT]);
  execFileSync("sh", ["-n", "-c", w.PROBE_SCRIPT]);
});
