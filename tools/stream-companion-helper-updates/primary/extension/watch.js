import { watchPage } from './watch-page.js';

export const WATCH_ACCESS = { permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] };
const STORAGE_KEY = 'watchSession';
const RESERVED = new Set(['directory', 'settings', 'downloads', 'videos', 'subscriptions', 'inventory', 'drops', 'wallet', 'search', 'popout', 'clip', 'clips', 'collections', 'dashboard', 'login', 'signup', 'logout', 'activate', 'turbo', 'jobs', 'p', 'friends', 'messages', 'store', 'products', 'prime', 'team', 'teams', 'bits', 'checkout', 'payments', 'moderator']);
const OFF = { enabled: false, tabId: null, account: '', channel: '', url: '', status: 'off', detail: 'Playback checks are off.', checkedAt: 0, lastProgressAt: 0, error: '', syncStatus: 'idle', syncError: '', generation: 0, sessionId: '', documentId: '', videoId: '' };

export function watchChannel(raw) {
  try {
    const u = new URL(raw);
    if (u.origin !== 'https://www.twitch.tv' || u.username || u.password) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || !/^[a-z0-9_]{3,25}$/i.test(parts[0]) || RESERVED.has(parts[0].toLowerCase())) return '';
    return parts[0].toLowerCase();
  } catch { return ''; }
}

export function playbackState(snapshot, previous = {}, now = Date.now()) {
  const sameDocument = !!previous.documentId && snapshot.documentId === previous.documentId;
  const sameMedia = typeof snapshot.videoId === 'string' && /^v[1-9]\d{0,8}$/.test(snapshot.videoId) && snapshot.videoId === previous.videoId;
  const sameClock = sameDocument && sameMedia && previous.hasVideo && previous.ad === snapshot.ad;
  const delta = snapshot.currentTime - (previous.currentTime || 0);
  const advanced = sameClock && delta > 0.1 && snapshot.currentTime >= 0;
  const reset = !sameClock || delta < -0.1;
  let lastProgressAt = advanced ? now : reset ? 0 : previous.lastProgressAt || 0;
  const waitingSince = reset || previous.paused !== snapshot.paused ? now : previous.waitingSince || now;
  let status = 'checking', detail = 'Checking whether the native player is advancing.';
  if (snapshot.error) { status = 'error'; detail = 'Twitch is showing a playback error.'; }
  else if (snapshot.offline) { status = 'offline'; detail = 'This channel is offline.'; }
  else if (snapshot.commercialBreak) { status = 'commercial'; detail = 'Twitch is showing a commercial-break slate. The cause is not reported by the player.'; }
  else if (!snapshot.hasVideo) { status = 'unavailable'; detail = 'No native video player is available on this page.'; }
  else if (snapshot.ended) { status = 'ended'; detail = 'The native video has ended.'; }
  else if (snapshot.paused) { status = 'paused'; detail = 'The native player is paused. Use Twitch to resume it.'; }
  else if (advanced) { status = snapshot.ad ? 'ad' : 'playing'; detail = snapshot.ad ? 'Twitch’s ad indicator is visible and the video is advancing.' : 'The native video is advancing.'; }
  else if (now - (lastProgressAt || waitingSince) >= 30_000) { status = 'stalled'; detail = 'The player has not advanced for at least 30 seconds.'; }
  else if (snapshot.readyState < 3) { status = 'buffering'; detail = 'The native player is buffering.'; }
  else if (lastProgressAt && now - lastProgressAt < 15_000) { status = snapshot.ad ? 'ad' : 'playing'; detail = snapshot.ad ? 'Twitch’s ad indicator is visible and the video is advancing.' : 'The native video advanced at the last checkpoint.'; }
  return { ...snapshot, status, detail, checkedAt: now, lastProgressAt, waitingSince, error: snapshot.error ? detail : '' };
}

