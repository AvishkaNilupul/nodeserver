const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Engine}=require('../tools/rivals-level-worker/engine.cjs');
const {uid,progress,classify,features}=require('../tools/rivals-level-worker/vision.cjs');
const {preparation,run}=require('../tools/rivals-level-worker/cli.cjs');
const {Queue}=require('../tools/rivals-claim-worker/queue.cjs');
const {remoteCheck}=require('../tools/rivals-level-worker/stock-check.cjs');
const {glyphMask}=require('../tools/rivals-level-worker/badge.cjs');
const UID='123456789';
function frame(text){return {capturedAt:new Date().toISOString(),output:'/private/fixture.png',lines:text.split('\n').map((text,i)=>({text,confidence:.99,x:/^ACCOUNT XP/.test(text)?.4:.1,y:/^ACCOUNT XP/.test(text)?.4:/^(START|CONFIRM|NEXT|CONTINUE)$/.test(text)?.8:.05+i*.04,width:.2,height:.02}))};}
function gameFrame(){const f=frame('');f.lines.push({text:'300 / 300',x:.47,y:.9,width:.06,height:.02,confidence:.99});return f;}
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
  const f=frame('CAREER\nOVERVIEW\nBASIC STATS\nUID:'+UID);
  f.lines.push({text:'1',x:.07,y:.25,width:.007,height:.014,confidence:.9},{text:'99',x:.4,y:.5,width:.03,height:.04,confidence:.9});
  assert.equal(progress(f).level,1);assert.equal(uid(f),UID);
  assert.notEqual(classify(frame('CAREER\nOVERVIEW\nCUSTOMIZE\nNAMEPLATE\nEQUIPPED')),'career');
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
  assert.throws(()=>e.step(gameFrame()),/verified AI/);
});
test('live menu text cannot be mistaken for match results or start a Quick Match',()=>{
  const picker=frame('SELECT MODE\nQUICK MATCH\nDefeat enemies and complete objectives!\nPRACTICE\nVS. AI');
  assert.equal(classify(picker),'mode-menu');
  const e=new Engine({expectedUid:UID});baseline(e);
  const menu=frame('PLAY\nHEROES\nSTORE\nQUICK MATCH\nCHANGE MODE\nSTART');
  assert.equal(classify(menu),'play-menu');assert.equal(e.step(menu).queue,undefined);
  const ai=frame('PLAY\nCHANGE MODE\nPRACTICE VS. AI\nSTART');
  ai.lines.find(l=>l.text==='PRACTICE VS. AI').x=.77;ai.lines.find(l=>l.text==='PRACTICE VS. AI').y=.77;
  ai.lines.find(l=>l.text==='START').x=.86;
  ai.lines.find(l=>l.text==='START').width=.1;
  assert.equal(e.step(ai).queue,true);
});
test('an accepted Start is never clicked again while the queue UI catches up',()=>{
  let now=1000;const e=new Engine({expectedUid:UID,now:()=>now});baseline(e);
  const screen=frame('PRACTICE VS AI\nSTART'),decision=e.step(screen);e.actionApplied(decision);
  now+=4000;assert.deepEqual(e.step(screen),{kind:'queue',wait:true});
  now+=180000;assert.throws(()=>e.step(screen),/Queue did not reach/);
  assert.notEqual(classify(frame('From an island he suspended above Tokyo, the Master Weaver plans to use energy')),'blocked');
  assert.equal(classify(frame('ACCOUNT SUSPENDED')),'blocked');
  assert.equal(classify(frame('CONFIRM YOUR HERO\nCONFIRM')),'hero-select');
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
  assert.equal(e.step(gameFrame()).action.fire,undefined);
  now=11000;assert.throws(()=>e.step(gameFrame()),/No visible/);
});
test('a visible spawn exit or labeled objective distance drives bounded navigation',()=>{
  const e=new Engine({expectedUid:UID});start(e);
  const hud=gameFrame();
  let d=e.step(hud,{enemies:[],objectives:[],exits:[{x:.48,y:.5}]});assert.deepEqual(d.action.keys,['w']);assert.equal(d.action.milliseconds,2500);
  const dist=gameFrame();dist.lines.push({text:'82M',x:.65,y:.5,width:.03,height:.02,confidence:.99});
  d=e.step(dist,{enemies:[],objectives:[],exits:[]});assert.deepEqual(d.action.keys,['w']);assert.ok(d.action.dx>0);
  assert.equal(classify(frame("You are about to be removed from the game")),'blocked');
  assert.equal(classify(frame('NETWORK FLUCTUATION ALERT')),'blocked');
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
  e.step(gameFrame(),hints);now=100;e.step(gameFrame(),hints);now=8300;
  assert.throws(()=>e.step(gameFrame(),hints),/stopped changing/);
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
    const f=screens.shift();if(!f)throw Error('Fixture frames exhausted');fs.writeFileSync(p.output,Buffer.alloc(0));return {...f,output:p.output,capturedAt:f.capturedAt??new Date().toISOString(),frontmostPid:f.frontmostPid??123};
  }return {};},async close(){closed++;}});}
  const options={queue:q,directoryRoot:root,checkStock:async()=>({held:true}),readFeatures:async()=>({enemies:[{x:.51,y:.48}],objectives:[]}),emergencyRelease:()=>released++};
  return {q,id,root,calls,config,options,driverFactory,get released(){return released;},get closed(){return closed;}};
}
test('runner returns the same claim session and saves actual-match-shaped evidence without advancing its claim phase',async t=>{
  const f=runningFixture(t),screens=[frame('CAREER\nOVERVIEW\nUID:'+UID+'\nACCOUNT LEVEL 1'),frame('PRACTICE VS AI\nSTART'),frame('PRACTICE VS AI\nSTART'),
    frame('SELECT YOUR HERO\nTHE PUNISHER\nCONFIRM'),gameFrame(),frame('VICTORY\nNEXT'),frame('ACCOUNT XP EARNED +450')];
  const result=await run(f.config,{...f.options,driverFactory:f.driverFactory(screens)});
  assert.equal(result.status,'complete');assert.equal(result.matches[0].earnedXp,450);assert.equal(f.closed,1);assert.equal(f.released,1);
  const j=f.q.status().jobs[0];assert.equal(j.phase,'collected');assert.equal(j.lease,null);assert.equal(j.rivalsUid,UID);
  assert.equal(fs.existsSync(path.join(f.root,'commission.json')),false); // XP alone cannot commission combat.
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
test('retained takeover owns only the verified active account while the global queue stays paused',t=>{
  const f=runningFixture(t);f.q.pause(false);const params={rivalsUid:UID,holdId:'test-hold-fixture',confirmedAt:new Date().toISOString()};
  assert.throws(()=>f.q.acquireRetainedTest('level-worker',f.id,params),/verified retained/);
  f.q.store.transact(d=>{d.jobs[0].phase='verified';d.jobs[0].verifiedRewards=['fixture-reward'];});
  assert.throws(()=>f.q.acquire('level-worker',f.id),/Queue paused/);
  assert.throws(()=>f.q.acquireRetainedTest('level-worker',f.id,{...params,rivalsUid:'987654321'}),/exact verified/);
  const lease=f.q.acquireRetainedTest('level-worker',f.id,params);assert.equal(f.q.status().enabled,false);assert.equal(lease.job.phase,'verified');
  assert.throws(()=>f.q.acquireRetainedTest('another-worker',f.id,params),/Another worker/);
  f.q.releaseLease(f.id,lease.leaseToken);assert.equal(f.q.status().enabled,false);
});
test('retained stock requires the exact paused remote offer, unchanged delivery and no other commitment',async()=>{
  function fixture({remoteState='Paused',status='paused',foreign=0,sale=0,expired=false,changedDelivery=false}={}){
    const id='a'.repeat(24),listingId='c'.repeat(24),request={id:'rivals-retained-fixture',steamId:id,steamLogin:'fixture_steam',holdId:'reward-fixture',testHoldId:'test-hold-fixture'};
    const entries=[{accountLogin:'fixture_steam',accountPassword:'fake-fixture-secret'}],crypto=require('node:crypto');
    const prep={status:'held',steamId:id,twitchId:'twitch-fixture',holdId:request.holdId,reservedCount:58,listingId,gameReport:{sessionRetention:{mode:'owner-retained'}},
      levelingTestHold:{id:request.testHoldId,listingId,externalId:'offer-fixture',expiresAt:new Date(Date.now()+(expired?-60000:60000)),stockHash:crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')}};
    const listing={kind:'rivals',preparationId:request.id,status,externalId:'offer-fixture',accounts:[{steamAccountId:id,state:'listed'}]};
    const db={collection(name){return {async findOne(){return name==='steamaccounts'?{stage:'listed',notes:request.id,accountName:request.steamLogin}:name==='steamlistings'?listing:prep;},
      async countDocuments(){return ({steamlistings:foreign,steamsales:sale,droplogs:58})[name]??0;}};}};
    const mongo={Types:{ObjectId:function(s){this.toString=()=>s;}},connect:async()=>{},disconnect:async()=>{},connection:{db}};
    const load=n=>n==='dotenv'?{config(){}}:n==='mongoose'?mongo:n==='node:crypto'?crypto:n==='axios'?{interceptors:{request:{use(){}},response:{use(){}}}}:n==='./utils/settings'?{}:
      {getAccountOffer:async()=>({offerState:remoteState,quantity:1}),getAccountEntries:async()=>changedDelivery?[{accountLogin:'another_fixture'}]:entries};
    return {request,load};
  }
  const good=fixture();assert.equal((await remoteCheck(good.request,{load:good.load})).retainedTest,true);
  for(const changes of [{remoteState:'Active'},{status:'active'},{foreign:1},{sale:1},{expired:true},{changedDelivery:true}]){
    const f=fixture(changes);await assert.rejects(remoteCheck(f.request,{load:f.load}));
  }
});

test('depth routing prefers an open passage over the objective behind a wall',()=>{
  const {corridors}=require('../tools/rivals-level-worker/perception.cjs');
  const w=72,h=48,d=Array(w*h).fill(.1);for(let y=0;y<h;y++)for(let x=0;x<30;x++)d[y*w+x]=.9;
  const routes=corridors({width:w,height:h,inverseDepth:d},.23);
  assert.ok(routes.length);assert.ok(routes[0].x>.4);assert.ok(routes.find(x=>x.x===.23).obstruction>.8);
});
test('the gameplay navigator prioritizes a visible enemy and reloads an empty rifle',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator();
  const hud=frame('300 / 300');hud.lines[0].x=.48;hud.lines[0].y=.9;
  const hints={enemies:[{x:.505,y:.49,width:.04}],objectives:[]};
  const d=n.step(hud,hints,1000);assert.equal(d.action.fire,true);assert.equal(d.action.dx,0);assert.deepEqual(d.action.keys,[]);
  const correction=n.step(hud,{enemies:[{x:.65,y:.5,width:.04}]},1500);assert.equal(correction.action.fire,undefined);assert.deepEqual(correction.action.keys,[]);
  hud.lines.push({text:'0/40',x:.17,y:.91,width:.05,height:.02,confidence:.99});
  assert.ok(n.step(hud,hints,2000).action.keys.includes('r'));
});
test('the live reward panel binds account XP to the Level row, excluding accessory points',()=>{
  const fields=[['VICTURY',.02,.02,.18,.086],['LEVEL',.09,.417,.022,.013],['1',.093,.439,.015,.031],['227 / 500',.121,.439,.044,.019],['+227',.5,.439,.026,.018],['ACCESSORY POINTS',.092,.495,.068,.014],['+20',.5,.518,.022,.018]];
  const f={lines:fields.map(([text,x,y,width,height])=>({text,x,y,width,height,confidence:.99}))};
  assert.equal(classify(f),'xp');assert.equal(progress(f).earnedXp,227);assert.equal(progress(f).currentXp,227);assert.equal(progress(f).completedMatch,true);
  f.lines=f.lines.filter(l=>l.text!=='+227');assert.equal(progress(f).earnedXp,null);
});

test('coral body outlines survive high resolution while filled scenery and blue allies are rejected',()=>{
  const {outlinedEnemies}=require('../tools/rivals-level-worker/perception.cjs'),w=640,h=415,d=Buffer.alloc(w*h*4);
  const pixel=(x,y,r,g,b)=>{const i=(y*w+x)*4;d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255;};
  for(let y=140;y<195;y++)for(let x=360;x<385;x++)if(x<362||x>=383||y<142||y>=193)pixel(x,y,230,120,110);
  for(let y=150;y<200;y++)for(let x=120;x<160;x++)pixel(x,y,230,120,110);
  for(let y=130;y<190;y++)for(let x=450;x<475;x++)pixel(x,y,50,100,230);
  const targets=outlinedEnemies(d,w,h);assert.equal(targets.length,1);assert.ok(targets[0].x>.55&&targets[0].x<.62);
  assert.equal(outlinedEnemies(d,w,h,[],{requireOpponentLabel:true}).length,0);
});

 test('a dim outline requires its red enemy label and blue names veto a muzzle flash',()=>{
  const {outlinedEnemies,excludeFriendlyNameplates}=require('../tools/rivals-level-worker/perception.cjs'),w=640,h=415,d=Buffer.alloc(w*h*4);
  const pixel=(x,y,r,g,b)=>{const i=(y*w+x)*4;d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255;};
  for(let y=140;y<195;y++)for(let x=360;x<385;x++)if(x<362||x>=383||y<142||y>=193)pixel(x,y,195,100,100);
  assert.equal(outlinedEnemies(d,w,h).length,0);
  const label={text:'ENEMY',x:350/w,y:120/h,width:45/w,height:10/h,confidence:.99};
  for(let y=120;y<130;y++)for(let x=350;x<395;x++)pixel(x,y,230,80,80);
  const named=outlinedEnemies(d,w,h,[label]);assert.equal(named.length,1);assert.equal(named[0].source,'named-coral-outline');
  for(let y=120;y<130;y++)for(let x=350;x<395;x++)pixel(x,y,40,90,230);
  assert.equal(excludeFriendlyNameplates(named,d,w,h,[label]).length,0);
 });

test('a retained roster scroll is reset before preview and a wrong title never confirms',()=>{
  let now=1000;const e=new Engine({expectedUid:UID,now:()=>now});baseline(e);e.step(frame('PRACTICE VS AI\nSTART'));
  const wrong=frame('SELECT YOUR HERO\nGORR\nDIFFICULTY\nTEAM-UP ABILITIES\nCONFIRM');wrong.lines.at(-1).x=.85;wrong.lines.at(-1).width=.1;
  const scroll=e.step(wrong);assert.equal(scroll.action.command,'scroll');assert.equal(scroll.action.pulses,48);
  const preview=e.step(wrong);assert.equal(preview.action.command,'click');assert.equal(preview.action.x,.93);
  assert.equal(e.step(wrong).wait,true);now+=9000;assert.throws(()=>e.step(wrong),/left-side title/);
});

test('the mode picker can return from its retained Practice tab before selecting AI',()=>{
  const e=new Engine({expectedUid:UID});baseline(e);
  const f=frame('SELECT MODE\nRIVALRY\nPRACTICE\nPRACTICE RANGE\nTUTORIAL');
  const d=e.step(f);assert.equal(d.kind,'mode-menu');assert.equal(d.action.command,'click');assert.equal(d.queue,undefined);
});

test('an unselected live roster is recognized before any hero difficulty label appears',()=>{
  const f=frame('CONVOY\nCONFIRM\nGAME STARTED\nTEAM-UP ABILITIES');
  assert.equal(classify(f),'hero-select');
});

test('the roster transition waits for its controls and an idle overlay does not hide hero selection',()=>{
  let now=1000;const e=new Engine({expectedUid:UID,now:()=>now});baseline(e);e.step(frame('PRACTICE VS AI\nSTART'));
  const loading=frame('CONFIRM YOUR HERO\nTEAM-UP ABILITIES');assert.equal(e.step(loading).wait,true);
  const overlay=frame("You are about to be removed\nYou've been idle for a while\nCONFIRM\nGAME STARTED\nTEAM-UP ABILITIES");
  assert.equal(classify(overlay),'hero-select');
  const full=frame('CONFIRM YOUR HERO\nTHE PUNISHER\nDIFFICULTY\nTEAM-UP ABILITIES\nCONFIRM');now+=3000;
  assert.equal(e.step(full).action.command,'click');assert.equal(e.inMatch,true);
});

test('map loading lore about captured deities is not a combat HUD',()=>{
  assert.equal(classify(frame('GOD QUARRY\nQUICK MATCH - DOMINATION\nThe other captured deities are tormented relentlessly\n871657 651710 1700')),'preparing');
});

test('a teammate disconnect chat line is distinct from this client losing connection',()=>{
  const f=gameFrame();f.lines.push({text:'• [System] Ty65432 has disconnected from the server and',x:.01,y:.79,width:.4,height:.02,confidence:.99});
  assert.equal(classify(f),'combat');assert.equal(classify(frame('CONNECTION LOST\nRECONNECT')),'blocked');
  assert.equal(classify(frame('SPACE\nSKIP')),'intro');
});

test('a visible objective circle and side chevron turn away from a forward wall',()=>{
  const {objectiveArrows}=require('../tools/rivals-level-worker/perception.cjs'),{Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),w=320,h=200,d=Buffer.alloc(w*h*4);
  const px=(x,y,c)=>{const i=(y*w+x)*4;for(let k=0;k<3;k++)d[i+k]=c[k];d[i+3]=255;};
  for(let y=104;y<=116;y++)for(let x=42;x<=54;x++)if((x-48)**2+(y-110)**2<36)px(x,y,[250,130,90]);
  for(let y=108;y<112;y++)for(let x=46;x<50;x++)px(x,y,[240,240,240]);
  assert.equal(objectiveArrows(d,w,h).length,0);
  for(let y=106;y<114;y++)for(let x=36;x<39;x++)px(x,y,[230,230,230]);
  const arrows=objectiveArrows(d,w,h);assert.equal(arrows.length,1);assert.equal(arrows[0].bearing,'left');
  const decision=new Navigator().step(gameFrame(),{enemies:[],navigationMarkers:arrows},1000);assert.ok(decision.action.dx<0);assert.deepEqual(decision.action.keys,[]);
  for(let y=106;y<114;y++)for(let x=36;x<39;x++)px(x,y,[0,0,0]);
  for(let y=106;y<114;y++)for(let x=58;x<61;x++)px(x,y,[230,230,230]);
  assert.equal(objectiveArrows(d,w,h)[0].bearing,'left');
});

test('spawn navigation takes the visible exit before an objective behind the wall',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator();
  const d=n.step(gameFrame(),{enemies:[],exits:[{x:.6,y:.5,width:.2,height:.5}],navigationMarkers:[{bearing:'left'}]},1000);
  assert.match(d.reason,/spawn exit/);assert.ok(d.action.dx>0);assert.deepEqual(d.action.keys,[]);
});
test('a traversable center after turning is advanced into before another exploratory turn',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator(),w=72,h=48,d=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)d.push(.1+y*.01+(x<30?.7:0));
  const hints={enemies:[],depth:{width:w,height:h,inverseDepth:d}};
  const hud=gameFrame();hud.lines.push({text:'82M',x:.75,y:.5,width:.03,height:.02,confidence:.99});
  const first=n.step(hud,hints,1000);assert.equal(first.action.keys.length,0);
  hints.depth={width:w,height:h,inverseDepth:d.map((v,i)=>.1+Math.floor(i/w)*.01+(i%w<18?.7:0))};
  assert.ok(n.step(hud,hints,2000).action.keys.includes('w'));
});

