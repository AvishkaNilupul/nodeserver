// One Steam account "playing" free games so Steam records playtime.
// Built on node-steam-user, the library every GitHub hour booster uses
// (logic follows DrWarpMan/steam-hour-booster: refresh-token logins, give way when the
// account is played elsewhere), plus what our accounts need: the Steam Guard code is read
// from the account's own inbox, the login goes through a proxy in the signup country, and
// free-to-play games are added to the library before playing them.
const EventEmitter = require('events');
const SteamUser = require('steam-user');
const { EResult } = SteamUser;

// Steam answers that retrying will not fix. The account needs a person.
const FATAL = new Map([
  [EResult.InvalidPassword, 'Wrong password (was it changed?)'],
  [EResult.AccountNotFound, 'Steam says the account does not exist'],
  [EResult.Banned, 'Account banned'],
  [EResult.AccountDisabled, 'Account disabled by Steam'],
  [EResult.Suspended, 'Account suspended by Steam'],
  [EResult.AccountLockedDown, 'Account locked by Steam'],
  [EResult.AccountLoginDeniedNeedTwoFactor, 'A mobile authenticator is on the account'],
]);
// A saved refresh token stopped working (password change, sign-out of all devices, expiry).
const TOKEN_REJECTED = new Set([EResult.AccessDenied, EResult.Revoked, EResult.Expired, EResult.InvalidSignature]);
const MAX_GAMES = 32; // Steam's limit for one session
const PLAYTIME_EVERY_MS = 30 * 60 * 1000;

