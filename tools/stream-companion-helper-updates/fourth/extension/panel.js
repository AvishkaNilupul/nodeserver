import { sendGate } from './core.js';
import { DROP_ACCESS } from './drops.js';
import { activitySummary } from './activity.js';
import { USA_ACCESS } from './usa-transport.js';
const $ = id => document.getElementById(id);
let current, initialized = false, pending = false, nextAuthPoll = 0;
async function call(message) {
  const data = await chrome.runtime.sendMessage(message);
  if (data?.error) throw new Error(data.error);
  return data;
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function showActivity() {
  const view = activitySummary(current);
  for (const [key, id] of [['playback', 'playbackStatus'], ['chat', 'chatActivity'], ['replies', 'replyActivity']]) {
    $(id).textContent = view[key].label;
    $(id).dataset.tone = view[key].tone;
    $(key === 'playback' ? 'playbackDetail' : `${id}Detail`).textContent = view[key].detail;
  }
  const last = view.latestConfirmed;
  $('latestReplyText').textContent = last?.text || 'No confirmed message yet.';
  $('latestReplyMeta').textContent = last ? `${new Date(last.at).toLocaleString()} · @${last.channel} · Twitch confirmed` : 'An enabled chat switch is not a sent message.';
  const attempt = view.latestAttempt;
  const delivery = { pending: 'Submitting a reply…', unknown: 'Last delivery is uncertain; it will not be retried.', rejected: 'Twitch rejected the last reply.', cancelled: 'The last reply was cancelled.' };
  $('latestAttemptState').textContent = attempt && attempt !== last && delivery[attempt.delivery]
    ? `${delivery[attempt.delivery]}${attempt.reason ? ` ${attempt.reason}` : ''}` : '';
}
function renderDraft(result) {
  $('draftTitle').textContent = result?.summary ? 'Chat catch-up' : result ? 'Reply preview' : 'Message';
  $('summaryText').textContent = result?.summary || ''; $('draft').hidden = !!result?.summary;
  $('draft').value = result?.text || ''; $('reason').textContent = result?.reason || '';
  $('send').hidden = !!result?.summary; render();
}
function render() {
  if (!current) return;
  const { settings: s, chat: c } = current;
  const text = $('draft').value;
  const reason = s.paused ? 'Companion is paused.' : !c.connected ? 'Connect official Twitch chat to send.' : !text.trim() ? 'Write a message first.' : sendGate({ channel: c.channel, allowedChannel: s.allowedChannel, login: c.account, expectedLogin: s.account, text, recent: current.sent });
  $('send').disabled = !!reason || pending; $('sendState').textContent = pending ? 'Working…' : reason || 'Ready to send through Twitch API.';
  $('messagePreview').textContent = text.trim();
  for (const key of ['summary', 'reply']) $(key).disabled = !c.connected || s.paused || pending;
  for (const key of ['pickPhrase', 'connect']) $(key).disabled = s.paused || pending;
  $('authorize').disabled = pending || !!current.usa && !current.usa.ready;
  $('autoReply').disabled = !c.connected || s.paused || pending;
  $('chatMode').disabled = pending;
  $('chatModeHelp').textContent = $('chatMode').value === 'participate'
    ? 'Join the conversation can greet and participate without an @mention. Direct mentions still take priority.'
    : 'Mentions only answers fresh direct @mentions.';
  $('autoResume').disabled = !c.connected || s.paused || pending;
  $('disconnect').disabled = !c.channel || pending;
  $('openTwitch').disabled = !s.allowedChannel || pending;
  $('openTwitch').textContent = s.allowedChannel ? `Watch @${s.allowedChannel} on Twitch` : 'Watch on Twitch';
  $('stopWatching').disabled = !current.watch?.enabled;
  $('authorization').disabled = !nextAuthPoll || Date.now() < nextAuthPoll || pending || !!current.usa && !current.usa.ready;
  $('dropsEnable').disabled = pending || s.paused || !s.account || current.drops?.enabled;
  $('dropsDisable').disabled = !current.drops?.enabled;
  $('dropsCheck').disabled = pending || !current.drops?.enabled;
}
async function refresh() {
  const previous = current; current = await call({ type: 'getState' });
  const { settings: s, chat: c } = current;
  for (const key of ['account', 'allowedChannel', 'pairingToken', 'replySource', 'clientId', 'chatMode']) {
    const fallback = key === 'chatMode' ? 'mentions' : '';
    if (!initialized || $(key).value === (previous?.settings[key] || fallback)) $(key).value = s[key] || fallback;
  }
  if (!initialized) {
    $('autoReply').checked = s.autoReply; $('autoResume').checked = !!s.autoResume; initialized = true;
  }
  if (previous?.settings.autoReply !== s.autoReply) $('autoReply').checked = s.autoReply;
  if (previous?.settings.autoResume !== s.autoResume) $('autoResume').checked = !!s.autoResume;
  $('pause').textContent = s.paused ? 'Resume companion' : 'Pause companion';
  const grants = current.permissions;
  $('permissionState').textContent = grants?.permissions?.includes('debugger') ? 'Chrome still retains legacy debugger access.' : grants?.origins?.some(x => x.includes('twitch.tv')) ? 'Twitch access is enabled for the selected stream’s playback checks and the separate Drops inventory.' : 'Watching works on Twitch normally. Playback checks and Drop claims use optional Twitch access.';
  const usa = current.usa;
  $('usaState').textContent = usa?.ready && usa.country === 'US' ? `USA connection ready · US${usa.lastCheckAt ? ` · Checked ${new Date(usa.lastCheckAt).toLocaleTimeString()}` : ''}` : `${usa?.heldReason || 'Enable USA & Twitch access to verify the connection.'}${usa?.lastCheckAt ? ` Last checked ${new Date(usa.lastCheckAt).toLocaleTimeString()}.` : ''}`;
  $('enableUsa').disabled = pending;
  $('connection').textContent = s.paused ? 'Paused' : !c.connected ? 'Draft mode · chat disconnected' : s.autoReply ? `Automatic chat on · ${s.chatMode === 'participate' ? 'joining the conversation' : 'mentions only'}` : 'Chat connected · manual send';
  $('chatState').textContent = current.helperError || c.error || (c.connected ? `Connected as @${c.account} to @${c.channel}.` : c.channel ? 'Connecting to Twitch chat…' : 'Chat is disconnected. Authorize the account, then connect chat.');
  $('stats').textContent = c.connected ? `@${c.channel} · ${c.digest.messages} messages · ${c.digest.people} people` : 'Connect Twitch chat to receive messages.';
  $('topics').replaceChildren(...(c.digest.topics || []).map(text => { const el = document.createElement('span'); el.textContent = text; return el; }));
  $('chat').replaceChildren(...c.messages.slice(-30).map(m => { const el = document.createElement('div'); el.className = 'line'; const author = document.createElement('strong'); author.textContent = m.author; el.append(author, document.createTextNode(m.text)); return el; }));
  $('history').replaceChildren(...current.sent.slice(-8).reverse().map(x => { const el = document.createElement('p'); el.textContent = `${new Date(x.at).toLocaleTimeString()} · @${x.channel} · ${x.delivery}: ${x.text}`; return el; }));
  if (!current.sent.length) $('history').textContent = 'No messages submitted.';
  showActivity();
  const d = current.drops || {};
  $('dropsState').textContent = `${d.enabled ? 'Automatic claims on. ' : ''}${d.status || 'Automatic claims are off.'}${d.lastCheck ? ` Last checked ${new Date(d.lastCheck).toLocaleTimeString()}.` : ''}`;
  $('dropsBadge').textContent = d.enabled ? 'On' : 'Off';
  $('dropsHistory').replaceChildren(...(d.history || []).slice(-8).reverse().map(x => { const el = document.createElement('p'); el.textContent = `${x.name} · ${x.delivery}${x.reason ? ` · ${x.reason}` : ''}`; return el; }));
  $('lastError').textContent = current.lastError ? `${Date.now() - current.lastError.at > 120_000 ? 'Earlier issue' : 'Latest recorded issue'} (${new Date(current.lastError.at).toLocaleString()}): ${current.lastError.message}` : '';
  render();
}
async function save(paused = current.settings.paused) {
  const settings = { paused, autoReply: $('autoReply').checked, autoResume: $('autoResume').checked };
  for (const key of ['account', 'allowedChannel', 'pairingToken', 'replySource', 'clientId', 'chatMode']) settings[key] = $(key).value;
  await call({ type: 'saveSettings', settings });
}
async function run(fn) {
  if (pending) return; pending = true; render();
  try { await fn(); } catch (e) { status(e.message, true); }
  finally { pending = false; await refresh().catch(e => status(e.message, true)); }
}
$('enableUsa').addEventListener('click', () => {
  if (pending) return;
  // Chrome requires this optional permission request within the native click.
  const grant = chrome.permissions?.request ? chrome.permissions.request(USA_ACCESS) : Promise.resolve(false);
  void run(async () => {
    if (!await grant) { status('USA access was not granted. The connection stays held.'); return; }
    await call({ type: 'usaStatus' }); status('Checking the USA connection. Chat stays stopped.');
  });
});
$('save').addEventListener('click', () => run(async () => { await save(); status('Setup saved.'); }));
$('pause').addEventListener('click', async () => {
  if (current.settings.paused) return run(async () => { await call({ type: 'saveSettings', settings: { paused: false, autoReply: false, autoResume: false } }); status('Resumed in draft mode.'); });
  // Stop remains usable during slow model, connection, and send requests.
  try { await call({ type: 'pause' }); await refresh(); status('Paused and disconnected.'); }
  catch (e) { status(e.message, true); }
});
$('authorize').addEventListener('click', () => run(async () => {
  $('autoReply').checked = false; $('autoResume').checked = false; await save();
  const result = await call({ type: 'authorize' });
  nextAuthPoll = Date.now() + result.pollAfterMs;
  $('authLink').href = result.verificationUrl; $('authLink').hidden = false;
  $('authState').textContent = `Open Twitch authorization and enter ${result.userCode} if requested. Sign in as @${current.settings.account}, then click I authorized it.`;
  status('Twitch authorization is ready.');
}));
$('authorization').addEventListener('click', () => run(async () => {
  const result = await call({ type: 'authorization' });
  if (result.pending) { nextAuthPoll = Date.now() + result.pollAfterMs; status('Twitch is still waiting for authorization.'); }
  else { nextAuthPoll = 0; $('authLink').hidden = true; $('authState').textContent = `Authorized as @${result.account}.`; status('Account authorized. Connect chat next.'); }
}));
$('connect').addEventListener('click', () => run(async () => { $('autoReply').checked = false; $('autoResume').checked = false; await save(); await call({ type: 'connect' }); status('Connecting to official Twitch chat.'); }));
$('disconnect').addEventListener('click', () => run(async () => { await call({ type: 'disconnect' }); status('Chat disconnected.'); }));
$('openTwitch').addEventListener('click', () => {
  if (pending) return;
  const grants = current.permissions;
  const hasAccess = grants?.permissions?.includes('scripting') && grants?.origins?.includes('https://www.twitch.tv/*');
  // Keep an optional permission request inside the actual button gesture.
  const grant = hasAccess ? Promise.resolve(true) : chrome.permissions?.request ? chrome.permissions.request(DROP_ACCESS) : Promise.resolve(false);
  void run(async () => {
    const allowed = await grant;
    const result = await call({ type: 'openTwitch' });
    status(result.monitored ? 'Opened Twitch. Playback checks apply to this stream tab.'
      : current.settings.paused ? 'Opened Twitch. Resume the companion, then use Watch on Twitch to start playback checks.'
      : !allowed ? 'Opened Twitch. Playback checks need Twitch access.' : 'Opened Twitch. Playback checks are off.');
  });
});
$('stopWatching').addEventListener('click', async () => {
  try { await call({ type: 'stopWatching' }); await refresh(); status('Playback checks stopped. Twitch video continues independently.'); }
  catch (e) { status(e.message, true); }
});
$('dropsEnable').addEventListener('click', () => {
  if (pending || current.settings.paused) return;
  // The request must start directly inside the real click's user gesture.
  const grant = chrome.permissions.request(DROP_ACCESS);
  void run(async () => { if (!await grant) { status('Inventory access was not granted. Automatic claims remain off.'); return; } await call({ type: 'dropsEnable' }); status('Automatic earned-drop claims enabled.'); });
});
$('dropsDisable').addEventListener('click', async () => {
  try { await call({ type: 'dropsDisable' }); await refresh(); status('Automatic claims stopped.'); }
  catch (e) { status(e.message, true); }
});
$('dropsCheck').addEventListener('click', () => run(async () => { await call({ type: 'dropsCheck' }); status('Checking the inventory…'); }));
$('manual').addEventListener('click', () => { renderDraft(null); $('draft').focus(); });
$('pickPhrase').addEventListener('click', () => run(async () => { renderDraft(await call({ type: 'pickPhrase', category: $('phraseCategory').value })); status('Local preview ready.'); }));
$('draft').addEventListener('input', render);
$('chatMode').addEventListener('change', render);
for (const mode of ['reply', 'summary']) $(mode).addEventListener('click', () => run(async () => { const result = await call({ type: 'compose', mode }); renderDraft(result); status(result.text ? 'Reply ready for review.' : result.summary ? 'Catch-up ready.' : result.reason || 'Staying quiet.'); }));
$('send').addEventListener('click', () => run(async () => { const result = await call({ type: 'send', text: $('draft').value }); status(result.delivery === 'confirmed' ? 'Twitch confirmed the message was sent.' : result.delivery === 'rejected' ? `Twitch rejected the message: ${result.reason}.` : 'Delivery is uncertain; it will not be retried.'); }));
await refresh().catch(e => status(e.message, true));
setInterval(() => { if (!pending) refresh().catch(e => status(e.message, true)); }, 2000);
