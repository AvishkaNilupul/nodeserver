import { mergeMessages, digest, sendGate } from './core.js';
import { directorBinding, directorOffer, importPages, importAcknowledged, sameBinding, sha256 } from './director.js';
import { DropClaims } from './drops.js';
import { WatchSession } from './watch.js';
import { exchangeContext, humanMessages, normalizeStreamContext } from './chat-context.js';
import { LocalControlBridge } from './local-control.js';

const defaults = { account: '', allowedChannel: '', autoReply: false, autoResume: false, chatMode: 'mentions', replySource: 'local', pairingToken: '', paused: false, clientId: '' };
let serial = Promise.resolve(), autoInFlight = false, recoveryInFlight = false, operationEpoch = 0;
let controlBridge, migrationGate = null;
let messageDirector = null, browserImportFlight = null, browserImported = false;
const locked = fn => {
  const epoch = operationEpoch;
  const run = () => { if (epoch !== operationEpoch) throw new Error('Operation cancelled by Pause or Disconnect.'); return fn(); };
  const result = serial.then(run, run); serial = result.catch(() => {}); return result;
};
const settings = async () => {
  const stored = (await chrome.storage.local.get('settings')).settings || {};
  return { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in stored).map(k => [k, stored[k]])), autoReply: [6, 7, 8].includes(stored.schemaVersion) && !!stored.autoReply, autoResume: [7, 8].includes(stored.schemaVersion) && !!stored.autoResume, chatMode: stored.schemaVersion === 8 && stored.chatMode === 'participate' ? 'participate' : 'mentions', revision: stored.revision || 0 };
};
// Serialize only short settings writes. Pause bypasses model/network work, but
// its disarm write must land after any older write already being persisted.
let settingsSerial = Promise.resolve();
function updateSettings(fields, { expectedRevision, epoch } = {}) {
  const result = settingsSerial.then(async () => {
    const current = await settings();
    if ((epoch !== undefined && epoch !== operationEpoch) || (expectedRevision !== undefined && current.revision !== expectedRevision)) throw new Error('Setup changed; operation cancelled.');
    const next = { ...current, ...(typeof fields === 'function' ? fields(current) : fields), schemaVersion: 8, revision: current.revision + 1 };
    await chrome.storage.local.set({ settings: next });
    messageDirector = null;
    return next;
  });
  settingsSerial = result.catch(() => {});
  return result;
}
let chat = { connected: false, messages: [], channel: '', account: '' };
const drops = new DropClaims(chrome, settings);
let activity = { state: 'waiting', reason: 'Waiting for a direct mention.', at: Date.now() };
let channelInfo = null, channelInfoBinding = null, metadataFlight = null, watchTransition = false, chatRefreshSequence = 0;
const navigationTasks = new Map();
const setActivity = (state, reason) => { activity = { state, reason, at: Date.now() }; };
const watch = new WatchSession(chrome, settings, {
  onNavigation(token) {
    const epoch = ++operationEpoch;
    const binding = controlBridge?.binding();
    watchTransition = true;
    setActivity('switching', token.channel ? `Aligning chat with @${token.channel}…` : 'The selected stream tab is no longer on a channel.');
    chat = { connected: false, messages: [], channel: '', account: '' };
    channelInfo = null;
    const task = (async () => {
      const s = await settings();
      await helper('/api/twitch/disconnect', { disarmOnly: true }, s, binding).catch(() => {});
      if (!token.channel && epoch === operationEpoch) {
        await updateSettings({ autoReply: false, autoResume: false }, { epoch });
        watchTransition = false;
        setActivity('waiting', 'The selected stream tab is closed or away from a channel. Replies are off.');
      }
      return { s, epoch, binding };
    })();
    navigationTasks.set(`${token.sessionId}:${token.generation}`, task);
    void task.catch(e => setActivity('error', e.message));
  },
  async onChannel(token) {
    const key = `${token.sessionId}:${token.generation}`;
    const task = navigationTasks.get(key); navigationTasks.delete(key);
    if (!task) return { ok: false, error: 'Channel alignment was cancelled.' };
    const { s, epoch, binding } = await task;
    try {
      if (!token.channel || epoch !== operationEpoch || s.paused || !await watch.current(token)) return { ok: false, error: 'Channel alignment was cancelled.' };
      const info = await helper('/api/twitch/channel', { account: s.account, channel: token.channel }, s);
      const current = await settings();
      if (epoch !== operationEpoch || current.revision !== s.revision || current.paused || !await watch.current(token)) return { ok: false, error: 'Channel alignment was cancelled.' };
      const next = await updateSettings({ allowedChannel: token.channel, chatMode: 'mentions', autoReply: info.canReply && current.autoReply, autoResume: info.canReply && current.autoResume }, { expectedRevision: current.revision, epoch });
      channelInfo = info; channelInfoBinding = metadataBinding(next, epoch);
      if (!info.canReply) { setActivity('error', info.reason || 'The destination chat could not be verified.'); return { ok: false, error: activity.reason }; }
      if (epoch !== operationEpoch || !await watch.current(token)) return { ok: false, error: 'Channel alignment was cancelled.' };
      await helper('/api/twitch/connect', { account: next.account, channel: next.allowedChannel }, next, binding);
      const final = await settings();
      if (epoch !== operationEpoch || final.revision !== next.revision || final.paused || !await watch.current(token)) return { ok: false, error: 'Channel alignment was cancelled.' };
      setActivity('waiting', `Chat followed this stream tab to @${next.allowedChannel}. Waiting for a direct mention.`);
      return { ok: true, status: 'aligned' };
    } catch (e) {
      if (epoch === operationEpoch) {
        await updateSettings({ autoReply: false, autoResume: false }, { epoch }).catch(() => {});
        setActivity('error', `Chat alignment stopped: ${e.message}`);
      }
      return { ok: false, error: e.message };
    } finally { if (epoch === operationEpoch) watchTransition = false; }
  }
});

