// Production reaches this localhost bridge through the existing SSH tunnel.
// The paired extension performs checkout in the owner's normal Chrome profile.
const crypto=require('crypto');
const {execFile}=require('child_process');
const {validJob}=require('./browser-worker.cjs');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
// The helper polls every 30 s; a job it hasn't taken within pickupMs is
// withdrawn as "unavailable" (nothing reached Epic, so no try is counted).
// Once taken, the helper gives up at 120 s and its tab check at 130-160 s,
// so its own answer, with the reason, lands before resultMs.
const PICKUP_MS=60000,RESULT_MS=180000,SEEN_MS=90000;
const short=s=>String(s||'').slice(0,8);
function createBridge({express,token,now=Date.now,pickupMs=PICKUP_MS,resultMs=RESULT_MS,screenLocked=()=>false,log=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}) {
 if(!token)throw Error('Worker token required');
 const extensionToken=crypto.createHmac('sha256',token).update('epic-claim-extension-v1').digest('hex');
 const app=express();let current=null,lastSeen=0;
 const label=job=>'job '+short(job.id)+' '+(job.mode==='recover'?'recover ':'')+job.displayName+(job.offerId?' offer '+short(job.offerId):'');
 // Labels of finished jobs (never the job: a recovery job holds a login), so
 // a result that arrives too late can still be logged by name.
 const finished=new Map();
 const remember=job=>{finished.set(job.id,label(job));if(finished.size>20)finished.delete(finished.keys().next().value);};
 const seenAgo=()=>lastSeen?Math.round((now()-lastSeen)/1000):null;
 const connected=()=>lastSeen>0&&now()-lastSeen<SEEN_MS;
 app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
 app.use((req,res,next)=>{
  const host=req.get('host')||'';
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))return res.sendStatus(403);
  res.set('Cache-Control','no-store');res.set('X-Frame-Options','DENY');
  next();
 });
 const auth=secret=>(req,res,next)=>equal(req.get('authorization'),'Bearer '+secret)?next():res.sendStatus(401);
 // Why a new job can't run right now, or '' when it can.
 function unavailable() {
  if(!connected())return lastSeen?'Chrome claim helper has not checked in for '+seenAgo()+' s; check that Chrome is open':'Connect Epic Claim Helper at http://127.0.0.1:8123/connect';
  // A locked screen hides every Chrome page; checkouts then stall until the
  // bridge times out (2026-10-31 and 11-01: every claim while locked failed).
  if(screenLocked())return 'Mac screen is locked; unlock it so Chrome can run claims';
  return '';
 }
 // Holds one job until the helper answers. A claim the helper never takes is
 // withdrawn after `pickup`; once taken it has `result` more. A job with
 // `total` keeps one deadline from the start instead (account recovery).
 function hold(job,res,{pickup,result,total,timeoutError}) {
  const started=now();let timer=null;
  const end=(outcome,note)=>{
   if(current?.job.id!==job.id)return;
   current=null;clearTimer(timer);remember(job);
   log(label(job)+' '+note+' after '+Math.round((now()-started)/1000)+' s: '+outcome.status+(outcome.error?' - '+outcome.error:''));
   if(!res.destroyed)res.json(outcome);
  };
  const timedOut=()=>end({status:'error',error:timeoutError},'timed out');
  timer=total?setTimer(timedOut,total):setTimer(()=>end({status:'worker_unavailable',error:'Chrome claim helper did not pick up the job within '+Math.round(pickup/1000)+' s; check that Chrome is open and the Mac screen is unlocked'},'not picked up'),pickup);
  current={job,assigned:false,finish:outcome=>end(outcome,'answered'),
   assign(){
    log(label(job)+' picked up after '+Math.round((now()-started)/1000)+' s');
    if(!total){clearTimer(timer);timer=setTimer(timedOut,result);}
   }};
  log(label(job)+' queued');
 }
 app.get('/connect',(req,res)=>{
  if(req.get('sec-fetch-site')==='cross-site')return res.sendStatus(403);
  res.type('html').send('<!doctype html><title>Epic browser claims</title><style>body{font:18px system-ui;max-width:650px;margin:80px auto;background:#15181f;color:#eee}button{padding:12px;font:inherit}label{display:block;margin:24px 0}</style><h1>Epic browser claims</h1><p>Claims run in your regular Chrome session while Chrome and this Mac are running and the screen is unlocked. Only explicitly free, zero-price games are submitted. Visible security checks pause for you.</p><label><input id="accept" type="checkbox"> Allow free-game checkout, including Epic’s EULA confirmation.</label><label><input id="isolate" type="checkbox"> Clear only Epic browser cookies locally before each claim, signing Epic tabs out.</label><button id="connect" data-token="'+extensionToken+'">Connect Epic Claim Helper</button><p id="status">Use Epic Claim Helper 1.2.0.</p>');
 });
 app.get('/health',auth(token),(_req,res)=>{
  const why=unavailable(),busy=!!current;
  res.json({ok:true,mode:'extension',connected:connected(),busy,screenLocked:!!screenLocked(),ready:!why&&!busy,lastSeenSecondsAgo:seenAgo(),...(why?{reason:why}:busy?{reason:'Mac is running another claim'}:{})});
 });
 app.get('/extension/status',auth(extensionToken),(_req,res)=>{lastSeen=now();res.json({ok:true});});
 app.get('/extension/next',auth(extensionToken),(_req,res)=>{
  lastSeen=now();if(!current||current.assigned)return res.json({job:null});
  current.assigned=true;current.assign();res.json({job:current.job});
 });
 app.post('/extension/otp',auth(extensionToken),async(req,res)=>{
  const b=req.body;
  if(!current||current.job.mode!=='recover'||b.id!==current.job.id||b.lease!==current.job.lease)return res.sendStatus(409);
  const email=current.job.email,since=current.job.startedAt;
  try{const r=await fetch('http://127.0.0.1:3999/api/accounts/'+encodeURIComponent(email)+'/otp?for=epic&since='+encodeURIComponent(since)+'&via=graph',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(23000)});const data=await r.json();res.json({ok:true,...(data.ok&&/^\d{6}$/.test(data.code||'')?{code:data.code}:{waiting:true})});}catch{res.json({ok:true,waiting:true});}
 });
 app.post('/extension/result',auth(extensionToken),(req,res)=>{
  lastSeen=now();const b=req.body||{};
  if(!current||b.id!==current.job.id||b.lease!==current.job.lease){
   // Usually the helper's own answer after the bridge already gave up: it is
   // the only record of what the claim tab actually saw.
   log((finished.get(b.id)||'unknown job '+short(b.id))+' late result ignored: '+String(b.status||'').slice(0,30)+(b.error?' - '+String(b.error).slice(0,300):''));
   return res.sendStatus(409);
  }
  if(!['submitted','already_owned','needs_captcha','session_failed','reauthorized','region_unavailable','not_free','rate_limited','error'].includes(b.status))return res.sendStatus(400);
  if(b.status==='reauthorized'&&(current.job.mode!=='recover'||!(/^[a-f\d]{32}$/i).test(b.code||'')))return res.sendStatus(400);
  current.finish({status:b.status,error:String(b.error||'').slice(0,300),...(b.status==='rate_limited'?{retryAfterSeconds:Number(b.retryAfterSeconds)||0}:{}),...(b.status==='reauthorized'?{code:b.code}:{})});res.json({ok:true});
 });
 app.post('/recover',auth(token),(req,res)=>{
  const b=req.body;
  if(!(/^[a-f\d]{32}$/i).test(b.accountKey||'')||typeof b.displayName!=='string'||!b.displayName||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(b.email||'')||typeof b.password!=='string'||!b.password||b.password.length>256)return res.sendStatus(400);
  if(current)return res.status(409).json({status:'busy'});
  if(!connected())return res.status(503).json({status:'worker_unavailable'});
  const job={id:crypto.randomUUID(),lease:crypto.randomBytes(24).toString('hex'),mode:'recover',accountKey:b.accountKey,displayName:b.displayName,email:b.email,password:b.password,startedAt:new Date(now()).toISOString()};
  // One 240 s budget, as before: reconnect-local.cjs waits 260 s.
  hold(job,res,{total:240000,timeoutError:'Account sign-in timed out'});
 });
 app.post('/claim',auth(token),(req,res)=>{
  const b=req.body;
  if(!validJob(b)||!b.displayName||String(b.displayName).length>100)return res.status(400).json({status:'error',error:'Invalid claim job'});
  if(current)return res.status(409).json({status:'busy',error:'Browser claim already in progress'});
  const why=unavailable();
  if(why){log('claim for '+String(b.displayName).slice(0,100)+' offer '+short(b.offerId)+' refused: '+why);return res.status(503).json({status:'worker_unavailable',error:why});}
  const job={id:crypto.randomUUID(),lease:crypto.randomBytes(24).toString('hex'),exchangeCode:b.exchangeCode,namespace:b.namespace,offerId:b.offerId,accountKey:b.accountKey,displayName:b.displayName};
  hold(job,res,{pickup:pickupMs,result:resultMs,timeoutError:'Browser checkout timed out; verify library'});
 });
 return {app,extensionToken};
}
// macOS adds CGSSessionScreenIsLocked to the console session while the screen
// is locked. Unknown (ioreg failed) counts as unlocked, so it never blocks claims.
const screenLockedIn=plist=>/<key>CGSSessionScreenIsLocked<\/key>\s*(?:<true\/>|<integer>1<\/integer>)/.test(String(plist||''));
function readScreenLocked() {
 return new Promise(resolve=>execFile('/usr/sbin/ioreg',['-n','Root','-d1','-a'],{timeout:5000,maxBuffer:4<<20},(err,out)=>resolve(!err&&screenLockedIn(out))));
}
function start(){
 const log=line=>console.log(new Date().toISOString()+' '+line);
 // Polled in the background so request handlers stay synchronous.
 // EPIC_CLAIM_ALLOW_LOCKED=1 lets claims run while locked (still logged).
 let locked=false;
 const probe=()=>readScreenLocked().then(v=>{if(v!==locked)log('screen '+(v?'locked':'unlocked'));locked=v;});
 probe();setInterval(probe,5000).unref();
 const allowLocked=process.env.EPIC_CLAIM_ALLOW_LOCKED==='1';
 const {app}=createBridge({express:require('express'),token:process.env.CLAIM_WORKER_TOKEN,screenLocked:()=>!allowLocked&&locked,log});
 app.listen(Number(process.env.PORT||8123),'127.0.0.1',()=>log('Epic extension claim bridge ready'+(allowLocked?' (claims allowed while locked)':'')));
}
if(require.main===module)start();
module.exports={createBridge,start,readScreenLocked,screenLockedIn};
