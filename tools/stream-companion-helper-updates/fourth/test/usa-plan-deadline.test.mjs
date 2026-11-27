import { createHash } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsTransport } from '../lib/usa-transport.mjs';
import { UsaBrowserRelay } from '../extension/usa-transport.js';
import { TRACE_URL } from '../extension/usa-policy.js';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';

const credentials = { clientId: 'testclient1234', account: 'companion_test', userId: '123', accessToken: 'test-only-access', refreshToken: 'test-only-refresh', scopes: chatScopes };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.fail('Bounded synthetic roundtrip did not complete.'); }
function harness(t, { country = 'US', trace, network } = {}) {
  const helper = createUsTransport(), calls = [], sockets = [], operations = []; let number = 0;
  class BrowserSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, wasClean: true })); }
    send(data) { this.lastSent = data; }
  }
  const browser = new UsaBrowserRelay({
    settings: async () => ({ account: credentials.account, pairingToken: 'synthetic-pairing-only' }), access: async () => true,
    sessionId: () => `synthetic-browser-${String(++number).padStart(4, '0')}`,
    post: async (path, input) => { operations.push({ action: path.split('/').at(-1), id: input.id }); return helper[path.split('/').at(-1)](input); },
    WebSocketImpl: BrowserSocket,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === TRACE_URL) return trace ? trace() : new Response(`ip=203.0.113.1\nloc=${country}\n`);
      if (network) return network(url, options);
      if (url.endsWith('/validate')) return response({ client_id: credentials.clientId, login: credentials.account, user_id: credentials.userId, scopes: chatScopes });
      if (url.includes('/users?')) return response({ data: [{ id: '456', login: 'friend_channel' }] });
      if (url.endsWith('/eventsub/subscriptions')) return response({ data: [{ status: 'enabled' }] });
      if (url.includes('/shared_chat/session?')) return response({ data: [] });
      if (url.endsWith('/chat/messages')) return response({ data: [{ is_sent: true, message_id: 'confirmed-before-transfer' }] });
      return response({ device_code: 'test-only-device', user_code: 'ABCD', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
    }
  });
  const twitch = new TwitchChat({ credentials: structuredClone(credentials), fetchImpl: helper.fetch, WebSocketImpl: helper.WebSocket, transport: helper });
  helper.bind({ getGeneration: () => twitch.generation });
  t.after(() => { browser.stop(); twitch.disconnect(); helper.close(); });
  async function tick() { await browser.tick(); await flush(); }
  return { helper, browser, twitch, calls, sockets, operations, tick };
}


