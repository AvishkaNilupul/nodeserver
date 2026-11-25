import { mergeMessages, sendGate, validateReply } from '../extension/core.js';
import { exchangeOffer } from '../extension/exchange.js';
import { humanMessages } from '../extension/participation.js';

export const chatScopes = ['user:read:chat', 'user:write:chat'];
export const clipScope = 'clips:edit';
const oauth = 'https://id.twitch.tv/oauth2';
const helix = 'https://api.twitch.tv/helix';
const login = value => typeof value === 'string' && /^[a-z0-9_]{3,25}$/.test(value);
const id = value => typeof value === 'string' && /^\d+$/.test(value);
// Only known protocol codes become public diagnostics; never echo payloads.
const revocationReasons = new Map([
  ['chat_user_banned', 'Twitch removed this account from this channel’s chat (chat_user_banned). Automatic reconnect is disabled.'],
  ['authorization_revoked', 'Twitch revoked the chat subscription’s authorization (authorization_revoked). Reauthorize Twitch before reconnecting.'],
  ['user_removed', 'A user required by the Twitch chat subscription was removed (user_removed). Automatic reconnect is disabled.'],
  ['version_removed', 'Twitch no longer supports this chat subscription version (version_removed). The helper needs an update.']
]);
const subscriptionForbidden = 'Twitch refused this channel’s chat subscription (HTTP 403). Chat permission or channel access was denied; automatic reconnect is disabled.';

export function reconnectUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv' || url.port || url.username || url.password || url.pathname !== '/ws') throw new Error('Unexpected EventSub reconnect address.');
  return url.href;
}

// Tokens stay in the paired loopback helper. No browser cookies, playback,
// follows, browser input, or public-page navigation are used by this transport.
export class TwitchChat {
  constructor({ credentials = {}, history = [], coordinator = null, saveCredentials = async () => {}, saveHistory = async () => {}, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { credentials, history, coordinator, saveCredentials, saveHistory, fetch: fetchImpl, WebSocket: WebSocketImpl, now, setTimer, clearTimer });
    this.messages = []; this.connected = false; this.error = ''; this.generation = 0; this.validatedAt = null;
    this.sockets = new Set(); this.timers = new Map(); this.chain = Promise.resolve();
    this.channelCache = new Map();
  }

