import { channelFromUrl } from './core.js';
import { activitySummary } from './activity.js';
import { DROP_ACCESS } from './drops.js';
const $ = id => document.getElementById(id);
let current, pending = false, generation = 0, initialized = false, previousChannel = '';
async function call(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
function notice(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function channelLogin(value) {
  const raw = value.trim();
  const login = /^https?:\/\//i.test(raw) ? channelFromUrl(raw) : raw.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new Error('Enter a Twitch channel name or channel URL.');
  return login;
}
function render() {
  if (!current) return;
  const s = current.settings, view = activitySummary(current);
  $('start').disabled = pending || !s.account || !s.pairingToken;
  $('channel').disabled = pending;
  $('start').textContent = pending ? 'Starting…' : 'Start chatting';
  $('account').textContent = s.account ? `Chatting as @${s.account} · ${s.replySource === 'ai' ? 'AI replies' : 'Local replies'}` : 'Finish account setup in Advanced controls first.';
  for (const [id, item] of [['activity', view.replies], ['playback', view.playback]]) {
    $(id).textContent = item.label; $(id).dataset.tone = item.tone; $(`${id}Detail`).textContent = item.detail;
  }
  $('connection').textContent = `${view.chat.label}. ${view.chat.detail}`;
  const history = (current.sent || []).filter(x => x.channel === s.allowedChannel).sort((a,b) => b.at - a.at);
  const last = history.find(x => x.delivery === 'confirmed');
  $('lastMessage').textContent = last?.text || 'No confirmed message yet.';
  $('lastMeta').textContent = last ? `@${last.channel} · ${new Date(last.at).toLocaleString()} · Twitch confirmed` : '';
  const attempt = history[0];
  $('attempt').textContent = attempt && attempt.delivery !== 'confirmed' ? `Latest attempt: ${attempt.delivery}${attempt.reason ? ` · ${attempt.reason}` : ''}` : '';
  if (!initialized || $('channel').value === previousChannel) $('channel').value = s.allowedChannel || '';
  initialized = true; previousChannel = s.allowedChannel || '';
  const channels = [...new Set([s.allowedChannel, ...(current.sent || []).map(x => x.channel)].filter(Boolean))];
  $('channels').replaceChildren(...channels.map(value => { const option = document.createElement('option'); option.value = value; return option; }));
}
async function refresh() { current = await call({ type: 'getState' }); render(); }
$('start').addEventListener('click', () => {
  if (pending || !current) return;
  let channel;
  try { channel = channelLogin($('channel').value); } catch (e) { notice(e.message, true); return; }
  // Begin the optional permission request in the actual click gesture.
  const access = chrome.permissions.request(DROP_ACCESS);
  const token = ++generation, account = current.settings.account;
  const check = () => { if (token !== generation) throw new Error('Start cancelled.'); };
  const step = async message => { check(); const result = await call(message); check(); return result; };
  pending = true; render(); notice('Connecting your companion…');
  void (async () => {
    try {
      if (!await access) throw new Error('Allow Twitch playback access to start.');
      check();
      await step({ type: 'saveSettings', settings: { allowedChannel: channel, paused: false, autoReply: false, autoResume: false } });
      await step({ type: 'connect' });
      let state;
      for (let i = 0; i < 30; i++) {
        state = await step({ type: 'getState' });
        if (state.settings.paused || state.settings.allowedChannel !== channel || state.settings.account !== account) throw new Error('Setup changed. Start again when ready.');
        if (state.helperError || state.chat.error) throw new Error(state.helperError || state.chat.error);
        if (state.chat.connected) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      check();
      if (!state.chat.connected || state.chat.channel !== channel || state.chat.account !== state.settings.account) throw new Error('Chat did not connect. Check Advanced controls and try again.');
      const opened = await step({ type: 'openTwitch' });
      if (!opened.monitored) throw new Error('Playback checks could not start. Check Advanced controls.');
      await step({ type: 'saveSettings', expectedRevision: state.settings.revision, settings: { chatMode: 'participate', autoReply: true, autoResume: true } });
      notice('Automatic chat is on. Waiting for live playback and a conversation opportunity.');
    } catch (e) { if (token === generation) notice(e.message, true); }
    finally { if (token === generation) { pending = false; await refresh().catch(e => notice(e.message, true)); } }
  })();
});
$('stop').addEventListener('click', async () => {
  ++generation; pending = false; render();
  try { await call({ type: 'pause' }); await refresh(); notice('Stopped.'); }
  catch (e) { notice(e.message, true); }
});
await refresh().catch(e => notice(e.message, true));
setInterval(() => { if (!pending) void refresh().catch(e => notice(e.message, true)); }, 2000);