async function runCase(mode, manual = false) {
 const cleanup=[],originalNow=Date.now;let time=1800000000000;Date.now=()=>time;
 const t={after(fn){cleanup.push(fn)}};
 try {
  let release;
  const h=harness(t,mode==='after-dispatch'?{network:async(url)=>{if(url.includes('/shared_chat/session?'))return response({data:[]});if(url.endsWith('/chat/messages'))return new Promise(resolve=>{release=()=>resolve(response({data:[{is_sent:true,message_id:'late-response'}]}));});throw Error('Unexpected synthetic provider target.');}}:{});await h.tick();await h.tick();
  const account=credentials.account,channel='friend_channel',streamId='123456789';
  const event={id:`bits:boundary-${mode}`,channel,type:'bits',at:time-44000};
  const binding={generation:'synthetic-control',sessionId:'synthetic-browser',settingsRevision:1};
  const text='nice cheer',expiresAt=event.at+45000;
  const offer={planId:`boundary-plan-${mode}`,authorityEpoch:'synthetic-authority',clientId:'fourth',account,channel,streamId,kind:'event',category:'bits',event,text,textKey:messageKey(text),exactKey:createHash('sha256').update(text).digest('hex'),source:'automatic',participationKey:`event:${channel}:${event.id}`,opportunityKey:`event:${channel}:${event.id}`,replyId:'',replyAuthor:'',replyAt:0,notBefore:time,expiresAt,binding};
  if(manual){offer.kind='';offer.category='';offer.source='manual';offer.participationKey='';offer.opportunityKey='manual:fixture';offer.streamId='';delete offer.event;}
  h.twitch.connected=true;h.twitch.channel=channel;h.twitch.broadcasterId='456';h.twitch.validatedAt=time;h.twitch.events=[event];
  h.twitch.coordinator={currentPlan:()=>offer,snapshot:()=>({available:true,paused:false,accounts:[account]}),reserve:async()=>({ok:true,reservationId:'synthetic-permit'}),begin:async()=>({ok:true}),finish:async()=>{}};
  h.twitch.inspectChannel=async()=>({streamContext:{isLive:true,streamId},sharedChat:false,chatSettings:{}});
  let chatJob='',advanced=false,queued=false,beginReturned=false;const originalPost=h.browser.post;
  const originalFetch=h.twitch.fetch;h.twitch.fetch=(url,options)=>{if(url.endsWith('/chat/messages')){queued=true;assert.equal(options.providerDeadlineAt,offer.expiresAt);}return originalFetch(url,options);};
  const originalTimer=h.browser.setTimer;h.browser.setTimer=(fn,delay)=>{const timer=originalTimer(fn,delay);if(mode==='after-timer'&&beginReturned&&!advanced){advanced=true;time+=2000;}return timer;};
  h.browser.post=async(path,input)=>{
   const result=await originalPost(path,input);
   if(path.endsWith('/poll')&&result.job?.url?.endsWith('/chat/messages'))chatJob=result.job.id;
   if(path.endsWith('/begin')&&input.id===chatJob){beginReturned=true;if(mode==='post-begin'&&!advanced){advanced=true;time+=2000;}}
   return result;
  };
  let done=false,error=null,result=null;
  const pending=h.twitch.send({account,channel,text,kind:offer.kind,category:offer.category,streamId:offer.streamId,participationKey:offer.participationKey,planId:offer.planId,authorityEpoch:offer.authorityEpoch,binding}).then(r=>{result=r;},e=>{error=e;}).finally(()=>{done=true;});
  for(let i=0;i<30;i++){
   await h.tick();
   if(queued&&h.helper.status().pending===1&&!h.calls.some(c=>c.url.endsWith('/chat/messages')))break;
  }
  assert.equal(queued,true,'The chat request really reached the helper queue before advancing time.');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/chat/messages')).length,0,'No provider chat before the queue boundary.');
  if(mode==='pre-begin')time+=2000;
  if(mode==='after-dispatch'){for(let i=0;i<30&&!release;i++)await h.tick();assert.equal(typeof release,'function');time+=2000;release();}
  for(let i=0;i<30&&!done;i++)await h.tick();
  await pending;
  const chatCalls=h.calls.filter(c=>c.url.endsWith('/chat/messages'));const calls=chatCalls.length;
  for(const call of chatCalls){assert.equal('providerDeadlineAt' in call.options,false,'Private deadline never becomes a browser Fetch option.');assert.equal(JSON.parse(call.options.body).message,offer.text);}
  assert.equal(calls,mode==='after-dispatch'?1:0,`${mode}: provider dispatch count`);
  assert.notEqual(result?.delivery,'confirmed');
  if(mode==='pre-begin'){assert.equal(result?.delivery,'cancelled');assert.equal(result.submitted,false);}
  else assert.equal(h.twitch.history.at(-1)?.delivery,'unknown','A successful BEGIN without a dispatch/outcome proof stays consumed unknown.');
  if(mode==='after-dispatch'){assert.equal(h.twitch.history.at(-1)?.delivery,'unknown');for(let i=0;i<10;i++)await h.tick();assert.equal(h.calls.filter(c=>c.url.endsWith('/chat/messages')).length,1,'Uncertain request is never replayed.');}
  const report={mode,providerChatCalls:calls,delivery:result?.delivery||h.twitch.history.at(-1)?.delivery,error:error?.message||null,sourceAgeMs:time-event.at,realProviderCalls:0};
  return report;
 } finally {for(const fn of cleanup)fn();Date.now=originalNow;}
}

for(const mode of ['pre-begin','post-begin','after-timer','after-dispatch']) test(`actual USA relay respects the immutable event deadline at ${mode}`,async()=>{await runCase(mode);});
test('ordinary reviewed chat plans carry their exact expiry to the same queue',async()=>{await runCase('pre-begin',true);});

test('a private chat deadline only shortens queue TTL and cannot affect non-chat targets',async t=>{
 let time=1800000000000;const helper=createUsTransport({now:()=>time});t.after(()=>helper.close());let epoch;
 const poll=()=>{const value=helper.poll({sessionId:'deadline-test-session-0001',...(epoch?{epoch}:{}),proof:{ip:'203.0.113.1',loc:'US',checkedAt:time}});epoch=value.epoch;return value;};
 poll();const url='https://api.twitch.tv/helix/chat/messages',options={method:'POST',headers:{Authorization:'Bearer test-only-access','Client-Id':credentials.clientId,'Content-Type':'application/json'},body:JSON.stringify({broadcaster_id:'456',sender_id:'123',message:'nice cheer'})};
 for(const [offset,expected]of[[1000,1000],[90000,10000]]){const promise=helper.fetch(url,{...options,providerDeadlineAt:time+offset});promise.catch(()=>{});const job=poll().job;assert.equal(job.expiresAt,time+expected);assert.equal('providerDeadlineAt' in job,false);helper.invalidate();await assert.rejects(promise,e=>e.notSubmitted===true);poll();}
 for(const deadline of [time,time-1,NaN,Infinity,'later'])await assert.rejects(helper.fetch(url,{...options,providerDeadlineAt:deadline}),e=>e.notSubmitted===true);
 const validate='https://id.twitch.tv/oauth2/validate',read={method:'GET',headers:{Authorization:'OAuth test-only-access'}};
 await assert.rejects(helper.fetch(validate,{...read,providerDeadlineAt:time+1000}),e=>e.notSubmitted===true);
 const pending=helper.fetch(validate,read);pending.catch(()=>{});assert.equal(poll().job.expiresAt,time+10000);helper.invalidate();await assert.rejects(pending,e=>e.notSubmitted===true);
});