function metadataBinding(s, epoch = operationEpoch) {
  return { account: s.account, channel: s.allowedChannel, revision: s.revision, epoch };
}
function sameMetadataBinding(binding, s, epoch = operationEpoch) {
  return epoch === operationEpoch && binding?.epoch === epoch && binding.account === s.account
    && binding.channel === s.allowedChannel && binding.revision === s.revision;
}
function metadataContext(s, epoch = operationEpoch) {
  if (!sameMetadataBinding(channelInfoBinding, s, epoch) || channelInfo?.channel !== s.allowedChannel) return null;
  const context = normalizeStreamContext(channelInfo.streamContext, s.allowedChannel, Date.now());
  return typeof context?.isLive === 'boolean' && (!context.isLive || context.streamId) ? context : null;
}
function chatStreamContext(s) {
  return chat.connected === true && chat.account === s.account && chat.channel === s.allowedChannel
    ? metadataContext(s) : null;
}
async function refreshChannelInfo(s) {
  const epoch = operationEpoch, context = metadataContext(s, epoch);
  if (context && Date.now() - context.checkedAt < 30_000) return channelInfo;
  if (metadataFlight && sameMetadataBinding(metadataFlight.binding, s, epoch)) {
    await metadataFlight.promise; return metadataContext(s, epoch) ? channelInfo : null;
  }
  const flight = { binding: metadataBinding(s, epoch), promise: null };
  flight.promise = (async () => {
    const info = await helper('/api/twitch/channel', { account: s.account, channel: s.allowedChannel }, s);
    const latest = await settings();
    const context = normalizeStreamContext(info?.streamContext, s.allowedChannel, Date.now());
    if (sameMetadataBinding(flight.binding, latest, epoch) && !latest.paused && info?.channel === s.allowedChannel
      && typeof context?.isLive === 'boolean' && (!context.isLive || context.streamId)) {
      channelInfo = info; channelInfoBinding = flight.binding;
    }
    return metadataContext(s, epoch) ? channelInfo : null;
  })();
  metadataFlight = flight;
  try { return await flight.promise; } finally { if (metadataFlight === flight) metadataFlight = null; }
}

function sendHoldReason(s) {
  const hold = chat.sendHold;
  return hold?.held === true && hold.account === s.account && hold.channel === s.allowedChannel ? hold.reason || 'Chat is held for this account and channel.' : '';
}

async function watchSendGate(s, automatic = false) {
  const held = sendHoldReason(s); if (held) return held;
  return playbackGate(s, automatic);
}

async function playbackGate(s, automatic = false) {
  if (watchTransition) return 'Waiting for chat to align with the stream tab.';
  const w = await watch.state();
  if (!w.enabled) return '';
  if (w.account !== s.account || w.channel !== s.allowedChannel) return 'The stream and chat channels do not match.';
  if (automatic && normalizeStreamContext(chat.streamContext, s.allowedChannel)?.isLive === false) return 'The stream is offline; waiting for live playback.';
  if (automatic && !['playing', 'ad'].includes(w.status)) return `Waiting for playback: ${w.status}.`;
  return '';
}

async function participationGate(s, proposal) {
  if (s.chatMode !== 'participate' || !s.autoReply) return 'Join the conversation is not enabled.';
  const tracked = await watch.state();
  if (!tracked.enabled) return 'Open Watch on Twitch to verify playback before automatic participation.';
  const reason = await watchSendGate(s, true);
  if (reason) return reason;
  const context = normalizeStreamContext(chat.streamContext, s.allowedChannel);
  if (context?.isLive === false) return 'The stream is offline; waiting for live playback.';
  if (!context?.isLive || !context.streamId) return 'Waiting for current live channel information.';
  if (proposal && proposal.streamId !== context.streamId) return 'The live broadcast changed before submission.';
  if (channelInfo?.sharedChat || channelInfo?.chatSettings?.emoteOnly || channelInfo?.chatSettings?.subscribersOnly) return 'The channel currently restricts automatic participation.';
  return '';
}

async function helper(path, body = {}, options, binding = controlBridge?.binding()) {
  const s = options || await settings();
  if (!s.pairingToken) throw new Error('Enter the local pairing token first.');
  if (path.startsWith('/api/director/') || ['/api/twitch/connect', '/api/twitch/send'].includes(path) || path === '/api/twitch/disconnect' && body.disarmOnly === true) body = { ...body, ...binding };
  const response = await fetch(`http://127.0.0.1:8796${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.pairingToken}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(path === '/api/compose' || path.startsWith('/api/director/') ? 40_000 : 12_000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Local helper returned ${response.status}.`);
  if (path !== '/api/control/bridge' && data.intent) await controlBridge?.adopt(data.intent);
  return data;
}

