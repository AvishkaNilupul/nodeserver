// In-process "being worked on" marks for RenterAccount rows (2026-10-01).
//
// The lapse sweep (renterExpiry) pulls an account off its bot and THEN stamps
// the row ended; "Farm days" and a manual re-add re-arm or re-place a window.
// Interleaved, the sweep could pull an account the operator had just extended
// and stamp it ended over the extension — or the route could re-arm a row
// whose account the sweep had just pulled, and answer "Farms until …" with the
// account in no config. Both run in the one server process (the assumption
// utils/fileLock.js already makes), so a Set is enough: the sweep leaves a busy
// row to its next tick, a route answers 409 "try again in a minute".
//
// All-or-nothing: tryAcquire(ids) takes every id or none, and returns the
// release function (null when any id is taken).
const busy = new Set();

function tryAcquire(ids) {
  const keys = [...new Set((ids || []).map(String))];
  if (keys.some((k) => busy.has(k))) return null;
  for (const k of keys) busy.add(k);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) busy.delete(k);
  };
}

function isBusy(id) {
  return busy.has(String(id));
}

module.exports = { tryAcquire, isBusy, _reset: () => busy.clear() };