test('an unselected roster with suggested picks survives a misread hero prompt',()=>{
  const f=frame('CONFIRM YOUR HERD\nCONFIRM\nSUGGESTED PICK: VANGUARD\nTEAM-UP ABILITIES');
  f.lines.find(l=>l.text==='CONFIRM').x=.8;f.lines.find(l=>l.text==='CONFIRM').width=.1;
  assert.equal(classify(f),'hero-select');const e=new Engine({expectedUid:UID});baseline(e);e.modeVerified=true;
  assert.equal(e.step(f).action.command,'scroll');
  e.step(frame('Roster transition'));assert.equal(e.step(f).action.command,'click');
});
test('world distance tolerates the observed Cyrillic glyphs without reading the footer',()=>{
  const {worldDistance}=require('../tools/rivals-level-worker/vision.cjs'),f=gameFrame();
  f.lines.push({text:'Î_1ЗBМ+',x:.6,y:.5,width:.05,height:.02,confidence:.99});assert.equal(worldDistance(f).meters,138);
  f.lines.at(-1).y=.97;assert.equal(worldDistance(f),null);
  const hud=frame('');hud.lines.push({text:'04:40',x:.48,y:.05,width:.04,height:.02,confidence:.99},{text:'D 39/4ąłś',x:.15,y:.92,width:.12,height:.02,confidence:.99});
  assert.equal(classify(hud),'combat');
});
test('a doorway needs body clearance on the left of the crosshair',()=>{
  const {corridors}=require('../tools/rivals-level-worker/perception.cjs'),w=72,h=48,d=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)d.push(x<w*.465?.9:.1+y*.008);
  const paths=corridors({width:w,height:h,inverseDepth:d});assert.ok(paths[0].x>.5);assert.ok(paths.find(p=>p.x===.5).obstruction>.8);
});
test('green side rails form an exit while a solid foliage patch does not',()=>{
  const w=320,h=200,make=solid=>{const d=Buffer.alloc(w*h*4);for(let y=45;y<130;y++)for(let x=120;x<180;x++)if(solid||x<128||x>171||y<51){const i=(y*w+x)*4;d[i]=80;d[i+1]=150;d[i+2]=40;d[i+3]=255;}return features(d,w,h);};
  assert.equal(make(false).exits.length,1);
  // A connected bush is narrower at its edges than in its solid center.
  const d=Buffer.alloc(w*h*4);for(let y=45;y<130;y++)for(let x=120;x<180;x++)if(x>130&&x<170||y>80&&y<87){const i=(y*w+x)*4;d[i]=80;d[i+1]=150;d[i+2]=40;d[i+3]=255;}
  assert.equal(features(d,w,h).exits.length,0);
});

