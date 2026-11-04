'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Queue}=require('../rivals-claim-worker/queue.cjs');
const {Driver}=require('./driver.cjs');
const {Engine,OWNER}=require('./engine.cjs');
const {BadgeReader}=require('./badge.cjs');
const vision=require('./vision.cjs'),stock=require('./stock-check.cjs');
const base=process.env.RIVALS_LEVEL_DIR||path.join(os.homedir(),'Library/Application Support/RivalsLevelWorker');
const claimDir=process.env.RIVALS_WORKER_DIR||path.join(os.homedir(),'Library/Application Support/RivalsClaimWorker');
const binary=path.join(base,'native'),stopFile=path.join(base,'STOP');
function save(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
function preparation(queue,id){
  const job=queue.status().jobs.find(j=>j.id===id);
  if(!job||!['collected','verified'].includes(job.phase)||!['running','pending'].includes(job.state)||!job.rivalsUid)throw Error('Use an active held preparation after mailbox collection and before sign-out');
  if(job.lease)throw Error('Another worker still owns the game session; wait for its explicit handoff even if the lease has expired');
  return job;
}
async function loadFeatures(output){
  const pixels=await require('sharp')(output).resize({width:384}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return vision.features(pixels.data,pixels.info.width,pixels.info.height);
}
async function run(config,{queue=new Queue(claimDir),checkStock=stock.check,driverFactory=b=>new Driver(b),now=Date.now,
  directoryRoot=base,readFeatures=loadFeatures,emergencyRelease=()=>spawnSync(binary,[],{input:JSON.stringify({command:'release-all'})+'\n',stdio:['pipe','ignore','ignore'],timeout:3000})}={}){
  const runStopFile=path.join(directoryRoot,'STOP');
  const job=preparation(queue,config.id);
  if(!Number.isInteger(config.pid)||config.pid<1||typeof config.title!=='string'||!config.title.trim())throw Error('Exact observed game PID and title required');
  const minutes=config.minutes??30;
  if(!Number.isFinite(minutes)||minutes<1||minutes>120)throw Error('Runtime limit must be 1-120 minutes');
  if(fs.existsSync(runStopFile))throw Error('STOP file is present; inspect the previous run before removing it');
  if((config.matches??1)>1){
    let commission;try{commission=JSON.parse(fs.readFileSync(path.join(directoryRoot,'commission.json'),'utf8'));}catch{}
    if(!commission?.positiveAccountXp||!commission?.combatFrames)throw Error('Complete one observed benchmark before enabling repeated matches');
  }
  const engine=new Engine({expectedUid:job.rivalsUid,targetLevel:config.targetLevel??15,maxMatches:config.matches??1,now});
  await checkStock(job);
  const acquired=queue.acquire(OWNER+':'+crypto.randomUUID(),job.id);
  if(!acquired||acquired.job.id!==job.id)throw Error('Could not acquire the exact claim session');
  let driver,badge,lockOwned=false,interrupted=false,token=acquired.leaseToken;
  const lock=path.join(directoryRoot,'run.lock');
  const directory=path.join(directoryRoot,'runs',new Date(now()).toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
  const target={pid:config.pid,title:config.title,stopFile:runStopFile};
  let result={id:job.id,steamAccountId:job.steamAccountId,uid:job.rivalsUid,status:'running',events:[],startedAt:new Date(now()).toISOString()};
  const record=()=>save(path.join(directory,'run.json'),{...result,...engine.state()});
  const stop=()=>{interrupted=true;};
  try{
    // Never steal a stale lock automatically; preserve the previous run for review.
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,id:job.id}),{mode:0o600,flag:'wx'});lockOwned=true;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});record();
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    driver=driverFactory(binary);
    // Focus is requested once. Later focus loss always stops the worker.
    await driver.request({command:'focus',...target});
    let heartbeatAt=0;
    for(let frameNo=0;!engine.complete;frameNo++){
      if(interrupted||fs.existsSync(runStopFile))throw Error('Stopped by owner');
      if(now()-engine.startedAt>minutes*60000)throw Error('Runtime limit reached');
      if(now()-heartbeatAt>10000){queue.heartbeat(job.id,token);heartbeatAt=now();}
      const output=path.join(directory,String(frameNo).padStart(5,'0')+'.png');
      const frame=await driver.request({command:'capture',...target,output});
      if(frame.frontmostPid!==config.pid)throw Error('Game lost focus');
      if(!Number.isFinite(Date.parse(frame.capturedAt))||now()-Date.parse(frame.capturedAt)>5000)throw Error('Screenshot/OCR is too old for live game control');
      if(vision.classify(frame)==='career'&&vision.progress(frame).level===null){
        badge??=new BadgeReader(directoryRoot);frame.accountLevelBadge=await badge.read(output);
      }
      const hints=await readFeatures(output);
      const decision=engine.step(frame,hints);
      const keep=frameNo%15===0||result.events.at(-1)?.kind!==decision.kind||['career','xp','result'].includes(decision.kind);
      save(output+'.json',{...frame,hints,decision});
      result.events.push({frame:frameNo,kind:decision.kind,at:frame.capturedAt,action:decision.action?.command??null,retained:true});record();
      if(decision.done)break;
      if(decision.queue)await checkStock(job);
      if(decision.action){
        queue.heartbeat(job.id,token);
        if(interrupted)throw Error('Stopped by owner');
        if(now()-Date.parse(frame.capturedAt)>5000)throw Error('Observed controls are too old after verification');
        await driver.request({...decision.action,...target,expectedBounds:frame.window?.bounds});
      }else await new Promise(resolve=>setTimeout(resolve,750));
      if(!keep){fs.unlinkSync(output);fs.unlinkSync(output+'.json');result.events.at(-1).retained=false;record();}
    }
    result.status='complete';record();
    const positiveAccountXp=engine.matches.reduce((n,m)=>n+m.earnedXp,0),combatFrames=result.events.filter(e=>e.kind==='combat').length;
    if(positiveAccountXp>0&&combatFrames>0)save(path.join(directoryRoot,'commission.json'),{positiveAccountXp,combatFrames,run:directory,uid:job.rivalsUid,at:new Date(now()).toISOString()});
    return {...result,...engine.state(),directory};
  }catch(e){result.status='stopped';result.reason=e.message;if(fs.existsSync(directory))record();throw Object.assign(e,{directory});}
  finally{
    if(driver)await driver.close().catch(()=>{});
    if(badge)await badge.close().catch(()=>{});
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
    if(p.status!==0)throw Error('Native driver did not compile');console.log(JSON.stringify({ok:true,binary}));return;
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
module.exports={run,preparation};