async function migrate() {
  let releaseMigration;
  migrationGate = new Promise(resolve => { releaseMigration = resolve; });
  try {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await controlBridge?.poll();
  const s = await settings();
  // Drop active v0.5 settings; retain historical records without executing them.
  await updateSettings(current => ({ autoReply: current.autoResume && !current.paused && current.autoReply }));
  const lastError = (await chrome.storage.local.get('lastError')).lastError;
  if (lastError?.message?.startsWith('Legacy permission')) await chrome.storage.local.set({ lastError: null });
  await chrome.storage.session.clear();
  if (s.paused || !s.autoResume) await watch.stop('Playback checks are off after restart.');
  else {
    const tracked = await watch.raw();
    if (tracked.enabled) await watch.patch({ checkedAt: 0, lastProgressAt: 0, documentId: '', status: 'checking', currentTime: 0, hasVideo: false }, tracked);
  }
  chat = { connected: false, messages: [], channel: '', account: '' };
  await chrome.alarms.clearAll();
  await chrome.alarms.create('companion-chat', { periodInMinutes: 0.5 });
  await chrome.alarms.create('companion-drops', { periodInMinutes: 5 });
  if (s.paused) await drops.stop('Companion is paused.');
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await helper('/api/twitch/disconnect', { disarmOnly: true }, s).catch(() => {});
  if (s.autoResume && !s.paused) { await watch.poll({ force: true }); await refreshChat().catch(() => {}); }
  } finally { releaseMigration(); migrationGate = null; }
  void controlBridge?.poll();
}
chrome.runtime.onInstalled.addListener(migrate);
chrome.runtime.onStartup.addListener(migrate);

async function refreshChat({ automatic = true } = {}) {
  const epoch = operationEpoch, refresh = ++chatRefreshSequence;
  const before = await settings();
  const current = s => refresh === chatRefreshSequence && epoch === operationEpoch && !s.paused
    && s.revision === before.revision && s.account === before.account && s.allowedChannel === before.allowedChannel;
  if (!current(before)) return chat;
  const playback = await watch.state();
  if (!current(before)) return chat;
  const context = !sendHoldReason(before) && before.chatMode === 'participate' && before.autoReply && !before.paused
    && playback.enabled && playback.account === before.account && playback.channel === before.allowedChannel
    && ['playing', 'ad'].includes(playback.status) && chat.channel === before.allowedChannel
    ? exchangeContext({ messages: chat.messages, account: before.account, channel: before.allowedChannel,
      streamContext: channelInfo?.streamContext, accounts: chat.coordination?.accounts || [] }) : null;
  const snapshot = await helper('/api/twitch/status', { observation: { channel: before.allowedChannel, paused: before.paused,
    autoReply: before.autoReply, chatMode: before.chatMode, exchangeContext: context,
    playback: { enabled: playback.enabled, channel: playback.channel, status: playback.status, checkedAt: playback.checkedAt } } });
  const after = await settings();
  if (!current(after)) return chat;
  // Publish helper connection truth immediately, with only still-valid metadata
  // owned by this exact setup. A slow metadata read must not erase that evidence.
  chat = { ...snapshot, messages: mergeMessages([], snapshot.messages || []) };
  chat.streamContext = chatStreamContext(after);
  if (chat.connected) {
    await refreshChannelInfo(after).catch(() => {});
    const latest = await settings();
    if (!current(latest)) return chat;
    chat.streamContext = chatStreamContext(latest);
    if (!sendHoldReason(latest)) await syncDirector(latest);
    else messageDirector = null;
    if (!current(await settings())) return chat;
    if (automatic) requestAutoReply(); await chrome.storage.session.set({ recovery: {} });
  }
  else requestRecovery();
  return chat;
}