function cleanGames(games) {
  const list = [...new Set((games || []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
  if (!list.length) throw Error('Pick at least one game');
  if (list.length > MAX_GAMES) throw Error(`Steam allows at most ${MAX_GAMES} games at once`);
  return list;
}

class AccountBooster extends EventEmitter {
  /**
   * @param {object} o
   * @param {{id,username,password,email,country}} o.account
   * @param {number[]} o.games - AppIDs to idle
   * @param {{get(id),set(id,token),clear(id)}} o.tokens - refresh token storage
   * @param {{waitForCode(email,since,opts)}} o.guardMail
   * @param {(country)=>Promise<{url,location}>|null} o.proxy - null = connect directly
   */
  constructor({ account, games, tokens, guardMail, proxy = null, dataDirectory, createClient, timers, log, debug, licensed = [] } = {}) {
    super();
    this.debug = debug || null;
    // AppIDs Steam already granted. Steam's owned-games list hides free games until they have
    // been played, so without this every login would ask for the same licenses again.
    this.licensed = new Set(licensed.map(Number));
    this.account = account;
    this.games = cleanGames(games);
    this.tokens = tokens;
    this.guardMail = guardMail;
    this.proxy = proxy;
    this.dataDirectory = dataDirectory;
    this.createClient = createClient || (options => new SteamUser(options));
    this.timers = timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.log = log || (() => {});
    this.running = false;
    this.paused = false;
    this.ready = false; // licenses checked since the last login
    this.state = 'stopped';
    this.client = null;
    this.steamID = null;
    this.blocked = false;
    this.playing = [];
    this.playingSince = null;
    this.playtime = null; // { appid: {name, minutes} } from Steam
    this.owned = null;
    this.lastError = null;
    this.exit = null; // proxy exit used for the current login
    this.failures = 0;
    this.usedCodes = [];
    this._epoch = 0; // invalidate asynchronous work when a session ends
    this._retryTimer = null;
    this._playtimeTimer = null;
  }

  status() {
    return {
      id: this.account.id,
      state: this.state,
      steamID: this.steamID,
      games: this.games,
      playing: this.playing,
      playingSince: this.playingSince,
      blocked: this.blocked,
      playtime: this.playtime,
      lastError: this.lastError,
      exit: this.exit ? { country: this.exit.country, city: this.exit.city } : null,
    };
  }

  _setState(state, detail) {
    if (this.state === state && !detail) return;
    this.state = state;
    this.log(`${state}${detail ? ' — ' + detail : ''}`);
    this.emit('state', state, detail);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastError = null;
    this.failures = 0;
    this._connect().catch(e => {
      if (this.running) this._retryLater(e.message);
    });
  }

  async stop() {
    this._epoch++;
    this.ready = false;
    this.running = false;
    this.timers.clearTimeout(this._retryTimer);
    this.timers.clearInterval(this._playtimeTimer);
    if (this.client) {
      if (this.steamID) {
        this._applyPlaying([]);
        this.client.logOff();
      } else {
        this.client.logOff(); // also cancels a login in progress
      }
    }
    this.steamID = null;
    this._setState('stopped');
  }

  setGames(games) {
    this.games = cleanGames(games);
    if (this.steamID) this._afterLogin().catch(e => this.log('games update failed: ' + e.message));
  }

  // Stay logged in but stop playing (Steam then books the session's time).
  pause() {
    this.paused = true;
    this._play();
  }

  resume() {
    this.paused = false;
    this._play();
  }

  async _connect() {
    if (!this.running) return;
    const epoch = ++this._epoch;
    this._setState('connecting');
    let httpProxy = null;
    try {
      if (this.proxy) {
        const exit = await this.proxy(this.account.country);
        httpProxy = exit.url;
        this.exit = exit.location;
      }
    } catch (e) {
      return this._retryLater(e.message);
    }
    if (!this.running || epoch !== this._epoch) return;
    if (!this.client) {
      this.client = this.createClient({
        autoRelogin: true, // short Steam outages: steam-user reconnects by itself
        renewRefreshTokens: true,
        dataDirectory: this.dataDirectory,
        httpProxy,
      });
      this._bind(this.client);
    } else {
      this.client.setOption('httpProxy', httpProxy);
    }
    const token = await this.tokens.get(this.account.id);
    if (!this.running || epoch !== this._epoch) return;
    this.usedToken = !!token;
    this.loginStartedAt = new Date().toISOString();
    this.client.logOn(token
      ? { refreshToken: token }
      : { accountName: this.account.username, password: this.account.password });
  }

  _bind(client) {
    if (this.debug) {
      // steam-user's own trace, minus anything that could carry a secret.
      client.on('debug', m => {
        const line = String(m);
        if (!/password|token|code|guard|secret|cookie/i.test(line)) this.debug(line.slice(0, 200));
      });
    }
    client.on('steamGuard', (domain, callback) => this._steamGuard(domain, callback));
    client.on('refreshToken', token => {
      Promise.resolve(this.tokens.set(this.account.id, token)).catch(e => this.log('saving token failed: ' + e.message));
    });
    client.on('loggedOn', () => {
      if (!this.running) { client.logOff(); return; }
      this.steamID = client.steamID ? client.steamID.getSteamID64() : null;
      this.failures = 0;
      this.lastError = null;
      this._setState('online', this.steamID);
      const epoch = this._epoch;
      this._afterLogin().catch(e => {
        if (!this.running || epoch !== this._epoch) return;
        this._markStopped();
        client.logOff();
        this._retryLater('after-login step failed: ' + e.message);
      });
    });
    client.on('playingState', (blocked, playingApp) => {
      this.blocked = blocked;
      if (blocked) this.log(`someone else is playing ${playingApp} on this account`);
      this._play();
    });
    client.on('disconnected', (eresult, msg) => {
      // steam-user logs back in by itself after these (autoRelogin)
      this._markStopped();
      if (this.running) this._setState('reconnecting', msg || String(eresult));
    });
    client.on('error', err => this._onError(err));
  }

  async _steamGuard(domain, callback) {
    if (!this.running) return;
    const epoch = this._epoch;
    if (!domain) {
      // An authenticator-app code: we never hold those.
      return this._fail('A mobile authenticator is on the account');
    }
    this._setState('waiting-code', 'Steam Guard mail to ' + domain);
    try {
      const hit = await this.guardMail.waitForCode(this.account.email, this.loginStartedAt, { exclude: this.usedCodes });
      if (!this.running || epoch !== this._epoch) return;
      this.usedCodes.push(hit.messageId);
      this.log('Steam Guard code read from mail: ' + hit.subject);
      callback(hit.code);
    } catch (e) {
      if (!this.running || epoch !== this._epoch) return;
      this.client.logOff();
      this._retryLater(e.message);
    }
  }

  async _afterLogin() {
    const epoch = this._epoch;
    // Never report a game as played before it is in the library: Steam would not book it.
    this.ready = false;
    this._play();
    const granted = await this._addMissingLicenses();
    if (!this.running || epoch !== this._epoch) return;
    await this.refreshPlaytime();
    if (!this.running || epoch !== this._epoch) return;
    this.ready = true;
    if (granted.length) this._applyPlaying([]); // restart the session so it covers the new licenses
    this._play();
    this.timers.clearInterval(this._playtimeTimer);
    this._playtimeTimer = this.timers.setInterval(() => {
      this.refreshPlaytime().catch(e => this.log('playtime read failed: ' + e.message));
    }, PLAYTIME_EVERY_MS);
  }

  // Free-to-play games must be in the library or Steam records no time for them.
  async _addMissingLicenses() {
    const epoch = this._epoch;
    await this.refreshPlaytime();
    if (!this.running || epoch !== this._epoch) return [];
    const missing = this.games.filter(g => !this.owned?.has(g) && !this.licensed.has(g));
    if (!missing.length) return [];
    const granted = await new Promise((resolve, reject) => {
      this.client.requestFreeLicense(missing, (err, packages, apps) => err ? reject(err) : resolve(apps || []));
    });
    if (!this.running || epoch !== this._epoch) return [];
    for (const app of granted) this.licensed.add(Number(app));
    this.log(`asked Steam for ${missing.join(', ')}; granted apps: ${granted.join(', ') || 'none'}`);
    this.emit('licenses', { requested: missing, granted });
    const refused = missing.filter(app => !this.licensed.has(app));
    if (refused.length) throw Error('Steam did not grant licenses for: ' + refused.join(', '));
    return granted;
  }

  // Reads the account's real playtime from Steam (minutes per game).
  async refreshPlaytime() {
    if (!this.steamID) return this.playtime;
    const epoch = this._epoch;
    const res = await new Promise((resolve, reject) => {
      this.client.getUserOwnedApps(this.client.steamID, {
        includePlayedFreeGames: true,
        includeFreeSub: true,
        filterAppids: this.games,
      }, (err, r) => err ? reject(err) : resolve(r));
    });
    if (!this.running || epoch !== this._epoch) return this.playtime;
    const playtime = {};
    for (const app of res.apps || []) playtime[app.appid] = { name: app.name, minutes: app.playtime_forever || 0 };
    this.playtime = playtime;
    this.owned = new Set(Object.keys(playtime).map(Number));
    this.playtimeAt = new Date().toISOString();
    this.emit('playtime', playtime);
    return playtime;
  }

  _play() {
    const want = this.running && this.steamID && this.ready && !this.blocked && !this.paused ? this.games : [];
    this._applyPlaying(want);
    if (!this.running || !this.steamID || !this.ready) return;
    if (this.blocked) this._setState('giving-way', 'the account is being played somewhere else');
    else if (this.paused) this._setState('paused');
    else this._setState('playing', this.games.join(', '));
  }

  _applyPlaying(list) {
    const same = list.length === this.playing.length && list.every((g, i) => g === this.playing[i]);
    if (same) return;
    this.client.gamesPlayed(list);
    this.playing = [...list];
    this.playingSince = list.length ? new Date().toISOString() : null;
  }

  _markStopped() {
    this._epoch++;
    this.ready = false;
    this.playing = [];
    this.playingSince = null;
    this.steamID = null;
    this.timers.clearInterval(this._playtimeTimer);
  }

  _onError(err) {
    this._markStopped();
    if (!this.running) return;
    const code = err.eresult;
    if (this.usedToken && TOKEN_REJECTED.has(code)) {
      // Fall back to the password once; a fresh token is saved on success.
      Promise.resolve(this.tokens.clear(this.account.id)).catch(() => {}).then(() => this._retryLater('saved login expired', 1000));
      return;
    }
    if (FATAL.has(code)) return this._fail(FATAL.get(code));
    if (code === EResult.RateLimitExceeded || code === EResult.AccountLoginDeniedThrottle) {
      return this._retryLater('Steam rate limit', 35 * 60 * 1000);
    }
    if (code === EResult.LoggedInElsewhere) return this._retryLater('logged in elsewhere', 10 * 60 * 1000);
    this._retryLater(err.message || 'connection error');
  }

  _retryLater(reason, delayMs) {
    if (!this.running) return;
    this.failures += 1;
    this.lastError = reason;
    const wait = delayMs || Math.min(30 * 1000 * 2 ** (this.failures - 1), 15 * 60 * 1000);
    this._setState('retrying', `${reason}; next try in ${Math.round(wait / 1000)}s`);
    this.timers.clearTimeout(this._retryTimer);
    this._retryTimer = this.timers.setTimeout(() => {
      this._connect().catch(e => { if (this.running) this._retryLater(e.message); });
    }, wait);
  }

  _fail(reason) {
    this._epoch++;
    this.ready = false;
    this.lastError = reason;
    this.running = false;
    this.timers.clearTimeout(this._retryTimer);
    this.timers.clearInterval(this._playtimeTimer);
    try { this.client?.logOff(); } catch { /* already gone */ }
    this._setState('failed', reason);
    this.emit('failed', reason);
  }
}

module.exports = { AccountBooster, cleanGames, FATAL, TOKEN_REJECTED, MAX_GAMES };
