const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Engine}=require('../tools/rivals-level-worker/engine.cjs');
const {uid,progress,classify,features}=require('../tools/rivals-level-worker/vision.cjs');
const {preparation,run}=require('../tools/rivals-level-worker/cli.cjs');
const {Queue}=require('../tools/rivals-claim-worker/queue.cjs');
const {remoteCheck}=require('../tools/rivals-level-worker/stock-check.cjs');
const {glyphMask}=require('../tools/rivals-level-worker/badge.cjs');
const UID='123456789';
function frame(text){return {capturedAt:new Date().toISOString(),output:'/private/fixture.png',lines:text.split('\n').map((text,i)=>({text,confidence:.99,x:/^ACCOUNT XP/.test(text)?.4:.1,y:/^ACCOUNT XP/.test(text)?.4:/^(START|CONFIRM|NEXT|CONTINUE)$/.test(text)?.8:.05+i*.04,width:.2,height:.02}))};}
function baseline(engine){return engine.step(frame('CAREER\nOVERVIEW\nUID:'+UID+'\nACCOUNT LEVEL: 1'));}
function start(engine){baseline(engine);engine.step(frame('PRACTICE VS AI\nSTART'));engine.step(frame('SELECT YOUR HERO\nTHE PUNISHER\nCONFIRM'));}