async function importBrowser(s) {
  if (browserImported) return;
  if (!browserImportFlight) browserImportFlight = (async () => {
    const stored = await chrome.storage.local.get(['sent', 'participationAttempts', 'handled', 'directorImport']);
    const old = stored.directorImport;
    if (old?.account === s.account && old.complete === true) { browserImported = true; return; }
    if (old?.account && old.account !== s.account) throw Error('The central migration journal belongs to another account.');
    let pages = old?.pages;
    if (!Array.isArray(pages) || !pages.length) {
      pages = await importPages({ source: 'browser', account: s.account, history: stored.sent || [],
        participationAttempts: stored.participationAttempts || [], handled: stored.handled || [],
        preferences: { chatMode: s.chatMode, replySource: s.replySource } });
      await chrome.storage.local.set({ directorImport: { version: 1, account: s.account, pages, nextPage: 0, complete: false } });
    }
    for (const page of pages) {
      const current = await settings();
      if (current.account !== s.account) throw Error('Account changed during central history import.');
      await controlBridge.poll();
      const result = await helper('/api/director/import', { page, settingsRevision: current.revision }, current);
      if (!importAcknowledged(result, page)) throw Error('Central history import was not durably acknowledged.');
      await chrome.storage.local.set({ directorImport: page.final
        ? { version: 1, account: s.account, importId: page.importId, digest: page.digest, complete: true }
        : { version: 1, account: s.account, pages, nextPage: page.page + 1, complete: false } });
    }
    browserImported = true;
  })().finally(() => { browserImportFlight = null; });
  return browserImportFlight;
}
async function syncDirector(s) {
  await importBrowser(s);
  await controlBridge.poll();
  const current = await settings();
  if (current.revision !== s.revision || current.account !== s.account) return;
  const expectedBinding = directorBinding(controlBridge.binding(), current.revision);
  const response = await helper('/api/director/sync', { settingsRevision: current.revision }, current);
  const latest = await settings();
  if (latest.revision !== current.revision || latest.paused || !sameBinding(directorBinding(controlBridge.binding(), latest.revision), expectedBinding)) return;
  const value = response.director;
  if (!value || value.protocol !== 1 || typeof value.authorityEpoch !== 'string') throw Error('The central message controller is unavailable.');
  messageDirector = value;
  chat.coordination = { ...(chat.coordination || {}), director: value };
  const profile = value.profile;
  if (profile && ['mentions', 'participate'].includes(profile.chatMode) && ['local', 'ai'].includes(profile.replySource)
    && (profile.chatMode !== latest.chatMode || profile.replySource !== latest.replySource)) {
    await updateSettings({ chatMode: profile.chatMode, replySource: profile.replySource }, { expectedRevision: latest.revision });
    messageDirector = null;
  }
}
async function compose(mode, s, target, category) {
  const held = sendHoldReason(s); if (held) throw new Error(held);
  await importBrowser(s); await controlBridge.poll();
  const latest = await settings();
  const result = await helper('/api/director/draft', { requestId: crypto.randomUUID(), mode,
    ...(mode === 'phrase' ? { category } : {}), settingsRevision: latest.revision }, latest);
  if (!result.draft) throw Error(result.director?.reason || 'The central controller has no draft for this context.');
  return result.draft;
}
async function submit(text, target, category, offered, binding = controlBridge?.binding(), check = () => {}) {
  check();
  const epoch = operationEpoch;
  let s = await settings();
  if (s.paused) throw new Error('Companion is paused.');
  await refreshChat({ automatic: false }); check();
  const latest = await settings();
  if (latest.revision !== s.revision || epoch !== operationEpoch) throw Error('Setup changed before submission.');
  const held = sendHoldReason(s); if (held) throw Error(held);
  if (!offered) {
    const result = await helper('/api/director/manual', { requestId: crypto.randomUUID(), text,
      settingsRevision: s.revision }, s, binding);
    check(); offered = result.plan || result.director?.plan;
    if (result.director) messageDirector = result.director;
  }
  const currentBinding = directorBinding(binding, s.revision);
  const plan = directorOffer(offered, { account: s.account, channel: s.allowedChannel, binding: currentBinding,
    authorityEpoch: messageDirector?.authorityEpoch });
  if (!plan || plan.text !== text || await sha256(text) !== plan.exactKey) throw Error('An exact current central message command is required.');
  if (plan.source === 'automatic' && (messageDirector?.ready !== true || messageDirector?.plan?.planId !== plan.planId
    || messageDirector.plan.text !== text || !s.autoReply)) throw Error('The central automatic message is no longer current.');
  if (!chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) throw Error('Connect chat to the configured channel first.');
  const participation = plan.kind ? { key: plan.participationKey, kind: plan.kind, streamId: plan.streamId,
    ...(plan.kind === 'exchange' ? { exchangeId: plan.participationKey.slice('exchange:'.length) } : {}) } : null;
  target = plan.replyId ? chat.messages.find(x => x.id === plan.replyId && x.author.toLowerCase() === plan.replyAuthor
    && x.at === plan.replyAt && x.at <= Date.now() && Date.now() - x.at <= 45_000) : null;
  if (plan.replyId && !target) throw Error('The central reply target is no longer current.');
  const watchReason = participation ? await participationGate(s, participation) : await watchSendGate(s, plan.source === 'automatic');
  if (watchReason) throw Error(watchReason);
  if (plan.kind === 'exchange' && humanMessages(chat.messages, s.account, chat.coordination?.accounts || [])
    .some(x => x.at <= Date.now() && x.at > Date.now() - 90_000)) throw Error('Fresh human chat takes priority over the scheduled exchange.');
  const recent = (await chrome.storage.local.get('sent')).sent || [];
  const reason = sendGate({ channel: chat.channel, allowedChannel: s.allowedChannel, login: chat.account, expectedLogin: s.account, recent, text });
  if (reason) throw Error(reason);
  const intent = { participationKey: plan.participationKey, kind: plan.kind, streamId: plan.streamId,
    ...(participation?.exchangeId ? { exchangeId: participation.exchangeId } : {}) };
  const attempt = { at: Date.now(), account: s.account, channel: s.allowedChannel, text, delivery: 'pending', category: plan.category,
    planId: plan.planId, authorityEpoch: plan.authorityEpoch, ...(target ? { replyTo: plan.replyAuthor, replyId: plan.replyId } : {}), ...intent };
  const journal = (await chrome.storage.local.get('participationAttempts')).participationAttempts || [];
  if (participation && journal.some(x => x.key === participation.key && !(x.delivery === 'cancelled' && x.submitted === false))) throw Error('This contribution was already attempted.');
  const entry = participation && { key: participation.key, account: s.account, channel: s.allowedChannel,
    streamId: plan.streamId, kind: plan.kind, at: attempt.at, delivery: 'pending', submitted: false, planId: plan.planId };
  const currentBroadcast = x => entry && x.account === entry.account && x.channel === entry.channel && x.streamId === entry.streamId;
  const retained = entry ? [...journal.filter(x => x.kind !== 'conversation' && currentBroadcast(x)),
    ...journal.filter(x => x.kind !== 'conversation' && !currentBroadcast(x) && x.at > Date.now() - 14 * 86400_000).slice(-99),
    ...journal.filter(x => x.kind === 'conversation' && x.at > Date.now() - 86400_000).slice(-199)] : [];
  await chrome.storage.local.set({ sent: [...recent.filter(x => x.at > Date.now() - 3_600_000), attempt],
    ...(entry ? { participationAttempts: [...retained, entry] } : {}) });
  let result, submittedToHelper = false;
  try {
    const final = await settings(); check();
    if (final.paused || final.revision !== s.revision || epoch !== operationEpoch || plan.expiresAt <= Date.now()
      || !sameBinding(plan.binding, directorBinding(controlBridge.binding(), final.revision))) throw Error('Central message cancelled by Stop, expiry or changed setup.');
    const finalWatch = participation ? await participationGate(final, participation) : await watchSendGate(final, plan.source === 'automatic');
    if (finalWatch) throw Error(finalWatch);
    submittedToHelper = true;
    result = await helper('/api/twitch/send', { account: s.account, channel: s.allowedChannel, text,
      replyTo: plan.replyId, replyAuthor: plan.replyAuthor, category: plan.category, ...intent,
      planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding, settingsRevision: s.revision }, s, binding);
    Object.assign(attempt, { delivery: result.delivery, messageId: result.messageId, reason: result.reason });
    if (result.sendHold) chat.sendHold = result.sendHold;
    if (result.suppressed === true && result.submitted === false) { submittedToHelper = false; attempt.suppressed = true; }
    setActivity(attempt.suppressed ? 'waiting' : result.delivery === 'confirmed' ? 'sent' : 'error',
      attempt.suppressed ? result.reason : result.delivery === 'confirmed' ? 'Twitch confirmed the latest message.' : `Message ${result.delivery}; no automatic retry was made.`);
  } catch (error) { attempt.delivery = submittedToHelper ? 'unknown' : 'cancelled'; attempt.reason = error.message; throw error; }
  finally {
    const entries = (await chrome.storage.local.get('sent')).sent || [];
    const participationEntries = entry ? (await chrome.storage.local.get('participationAttempts')).participationAttempts || [] : [];
    await chrome.storage.local.set({ sent: attempt.suppressed ? entries.filter(x => x.at !== attempt.at) : entries.map(x => x.at === attempt.at ? attempt : x),
      ...(entry ? { participationAttempts: participationEntries.map(x => x.key === entry.key && x.at === entry.at ? { ...x, delivery: attempt.delivery, submitted: submittedToHelper } : x) } : {}) });
  }
  return result;
}

