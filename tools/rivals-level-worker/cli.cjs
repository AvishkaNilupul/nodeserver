'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Queue}=require('../rivals-claim-worker/queue.cjs');
const {Driver}=require('./driver.cjs');
const {WineDriver}=require('./wine-driver.cjs');
const {Engine,OWNER}=require('./engine.cjs');
const {BadgeReader}=require('./badge.cjs');
const {DepthReader}=require('./depth.cjs');
const {outlinedEnemies,excludeFriendlyNameplates,objectiveArrows}=require('./perception.cjs');
const vision=require('./vision.cjs'),stock=require('./stock-check.cjs');
const base=process.env.RIVALS_LEVEL_DIR||path.join(os.homedir(),'Library/Application Support/RivalsLevelWorker');
const claimDir=process.env.RIVALS_WORKER_DIR||path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker');
const binary=path.join(base,'native'),stopFile=path.join(base,'STOP');
function save(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
function preparation(queue,id,retainedTest){
  const job=queue.status().jobs.find(j=>j.id===id);
  if(!job||!['collected','verified'].includes(job.phase)||!['running','pending'].includes(job.state)||!job.rivalsUid)throw Error('Use an active held preparation after mailbox collection and before sign-out');
  if(job.lease&&(job.lease.active||!retainedTest))throw Error('Another worker still owns the game session; wait for its explicit handoff even if the lease has expired');
  if(retainedTest&&(job.phase!=='verified'||!retainedTest.holdId||!Number.isFinite(Date.parse(retainedTest.confirmedAt))))throw Error('Exact verified retained-session handoff required');
  return job;
}
async function loadFeatures(output,depth,combat=true,frame={lines:[]}){
  if(!combat)return {enemies:[],objectives:[]};
  const sharp=require('sharp');
  const [pixels,detail]=await Promise.all([sharp(output).resize({width:384}).ensureAlpha().raw().toBuffer({resolveWithObject:true}),sharp(output).resize({width:1280}).ensureAlpha().raw().toBuffer({resolveWithObject:true})]);
  const hints=vision.features(pixels.data,pixels.info.width,pixels.info.height);
  hints.navigationMarkers=objectiveArrows(detail.data,detail.info.width,detail.info.height);
  const practiceRange=frame.lines.some(l=>/PRACTICE RANGE/i.test(l.text));
  hints.healthBars=hints.enemies;hints.enemies=excludeFriendlyNameplates(outlinedEnemies(detail.data,detail.info.width,detail.info.height,frame.lines,{requireOpponentLabel:!practiceRange}),detail.data,detail.info.width,detail.info.height,frame.lines);
  if(depth)hints.depth=await depth.read(output);
  return hints;
}
async function run(config,{queue=new Queue(claimDir),checkStock=stock.check,driverFactory=(b,o)=>o.bottle?new WineDriver(b,o):new Driver(b),now=Date.now,
  directoryRoot=base,readFeatures=loadFeatures,emergencyRelease=()=>spawnSync(binary,[],{input:JSON.stringify({command:'release-all'})+'\n',stdio:['pipe','ignore','ignore'],timeout:3000})}={}){
  const runStopFile=path.join(directoryRoot,'STOP');
  const job=preparation(queue,config.id,config.retainedTest);
  if(!Number.isInteger(config.pid)||config.pid<1||typeof config.title!=='string'||!config.title.trim())throw Error('Exact observed game PID and title required');
  if(config.captureMethod!==undefined&&!['system','display-kit'].includes(config.captureMethod))throw Error('Invalid display capture method');
  const minutes=config.minutes??30;
  const retainedUntil=config.retainedTest?.authorizedUntil?Date.parse(config.retainedTest.authorizedUntil):Infinity;
  if(Number.isNaN(retainedUntil))throw Error('Invalid retained-session deadline');
  if(!Number.isFinite(minutes)||minutes<1||minutes>120)throw Error('Runtime limit must be 1-120 minutes');
  if(fs.existsSync(runStopFile))throw Error('STOP file is present; inspect the previous run before removing it');
  if((config.matches??1)>1){
    let commission;try{commission=JSON.parse(fs.readFileSync(path.join(directoryRoot,'commission.json'),'utf8'));}catch{}
    if(!commission?.positiveAccountXp||!commission?.combatFrames||!(commission?.verifiedDamage>0))throw Error('Complete one observed benchmark before enabling repeated matches');
  }
  const engine=new Engine({expectedUid:job.rivalsUid,expectedName:config.nickname,targetLevel:config.targetLevel??15,maxMatches:config.matches??1,now});
  const verifyStock=()=>checkStock(job,{testHoldId:config.retainedTest?.holdId});
  await verifyStock();
  const owner=OWNER+':'+crypto.randomUUID();
  const acquired=config.retainedTest?queue.acquireRetainedTest(owner,job.id,{rivalsUid:job.rivalsUid,...config.retainedTest}):queue.acquire(owner,job.id);
  if(!acquired||acquired.job.id!==job.id)throw Error('Could not acquire the exact claim session');
  let driver,badge,depth,lockOwned=false,interrupted=false,token=acquired.leaseToken;
  const lock=path.join(directoryRoot,'run.lock');
  const directory=path.join(directoryRoot,'runs',new Date(now()).toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
  const target={pid:config.pid,title:config.title,stopFile:runStopFile,captureMethod:config.captureMethod};
  let result={id:job.id,steamAccountId:job.steamAccountId,uid:job.rivalsUid,status:'running',events:[],startedAt:new Date(now()).toISOString()};
  const record=()=>save(path.join(directory,'run.json'),{...result,...engine.state()});
  const stop=()=>{interrupted=true;};
  try{
    // Never steal a stale lock automatically; preserve the previous run for review.
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,id:job.id}),{mode:0o600,flag:'wx'});lockOwned=true;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});record();
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    if(config.depth){depth=new DepthReader(path.join(directoryRoot,'depth-native'),path.join(directoryRoot,'models/DepthAnythingV2SmallF16.mlpackage'));await depth.ready;queue.heartbeat(job.id,token);}
    driver=driverFactory(binary,{bottle:config.bottle,directoryRoot});
    // Focus is requested once. Later focus loss always stops the worker.
    await driver.request({command:'focus',...target});
    if(depth){
      const warmup=path.join(directory,'perception-warmup.png');
      await driver.request({command:'capture',...target,output:warmup});
      await loadFeatures(warmup,depth);queue.heartbeat(job.id,token);
    }
    let heartbeatAt=0,lastMenuAction=null,menuRepeats=0,queueVerifiedAt=0,attackProofs=0,staleDecisions=0;
    for(let frameNo=0;!engine.complete;frameNo++){
      if(interrupted||fs.existsSync(runStopFile))throw Error('Stopped by owner');
      if(now()>=retainedUntil)throw Error('Retained-session test window ended');
      if(now()-engine.startedAt>minutes*60000)throw Error('Runtime limit reached');
      if(now()-heartbeatAt>10000){queue.heartbeat(job.id,token);heartbeatAt=now();}
      const output=path.join(directory,String(frameNo).padStart(5,'0')+'.png');
      const frame=await driver.request({command:'capture',...target,output});
      if(frame.frontmostPid!==config.pid)throw Error('Game lost focus');
      if(!Number.isFinite(Date.parse(frame.capturedAt))||now()-Date.parse(frame.capturedAt)>5000)throw Error('Screenshot/OCR is too old for live game control');
      if(vision.classify(frame)==='career'&&vision.progress(frame).level===null){
        badge??=new BadgeReader(directoryRoot);frame.accountLevelBadge=await badge.read(output);
      }
      if(vision.matchLevelPanel(frame)&&vision.progress(frame).level===null){
        badge??=new BadgeReader(directoryRoot);frame.matchLevelBadge=await badge.read(output,{left:.085,top:.433,width:.028,height:.045});
      }
      if(vision.classify(frame)==='scoreboard'&&config.nickname){
        const stats=vision.combatStats(frame,config.nickname),row=frame.lines.find(l=>l.x>.25&&l.x<.39&&vision.normalize(l.text)===vision.normalize(config.nickname));
        if(stats&&row){frame.scoreboardNumbers={name:config.nickname};for(const [key,left,right]of [['damage',.645,.712],['finalHits',.59,.645]])if(stats[key]===null){badge??=new BadgeReader(directoryRoot);frame.scoreboardNumbers[key]=await badge.orangeNumber(output,{left,top:row.y-.008,width:right-left,height:.035});}}
      }
      const hints=await readFeatures(output,depth,vision.classify(frame)==='combat',frame);
      let decision;try{decision=engine.step(frame,hints);}catch(e){save(output+'.json',{...frame,hints,error:e.message});throw e;}
      if(decision.queue&&now()-queueVerifiedAt>10000){
        await verifyStock();queueVerifiedAt=now();
        save(output+'.json',{...frame,hints,decision,actionSuppressed:'Fresh stock verified; re-observe Start before clicking'});
        result.events.push({frame:frameNo,kind:decision.kind,at:frame.capturedAt,action:'verify-stock',retained:true});record();
        // Network verification can outlive the UI freshness budget. Capture a
        // new frame before using its controls rather than relaxing that budget.
        continue;
      }
      if(decision.action&&!['combat','preparing','respawn'].includes(decision.kind)){
        const signature=JSON.stringify([decision.kind,decision.action]);
        menuRepeats=signature===lastMenuAction?menuRepeats+1:1;lastMenuAction=signature;
        if(menuRepeats>3)throw Error('Menu action did not advance the game; inspect the current layout');
      }else{lastMenuAction=null;menuRepeats=0;}
      const attackProof=decision.action?.fire===true&&attackProofs++<8;
      const keep=attackProof||frameNo%15===0||result.events.at(-1)?.kind!==decision.kind||['career','xp','result','scoreboard'].includes(decision.kind);
      save(output+'.json',{...frame,hints,decision});
      result.events.push({frame:frameNo,kind:decision.kind,at:frame.capturedAt,action:decision.action?.command??null,fire:decision.action?.fire??false,reason:decision.reason??null,retained:true});record();
      if(decision.done)break;
      if(decision.action){
        queue.heartbeat(job.id,token);
        if(interrupted)throw Error('Stopped by owner');
        if(now()+(decision.action.milliseconds??1000)>=retainedUntil)throw Error('Retained-session test window ended');
        if(now()-Date.parse(frame.capturedAt)>5000){
          result.events.at(-1).action='reobserve';result.events.at(-1).actionSuppressed='Perception exceeded freshness budget';record();
          if(++staleDecisions>=3)throw Error('Perception exceeded freshness budget three times');continue;
        }
        staleDecisions=0;
        await driver.request({...decision.action,...target,expectedBounds:frame.window?.bounds});
        engine.actionApplied(decision);
        if(config.fastCombat&&decision.kind==='combat'&&decision.target&&['Aligning on visible enemy','Firing at the observed aligned enemy'].includes(decision.reason)){
          await require('./combat.cjs').track({driver,target,seed:decision.target,reference:frame,directory,prefix:String(frameNo).padStart(5,'0'),now,deadline:Math.min(retainedUntil,engine.startedAt+minutes*60000),
            guard:()=>{if(interrupted||fs.existsSync(runStopFile))throw Error('Stopped by owner');queue.heartbeat(job.id,token);},
            record:receipt=>{result.events.push({frame:frameNo,kind:'combat',at:receipt.capturedAt,action:'controls',fire:receipt.action.fire,reason:'Fresh visual target tracking',retained:true,proof:receipt.output});record();}});
        }
      }else await new Promise(resolve=>setTimeout(resolve,750));
      if(!keep){fs.unlinkSync(output);fs.unlinkSync(output+'.json');result.events.at(-1).retained=false;record();}
    }
    result.status='complete';record();
    const positiveAccountXp=engine.matches.reduce((n,m)=>n+m.earnedXp,0),combatFrames=result.events.filter(e=>e.kind==='combat').length;
    const verifiedDamage=engine.matches.reduce((n,m)=>n+(m.combat?.damage??0),0);
    if(positiveAccountXp>0&&combatFrames>0&&verifiedDamage>0)save(path.join(directoryRoot,'commission.json'),{positiveAccountXp,combatFrames,verifiedDamage,run:directory,uid:job.rivalsUid,at:new Date(now()).toISOString()});
    return {...result,...engine.state(),directory};
  }catch(e){result.status='stopped';result.reason=e.message;if(fs.existsSync(directory))record();throw Object.assign(e,{directory});}
  finally{
    if(driver)await driver.close().catch(()=>{});
    if(badge)await badge.close().catch(()=>{});
    if(depth)await depth.close().catch(()=>{});
    // Separate key-up process also covers a native child that exited mid-action.
    if(driver)emergencyRelease();
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    try{queue.releaseLease(job.id,token);}catch{}
    if(lockOwned)fs.unlinkSync(lock);
  }
}
async function main(){
  fs.mkdirSync(base,{recursive:true,mode:0o700});fs.chmodSync(base,0o700);
  const command=process.argv[2]??'status';
  if(command==='build'){
    const p=spawnSync('swiftc',[path.join(__dirname,'native.swift'),'-o',binary],{stdio:'inherit'});
    if(p.status!==0)throw Error('Native driver did not compile');
    const warmup=path.join(base,'native-warmup.png');
    await require('sharp')({create:{width:1024,height:768,channels:3,background:'#20242a'}}).composite([{input:Buffer.from('<svg width="1024" height="768"><text x="80" y="350" fill="white" font-size="64">Rivals Worker Warmup 123</text></svg>')}]).png().toFile(warmup);fs.chmodSync(warmup,0o600);
    const d=new Driver(binary);try{await d.request({command:'analyze',file:warmup});}finally{await d.close();}
    console.log(JSON.stringify({ok:true,binary,warmed:true}));return;
  }
  if(command==='stop'){fs.writeFileSync(stopFile,new Date().toISOString(),{mode:0o600});console.log(JSON.stringify({ok:true,stopping:true}));return;}
  if(command==='status'){
    const q=new Queue(claimDir);console.log(JSON.stringify({ok:true,stopped:fs.existsSync(stopFile),nativeBuilt:fs.existsSync(binary),
      jobs:q.status().jobs.map(j=>({id:j.id,uid:j.rivalsUid,phase:j.phase,state:j.state,lease:j.lease}))}));return;
  }
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>8192)throw Error('Input too large');}
  const config=JSON.parse(raw||'{}');
  if(command==='run'){const result=await run(config);console.log(JSON.stringify({ok:true,result}));return;}
  const driver=new Driver(binary);
  try{
    if(command==='inspect'){
      const state=await driver.request({command:'windows'});
      console.log(JSON.stringify({ok:true,result:{trusted:state.trusted,windows:state.windows.filter(w=>/marvel/i.test(w.title+' '+w.owner)&&w.title&&w.bounds.Width>100&&w.bounds.Height>100)}}));
    }else if(command==='analyze'){
      const frame=await driver.request({command:'analyze',file:config.file});
      if(vision.classify(frame)==='career'&&vision.progress(frame).level===null){
        const reader=new BadgeReader(base);try{frame.accountLevelBadge=await reader.read(config.file);}finally{await reader.close();}
      }
      console.log(JSON.stringify({ok:true,result:{frame,kind:vision.classify(frame),uid:vision.uid(frame),progress:vision.progress(frame)}}));
    }else throw Error('Commands: build, status, inspect, analyze, run, stop');
  }finally{await driver.close();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,directory:e.directory}));process.exitCode=1;});
module.exports={loadFeatures,run,preparation};
