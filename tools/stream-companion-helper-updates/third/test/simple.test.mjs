import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
let seq = 0;
const flush = async () => { for(let i=0;i<30;i++) await new Promise(r=>setImmediate(r)); };
async function harness(t, { permission = true, connectError = '', deferredConnect = false } = {}) {
  const dom = new JSDOM(await readFile(new URL('../extension/simple.html', import.meta.url), 'utf8'));
  const saved = { document: globalThis.document, chrome: globalThis.chrome, setInterval: globalThis.setInterval };
  const state = { settings: { account:'companion_test', pairingToken:'paired', allowedChannel:'old_channel', replySource:'local', paused:true }, chat:{connected:false}, sent:[] };
  const calls=[]; let release;
  globalThis.document=dom.window.document; globalThis.setInterval=()=>0;
  globalThis.chrome={ permissions:{request:async()=>permission}, runtime:{sendMessage:async m=>{
    calls.push(m);
    if(m.type==='getState') return structuredClone(state);
    if(m.type==='saveSettings') { Object.assign(state.settings,m.settings); return {ok:true}; }
    if(m.type==='connect') { if(deferredConnect) await new Promise(r=>release=r); if(connectError) return {error:connectError}; state.chat={connected:true,channel:state.settings.allowedChannel,account:state.settings.account}; return {ok:true}; }
    if(m.type==='openTwitch') return {monitored:true};
    if(m.type==='pause') { state.settings.paused=true;state.settings.autoReply=false;return {ok:true}; }
    throw new Error('Unexpected action');
  }}};
  t.after(()=>{Object.assign(globalThis,saved);dom.window.close();});
  await import(`../extension/simple.js?test=${++seq}`);
  return {state,calls,$:id=>dom.window.document.getElementById(id),release:()=>release()};
}
test('simple start selects channel, connects and opens playback before arming existing participation',async t=>{
  const h=await harness(t);
  h.$('channel').value='https://www.twitch.tv/new_channel';h.$('start').click();await flush();
  assert.equal(h.state.settings.allowedChannel,'new_channel');
  assert.equal(h.state.settings.chatMode,'participate');assert.equal(h.state.settings.autoReply,true);assert.equal(h.state.settings.autoResume,true);
  assert.ok(h.calls.findIndex(x=>x.type==='openTwitch')<h.calls.findIndex(x=>x.settings?.autoReply===true));
  assert.equal(h.calls.some(x=>['send','dropsEnable','authorize'].includes(x.type)),false);
  assert.match(h.$('status').textContent,/Automatic chat is on/);
});
test('denied access leaves current session unchanged',async t=>{
  const h=await harness(t,{permission:false});h.$('start').click();await flush();
  assert.equal(h.calls.some(x=>x.type==='saveSettings'),false);assert.match(h.$('status').textContent,/Allow Twitch/);
});
test('connection failure never arms chat or opens stream',async t=>{
  const h=await harness(t,{connectError:'Authorization expired'});h.$('start').click();await flush();
  assert.equal(h.state.settings.autoReply,false);assert.equal(h.calls.some(x=>x.type==='openTwitch'),false);assert.match(h.$('status').textContent,/Authorization expired/);
});
test('Stop during an outstanding connection cancels remaining start steps',async t=>{
  const h=await harness(t,{deferredConnect:true});h.$('start').click();await flush();
  h.$('stop').click();await flush();h.release();await flush();
  assert.equal(h.state.settings.autoReply,false);assert.equal(h.state.settings.paused,true);assert.equal(h.calls.some(x=>x.type==='openTwitch'),false);
  assert.equal(h.calls.some(x=>x.settings?.autoReply===true),false);assert.equal(h.$('status').textContent,'Stopped.');
});
test('invalid channel is rejected before setup changes',async t=>{
  const h=await harness(t);h.$('channel').value='https://example.com/channel';h.$('start').click();await flush();
  assert.equal(h.calls.some(x=>x.type==='saveSettings'),false);assert.match(h.$('status').textContent,/Enter a Twitch/);
});