function panelSender(sender) {
  // Full-page extension controls and the side panel are both trusted. A Twitch
  // content script or another extension page cannot invoke these operations.
  return sender.id === chrome.runtime.id && ['panel.html', 'simple.html'].some(page => sender.url === `chrome-extension://${chrome.runtime.id}/${page}`);
}

async function handle(message) {
  if (message.type === 'pause') {
    const stop = helper('/api/twitch/disconnect').catch(() => {});
    await pauseLocal(); await stop;
    return { ok: true };
  }
  if (message.type === 'getState') {
    await watch.poll().catch(e => setActivity('error', e.message));
    let s = await settings(); let helperError = '';
    if (!s.paused && s.pairingToken) {
      try { await refreshChat(); } catch (e) { chat = { ...chat, connected: false, messages: [] }; helperError = e.message; }
    }
    s = await settings();
    const permissions = chrome.permissions?.getAll ? await chrome.permissions.getAll() : { permissions: [], origins: [] };
    return { settings: s, chat: { ...chat, digest: digest(chat.messages) }, watch: await watch.state(), activity, drops: await drops.state(), sent: (await chrome.storage.local.get('sent')).sent || [], helperError, permissions,
      lastError: (await chrome.storage.local.get('lastError')).lastError };
  }
  if (message.type === 'saveSettings') {
    const old = await settings(), m = message.settings || {};
    if (message.expectedRevision !== undefined && message.expectedRevision !== old.revision) throw new Error('Setup changed; start again when ready.');
    const next = { ...old, ...Object.fromEntries(Object.keys(defaults).filter(k => k in m).map(k => [k, m[k]])), revision: old.revision + 1 };
    for (const key of ['account', 'allowedChannel']) {
      next[key] = String(next[key] || '').trim().toLowerCase();
      if (next[key] && !/^[a-z0-9_]{3,25}$/.test(next[key])) throw new Error('Use account/channel logins without URLs.');
    }
    for (const key of ['pairingToken', 'clientId']) next[key] = String(next[key] || '').trim();
    if (!['local', 'ai'].includes(next.replySource)) throw new Error('Choose local or AI replies.');
    if (!['mentions', 'participate'].includes(next.chatMode)) throw new Error('Choose a supported chat mode.');
    next.paused = !!next.paused; next.autoReply = !!next.autoReply && !next.paused;
    next.autoResume = !!next.autoResume && !next.paused;
    const changed = ['account', 'allowedChannel', 'pairingToken', 'clientId'].some(k => old[k] !== next[k]);
    if (changed) next.chatMode = 'mentions';
    if (next.autoResume && (changed || !chat.connected || chat.account !== next.account || chat.channel !== next.allowedChannel)) throw new Error('Connect the configured account and channel before enabling away mode.');
    if (next.autoReply && (changed || !chat.connected || chat.account !== next.account || chat.channel !== next.allowedChannel)) throw new Error('Save setup and connect official Twitch chat before arming replies.');
    if (!changed && old.account && old.pairingToken && (next.chatMode !== old.chatMode || next.replySource !== old.replySource)) {
      await controlBridge.poll();
      const accepted = await helper('/api/director/preferences', { requestId: crypto.randomUUID(), settingsRevision: old.revision,
        chatMode: next.chatMode, replySource: next.replySource }, old);
      if (accepted.ok !== true) throw Error('Central message preferences could not be saved.');
    }
    if (next.paused || next.account !== old.account) await drops.stop(next.paused ? 'Companion is paused.' : 'Account changed. Enable claims for the new account explicitly.');
    await updateSettings(next, { expectedRevision: old.revision });
    if (changed || next.paused) {
      operationEpoch++; watchTransition = false;
      await watch.stop('Setup changed. Open the stream again to resume playback checks.');
      channelInfo = null;
      await helper('/api/twitch/disconnect', {}, old).catch(() => {});
      chat = { connected: false, messages: [], channel: '', account: '' };
    }
    return { ok: true };
  }
  const s = await settings();
  if (message.type === 'dropsDisable') { await drops.stop(); return { ok: true }; }
  if (message.type === 'dropsEnable') { const result = await drops.enable(); if (result.ok) void drops.run(); return result; }
  if (message.type === 'dropsCheck') { void drops.run({ reload: true }); return { ok: true }; }
  if (message.type === 'stopWatching') { operationEpoch++; watchTransition = false; await watch.stop('Playback checks stopped. The normal Twitch tab remains open.'); return { ok: true }; }
  if (message.type === 'openTwitch') {
    if (!/^[a-z0-9_]{3,25}$/.test(s.allowedChannel || '')) throw new Error('Save the Twitch channel login first.');
    // A normal, user-owned Twitch tab. Playback is handled entirely by Twitch.
    const tab = await chrome.tabs.create({ url: `https://www.twitch.tv/${s.allowedChannel}`, active: true });
    const access = await chrome.permissions?.contains?.({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] });
    if (!s.paused && access && Number.isInteger(tab?.id)) await watch.attach({ tabId: tab.id, channel: s.allowedChannel, account: s.account });
    return { ok: true, monitored: !s.paused && !!access };
  }
  if (message.type === 'connect') {
    const epochBeforeHandshake = operationEpoch, previousIntent = controlBridge?.intent;
    await controlBridge?.poll();
    if (epochBeforeHandshake !== operationEpoch && (previousIntent || controlBridge?.intent?.stopped)) throw new Error('Connect cancelled by Stop or changed setup.');
    const epoch = operationEpoch, current = await settings(), binding = controlBridge?.binding();
    const next = await updateSettings({ paused: false, autoReply: false, autoResume: false }, { expectedRevision: current.revision, epoch });
    await refreshChannelInfo(next).catch(() => {});
    if (epoch !== operationEpoch) throw new Error('Connect cancelled by Stop or changed setup.');
    return helper('/api/twitch/connect', { account: next.account, channel: next.allowedChannel, explicitStart: true }, next, binding);
  }
  if (s.paused) throw new Error('Companion is paused.');
  if (message.type === 'authorize') return helper('/api/twitch/authorize', { clientId: s.clientId, account: s.account }, s);
  if (message.type === 'authorization') return helper('/api/twitch/authorization', {}, s);
  if (message.type === 'disconnect') {
    operationEpoch++;
    watchTransition = false;
    await watch.stop('Chat disconnected. Playback checks stopped.');
    setActivity('waiting', 'Chat disconnected.');
    await drops.stop('Chat disconnected; automatic claims stopped.');
    await updateSettings({ autoReply: false, autoResume: false });
    await helper('/api/twitch/disconnect', {}, s); chat = { connected: false, messages: [], channel: '', account: '' }; return { ok: true };
  }
  if (message.type === 'pickPhrase') return compose('phrase', s, null, message.category);
  if (message.type === 'compose') {
    await refreshChat();
    if (!chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) throw new Error('Connect official Twitch chat first.');
    return compose(message.mode === 'summary' ? 'summary' : 'reply', s);
  }
  if (message.type === 'send') return submit(message.text);
  throw new Error('Unknown operation.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'watchQualityActive') {
    watch.qualityActive(message, sender).then(respond, () => respond(false));
    return true;
  }
  if (message.type === 'dropsPermit') { drops.authorize(message, sender).then(respond).catch(() => respond({ ok: false })); return true; }
  if (!panelSender(sender)) { respond({ error: 'This operation is only available from the extension panel.' }); return false; }
  const result = ['getState', 'compose', 'pause', 'disconnect', 'dropsDisable', 'stopWatching'].includes(message.type) ? handle(message) : locked(() => handle(message));
  result.then(respond).catch(e => respond({ error: e.message })); return true;
});