test('wrong identity cannot trigger any game input',()=>{
  const e=new Engine({expectedUid:UID});
  assert.throws(()=>e.step(frame('UID:987654321\nCAREER\nOVERVIEW\nACCOUNT LEVEL 1')),/UID changed/);
  assert.throws(()=>e.step(frame('PLAY\nHEROES\nSTORE')),/not visible/);
});
test('does not interpret hero levels, proficiency XP, scoreboard digits or tokens as account progress',()=>{
  const f=frame('HERO LEVEL 15\nPROFICIENCY\nXP GAINED 900\nCHRONO TOKENS 1100\nELIMINATIONS 18');
  assert.equal(progress(f).level,null);assert.equal(progress(f).earnedXp,null);assert.notEqual(classify(f),'xp');
  assert.equal(progress(frame('ACCOUNT XP EARNED: +450')).earnedXp,450);
  const chat=frame('ACCOUNT XP EARNED: +450');chat.lines[0].x=.03;chat.lines[0].y=.85;
  assert.equal(progress(chat).earnedXp,null);
});
test('real Career badge location is distinct from other bare numbers',()=>{
  const f=frame('CAREER\nOVERVIEW\nUID:'+UID);
  f.lines.push({text:'1',x:.07,y:.25,width:.007,height:.014,confidence:.9},{text:'99',x:.4,y:.5,width:.03,height:.04,confidence:.9});
  assert.equal(progress(f).level,1);assert.equal(uid(f),UID);
});
test('digit isolation removes an edge-connected badge outline and refuses a clipped glyph',()=>{
  const w=80,h=50,d=Buffer.alloc(w*h);
  for(let x=0;x<w;x++){d[5*w+x]=255;d[44*w+x]=255;}
  for(let y=5;y<=44;y++){d[y*w+2]=255;d[y*w+77]=255;}
  for(let y=15;y<35;y++)for(let x=35;x<40;x++)d[y*w+x]=255;
  assert.equal(glyphMask(d,w,h).count,1);
  // The clipped stem touches the top and must not become a smaller level.
  const onlyClipped=Buffer.alloc(w*h);for(let y=0;y<30;y++)for(let x=35;x<40;x++)onlyClipped[y*w+x]=255;
  assert.throws(()=>glyphMask(onlyClipped,w,h),/clipped/);
});
test('PvP and an already-running combat screen cannot bypass AI mode verification',()=>{
  const e=new Engine({expectedUid:UID});baseline(e);
  assert.throws(()=>e.step(frame('SELECT YOUR HERO\nTHE PUNISHER\nCONFIRM')),/AI mode/);
  assert.throws(()=>e.step(frame('ATTACK\n250')),/verified AI/);
});
test('unknown screen never gets speculative clicks and stops after twelve seconds',()=>{
  let now=0;const e=new Engine({expectedUid:UID,now:()=>now});baseline(e);
  assert.deepEqual(e.step(frame('UNRECOGNIZED POPUP')),{kind:'unknown',wait:true});
  now=13000;assert.throws(()=>e.step(frame('UNRECOGNIZED POPUP')),/Unrecognized/);
});
test('actual match completion and positive account XP are both needed',()=>{
  const e=new Engine({expectedUid:UID});start(e);
  assert.throws(()=>e.step(frame('ACCOUNT XP EARNED +400')),/completed benchmark/);
  e.step(frame('VICTORY\nNEXT'));
  assert.throws(()=>e.step(frame('ACCOUNT XP EARNED 0')),/Positive account XP/);
  const result=e.step(frame('ACCOUNT XP EARNED +400'));
  assert.equal(result.done,true);assert.equal(e.matches.length,1);assert.equal(e.matches[0].earnedXp,400);
});
test('returning from a match without XP evidence stops the run',()=>{
  const e=new Engine({expectedUid:UID});start(e);e.step(frame('VICTORY\nNEXT'));
  assert.throws(()=>e.step(frame('PLAY\nHEROES\nSTORE')),/XP was not verified/);
});
test('no visible combat target stops active controls rather than firing blindly',()=>{
  let now=0;const e=new Engine({expectedUid:UID,now:()=>now});start(e);
  assert.equal(e.step(frame('ATTACK\n250')).action.fire,undefined);
  now=11000;assert.throws(()=>e.step(frame('ATTACK\n250')),/No visible/);
});
test('red scenery does not become an enemy target; thin healthbar does',()=>{
  const w=100,h=100,d=Buffer.alloc(w*h*4);
  const paint=(x,y,ww,hh)=>{for(let yy=y;yy<y+hh;yy++)for(let xx=x;xx<x+ww;xx++){const i=(yy*w+xx)*4;d[i]=255;d[i+3]=255;}};
  paint(10,20,20,20);assert.equal(features(d,w,h).enemies.length,0);
  paint(50,40,10,1);assert.equal(features(d,w,h).enemies.length,1);
});
test('legal agreements and disconnects require review',()=>{
  const e=new Engine({expectedUid:UID});baseline(e);
  for(const text of ['NETEASE TERMS OF USE\nAGREE','CONNECTION LOST\nRECONNECT'])assert.throws(()=>e.step(frame(text)),/requires review/);
});
test('active claims, listed/completed preparations and missing game IDs cannot be adopted',()=>{
  const job={id:'rivals-test-001',phase:'collected',state:'running',rivalsUid:UID,lease:{active:true,owner:'cua-rivals-worker'}};
  const queue={status:()=>({jobs:[job]})};assert.throws(()=>preparation(queue,job.id),/still owns/);
  job.lease=null;assert.equal(preparation(queue,job.id),job);
  job.lease={active:false,owner:'cua-rivals-worker'};assert.throws(()=>preparation(queue,job.id),/expired/);job.lease=null;
  job.phase='logged-out';job.state='ready';assert.throws(()=>preparation(queue,job.id),/before sign-out/);
});
test('an unchanged world image stops controls even when a colored marker remains visible',()=>{
  let now=0;const e=new Engine({expectedUid:UID,now:()=>now});start(e);
  const hints={enemies:[],objectives:[{x:.5,y:.4}],scene:[10,10,20]};
  e.step(frame('ATTACK\n250'),hints);now=100;e.step(frame('ATTACK\n250'),hints);now=8300;
  assert.throws(()=>e.step(frame('ATTACK\n250'),hints),/stopped changing/);
});
test('handoff preserves active identity and every claim phase, and invalidates the old token',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rivals-level-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const q=new Queue(dir);
  q.import({id:'rivals-test-001',holdId:'fixture-hold',holdVerified:true,holdCheckedAt:new Date().toISOString(),
    steam:{id:'a'.repeat(24),login:'fixture_steam',password:'fixture-password'},twitch:{id:'b'.repeat(24),login:'fixture_twitch',password:'fixture-password'},expectedRewards:[{id:'fixture-costume',name:'Fixture Costume'}]});
  const a=q.acquire('claim-worker','rivals-test-001');
  q.store.transact(d=>{d.jobs[0].phase='collected';d.jobs[0].rivalsUid=UID;});
  const released=q.releaseLease(a.job.id,a.leaseToken);
  assert.equal(released.phase,'collected');assert.equal(released.state,'running');assert.equal(released.attempts,1);assert.equal(released.rivalsUid,UID);
  assert.throws(()=>q.heartbeat(a.job.id,a.leaseToken),/lease/);
  const b=q.acquire('level-worker',a.job.id);assert.equal(b.job.id,a.job.id);assert.equal(b.job.phase,'collected');
  assert.throws(()=>q.acquire('another-worker',a.job.id),/Another worker/);
});

function remoteFixture({stage='problem',listing=0,sale=0,boost=0,held=58}={}){
  let disconnected=false,queries=[];
  const id='a'.repeat(24),request={id:'rivals-test-001',steamId:id,holdId:'held-fixture',steamLogin:'fixture_steam'};
  const db={collection(name){return {async findOne(){return name==='steamaccounts'?{stage,notes:request.id,accountName:request.steamLogin}:{steamId:id,status:'held',holdId:request.holdId,twitchId:'twitch-fixture',reservedCount:58};},
    async countDocuments(query){queries.push({name,query});return ({steamlistings:listing,steamsales:sale,steamboosts:boost,droplogs:held})[name]??0;}};}};
  const mongo={Types:{ObjectId:function(s){this.toString=()=>s;}},connect:async()=>{},disconnect:async()=>{disconnected=true;},connection:{db}};
  return {request,load:n=>n==='dotenv'?{config(){}}:mongo,disconnected:()=>disconnected,queries};
}
test('fresh stock check refuses listing, sale, active booster and missing consumed rewards',async()=>{
  for(const changes of [{stage:'listed'},{listing:1},{sale:1},{boost:1},{held:0}]){
    const f=remoteFixture(changes);await assert.rejects(remoteCheck(f.request,{load:f.load}));assert.equal(f.disconnected(),true);
  }
  const f=remoteFixture();assert.equal((await remoteCheck(f.request,{load:f.load})).held,true);assert.equal(f.disconnected(),true);
  assert.ok(f.queries.length>0);
});

function runningFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rivals-level-loop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new Queue(path.join(root,'claim'));const id='rivals-level-fixture';
  q.import({id,holdId:'fixture-hold',holdVerified:true,holdCheckedAt:new Date().toISOString(),steam:{id:'a'.repeat(24),login:'fixture_steam',password:'fixture-password'},
    twitch:{id:'b'.repeat(24),login:'fixture_twitch',password:'fixture-password'},expectedRewards:[{id:'fixture-reward',name:'Fixture Reward'}]});
  const original=q.acquire('claim-worker',id);q.store.transact(d=>{d.jobs[0].phase='collected';d.jobs[0].rivalsUid=UID;});
  q.releaseLease(id,original.leaseToken);
  const calls=[];let released=0,closed=0;
  const config={id,pid:123,title:'Synthetic Rivals',matches:1};
  function driverFactory(screens){return ()=>({async request(p){calls.push(p.command);if(p.command==='capture'){
    const f=screens.shift();if(!f)throw Error('Fixture frames exhausted');return {...f,output:p.output,capturedAt:f.capturedAt??new Date().toISOString(),frontmostPid:f.frontmostPid??123};
  }return {};},async close(){closed++;}});}
  const options={queue:q,directoryRoot:root,checkStock:async()=>({held:true}),readFeatures:async()=>({enemies:[{x:.51,y:.48}],objectives:[]}),emergencyRelease:()=>released++};
  return {q,id,root,calls,config,options,driverFactory,get released(){return released;},get closed(){return closed;}};
}
test('runner returns the same claim session and saves actual-match-shaped evidence without advancing its claim phase',async t=>{
  const f=runningFixture(t),screens=[frame('CAREER\nOVERVIEW\nUID:'+UID+'\nACCOUNT LEVEL 1'),frame('PRACTICE VS AI\nSTART'),
    frame('SELECT YOUR HERO\nTHE PUNISHER\nCONFIRM'),frame('ATTACK\n250'),frame('VICTORY\nNEXT'),frame('ACCOUNT XP EARNED +450')];
  const result=await run(f.config,{...f.options,driverFactory:f.driverFactory(screens)});
  assert.equal(result.status,'complete');assert.equal(result.matches[0].earnedXp,450);assert.equal(f.closed,1);assert.equal(f.released,1);
  const j=f.q.status().jobs[0];assert.equal(j.phase,'collected');assert.equal(j.lease,null);assert.equal(j.rivalsUid,UID);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'commission.json'))).positiveAccountXp,450);
});
test('runner stops on focus loss and stale images, releases controls, and preserves the held identity',async t=>{
  for(const changes of [{frontmostPid:999},{capturedAt:'2020-01-01T00:00:00Z'}]){
    const f=runningFixture(t),s={...frame('CAREER\nOVERVIEW\nUID:'+UID+'\nACCOUNT LEVEL 1'),...changes};
    await assert.rejects(run(f.config,{...f.options,driverFactory:f.driverFactory([s])}),/focus|too old/);
    assert.equal(f.closed,1);assert.equal(f.released,1);assert.equal(f.q.status().jobs[0].phase,'collected');assert.equal(f.q.status().jobs[0].lease,null);
    assert.deepEqual(f.calls,['focus','capture']);
  }
});
test('a changed stock commitment prevents the queue click, and an existing owner prevents even focusing',async t=>{
  const f=runningFixture(t);let checks=0;
  await assert.rejects(run(f.config,{...f.options,checkStock:async()=>{if(++checks===2)throw Error('Account was listed concurrently');},
    driverFactory:f.driverFactory([frame('CAREER\nOVERVIEW\nUID:'+UID+'\nACCOUNT LEVEL 1'),frame('PRACTICE VS AI\nSTART')])}),/listed concurrently/);
  assert.equal(f.calls.filter(c=>c==='click').length,0);assert.equal(f.q.status().jobs[0].lease,null);
  const lease=f.q.acquire('cua-rivals-worker',f.id);const before=f.calls.length;
  await assert.rejects(run(f.config,{...f.options,driverFactory:f.driverFactory([])}),/still owns/);
  assert.equal(f.calls.length,before);assert.equal(f.q.status().jobs[0].lease.owner,'cua-rivals-worker');f.q.releaseLease(f.id,lease.leaseToken);
});