test('a bottom objective glyph with its lower chevron turns back before walking',()=>{
  const {objectiveArrows}=require('../tools/rivals-level-worker/perception.cjs'),{Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),w=320,h=200,d=Buffer.alloc(w*h*4),white=(x,y)=>{const i=(y*w+x)*4;d[i]=d[i+1]=d[i+2]=240;d[i+3]=255;};
  for(let y=136;y<144;y++)for(let x=130;x<138;x++)white(x,y);
  for(let y=151;y<155;y++)for(let x=130;x<134;x++)white(x,y);
  const arrows=objectiveArrows(d,w,h);assert.equal(arrows.length,1);assert.equal(arrows[0].behind,true);
  const decision=new Navigator().step(gameFrame(),{enemies:[],navigationMarkers:arrows},1000);assert.equal(decision.action.dx,-300);assert.deepEqual(decision.action.keys,[]);
});
test('respawn discards the previous obstacle detour and target history',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator();Object.assign(n,{detourUntil:50000,detourSide:'d',pendingTurn:true,lastTargetAt:20000,lastTurn:1,lastGoalAt:21000,portalWalked:true,leftSpawn:true});
  n.reset();assert.deepEqual(n,new Navigator());
});

test('the retained-session deadline stops an already-owned runner before further input',async t=>{
  const f=runningFixture(t);f.q.pause(false);f.q.store.transact(d=>{d.jobs[0].phase='verified';d.jobs[0].verifiedRewards=['fixture-reward'];});
  let clock=Date.now();const deadline=clock+30000;
  f.config.retainedTest={holdId:'test-hold-fixture',confirmedAt:new Date(clock).toISOString(),authorizedUntil:new Date(deadline).toISOString()};
  const driver=f.driverFactory([])();const request=driver.request.bind(driver);driver.request=async p=>{const result=await request(p);if(p.command==='focus')clock=deadline+1;return result;};
  await assert.rejects(run(f.config,{...f.options,now:()=>clock,driverFactory:()=>driver}),/test window ended/);
  assert.deepEqual(f.calls,['focus']);assert.equal(f.closed,1);assert.equal(f.released,1);assert.equal(f.q.status().jobs[0].lease,null);assert.equal(f.q.status().enabled,false);
});