function requestAutoReply() {
  if (autoInFlight) return;
  autoInFlight = true;
  (async () => {
    const epoch = operationEpoch, s = await settings();
    if (!s.autoReply || s.paused || !chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) return;
    const held = sendHoldReason(s); if (held) { setActivity('waiting', held); return; }
    if (chat.coordination?.available === false || chat.coordination?.paused || messageDirector?.ready !== true) {
      setActivity('waiting', messageDirector?.reason || 'Central message authority is holding automatic chat.'); return;
    }
    const plan = directorOffer(messageDirector.plan, { account: s.account, channel: s.allowedChannel,
      binding: directorBinding(controlBridge.binding(), s.revision), authorityEpoch: messageDirector.authorityEpoch });
    if (!plan || plan.source !== 'automatic') { setActivity('waiting', messageDirector.reason || 'Waiting for a central message command.'); return; }
    await locked(async () => {
      const current = await settings();
      if (epoch !== operationEpoch || current.revision !== s.revision || current.paused || !current.autoReply) return;
      await submit(plan.text, undefined, plan.category, plan);
    });
  })().catch(error => { messageDirector = null; setActivity('error', error.message);
    return chrome.storage.local.set({ lastError: { at: Date.now(), message: error.message } }); }).finally(() => { autoInFlight = false; });
}