export class WatchSession {
  constructor(api, readSettings, hooks = {}) {
    this.api = api; this.settings = readSettings; this.hooks = hooks;
    this.serial = Promise.resolve(); this.epoch = 0; this.busy = false; this.lastPollAt = 0;
  }
  async raw() { return { ...OFF, ...((await this.api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {}) }; }
  async state() {
    const s = await this.raw();
    if (s.enabled && s.checkedAt && Date.now() - s.checkedAt > 45_000) { s.status = 'stale'; s.detail = 'Playback has not been checked recently; its current state is unknown.'; }
    return { ...s, lastCheck: s.checkedAt, lastAdvance: s.lastProgressAt };
  }
  patch(fields, token) {
    const work = this.serial.then(async () => {
      const s = await this.raw();
      if (token && (!s.enabled || s.sessionId !== token.sessionId || s.generation !== token.generation || s.tabId !== token.tabId)) return s;
      const next = { ...s, ...(typeof fields === 'function' ? fields(s) : fields) };
      await this.api.storage.local.set({ [STORAGE_KEY]: next }); return next;
    });
    this.serial = work.catch(() => {}); return work;
  }
  async current(token) {
    const [s, settings] = await Promise.all([this.raw(), this.settings()]);
    return !!s.enabled && !settings.paused && settings.account === token.account && s.account === token.account && s.tabId === token.tabId && s.sessionId === token.sessionId && s.generation === token.generation && s.channel === token.channel;
  }
  async attach({ tabId, channel, account }) {
    const epoch = ++this.epoch;
    const s = await this.settings();
    if (s.paused || s.account !== account) throw new Error('Resume the companion with the selected account before starting playback checks.');
    if (!Number.isInteger(tabId) || !/^[a-z0-9_]{3,25}$/.test(channel || '') || !/^[a-z0-9_]{3,25}$/.test(account || '')) throw new Error('A valid stream tab, channel and account are required.');
    if (!await this.api.permissions.contains(WATCH_ACCESS)) throw new Error('Allow Twitch playback-check access first.');
    const tab = await this.api.tabs.get(tabId);
    if (watchChannel(tab.pendingUrl || tab.url) !== channel) throw new Error('The selected tab is not showing the expected Twitch channel.');
    if (epoch !== this.epoch) return { ok: false };
    const value = await this.patch(old => ({ ...OFF, enabled: true, tabId, channel, account, url: tab.pendingUrl || tab.url, sessionId: crypto.randomUUID(), generation: old.generation + 1, startedAt: Date.now(), status: 'checking', detail: 'Checking the native Twitch player.', syncStatus: 'aligned', loading: tab.status === 'loading' }));
    this.lastPollAt = 0;
    if (epoch !== this.epoch) return { ok: false };
    return { ok: true, generation: value.generation, sessionId: value.sessionId };
  }
  async stop(reason = 'Playback checks are off.') {
    this.epoch++; this.lastPollAt = 0;
    return this.patch(old => ({ ...OFF, generation: old.generation + 1, detail: reason }));
  }
  async navigate(url, { loading = false } = {}) {
    // Only the small state transition is serialized. Official channel checks
    // may be slow, so a newer navigation must be able to invalidate them.
    let token, changed = false;
    await this.patch(old => {
      if (!old.enabled || url === old.url && (!loading || old.loading)) return old;
      const channel = watchChannel(url);
      changed = channel !== old.channel;
      token = { tabId: old.tabId, account: old.account, fromChannel: old.channel, channel, url, sessionId: old.sessionId, generation: old.generation + Number(changed), isRaid: false };
      try { token.isRaid = new URL(url).searchParams.get('referrer') === 'raid'; } catch {}
      // Document invalidation is separate from channel generation. A loading
      // event after a raid must not cancel the still-valid channel validation.
      this.epoch++; this.lastPollAt = 0;
      if (changed) this.hooks.onNavigation?.(token);
      return { ...token, status: channel ? 'checking' : 'unavailable', detail: channel ? 'Checking the new stream page.' : 'The tracked tab is no longer on a stream channel.', checkedAt: 0, lastProgressAt: 0, documentId: '', videoId: '', currentTime: 0, hasVideo: false, waitingSince: 0, loading, error: '', syncStatus: changed ? 'checking' : old.syncStatus, syncError: changed ? '' : old.syncError };
    });
    if (!token || !changed || !await this.current(token)) return this.state();
    try {
      const result = await this.hooks.onChannel?.(token);
      if (await this.current(token)) await this.patch({ syncStatus: result?.ok === false ? 'blocked' : 'aligned', syncError: String(result?.error || '').slice(0, 300) }, token);
    } catch (e) { if (await this.current(token)) await this.patch({ syncStatus: 'error', syncError: String(e.message || e).slice(0, 300) }, token); }
    return this.state();
  }
  async handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    const old = await this.raw();
    if (!old.enabled || old.tabId !== tabId) return;
    if (changeInfo.url || changeInfo.status === 'loading') await this.navigate(changeInfo.url || tab.pendingUrl || tab.url || old.url, { loading: changeInfo.status === 'loading' });
    if (changeInfo.status === 'complete') { await this.patch({ loading: false }); await this.poll({ force: true }); }
  }
  async handleTabRemoved(tabId) {
    const s = await this.raw();
    if (!s.enabled || s.tabId !== tabId) return;
    const token = { ...s, fromChannel: s.channel, channel: '', url: '', generation: s.generation + 1 };
    this.hooks.onNavigation?.(token);
    await this.stop('The stream tab was closed. Open a stream to start playback checks again.');
    await this.hooks.onChannel?.(token);
  }
  async poll({ force = false } = {}) {
    if (this.busy || (!force && Date.now() - this.lastPollAt < 5000)) return this.state();
    this.busy = true; this.lastPollAt = Date.now();
    let operationToken, pollEpoch = this.epoch;
    try {
      let s = await this.raw(); const settings = await this.settings();
      operationToken = s;
      if (!s.enabled || pollEpoch !== this.epoch) return this.state();
      if (settings.paused || settings.account !== s.account) return this.stop(settings.paused ? 'Companion is paused.' : 'Account changed. Start playback checks again.');
      if (!await this.api.permissions.contains(WATCH_ACCESS)) {
        // Preserve the tracked session so callers continue to hold automatic
        // replies on unknown playback rather than silently becoming chat-only.
        await this.patch({ status: 'unavailable', detail: 'Twitch playback-check access was removed.', error: 'Allow Twitch access to resume playback checks, or stop the checks explicitly.', checkedAt: Date.now(), lastProgressAt: 0, documentId: '', videoId: '', hasVideo: false }, operationToken);
        return this.state();
      }
      if (pollEpoch !== this.epoch) return this.state();
      let tab;
      try { tab = await this.api.tabs.get(s.tabId); } catch { await this.handleTabRemoved(s.tabId); return this.state(); }
      if (pollEpoch !== this.epoch) return this.state();
      const url = tab.pendingUrl || tab.url;
      if (url !== s.url) { await this.navigate(url, { loading: tab.status === 'loading' }); s = await this.raw(); operationToken = s; pollEpoch = this.epoch; }
      if (!s.enabled || !s.channel || tab.status === 'loading') return this.state();
      const token = { ...s }; const epoch = this.epoch;
      if (!await this.current(token) || epoch !== this.epoch) return this.state();
      const outputs = await this.api.scripting.executeScript({ target: { tabId: s.tabId, frameIds: [0] }, world: 'ISOLATED', func: watchPage, args: [] });
      const snapshot = outputs.find(x => x.frameId === 0 || outputs.length === 1 && x.frameId == null);
      if (!snapshot?.documentId || !snapshot.result || snapshot.result.url !== s.url || epoch !== this.epoch || !await this.current(token)) return this.state();
      // Re-read the browser's URL after execution: a previous document finishing
      // during navigation must not make a new page appear healthy.
      tab = await this.api.tabs.get(s.tabId);
      if ((tab.pendingUrl || tab.url) !== s.url || tab.status === 'loading') { await this.navigate(tab.pendingUrl || tab.url, { loading: tab.status === 'loading' }); return this.state(); }
      const raw = snapshot.result;
      const bounded = { documentId: snapshot.documentId, videoId: typeof raw.videoId === 'string' && /^v[1-9]\d{0,8}$/.test(raw.videoId) ? raw.videoId : '', url: raw.url, hasVideo: !!raw.hasVideo, currentTime: Number.isFinite(raw.currentTime) && raw.currentTime >= 0 ? raw.currentTime : 0, readyState: Math.max(0, Math.min(4, Number(raw.readyState) || 0)), paused: !!raw.paused, ended: !!raw.ended, ad: !!raw.ad, commercialBreak: !!raw.commercialBreak, offline: !!raw.offline, error: !!raw.error };
      await this.patch(playbackState(bounded, s), token);
      return this.state();
    } catch (e) {
      const s = await this.raw();
      if (s.enabled && operationToken && await this.current(operationToken)) await this.patch({ status: 'unavailable', detail: 'Playback could not be checked. It will be checked again.', error: String(e.message || e).slice(0, 300) }, operationToken);
      return this.state();
    } finally { this.busy = false; }
  }
}