test('a verified domination round transition preserves the match and resets its route',()=>{
  const e=new Engine({expectedUid:UID});start(e);e.navigator.leftSpawn=true;e.navigator.detourUntil=50000;
  const f=frame('CAPTURE THE ROYAL PALACE\nThrone Room\nCAPTURED\nNEXT OBJECTIVE\nOdin Archive');
  assert.equal(classify(f),'round-transition');assert.equal(e.step(f).wait,true);assert.equal(e.inMatch,true);assert.equal(e.navigator.leftSpawn,false);assert.equal(e.navigator.detourUntil,0);
});
test('a side-route maneuver is completed before turning back toward the blocked objective',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator();n.detourSide='d';n.detourUntil=5000;
  const decision=n.step(gameFrame(),{enemies:[],navigationMarkers:[{x:.1,bearing:'left'}]},1000);assert.deepEqual(decision.action.keys,['d']);assert.match(decision.reason,/clearer side/);
});
test('a red AI world name can supply a large hero target when no thin body outline survives',()=>{
  const {outlinedEnemies}=require('../tools/rivals-level-worker/perception.cjs'),w=640,h=415,d=Buffer.alloc(w*h*4),label={text:'DINOSAUR-Easy',x:.45,y:.28,width:.12,height:.016,confidence:.99};
  for(let y=117;y<121;y++)for(let x=290;x<360;x++){const i=(y*w+x)*4;d[i]=200;d[i+1]=60;d[i+2]=50;d[i+3]=255;}
  const targets=outlinedEnemies(d,w,h,[label]);assert.equal(targets.length,1);assert.equal(targets[0].source,'enemy-nameplate');assert.ok(targets[0].y>label.y);
  label.y=.05;assert.equal(outlinedEnemies(d,w,h,[label]).length,0);
});

