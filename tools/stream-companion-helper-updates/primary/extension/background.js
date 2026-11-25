import { mergeMessages, replyOpportunity, digest, sendGate, localSummary } from './core.js';
import { localReply, pickPhrase } from './replies.js';
import { DropClaims } from './drops.js';
import { WatchSession } from './watch.js';
import { planParticipation, planExchange, exchangeContext, humanMessages } from './participation.js';
import { normalizeStreamContext } from './replies.js';
import { exchangeOffer } from './exchange.js';
import { LocalControlBridge } from './local-control.js';

const defaults = { account: '', allowedChannel: '', autoReply: false, autoResume: false, chatMode: 'mentions', replySource: 'local', pairingToken: '', paused: false, clientId: '' };
let serial = Promise.resolve(), autoInFlight = false, recoveryInFlight = false, operationEpoch = 0;
let controlBridge, migrationGate = null;
const preparedDrafts = new Map();
function prunePreparedDrafts(s) {
  const now = Date.now();
  for (const [key, entry] of preparedDrafts) if (entry.epoch !== operationEpoch || entry.revision !== s.revision
    || entry.account !== s.account || entry.channel !== s.allowedChannel || now < entry.targetAt || now - entry.targetAt > 45_000) preparedDrafts.delete(key);
}
const draftKey = (s, target) => `${operationEpoch}:${s.revision}:${s.account}:${s.allowedChannel}:${target.id}`;
function preparedReply(s, target) {
  prunePreparedDrafts(s);
  const entry = preparedDrafts.get(draftKey(s, target));
  return entry && entry.targetAt === target.at && entry.author === target.author.toLowerCase() && entry.body === target.text ? entry.draft : null;
}
function rememberPreparedReply(s, target, result) {
  prunePreparedDrafts(s);
  const key = draftKey(s, target);
  if (!preparedDrafts.has(key) && preparedDrafts.size >= 32) preparedDrafts.delete(preparedDrafts.keys().next().value);
  preparedDrafts.set(key, { epoch: operationEpoch, revision: s.revision, account: s.account, channel: s.allowedChannel,
    targetAt: target.at, author: target.author.toLowerCase(), body: target.text,
    draft: { text: result.text, category: result.category || '', reason: result.reason || '', source: result.source || '' } });
}
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
    preparedDrafts.clear();
    return next;
  });
  settingsSerial = result.catch(() => {});
  return result;
}
let chat = { connected: false, messages: [], channel: '', account: '' };
const drops = new DropClaims(chrome, settings);
let activity = { state: 'waiting', reason: 'Waiting for a direct mention.', at: Date.now() };
let channelInfo = null, metadataFlight = null, watchTransition = false;
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
      channelInfo = info;
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

async function refreshChannelInfo(s) {
  if (channelInfo?.channel === s.allowedChannel && Date.now() - channelInfo.checkedAt < 30_000) return channelInfo;
  if (metadataFlight) { await metadataFlight; return channelInfo?.channel === s.allowedChannel ? channelInfo : null; }
  const epoch = operationEpoch;
  metadataFlight = (async () => {
    const info = await helper('/api/twitch/channel', { account: s.account, channel: s.allowedChannel }, s);
    const latest = await settings();
    if (epoch === operationEpoch && latest.account === s.account && latest.allowedChannel === s.allowedChannel && info.channel === s.allowedChannel) channelInfo = info;
    return channelInfo;
  })();
  try { return await metadataFlight; } finally { metadataFlight = null; }
}

