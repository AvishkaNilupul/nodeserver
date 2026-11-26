import test from 'node:test';
import assert from 'node:assert/strict';
import { UsaBrowserRelay, parseUsaTrace, hasUsaAccess, NETWORK_ORIGINS } from '../extension/usa-transport.js';
import { TRACE_URL } from '../extension/usa-policy.js';
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(t) {
  let time=1800000000000, access=true, trace='ip=203.0.113.42\nloc=US\n', traceHook, providerHook, beginHook, completeHook, eventHook, pollHook, sequence=0;
  const timers=new Map(), calls=[], network=[], queue=[], sockets=[];
  const settings={account:'companion_fourth',pairingToken:'independent-test-pairing-credential',paused:true,autoReply:false,autoResume:false};
  class FakeSocket {
    constructor(url){this.url=url;this.readyState=0;this.handlers=new Map();this.closed=0;this.sent=[];sockets.push(this);}
    addEventListener(name,fn){this.handlers.set(name,fn);}
    emit(name,event={}){if(name==='open')this.readyState=1;this.handlers.get(name)?.(event);}
    close(){this.closed++;this.readyState=3;}
    send(value){this.sent.push(value);}
  }
  const relay=new UsaBrowserRelay({settings:async()=>({...settings}),access:async()=>access,sessionId:()=>`browser-session-${++sequence}`,now:()=>time,
    setTimer:(fn,delay)=>{const key={unref(){}};timers.set(key,{fn,at:time+delay});return key;},clearTimer:key=>timers.delete(key),setIntervalImpl:()=>({unref(){}}),clearIntervalImpl:()=>{},WebSocketImpl:FakeSocket,
    fetchImpl:async(url,options)=>{
      network.push({url,options});
      if(url===TRACE_URL){assert.equal(options.headers,undefined,'trace never receives Twitch credentials');return traceHook?traceHook(options):new Response(trace);}
      assert.match(url,/^https:\/\/api\.twitch\.tv\/helix\//,'fixtures cannot reach any real external service');
      return providerHook?providerHook(options):new Response('{"ok":true}',{status:200,headers:{'content-type':'application/json','set-cookie':'must-not-be-relayed','retry-after':'3'}});
    },post:async(path,body)=>{
      calls.push({path,body:structuredClone(body)});
      if(path.endsWith('/poll'))return pollHook?pollHook(body):{ok:true,epoch:'helper-epoch',leaseExpiresAt:time+15000,needsProof:!body.proof,job:body.proof||queue[0]?.kind==='ws-close'?queue.shift()||null:null};
      if(path.endsWith('/begin'))return beginHook?beginHook(body):{ok:true,expiresAt:time+10000};
      if(path.endsWith('/complete'))return completeHook?completeHook(body):{ok:true};
      if(path.endsWith('/event'))return eventHook?eventHook(body):{ok:true,seq:body.seq};
      throw Error('Unexpected paired endpoint');
    }});
  t.after(()=>relay.stop());
  return {relay,calls,network,queue,sockets,settings,
    fetchJob:(id='request-1',extra={})=>({id,kind:'fetch',expiresAt:time+10000,url:'https://api.twitch.tv/helix/users?login=companion_fourth',method:'GET',headers:[['Authorization','Bearer fixture-token'],['Client-Id','fixtureclient123']],...extra}),
    socketJob:(id='socket-open',extra={})=>({id,kind:'ws-open',socketId:'socket-1',expiresAt:time+10000,url:'wss://eventsub.wss.twitch.tv/ws',...extra}),
    async pump(){for(let i=0;i<4;i++){await relay.tick();await flush();}},
    advance(ms){time+=ms;for(const[key,timer]of[...timers])if(timer.at<=time){timers.delete(key);timer.fn();}},
    trace:value=>{trace=value;},access:value=>{access=value;},traceHook:fn=>{traceHook=fn;},provider:fn=>{providerHook=fn;},begin:fn=>{beginHook=fn;},complete:fn=>{completeHook=fn;},event:fn=>{eventHook=fn;},poll:fn=>{pollHook=fn;}};
}
const providers=f=>f.network.filter(c=>c.url!==TRACE_URL);
const completed=f=>f.calls.filter(c=>c.path.endsWith('/complete'));

test('strict credentialless USA trace rejects duplicate/missing/malformed/non-US country and IP',()=>{
  assert.deepEqual(parseUsaTrace('loc=US\nip=2001:db8::1\n',123),{ip:'2001:db8::1',loc:'US',checkedAt:123});
  for(const trace of ['loc=US\nip=1.2.3.4\nloc=US','loc=US\nip=1.2.3.4\nip=1.2.3.4','loc=US','loc=US\nip=999.1.2.3','loc=US\nip=::invalid','loc=CA\nip=1.2.3.4','loc=us\nip=1.2.3.4','loc=US\nip=01.2.3.4'])assert.throws(()=>parseUsaTrace(trace,123));
});
test('required network permissions are all checked; missing origin and denied contains fail closed',async()=>{
  const calls=[];const chrome={permissions:{getAll:async()=>({origins:[...NETWORK_ORIGINS]}),contains:async value=>{calls.push(value);return true;}}};
  assert.equal(await hasUsaAccess(chrome),true);assert.equal(calls.length,4);
  chrome.permissions.getAll=async()=>({origins:NETWORK_ORIGINS.slice(0,3)});assert.equal(await hasUsaAccess(chrome),false);
  chrome.permissions.getAll=async()=>({origins:[...NETWORK_ORIGINS]});chrome.permissions.contains=async()=>false;assert.equal(await hasUsaAccess(chrome),false);
});
test('paused bootstrap executes one attested single-use fetch and returns only bounded safe result headers',async t=>{
  const f=fixture(t);f.queue.push(f.fetchJob());await f.pump();
  assert.equal(providers(f).length,1);const begin=f.calls.find(c=>c.path.endsWith('/begin'));assert.equal(begin.body.proof.loc,'US');
  assert.deepEqual(completed(f)[0].body.result,{ok:true,status:200,headers:[['content-type','application/json'],['retry-after','3']],body:'{"ok":true}'});
  const request=providers(f)[0].options;assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');
  assert.equal(f.relay.status().ready,true);assert.equal(f.relay.status().country,'US');assert.equal(JSON.stringify(f.relay.status()).includes('203.0.113.42'),false);
  f.queue.push(f.fetchJob());await f.pump();assert.equal(providers(f).length,1,'duplicate job cannot dispatch twice');
});
test('bootstrap supports blank account while paired and stopped without arming chat',async t=>{
  const f=fixture(t);f.settings.account='';await f.pump();assert.equal(f.relay.status().ready,true);assert.equal(f.settings.paused,true);assert.equal(f.settings.autoReply,false);
});
test('absent permission, non-US route and malformed trace never begin or dispatch Twitch work',async t=>{
  for(const[access,trace]of[[false,'ip=1.2.3.4\nloc=US'],[true,'ip=1.2.3.4\nloc=CA'],[true,'ip=1.2.3.4\nloc=US\nloc=US']]){
    const f=fixture(t);f.access(access);f.trace(trace);f.queue.push(f.fetchJob());await f.pump();assert.equal(providers(f).length,0);assert.equal(f.calls.some(c=>c.path.endsWith('/begin')),false);assert.equal(f.relay.status().ready,false);
  }
});
test('lost BEGIN response cannot dispatch, complete or replay provider work',async t=>{
  const f=fixture(t);f.begin(()=>{throw Error('lost ACK');});f.queue.push(f.fetchJob());await f.pump();
  assert.equal(providers(f).length,0);assert.equal(completed(f).length,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/begin')).length,1);
});
test('Stop during fresh country check retires the job before BEGIN',async t=>{
  const f=fixture(t);await f.pump();const gate=deferred();f.traceHook(()=>gate.promise);f.queue.push(f.fetchJob());await f.relay.tick();await flush();
  f.relay.reset('stopped');gate.resolve(new Response('ip=1.2.3.4\nloc=US'));await flush();assert.equal(providers(f).length,0);assert.equal(f.calls.some(c=>c.path.endsWith('/begin')),false);
});
test('account/pairing change and epoch rotation close sockets and prevent late old events',async t=>{
  const f=fixture(t);f.queue.push(f.socketJob());await f.pump();const socket=f.sockets[0];socket.emit('open');await flush();
  f.settings.account='different_account';await f.pump();assert.equal(socket.closed,1);const count=f.calls.filter(c=>c.path.endsWith('/event')).length;socket.emit('message',{data:'late'});await flush();assert.equal(f.calls.filter(c=>c.path.endsWith('/event')).length,count);
});
test('network jobs and proof do not block heartbeat polls; four requests run concurrently within their deadlines',async t=>{
  const f=fixture(t), held=[];f.provider(options=>new Promise((resolve,reject)=>{held.push({resolve,options});options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));}));
  for(let i=0;i<4;i++)f.queue.push(f.fetchJob(`parallel-${i}`));await f.pump();assert.equal(providers(f).length,4);
  const before=f.calls.filter(c=>c.path.endsWith('/poll')).length;f.advance(3000);await f.pump();assert.ok(f.calls.filter(c=>c.path.endsWith('/poll')).length>before);assert.equal(f.relay.status().ready,true);
  for(const item of held)item.resolve(new Response('done'));await flush();assert.equal(completed(f).length,4);
});
test('lease expiry aborts slow HTTP and closes an open WebSocket without another provider dispatch',async t=>{
  const f=fixture(t);f.queue.push(f.socketJob());await f.pump();f.provider(options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));f.queue.push(f.fetchJob());await f.pump();const request=providers(f)[0];
  f.advance(16000);await flush();assert.equal(request.options.signal.aborted,true);assert.equal(f.sockets[0].closed,1);assert.equal(f.relay.status().ready,false);assert.equal(providers(f).length,1);
});
test('non-US refresh closes existing sockets and aborts current HTTP immediately',async t=>{
  const f=fixture(t);f.queue.push(f.socketJob());await f.pump();f.provider(options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));f.queue.push(f.fetchJob());await f.pump();f.trace('loc=CA\nip=1.2.3.4');await assert.rejects(f.relay.attest());await flush();
  assert.equal(f.sockets[0].closed,1);assert.equal(providers(f)[0].options.signal.aborted,true);assert.equal(f.relay.status().ready,false);
});
test('HTTP overflow and timeout produce one failure result, never retry provider',async t=>{
  const f=fixture(t);f.provider(()=>new Response('x'.repeat(262145)));f.queue.push(f.fetchJob());await f.pump();assert.deepEqual(completed(f)[0].body.result,{ok:false,code:'bad_response'});assert.equal(providers(f).length,1);
  f.provider(options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));f.queue.push(f.fetchJob('timeout'));await f.pump();f.advance(10000);await flush();assert.equal(providers(f).length,2);assert.equal(completed(f).at(-1).body.result.code,'timeout');
});
test('lost completion ACK does not replace the accepted result or dispatch again',async t=>{
  const f=fixture(t);f.complete(()=>{throw Error('lost complete ACK');});f.queue.push(f.fetchJob());await f.pump();assert.equal(providers(f).length,1);assert.equal(completed(f).length,1);assert.equal(completed(f)[0].body.result.ok,true);
});
test('socket construction completes before ordered actual events, each frame waits for its exact ACK',async t=>{
  const f=fixture(t), ack=deferred();f.queue.push(f.socketJob());await f.pump();const socket=f.sockets[0];
  f.event(body=>body.seq===1?ack.promise:{ok:true,seq:body.seq});socket.emit('open');socket.emit('message',{data:'first'});socket.emit('message',{data:'second'});await flush();
  assert.equal(completed(f)[0].body.result.ok,true);assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/event')).map(c=>c.body.event.type),['open']);
  ack.resolve({ok:true,seq:1});await flush();assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/event')).map(c=>[c.body.seq,c.body.event.type]),[[1,'open'],[2,'message'],[3,'message']]);
});
test('lost event ACK or oversized frame closes socket and suppresses later events',async t=>{
  const f=fixture(t);f.queue.push(f.socketJob());await f.pump();f.event(()=>{throw Error('lost frame ACK');});f.sockets[0].emit('open');f.sockets[0].emit('message',{data:'must wait'});await flush();assert.equal(f.sockets[0].closed,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/event')).length,1);
  f.event(body=>({ok:true,seq:body.seq}));f.queue.push(f.socketJob('new-open',{socketId:'socket-2'}));await f.pump();f.sockets[1].emit('message',{data:'x'.repeat(65537)});await flush();assert.equal(f.sockets[1].closed,1);
});
test('cleanup close requires a single-use BEGIN but no country probe',async t=>{
  const f=fixture(t);f.queue.push(f.socketJob());await f.pump();const traces=f.network.filter(c=>c.url===TRACE_URL).length;
  f.queue.push({id:'close-1',kind:'ws-close',socketId:'socket-1',expiresAt:1800000010000,code:1000});await f.pump();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/begin')).at(-1).body.proof,null);assert.equal(f.network.filter(c=>c.url===TRACE_URL).length,traces);assert.equal(f.sockets[0].closed,1);
});
test('arbitrary URL/header work is rejected by browser even if paired helper offers it',async t=>{
  const f=fixture(t);f.queue.push(f.fetchJob('invalid',{url:'https://attacker.example/collect'}));await f.pump();assert.equal(providers(f).length,0);assert.equal(f.calls.some(c=>c.path.endsWith('/begin')),false);
});

test('fast native open/message before construction completion ACK stay queued until acknowledged',async t=>{
  const f=fixture(t), ack=deferred();f.complete(()=>ack.promise);f.queue.push(f.socketJob());await f.pump();
  f.sockets[0].emit('open');f.sockets[0].emit('message',{data:'immediate welcome'});await flush();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/event')).length,0,'helper must mark socket constructed before any event');
  ack.resolve({ok:true});await flush();assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/event')).map(c=>[c.body.seq,c.body.event.type]),[[1,'open'],[2,'message']]);
});
test('valid empty HTTP204 result is completed and no stale proof is presented as ready',async t=>{
  const f=fixture(t);f.provider(()=>new Response(null,{status:204}));f.queue.push(f.fetchJob());await f.pump();assert.deepEqual(completed(f)[0].body.result,{ok:true,status:204,headers:[],body:''});
  f.advance(5001);assert.equal(f.relay.status().ready,false);
});