test('domination combat remains visible through rifle ammo and its shift ability when HP OCR drops',()=>{
  const f=frame('');f.lines.push({text:'D 40/40',x:.11,y:.91,width:.1,height:.02,confidence:.99},{text:'LSHIFT',x:.82,y:.94,width:.03,height:.02,confidence:.99});
  assert.equal(classify(f),'combat');f.lines.push({text:'АTTАCК',x:.4,y:.5,width:.04,height:.02,confidence:.99});assert.ok(require('../tools/rivals-level-worker/vision.cjs').worldObjective(f));
});

test('the actual XP row remains a reward when the tiny level digit is unreadable',()=>{
  const fields=[['VICTURY',.02,.02,.18,.086],['LEVEL',.09,.417,.022,.013],['454 / 500',.121,.439,.044,.019],['+227',.5,.439,.026,.018],['ACCESSORY POINTS',.092,.495,.068,.014],['HOLD TO SKIP',.85,.9,.12,.02],['SPACE',.8,.9,.04,.02]];
  const f={lines:fields.map(([text,x,y,width,height])=>({text,x,y,width,height,confidence:.99}))};assert.equal(classify(f),'xp');assert.equal(progress(f).level,null);assert.equal(progress(f).earnedXp,227);
});
test('returning directly to Play or a team screen cannot skip the reward requirement',()=>{
  const e=new Engine({expectedUid:UID});start(e);
  assert.throws(()=>e.step(frame('PLAY\nCHANGE MODE\nPRACTICE VS AI\nSTART')),/without a completed-match result/);
  assert.throws(()=>e.step(frame('ONE MORE ROUND\nSCOREBOARD\nBACK')),/XP was not verified/);
});