async function watchSendGate(s, automatic = false) {
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
  if (['/api/twitch/connect', '/api/twitch/send'].includes(path) || path === '/api/twitch/disconnect' && body.disarmOnly === true) body = { ...body, ...binding };
  const response = await fetch(`http://127.0.0.1:8792${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.pairingToken}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(path === '/api/compose' ? 40_000 : 12_000)
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

async function refreshChat() {
  const epoch = operationEpoch;
  const before = await settings();
  const playback = await watch.state();
  const context = before.chatMode === 'participate' && before.autoReply && !before.paused
    && playback.enabled && playback.account === before.account && playback.channel === before.allowedChannel
    && ['playing', 'ad'].includes(playback.status) && chat.channel === before.allowedChannel
    ? exchangeContext({ messages: chat.messages, account: before.account, channel: before.allowedChannel,
      streamContext: channelInfo?.streamContext, accounts: chat.coordination?.accounts || [] }) : null;
  const snapshot = await helper('/api/twitch/status', { observation: { channel: before.allowedChannel, paused: before.paused,
    autoReply: before.autoReply, chatMode: before.chatMode, exchangeContext: context,
    playback: { enabled: playback.enabled, channel: playback.channel, status: playback.status, checkedAt: playback.checkedAt } } });
  const after = await settings();
  if (epoch !== operationEpoch || after.paused || before.revision !== after.revision) return chat;
  chat = { ...snapshot, messages: mergeMessages([], snapshot.messages || []) };
  if (chat.connected) {
    await refreshChannelInfo(after).catch(() => {});
    const latest = await settings();
    if (epoch !== operationEpoch || latest.paused || latest.revision !== after.revision) return chat;
    chat.streamContext = channelInfo?.channel === chat.channel ? channelInfo.streamContext : null;
    requestAutoReply(); await chrome.storage.session.set({ recovery: {} });
  }
  else requestRecovery();
  return chat;
}

async function compose(mode, s, target) {
  const recent = (await chrome.storage.local.get('sent')).sent || [];
  if (mode === 'summary' && s.replySource === 'local') return localSummary(chat.messages, chat.channel);
  if (mode === 'reply' && s.replySource === 'local') return localReply({ messages: chat.messages, account: s.account, channel: chat.channel, target, recent, streamContext: chat.streamContext, excludedKeys: chat.coordination?.textKeys || [] });
  return helper('/api/compose', { mode, channel: chat.channel, account: s.account, messages: chat.messages, target, streamContext: chat.streamContext, recentReplies: recent.filter(x => x.channel === chat.channel) }, s);
}

async function submit(text, target, category, participation, binding = controlBridge?.binding(), check = () => {}) {
  check();
  const epoch = operationEpoch;
  const s = await settings();
  if (s.paused) throw new Error('Companion is paused.');
  await refreshChat();
  check();
  if (!chat.connected || chat.channel !== s.allowedChannel) throw new Error('Connect chat to the configured channel first.');
  const watchReason = participation ? await participationGate(s, participation) : await watchSendGate(s, !!target);
  if (watchReason) throw new Error(watchReason);
  const recent = (await chrome.storage.local.get('sent')).sent || [];
  const reason = sendGate({ channel: chat.channel, allowedChannel: s.allowedChannel, login: chat.account, expectedLogin: s.account, recent, text });
  if (reason) throw new Error(reason);
  const intent = participation ? { participationKey: participation.key, kind: participation.kind, streamId: participation.streamId,
    ...(participation.kind === 'exchange' ? { exchangeId: participation.exchangeId } : {}) } : {};
  const attempt = { at: Date.now(), account: s.account, channel: s.allowedChannel, text, delivery: 'pending', category: category || '', ...(target ? { replyTo: target.author } : {}), ...intent };
  const journal = (await chrome.storage.local.get('participationAttempts')).participationAttempts || [];
  if (participation && journal.some(x => x.key === participation.key && !(x.delivery === 'cancelled' && x.submitted === false))) throw new Error('This contribution was already attempted.');
  if (participation) {
    const handled = (await chrome.storage.local.get('handled')).handled || [];
    const mention = replyOpportunity(humanMessages(chat.messages, s.account, chat.coordination?.accounts || []), s.account);
    const freshMention = mention?.id && !handled.includes(`${s.account}:${s.allowedChannel}:${mention.id}`);
    const planInput = { messages: chat.messages, account: s.account, channel: s.allowedChannel,
      streamContext: chat.streamContext, recent, attempts: journal, coordination: chat.coordination };
    const humanPlan = participation.kind === 'exchange' && planParticipation({ ...planInput,
      coordination: { ...chat.coordination, exchange: undefined } });
    // Exchanges are exact host-authored offers, not generated greeting/topic
    // plans. Fresh supported public conversation still takes priority.
    const currentPlan = participation.kind === 'exchange' ? planExchange(planInput) : planParticipation(planInput);
    if (freshMention || humanPlan?.kind === 'conversation' || currentPlan?.key !== participation.key
      || currentPlan?.exchangeId !== participation.exchangeId || (!target && currentPlan?.text !== text)) {
      setActivity('waiting', freshMention ? 'A fresh direct mention takes priority.' : 'The conversation changed; checking again.');
      return { delivery: 'cancelled', reason: activity.reason };
    }
  }
  const entry = participation && { key: participation.key, account: s.account, channel: s.allowedChannel, streamId: participation.streamId, kind: participation.kind, at: attempt.at, delivery: 'pending', submitted: false };
  // Keep greeting/topic tombstones for this broadcast even in a long session;
  // chat-message entries may roll over because their targets expire in 45s.
  const currentBroadcast = x => entry && x.account === entry.account && x.channel === entry.channel && x.streamId === entry.streamId;
  const retained = entry ? [
    ...journal.filter(x => x.kind !== 'conversation' && currentBroadcast(x)),
    ...journal.filter(x => x.kind !== 'conversation' && !currentBroadcast(x) && x.at > Date.now() - 14 * 86400_000).slice(-99),
    ...journal.filter(x => x.kind === 'conversation' && x.at > Date.now() - 86400_000).slice(-199)
  ] : [];
  await chrome.storage.local.set({ sent: [...recent.filter(x => x.at > Date.now() - 3_600_000), attempt], ...(entry ? { participationAttempts: [...retained, entry] } : {}) });
  let result, submittedToHelper = false;
  try {
    const latest = await settings();
    if (latest.paused || latest.revision !== s.revision || epoch !== operationEpoch) throw new Error('Setup changed before submission.');
    const finalWatchReason = participation ? await participationGate(latest, participation) : await watchSendGate(latest, !!target);
    check();
    if (finalWatchReason || epoch !== operationEpoch) throw new Error(finalWatchReason || 'The stream changed before submission.');
    if (participation?.kind === 'exchange') {
      const current = exchangeOffer(chat.coordination?.exchange, { account: latest.account, channel: latest.allowedChannel,
        streamId: participation.streamId, accounts: chat.coordination?.accounts || [] });
      if (!current || current.id !== participation.exchangeId || current.key !== participation.key || current.text !== text
        || chat.coordination?.paused || chat.coordination?.available === false) throw new Error('The scheduled companion exchange is no longer current.');
    }
    submittedToHelper = true;
    result = await helper('/api/twitch/send', { account: s.account, channel: s.allowedChannel, text, replyTo: target?.id || '', replyAuthor: target?.author || '', category: category || '', ...intent }, s, binding);
    Object.assign(attempt, { delivery: result.delivery, messageId: result.messageId, reason: result.reason });
    // Explicit suppression certifies that no Twitch send request was made.
    if (result.suppressed === true && result.submitted === false) { submittedToHelper = false; attempt.suppressed = true; }
    setActivity(attempt.suppressed ? 'waiting' : result.delivery === 'confirmed' ? 'sent' : 'error', attempt.suppressed ? result.reason : result.delivery === 'confirmed' ? 'Twitch confirmed the latest reply.' : `Message ${result.delivery}${result.reason ? `: ${result.reason}` : '.'}`);
  } catch (e) { attempt.delivery = submittedToHelper ? 'unknown' : 'cancelled'; attempt.reason = e.message; throw e; }
  finally {
    const entries = (await chrome.storage.local.get('sent')).sent || [];
    const participationEntries = entry ? (await chrome.storage.local.get('participationAttempts')).participationAttempts || [] : [];
    await chrome.storage.local.set({ sent: attempt.suppressed ? entries.filter(x => x.at !== attempt.at) : entries.map(x => x.at === attempt.at ? attempt : x), ...(entry ? { participationAttempts: participationEntries.map(x => x.key === entry.key && x.at === entry.at ? { ...x, delivery: attempt.delivery, submitted: submittedToHelper } : x) } : {}) });
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
  if (message.type === 'pickPhrase') return pickPhrase({ category: message.category, recent: (await chrome.storage.local.get('sent')).sent || [], excludedKeys: chat.coordination?.textKeys || [] });
  if (message.type === 'compose') {
    await refreshChat();
    if (!chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) throw new Error('Connect official Twitch chat first.');
    const target = replyOpportunity(chat.messages, s.account);
    return compose(message.mode === 'summary' ? 'summary' : 'reply', s, target);
  }
  if (message.type === 'send') return submit(message.text);
  throw new Error('Unknown operation.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'dropsPermit') { drops.authorize(message, sender).then(respond).catch(() => respond({ ok: false })); return true; }
  if (!panelSender(sender)) { respond({ error: 'This operation is only available from the extension panel.' }); return false; }
  const result = ['getState', 'compose', 'pause', 'disconnect', 'dropsDisable', 'stopWatching'].includes(message.type) ? handle(message) : locked(() => handle(message));
  result.then(respond).catch(e => respond({ error: e.message })); return true;
});

function requestAutoReply() {
  if (autoInFlight) return;
  autoInFlight = true;
  (async () => {
    const epoch = operationEpoch;
    const s = await settings();
    prunePreparedDrafts(s);
    if (!s.autoReply || s.paused || !chat.connected || chat.account !== s.account || chat.channel !== s.allowedChannel) return;
    if (chat.coordination?.available === false || chat.coordination?.paused) { setActivity('waiting', chat.coordination.reason || 'Central host is holding automatic chat.'); return; }
    const watchReason = await watchSendGate(s, true);
    if (watchReason) { setActivity('waiting', watchReason); return; }
    const handled = (await chrome.storage.local.get('handled')).handled || [];
    let target = replyOpportunity(humanMessages(chat.messages, s.account, chat.coordination?.accounts || []), s.account);
    if (target && (chat.coordination?.accounts || []).includes(target.author.toLowerCase())) target = null;
    let key = target?.id ? `${s.account}:${s.allowedChannel}:${target.id}` : '';
    if (!key || handled.includes(key)) target = null;
    const recent = (await chrome.storage.local.get('sent')).sent || [];
    let participation = null;
    if (!target && s.chatMode === 'participate') {
      const participationReason = await participationGate(s);
      if (participationReason) { setActivity('waiting', participationReason); return; }
      const attempts = (await chrome.storage.local.get('participationAttempts')).participationAttempts || [];
      participation = planParticipation({ messages: chat.messages, account: s.account, channel: s.allowedChannel, streamContext: chat.streamContext, recent, attempts, coordination: chat.coordination });
      if (!participation.kind) { setActivity('waiting', participation.reason || 'Waiting for a useful conversation opportunity.'); return; }
      target = participation.target || null;
      key = participation.key;
    }
    if (!target && !participation) { setActivity('waiting', 'Waiting for a fresh direct mention.'); return; }
    const reason = sendGate({ channel: chat.channel, allowedChannel: s.allowedChannel, login: chat.account, expectedLogin: s.account, text: 'preview', recent });
    if (reason) { setActivity('waiting', reason); return; }
    // Consume targeted generation once. Only a proven no-Twitch transient host
    // hold releases this target; its prepared draft survives until original expiry.
    if (target) {
      const targetKey = `${s.account}:${s.allowedChannel}:${target.id}`;
      if (handled.includes(targetKey)) return;
      await chrome.storage.local.set({ handled: [...handled.slice(-119), targetKey] });
    }
    setActivity('generating', target ? `Preparing a reply to @${target.author}.` : participation.reason);
    const result = target ? preparedReply(s, target) || await compose('reply', s, target) : participation;
    if (target && result.text && epoch === operationEpoch) rememberPreparedReply(s, target, result);
    if (!result.text) setActivity('no_match', result.reason || 'No useful contribution for this conversation.');
    await locked(async () => {
      const latest = await settings();
      if (epoch !== operationEpoch || latest.revision !== s.revision || latest.paused || !latest.autoReply || (target && Date.now() - target.at > 45_000)) return;
      if (result.text) {
        const outcome = await submit(result.text, target, result.category, participation);
        const stillCurrent = await settings();
        const fresh = target && target.at <= Date.now() && Date.now() - target.at <= 45_000;
        if (fresh && outcome?.suppressed === true && outcome.submitted === false && outcome.retryable === true
          && epoch === operationEpoch && stillCurrent.revision === s.revision && !stillCurrent.paused) {
          const targetKey = `${s.account}:${s.allowedChannel}:${target.id}`;
          const currentHandled = (await chrome.storage.local.get('handled')).handled || [];
          await chrome.storage.local.set({ handled: currentHandled.filter(x => x !== targetKey) });
        } else if (target) preparedDrafts.delete(draftKey(s, target));
      }
    });
  })().catch(e => { preparedDrafts.clear(); setActivity('error', e.message); return chrome.storage.local.set({ lastError: { at: Date.now(), message: e.message } }); }).finally(() => { autoInFlight = false; });
}

function requestRecovery() {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  const binding = controlBridge?.binding();
  locked(async () => {
    const s = await settings();
    if (await watchSendGate(s)) return;
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
  watchTransition = false; preparedDrafts.clear();
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
  return { settings: s, chat: { ...chat, digest: digest(chat.messages) }, watch: tracked, activity, drops: claims,
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
      channelInfo = info;
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
void controlBridge.poll();