function requestRecovery() {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  const binding = controlBridge?.binding();
  locked(async () => {
    const s = await settings();
    if (await playbackGate(s)) return;
    if (s.paused || !(s.autoResume || s.autoReply) || chat.connected || chat.channel || chat.recoverable === false) return;
    if (!s.account || !s.allowedChannel || chat.account !== s.account) return;
    const recovery = (await chrome.storage.session.get('recovery')).recovery || {};
    if (recovery.nextAt > Date.now()) return;
    const attempts = Math.min(7, (recovery.attempts || 0) + 1);
    await chrome.storage.session.set({ recovery: { attempts, nextAt: Date.now() + Math.min(300_000, 5000 * 2 ** (attempts - 1)) } });
    const latest = await settings();
    if (latest.paused || latest.revision !== s.revision) return;
    await helper('/api/twitch/connect', { account: s.account, channel: s.allowedChannel }, s, binding);
  }).catch(e => chrome.storage.local.set({ lastError: { at: Date.now(), message: e.message } })).finally(() => { recoveryInFlight = false; });
}
chrome.alarms.onAlarm.addListener(async alarm => {
  await controlBridge?.poll();
  if (alarm.name === 'companion-drops') { await drops.run({ reload: true }); return; }
  if (alarm.name !== 'companion-chat') return;
  await watch.poll().catch(e => setActivity('error', e.message));
  const s = await settings();
  if (!s.paused && (s.autoReply || s.autoResume)) await refreshChat().catch(e => chrome.storage.local.set({ lastError: { at: Date.now(), message: e.message } }));
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => { void watch.handleTabUpdated(tabId, changeInfo, tab).catch(e => setActivity('error', e.message)); });
chrome.tabs?.onRemoved?.addListener(tabId => { void watch.handleTabRemoved(tabId).catch(e => setActivity('error', e.message)); });

async function pauseLocal(expectedGeneration) {
  const epoch = ++operationEpoch;
  const current = () => epoch === operationEpoch && (!expectedGeneration || controlBridge?.intent?.generation === expectedGeneration);
  watchTransition = false; messageDirector = null;
  await watch.stop('Companion is paused.');
  if (!current()) return;
  await drops.stop('Companion is paused.');
  if (!current()) return;
  await updateSettings({ paused: true, autoReply: false, autoResume: false }, { epoch });
  if (!current()) return;
  chat = { connected: false, messages: [], channel: '', account: '' };
  setActivity('waiting', 'Companion is paused.');
}

async function controlBrowserState() {
  const s = await settings();
  // Refresh native playback at the existing bridge cadence. A slow renderer
  // must not delay Stop or heartbeats; the next heartbeat reports actual evidence.
  if (!s.paused) void watch.poll().catch(e => setActivity('error', e.message));
  const [tracked, claims, stored, access] = await Promise.all([watch.state(), drops.state(), chrome.storage.local.get('sent'),
    chrome.permissions?.contains?.({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] }) || false]);
  const latest = await settings();
  return { settings: latest, chat: { ...chat, streamContext: chatStreamContext(latest), digest: digest(chat.messages) }, watch: tracked, activity, drops: claims,
    sent: stored.sent || [], permissions: { playbackAccess: access === true } };
}

async function openSelectedWatch(s, check = () => {}, reuse = false) {
  if (!/^[a-z0-9_]{3,25}$/.test(s.allowedChannel || '')) throw new Error('Save the Twitch channel login first.');
  check();
  if (reuse) {
    const tracked = await watch.raw(); check();
    if (tracked.enabled && tracked.account === s.account && tracked.channel === s.allowedChannel && Number.isInteger(tracked.tabId)) {
      let tab;
      try { tab = await chrome.tabs.get(tracked.tabId); } catch {}
      check();
      if (tab && new URL(tab.pendingUrl || tab.url).href.split('?')[0] === `https://www.twitch.tv/${s.allowedChannel}`) {
        if (chrome.tabs.update) await chrome.tabs.update(tab.id, { active: true });
        check();
        if (chrome.windows?.update && Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
        check(); return { ok: true, monitored: true };
      }
    }
  }
  const access = await chrome.permissions?.contains?.({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] });
  check();
  const tab = await chrome.tabs.create({ url: `https://www.twitch.tv/${s.allowedChannel}`, active: true }); check();
  if (!s.paused && access && Number.isInteger(tab?.id)) { await watch.attach({ tabId: tab.id, channel: s.allowedChannel, account: s.account }); check(); }
  if (chrome.windows?.update && Number.isInteger(tab?.windowId)) { check(); await chrome.windows.update(tab.windowId, { focused: true }); check(); }
  return { ok: true, monitored: !s.paused && !!access };
}