test('fast combat only fires after centering and stops on a fresh-frame focus mismatch',async t=>{
  const {aim,track}=require('../tools/rivals-level-worker/combat.cjs');assert.equal(aim({x:.5,y:.5,width:.04}).fire,true);assert.equal(aim({x:.65,y:.5,width:.04}).fire,false);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rivals-track-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[];
  assert.equal(await track({driver:{async request(p){calls.push(p);return {frontmostPid:999,capturedAt:new Date().toISOString()};}},target:{pid:123},seed:{x:.5,y:.5},reference:{lines:[]},directory:root,prefix:'fixture',guard(){}}),0);
  assert.deepEqual(calls.map(c=>c.command),['capture']);assert.equal(calls[0].ocr,false);assert.equal(calls[0].maxWidth,1280);
});

test('navigation levels the camera after losing an elevated target even with a destination',()=>{
  const {Navigator}=require('../tools/rivals-level-worker/navigator.cjs'),n=new Navigator(),f=gameFrame();n.pitchDelta=-100;f.lines.push({text:'82M',x:.5,y:.5,width:.03,height:.02,confidence:.99});
  const d=n.step(f,{enemies:[]},1000);assert.equal(d.action.dy,100);assert.deepEqual(d.action.keys,[]);
  const onlyAmmo=frame('');onlyAmmo.lines.push({text:'0 08 40/40',x:.11,y:.91,width:.1,height:.02,confidence:.99});assert.equal(classify(onlyAmmo),'combat');
});