  async request(url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw Object.assign(new Error('Twitch connection failed; no automatic retry was made.'), { retryable: true }); }
    let data; try { data = await response.json(); } catch { data = {}; }
    return { response, data };
  }

  async form(path, values) {
    return this.request(`${oauth}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
  }

  async startAuthorization(clientId, account, { clips = false } = {}) {
    if (!/^[a-z0-9]{10,80}$/i.test(clientId || '')) throw new Error('Enter your Twitch developer app Client ID.');
    if (!login(account)) throw new Error('Enter the companion account login first.');
    const scopes = [...chatScopes, ...(clips || this.credentials.scopes?.includes(clipScope) ? [clipScope] : [])];
    this.disconnect(); this.pendingAuth = null;
    const generation = this.generation;
    const { response, data } = await this.form('device', { client_id: clientId, scopes: scopes.join(' ') });
    if (generation !== this.generation) throw new Error('Authorization cancelled.');
    if (!response.ok || !data.device_code || !data.user_code || !Number.isFinite(data.expires_in)) throw new Error(`Twitch authorization returned HTTP ${response.status}. Use a Public developer app.`);
    const url = new URL(data.verification_uri);
    if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv' || url.pathname !== '/activate' || url.username || url.password || url.port) throw new Error('Unexpected Twitch authorization address.');
    const interval = Math.max(5, Number(data.interval) || 5) * 1000;
    this.pendingAuth = { clientId, account, scopes, deviceCode: data.device_code, expires: this.now() + data.expires_in * 1000, nextPoll: this.now() + interval, interval };
    return { verificationUrl: url.href, userCode: data.user_code, pollAfterMs: interval, expiresAt: this.pendingAuth.expires };
  }

  async pollAuthorization({ beforeSave = () => {} } = {}) {
    const p = this.pendingAuth;
    if (!p || this.now() >= p.expires) { this.pendingAuth = null; throw new Error('Authorization expired. Connect Twitch again.'); }
    if (this.now() < p.nextPoll) return { pending: true, pollAfterMs: p.nextPoll - this.now() };
    p.nextPoll = this.now() + p.interval;
    const { response, data } = await this.form('token', { client_id: p.clientId, scopes: p.scopes.join(' '), device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (data.message === 'authorization_pending' || data.error === 'authorization_pending') return { pending: true, pollAfterMs: p.interval };
    if (data.message === 'slow_down' || data.error === 'slow_down') { p.interval += 5000; p.nextPoll = this.now() + p.interval; return { pending: true, pollAfterMs: p.interval }; }
    if (!response.ok || !data.access_token || !data.refresh_token) { this.pendingAuth = null; throw new Error('Twitch authorization was denied or expired. Connect again.'); }
    // Verify the account and app before persisting a new authorization.
    const candidate = { clientId: p.clientId, accessToken: data.access_token, refreshToken: data.refresh_token };
    const identity = await this.validate(candidate, p.account, p.scopes);
    if (this.pendingAuth !== p) throw new Error('Authorization cancelled.');
    beforeSave();
    const replacement = { ...candidate, ...identity };
    await this.saveCredentials(replacement);
    this.credentials = replacement;
    this.pendingAuth = null; this.validatedAt = this.now();
    return { authorized: true, account: identity.account };
  }

  async validate(credentials, expected, requiredScopes = chatScopes) {
    const { response, data } = await this.request(`${oauth}/validate`, { headers: { Authorization: `OAuth ${credentials.accessToken}` } });
    if (!response.ok) { const error = new Error('Twitch authorization could not be validated. Connect Twitch again.'); error.status = response.status; error.retryable = response.status === 429 || response.status >= 500; throw error; }
    if (data.client_id !== credentials.clientId || data.login !== expected || !id(data.user_id) || !requiredScopes.every(scope => data.scopes?.includes(scope))) throw new Error('The authorized Twitch account, app, or chat permissions do not match.');
    return { account: data.login, userId: data.user_id, scopes: [...chatScopes, ...(credentials.clipPermissionInvalid !== true && data.scopes.includes(clipScope) ? [clipScope] : [])] };
  }

  async ensureIdentity(expected) {
    if (this.identityFlight) {
      await this.identityFlight;
      if (this.credentials.account !== expected) throw new Error('The authorized Twitch account does not match.');
      return;
    }
    this.identityFlight = this.checkIdentity(expected);
    try { await this.identityFlight; } finally { this.identityFlight = null; }
  }

  async checkIdentity(expected) {
    if (!this.credentials.accessToken) throw new Error('Connect the companion account to Twitch first.');
    if (this.credentials.account !== expected) throw new Error('The authorized Twitch account does not match.');
    if (this.validatedAt !== null && this.now() - this.validatedAt < 3_600_000) return;
    let identity;
    try { identity = await this.validate(this.credentials, expected); }
    catch (e) {
      if (e.status !== 401 || !this.credentials.refreshToken) throw e;
      const { response, data } = await this.form('token', { client_id: this.credentials.clientId, grant_type: 'refresh_token', refresh_token: this.credentials.refreshToken });
      if (!response.ok || !data.access_token || !data.refresh_token) throw Object.assign(new Error('Twitch authorization expired. Connect Twitch again.'), { status: response.status, retryable: response.status === 429 || response.status >= 500 });
      // Persist rotated one-use refresh tokens before any further network call.
      this.credentials = { ...this.credentials, accessToken: data.access_token, refreshToken: data.refresh_token };
      await this.saveCredentials(this.credentials);
      identity = await this.validate(this.credentials, expected);
    }
    this.credentials = { ...this.credentials, ...identity };
    this.validatedAt = this.now();
  }

  async api(path, body) {
    const { response, data } = await this.request(`${helix}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.credentials.accessToken}`, 'Client-Id': this.credentials.clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw Object.assign(new Error(`Twitch API returned HTTP ${response.status}; no automatic retry was made.`), { status: response.status, retryable: response.status === 429 || response.status >= 500 });
    return data;
  }

  async invalidateClipPermission(failedAccessToken = this.credentials.accessToken) {
    // A late 401 for an old token must not invalidate a newly approved grant.
    if (!failedAccessToken || failedAccessToken !== this.credentials.accessToken) return;
    const replacement = { ...this.credentials, clipPermissionInvalid: true,
      scopes: (Array.isArray(this.credentials.scopes) ? this.credentials.scopes : []).filter(scope => scope !== clipScope) };
    this.credentials = replacement;
    // Keep clipping disabled in memory even if the credential disk is unavailable.
    // Chat credentials remain usable; only an explicit successful new grant clears this marker.
    try { await this.saveCredentials(replacement); } catch {}
  }

  async prepareViewerClip(account, channel, streamId) {
    if (!login(account) || !login(channel) || typeof streamId !== 'string' || !/^\d{1,32}$/.test(streamId)) throw new Error('Invalid clip channel.');
    const generation = this.generation, identityToken = this.credentials.accessToken;
    try { await this.ensureIdentity(account); }
    catch (error) { if (error.status === 401) await this.invalidateClipPermission(identityToken); throw error; }
    if (!this.credentials.scopes?.includes(clipScope) || this.credentials.clipPermissionInvalid === true) throw new Error('Enable clips for this account first.');
    const token = this.credentials.accessToken;
    try {
      const users = await this.api(`users?login=${encodeURIComponent(channel)}`);
      const user = users.data?.[0];
      if (!id(user?.id) || user.login !== channel) throw new Error('Twitch channel was not found.');
      const streams = await this.api(`streams?user_id=${user.id}`);
      if (!streams.data?.some(stream => stream.id === streamId && stream.user_id === user.id && stream.user_login === channel)) throw new Error('The selected stream is no longer live.');
      if (generation !== this.generation) throw new Error('Clip preparation cancelled.');
      return { broadcasterId: user.id, creatorId: this.credentials.userId };
    } catch (error) { if (error.status === 401) await this.invalidateClipPermission(token); throw error; }
  }

  async createViewerClip(broadcasterId) {
    if (!id(broadcasterId)) throw new Error('Invalid clip broadcaster.');
    const token = this.credentials.accessToken;
    let result;
    try { result = await this.request(`${helix}/clips?broadcaster_id=${broadcasterId}&duration=30`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.credentials.accessToken}`, 'Client-Id': this.credentials.clientId }
    }); } catch { throw Object.assign(new Error('The clip submission outcome is unconfirmed. It will not be retried.'), { uncertain: true }); }
    const { response, data } = result;
    if (response.status === 401) await this.invalidateClipPermission(token);
    if (response.status !== 202) {
      const reason = response.status === 403 ? 'Twitch refused clipping here. Clips may be disabled or this account is not eligible.'
        : response.status === 401 ? 'Twitch clip permission expired. Enable clips again.'
        : response.status === 404 ? 'The stream is offline.' : `Twitch clip request returned HTTP ${response.status}.`;
      throw Object.assign(new Error(reason), { uncertain: response.status >= 500 || response.status < 400 });
    }
    const clipId = data.data?.[0]?.id;
    if (typeof clipId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(clipId)) throw Object.assign(new Error('Twitch accepted the clip but its ID is unconfirmed.'), { uncertain: true });
    return clipId;
  }

  async getViewerClip(clipId) {
    if (typeof clipId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(clipId)) throw new Error('Invalid clip ID.');
    const result = await this.api(`clips?id=${encodeURIComponent(clipId)}`);
    if (!Array.isArray(result.data)) throw new Error('Twitch clip confirmation is unavailable.');
    const clip = result.data.find(value => value.id === clipId);
    return clip ? { id: clip.id, broadcasterId: clip.broadcaster_id, creatorId: clip.creator_id } : null;
  }

  async inspectChannel(account, channel) {
    if (!login(account) || !login(channel)) throw new Error('Enter one account and one channel login.');
    const generation = this.generation;
    await this.ensureIdentity(account);
    if (generation !== this.generation) throw new Error('Channel check cancelled.');
    const key = `${account}:${channel}`, cached = this.channelCache.get(key);
    if (cached && this.now() - cached.checkedAt < 45_000) return structuredClone(cached);
    const users = await this.api(`users?login=${encodeURIComponent(channel)}`);
    const user = users.data?.[0];
    if (!id(user?.id) || user.login !== channel) throw new Error('Twitch channel was not found.');
    const [streams, settings, shared] = await Promise.all([
      this.api(`streams?user_id=${user.id}`),
      this.api(`chat/settings?broadcaster_id=${user.id}`),
      this.api(`shared_chat/session?broadcaster_id=${user.id}`)
    ]);
    if (generation !== this.generation) throw new Error('Channel check cancelled.');
    const modes = settings.data?.[0];
    if (!Array.isArray(streams.data) || !Array.isArray(shared.data) || modes?.broadcaster_id !== user.id
      || ['follower_mode', 'subscriber_mode', 'emote_mode'].some(k => typeof modes[k] !== 'boolean')) {
      throw new Error('Twitch did not confirm this channel’s live and chat state.');
    }
    const stream = streams.data.find(x => x.user_id === user.id && x.user_login === channel);
    const reason = !stream ? 'The stream is offline.' : shared.data.length ? 'Sending is paused during shared chat.'
      : modes.emote_mode ? 'This channel is in emote-only mode.' : modes.subscriber_mode ? 'This channel is in subscriber-only mode.'
      : modes.follower_mode ? 'This channel is in followers-only mode.' : '';
    const checkedAt = this.now();
    const result = { channel, broadcasterId: user.id, checkedAt, canReply: !reason, reason, sharedChat: !!shared.data.length,
      streamContext: { channel, streamId: id(stream?.id) ? stream.id : '', title: String(stream?.title || '').slice(0, 300), gameName: String(stream?.game_name || '').slice(0, 100), isLive: !!stream, checkedAt },
      chatSettings: { followersOnly: modes.follower_mode, subscribersOnly: modes.subscriber_mode, emoteOnly: modes.emote_mode, slowSeconds: modes.slow_mode ? Number(modes.slow_mode_wait_time) || 0 : 0 } };
    this.channelCache.set(key, result);
    if (this.channelCache.size > 12) this.channelCache.delete(this.channelCache.keys().next().value);
    return structuredClone(result);
  }

  disconnect() {
    this.generation++; this.connected = false; this.channel = ''; this.broadcasterId = ''; this.messages = [];
    this.pendingAuth = null;
    this.clearTimer(this.identityTimer); this.identityTimer = null;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }

  async connect(account, channel) {
    if (!login(account) || !login(channel)) throw new Error('Enter one account and one channel login.');
    this.disconnect(); this.error = ''; this.recoverable = true;
    const generation = this.generation;
    try {
    await this.ensureIdentity(account);
    if (generation !== this.generation) return;
    const users = await this.api(`users?login=${encodeURIComponent(channel)}`);
    const user = users.data?.[0];
    if (!id(user?.id) || user.login !== channel) throw new Error('Twitch channel was not found.');
    if (generation !== this.generation) return;
    this.channel = channel; this.broadcasterId = user.id;
    this.openSocket('wss://eventsub.wss.twitch.tv/ws', generation);
    this.validateLater(account, generation);
    return { connecting: true };
    } catch (e) {
      if (generation === this.generation) this.fail(e.message, !!e.retryable);
      throw e;
    }
  }

  validateLater(account, generation) {
    this.identityTimer = this.setTimer(async () => {
      if (generation !== this.generation) return;
      this.validatedAt = null;
      try { await this.ensureIdentity(account); }
      catch (e) { if (generation === this.generation) this.fail(e.message, !!e.retryable); return; }
      if (generation === this.generation) this.validateLater(account, generation);
    }, 3_500_000);
    this.identityTimer?.unref?.();
  }

  armTimeout(socket, delay, generation) {
    this.clearTimer(this.timers.get(socket));
    const timer = this.setTimer(() => {
      if (generation === this.generation) this.fail('Twitch chat timed out.', true);
    }, delay);
    timer?.unref?.(); this.timers.set(socket, timer);
  }

  fail(message, recoverable = false) { this.disconnect(); this.error = message; this.recoverable = recoverable; }

  openSocket(url, generation, previous = null) {
    const socket = new this.WebSocket(reconnectUrl(url));
    this.sockets.add(socket); this.armTimeout(socket, 15_000, generation);
    let timeout = 15_000, transferring = false;
    socket.addEventListener('message', event => {
      this.chain = this.chain.then(async () => {
        if (generation !== this.generation || !this.sockets.has(socket)) return;
        const data = JSON.parse(event.data);
        const type = data.metadata?.message_type;
        if (type === 'session_welcome') {
          const session = data.payload?.session;
          if (!session?.id) throw new Error('Invalid EventSub welcome.');
          timeout = (Number(session.keepalive_timeout_seconds) || 10) * 1000 + 5000;
          if (!previous) {
            let subscription;
            try {
              subscription = await this.api('eventsub/subscriptions', {
                type: 'channel.chat.message', version: '1',
                condition: { broadcaster_user_id: this.broadcasterId, user_id: this.credentials.userId },
                transport: { method: 'websocket', session_id: session.id }
              });
            } catch (e) {
              if (e.status === 403) throw Object.assign(new Error(subscriptionForbidden), { chatSubscriptionRefused: true });
              throw e;
            }
            if (subscription.data?.[0]?.status !== 'enabled') throw new Error('Twitch did not enable the chat subscription.');
          }
          if (generation !== this.generation) return;
          if (previous) { this.sockets.delete(previous); this.clearTimer(this.timers.get(previous)); this.timers.delete(previous); previous.close(); }
          this.connected = true; this.error = '';
        } else if (type === 'notification' && data.metadata?.subscription_type === 'channel.chat.message') {
          const e = data.payload?.event;
          if (e?.broadcaster_user_id === this.broadcasterId && !e.source_broadcaster_user_id) {
            this.messages = mergeMessages(this.messages, [{ id: e.message_id, author: e.chatter_user_login, text: e.message?.text, at: Date.parse(data.metadata.message_timestamp), replyParentId: e.reply?.parent_message_id }], this.now());
          }
        } else if (type === 'session_reconnect') {
          if (!transferring) {
            this.openSocket(reconnectUrl(data.payload?.session?.reconnect_url), generation, socket);
            transferring = true;
          }
        } else if (type === 'revocation') {
          this.fail(revocationReasons.get(data.payload?.subscription?.status)
            || 'Twitch revoked the chat subscription (unknown_reason). Automatic reconnect is disabled.');
          return;
        }
        if (generation === this.generation) this.armTimeout(socket, timeout, generation);
      }).catch(e => {
        if (generation === this.generation) this.fail(e.chatSubscriptionRefused ? subscriptionForbidden
          : e.retryable ? 'Twitch chat connection interrupted.' : 'Twitch chat connection failed. Connect chat again.', !e.chatSubscriptionRefused && !!e.retryable);
      });
    });
    socket.addEventListener('close', () => {
      if (generation === this.generation && this.sockets.has(socket)) this.fail('Twitch chat disconnected.', true);
    });
    socket.addEventListener('error', () => {
      if (generation === this.generation && this.sockets.has(socket)) this.fail('Twitch chat connection interrupted.', true);
    });
  }

  async refreshCoordination(observation) {
    if (!this.coordinator?.refresh) return;
    this.coordinator.seed?.(this.history);
    await this.coordinator.refresh({ channel: this.channel || '', connected: this.connected, observation });
  }

  async finishCoordination(reservationId, delivery) {
    if (!reservationId) return;
    // Twitch delivery is already known independently of a host acknowledgement.
    // The remote adapter durably queues/replays this completion; a host outage
    // must never relabel a confirmed Twitch response as uncertain.
    try { await this.coordinator?.finish(reservationId, delivery); } catch {}
  }

  status() {
    return { authorized: !!this.credentials.accessToken, account: this.credentials.account || '', channel: this.channel || '', connected: this.connected, error: this.error, recoverable: this.recoverable !== false,
      messages: mergeMessages(this.messages, [], this.now()), sent: this.history.filter(x => x.at > this.now() - 3_600_000),
      ...(this.coordinator ? { coordination: this.coordinator.snapshot(this.channel || '') } : {}) };
  }

  async send({ account, channel, text, replyTo = '', replyAuthor = '', category = '', participationKey = '', kind = '', streamId = '', exchangeId, beforeSubmit }) {
    if (!this.connected || channel !== this.channel) throw new Error('Connect chat to the configured channel first.');
    const generation = this.generation;
    const message = validateReply(text);
    await this.ensureIdentity(account);
    if (generation !== this.generation || !this.connected) throw new Error('Chat disconnected before submission.');
    let exchange;
    if (kind === 'exchange' || exchangeId !== undefined) {
      if (kind !== 'exchange' || !participationKey || !exchangeId || replyTo || replyAuthor
        || !this.coordinator?.reserve || !this.coordinator?.begin) throw new Error('Invalid exchange intent.');
      await this.refreshCoordination();
      const snapshot = this.coordinator.snapshot(channel);
      if (snapshot.available !== true || snapshot.paused) return {
        submitted: false, suppressed: true, delivery: 'cancelled', code: snapshot.paused ? 'paused' : 'unavailable', retryable: true,
        reason: snapshot.paused ? 'Central coordination is paused.' : 'Central host is unavailable; waiting before submitting a message.'
      };
      exchange = exchangeOffer(snapshot.exchange,
        { account, channel, streamId, accounts: snapshot.accounts, now: this.now() });
      if (!exchange || exchange.id !== exchangeId || exchange.key !== participationKey || exchange.text !== message) {
        throw new Error('The scheduled companion exchange is no longer current.');
      }
      const ledger = this.history.filter(x => x.account === account && x.participationKey
        && !(x.delivery === 'cancelled' && x.submitted === false));
      if (ledger.some(x => !Number.isFinite(x.at) || x.at + 600_000 > this.now())) {
        throw new Error('Waiting ten minutes between conversation-mode attempts.');
      }
    }
    if (participationKey) {
      if (!['greeting', 'topic', 'conversation', 'exchange'].includes(kind) || !id(streamId) || typeof participationKey !== 'string' || participationKey.length > 400) throw new Error('Invalid participation intent.');
      if (this.history.some(x => x.participationKey === participationKey && x.delivery !== 'cancelled')) throw new Error('This contribution was already submitted.');
      const info = await this.inspectChannel(account, channel);
      if (!info.streamContext.isLive || info.streamContext.streamId !== streamId || info.sharedChat || info.chatSettings.emoteOnly || info.chatSettings.subscribersOnly) throw new Error('The live channel no longer permits this contribution.');
      if (generation !== this.generation || !this.connected) throw new Error('Chat disconnected before submission.');
    }
    if (replyTo && !this.messages.some(m => m.id === replyTo && m.at >= this.now() - 45_000 && m.at <= this.now())) throw new Error('The reply target is no longer current.');
    const reason = sendGate({ channel, allowedChannel: this.channel, login: this.credentials.account, expectedLogin: account, text: message, recent: this.history.filter(x => !(x.delivery === 'cancelled' && x.submitted === false)), now: this.now() });
    if (reason) throw new Error(reason);
    // User-token messages propagate to shared chat. Refuse shared sessions so
    // the one-channel contract remains true even when a broadcaster joins one.
    const shared = await this.api(`shared_chat/session?broadcaster_id=${this.broadcasterId}`);
    if (!Array.isArray(shared.data)) throw new Error('Twitch did not confirm the channel chat state.');
    if (shared.data?.length) throw new Error('Sending is paused while this channel is in shared chat.');
    if (generation !== this.generation || !this.connected) throw new Error('Chat disconnected before submission.');
    if (replyTo && this.coordinator?.snapshot(channel).accounts.includes(this.messages.find(x => x.id === replyTo)?.author?.toLowerCase())) {
      return { submitted: false, suppressed: true, delivery: 'cancelled', code: 'companion_message', retryable: false, reason: 'Automatic replies to another companion are disabled.' };
    }
    let reservation;
    try { reservation = await this.coordinator?.reserve({ account, channel, text: message, streamId, kind, replyTo,
      ...(exchange ? { exchangeId } : {}),
      ...(replyTo ? { replyAt: this.messages.find(m => m.id === replyTo)?.at } : {}) }); }
    catch { return { submitted: false, suppressed: true, delivery: 'cancelled', code: 'unavailable', retryable: true, reason: 'Central host is unavailable; waiting before submitting a message.' }; }
    if (reservation && !reservation.ok) return { submitted: false, suppressed: true, delivery: 'cancelled',
      code: reservation.code, retryable: reservation.retryable === true, reason: reservation.reason };
    const attempt = { at: this.now(), account, channel, text: message, delivery: 'pending', ...(reservation ? { coordinationId: reservation.reservationId } : {}), category: String(category).slice(0, 40), ...(replyTo ? { replyId: replyTo, replyTo: String(replyAuthor).slice(0, 30) } : {}), ...(participationKey ? { participationKey: String(participationKey).slice(0, 400), kind: String(kind).slice(0, 30), streamId: String(streamId).slice(0, 128), ...(exchange ? { exchangeId } : {}) } : {}) };
    this.history = [...this.history.filter(x => x.at > this.now() - 3_600_000), attempt];
    await this.saveHistory(this.history);
    if (generation !== this.generation || !this.connected) {
      attempt.delivery = 'cancelled'; attempt.submitted = false; await this.saveHistory(this.history);
      await this.finishCoordination(reservation?.reservationId, 'cancelled');
      throw new Error('Chat disconnected before submission.');
    }
    if (reservation && this.coordinator?.begin) {
      let permission;
      try { permission = await this.coordinator.begin(reservation.reservationId); }
      catch { permission = { ok: false, code: 'unavailable', retryable: true, reason: 'Central host is unavailable; waiting before submitting a message.' }; }
      if (!permission?.ok) {
        attempt.delivery = 'cancelled'; attempt.submitted = false;
        attempt.reason = permission?.reason || 'Central host is holding this turn.';
        // Even a lost begin response cannot strand a submitting tombstone:
        // this helper can certify that it has not called Twitch yet.
        try { await this.saveHistory(this.history); }
        finally { await this.finishCoordination(reservation.reservationId, 'cancelled'); }
        return { ...attempt, suppressed: true, submitted: false, code: permission?.code, retryable: permission?.retryable === true };
      }
      if (generation !== this.generation || !this.connected) {
        attempt.delivery = 'cancelled'; attempt.submitted = false; await this.saveHistory(this.history);
        await this.finishCoordination(reservation.reservationId, 'cancelled');
        throw new Error('Chat disconnected before submission.');
      }
    }
    const exchangeHuman = exchange && humanMessages(this.messages, account, this.coordinator.snapshot(channel).accounts)
      .some(m => Number.isFinite(m.at) && m.at > this.now() - 90_000 && m.at <= this.now());
    if ((exchange && (exchange.expiresAt <= this.now() || exchangeHuman))
      || (replyTo && !this.messages.some(m => m.id === replyTo && m.at >= this.now() - 45_000 && m.at <= this.now()))) {
      attempt.delivery = 'cancelled'; attempt.submitted = false;
      attempt.reason = exchangeHuman ? 'Fresh human chat takes priority over the scheduled exchange.'
        : exchange ? 'The scheduled exchange expired before submission.' : 'The reply target expired before submission.';
      try { await this.saveHistory(this.history); }
      finally { await this.finishCoordination(reservation?.reservationId, 'cancelled'); }
      return { ...attempt, suppressed: true, submitted: false,
        code: exchangeHuman ? 'exchange_quiet' : exchange ? 'exchange_expired' : 'target_expired', retryable: false };
    }
    try { await beforeSubmit?.(); }
    catch (e) {
      attempt.delivery = 'cancelled'; attempt.submitted = false;
      attempt.reason = e?.message || 'The local control command expired or was cancelled before submission.';
      try { await this.saveHistory(this.history); }
      catch { /* A local storage failure cannot turn a proven no-send into an unknown send. */ }
      finally { await this.finishCoordination(reservation?.reservationId, 'cancelled'); }
      return { ...attempt, suppressed: true, submitted: false, code: 'control_cancelled', retryable: false };
    }
    try {
      const data = await this.api('chat/messages', { broadcaster_id: this.broadcasterId, sender_id: this.credentials.userId, message, ...(replyTo ? { reply_parent_message_id: replyTo } : {}) });
      const result = data.data?.[0];
      attempt.delivery = result?.is_sent === true && result.message_id ? 'confirmed' : result?.is_sent === false ? 'rejected' : 'unknown';
      if (attempt.delivery === 'confirmed') attempt.messageId = result.message_id;
      if (attempt.delivery === 'rejected') attempt.reason = String(result.drop_reason?.code || 'twitch_rejected').slice(0, 100);
      await this.saveHistory(this.history);
      await this.finishCoordination(reservation?.reservationId, attempt.delivery);
      return { submitted: attempt.delivery === 'confirmed', ...attempt };
    } catch (e) {
      attempt.delivery = 'unknown';
      await this.saveHistory(this.history);
      await this.finishCoordination(reservation?.reservationId, 'unknown'); throw e;
    }
  }
}