async function executeControl(command, check) {
  if (migrationGate) await migrationGate;
  check();
  const binding = { controlGeneration: command.generation, controlSessionId: controlBridge.sessionId, controlCommandId: command.id };
  if (command.action === 'stop') { await pauseLocal(command.generation); return { ok: true, reason: 'Stopped.' }; }
  if (command.action === 'start') {
    const epoch = ++operationEpoch;
    let s = await settings(), revision = s.revision;
    const verify = async () => { check(); const latest = await settings();
      if (epoch !== operationEpoch || latest.revision !== revision || latest.account !== s.account) throw new Error('Setup changed before Start completed.');
      return latest;
    };
    try {
      if (!await chrome.permissions?.contains?.({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] })) throw new Error('Allow Twitch playback access in the extension controls before starting from this page.');
      await verify();
      await watch.stop('Starting the selected channel.'); await verify();
      s = await updateSettings({ allowedChannel: command.params.channel, paused: false, autoReply: false, autoResume: false,
        chatMode: command.params.chatMode, replySource: command.params.replySource }, { expectedRevision: revision, epoch });
      revision = s.revision; await verify();
      await helper('/api/twitch/disconnect', { disarmOnly: true }, s, binding); await verify();
      chat = { connected: false, messages: [], channel: '', account: s.account }; channelInfo = null;
      const info = await helper('/api/twitch/channel', { account: s.account, channel: s.allowedChannel }, s); await verify();
      const offline = info.channel === s.allowedChannel && info.streamContext?.isLive === false;
      if (!info.canReply && !offline) throw new Error(info.reason || 'The selected live channel does not permit chat.');
      channelInfo = info; channelInfoBinding = metadataBinding(s, epoch);
      await helper('/api/twitch/connect', { account: s.account, channel: s.allowedChannel }, s, binding); await verify();
      for (let i = 0; i < 30; i++) {
        await refreshChat(); await verify();
        if (chat.error) throw new Error(chat.error);
        if (chat.connected) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) throw new Error('Chat did not connect to the selected account and channel.');
      const opened = await openSelectedWatch(s, check); await verify();
      if (!opened.monitored) throw new Error('Playback checks could not start.');
      s = await updateSettings({ chatMode: command.params.chatMode, replySource: command.params.replySource, autoReply: true,
        autoResume: command.params.autoResume }, { expectedRevision: revision, epoch });
      revision = s.revision; await verify();
      setActivity('waiting', offline ? `${info.reason || 'The stream is offline.'} Automatic chat is armed and waiting for live playback.`
        : 'Automatic chat is on. Waiting for live playback and a conversation opportunity.');
      return { ok: true, reason: activity.reason };
    } catch (error) {
      if (epoch === operationEpoch && controlBridge.intent?.generation === command.generation) {
        await pauseLocal(command.generation);
        await helper('/api/twitch/disconnect', { disarmOnly: true }, undefined, binding).catch(() => {});
      }
      throw error;
    }
  }
  if (command.action === 'watch') return openSelectedWatch(await settings(), check, true);
  if (command.action === 'settings') {
    const s = await settings(); check();
    if (s.paused) await updateSettings({ ...command.params, paused: true, autoReply: false }, { expectedRevision: s.revision });
    else await handle({ type: 'saveSettings', expectedRevision: s.revision, settings: command.params });
    check(); return { ok: true, reason: s.paused ? 'Settings saved. The companion remains stopped.' : 'Settings saved.' };
  }
  if (command.action === 'draft') {
    const result = await handle({ type: 'compose', mode: command.params.mode }); check();
    return { ok: true, text: result.text || result.summary || '', reason: result.reason || '' };
  }
  if (command.action === 'send') {
    const result = await locked(async () => { check(); return submit(command.params.text, undefined, undefined, undefined, binding, check); }); check();
    if (result.delivery !== 'confirmed') throw new Error(result.reason || `Message ${result.delivery}; no automatic retry was made.`);
    return { ok: true, text: command.params.text, reason: 'Twitch confirmed the message.' };
  }
  if (command.action === 'drops-enable') {
    check(); const result = await drops.enable(); check();
    if (!result.ok) throw new Error('Drop claims could not start.');
    void drops.run(); return { ok: true, reason: 'Automatic earned-drop checks are enabled.' };
  }
  if (command.action === 'drops-disable') { await drops.stop(); check(); return { ok: true, reason: 'Automatic drop claims are off.' }; }
  if (command.action === 'drops-check') { check(); await drops.run({ reload: true }); check(); return { ok: true, reason: (await drops.state()).status }; }
  throw new Error('Unsupported local control.');
}

controlBridge = new LocalControlBridge({ transport: input => helper('/api/control/bridge', input), state: controlBrowserState,
  execute: executeControl, onIntent: async intent => {
    if (intent.stopped) await pauseLocal(intent.generation);
    else operationEpoch++;
  } });
controlBridge.start();
void controlBridge.poll().then(async () => {
  const current = await settings();
  if (current.account && current.pairingToken) await importBrowser(current);
}).catch(error => { setActivity('waiting', error.message); });
