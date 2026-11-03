process.env.CRED_SECRET ||= 'steam-boost-review-test';
process.env.SESSION_SECRET ||= 'steam-boost-review-session';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { hoursOf } = require('../utils/steamBoost')._internal;
const { AccountBooster } = require('../workers/steam-boost/booster.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
class Client extends EventEmitter {
  constructor() { super(); this.logins = []; this.played = []; this.logoffs = 0; this.owned = []; this.granted = [730]; }
  logOn(details) { this.logins.push(details); }
  logOff() { this.logoffs++; }
  gamesPlayed(games) { this.played.push(games); }
  setOption() {}
  getUserOwnedApps(_id, _opts, cb) { cb(null, { apps: this.owned.map(appid => ({ appid, playtime_forever: 0 })) }); }
  requestFreeLicense(_apps, cb) { cb(null, [1], this.granted); }
  login() { this.steamID = { getSteamID64: () => '76561190000000001' }; this.emit('loggedOn'); }
}
function setup(over = {}) {
  const client = new Client();
  const intervals = new Set();
  const booster = new AccountBooster({
    account: { id: 'a1', username: 'u', password: 'pw', email: 'u@outlook.com', country: 'JP' },
    games: [730],
    tokens: { get: async () => null, set: async () => {}, clear: async () => {} },
    guardMail: { waitForCode: async () => ({ code: 'BCDFG', messageId: 'm1' }) },
    timers: { setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) },
    createClient: () => client,
    ...over,
  });
  return { booster, client, intervals };
}
test('tier requires every selected game to have the promised minutes', () => {
  assert.deepEqual(hoursOf({ 730: 60000, 1172470: 0 }, [730,1172470]), { hours: 0, gamesWithHours: 1 });
  assert.deepEqual(hoursOf({ 730: 60000 }, [730,1172470]), { hours: 0, gamesWithHours: 1 });
  assert.deepEqual(hoursOf({ 730: 60000, 1172470: 30000 }, [730,1172470]), { hours: 500, gamesWithHours: 2 });
});
test('stop during token lookup prevents a later login', async () => {
  const token = deferred();
  const { booster, client } = setup({ tokens: { get: () => token.promise } });
  booster.start(); await tick();
  await booster.stop(); token.resolve('saved-token'); await tick();
  assert.equal(client.logins.length, 0);
});
test('late loggedOn event after stop cannot restart setup', async () => {
  const { booster, client, intervals } = setup();
  booster.start(); await tick(); await booster.stop();
  client.login(); await tick(); await tick();
  assert.equal(booster.state, 'stopped');
  assert.equal(intervals.size, 0);
  assert.equal(booster.steamID, null);
});
test('a Steam Guard response arriving after stop is ignored', async () => {
  const mail = deferred(); let answered = false;
  const { booster, client } = setup({ guardMail: { waitForCode: () => mail.promise } });
  booster.start(); await tick();
  client.emit('steamGuard', 'outlook.com', () => { answered = true; });
  await booster.stop(); mail.resolve({ code: 'BCDFG', messageId: 'm1' }); await tick();
  assert.equal(answered, false);
});
test('stopping during library read cannot leave a polling timer running', async () => {
  const { booster, client, intervals } = setup(); let answer;
  client.getUserOwnedApps = (_id, _opts, cb) => { answer = cb; };
  booster.start(); await tick(); client.login();
  await booster.stop();
  answer(null, { apps: [] }); await tick(); await tick();
  assert.equal(intervals.size, 0);
  assert.equal(booster.ready, false);
});
test('a refused license is never advertised to Steam as playing', async () => {
  const { booster, client } = setup(); client.granted = [];
  booster.start(); await tick(); client.login(); await tick(); await tick();
  assert.ok(client.played.every(games => games.length === 0));
  assert.equal(booster.state, 'retrying');
});
test('a granted free license still starts normal boosting', async () => {
  const { booster, client } = setup();
  booster.start(); await tick(); client.login(); await tick(); await tick();
  assert.deepEqual(client.played.at(-1), [730]);
  assert.equal(booster.state, 'playing'); await booster.stop();
});
