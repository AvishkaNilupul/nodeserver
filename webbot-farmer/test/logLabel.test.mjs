// The server-side heartbeat (utils/webbotFarmWatcher.js) counts DISTINCT
// ACCOUNTS by pulling the second bracket group out of each farmer log line:
//   sed -n -E 's/^\[[^]]*\] \[([^]]+)\].*/\1/p'
// So this log format is load-bearing. If it changes, partial-farm detection
// silently degrades back to a raw line count. These tests fail loudly instead.
import test from "node:test";
import assert from "node:assert";
import { scopedLog } from "../src/watcher.js";

const capture = (fn) => {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines;
};

// The exact expression the watcher ships to the Pi, as a JS regex.
const SED_EQUIVALENT = /^\[[^\]]*\] \[([^\]]+)\].*/;

test("scopedLog: a labelled line exposes the account as the second bracket group", () => {
  const [line] = capture(() => scopedLog("acct_01")("progress → drop c41d226f… 12/180 min"));
  const m = line.match(SED_EQUIVALENT);
  assert.ok(m, `heartbeat regex did not match the log line: ${line}`);
  assert.strictEqual(m[1], "acct_01");
  // The grep the watcher counts on must still hit.
  assert.ok(line.includes("progress → drop"));
});

test("scopedLog: logins with underscores and digits survive intact", () => {
  for (const login of ["ow_esports", "fuj__06", "a2004_melody", "yzttod"]) {
    const [line] = capture(() => scopedLog(login)("progress → drop x… 1/2 min"));
    assert.strictEqual(line.match(SED_EQUIVALENT)[1], login);
  }
});

test("scopedLog: no label falls back to an unlabelled line (pre-label behaviour)", () => {
  const [line] = capture(() => scopedLog("")("progress → drop x… 1/2 min"));
  // Must NOT match the extractor -> the server reads coverage as unknown and
  // falls back to line counts rather than reporting a stalled fleet.
  assert.strictEqual(line.match(SED_EQUIVALENT), null);
  assert.ok(line.includes("progress → drop"));
});

test("scopedLog: the no-session line is attributable too", () => {
  const [line] = capture(() => scopedLog("acct_02")("progress → no active drop-session on this channel yet"));
  assert.strictEqual(line.match(SED_EQUIVALENT)[1], "acct_02");
  assert.ok(line.includes("no active drop-session"));
});
