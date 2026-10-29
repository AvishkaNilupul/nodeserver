// Production reaches this localhost bridge through the existing SSH tunnel.
// The paired extension performs checkout in the owner's normal Chrome profile.
const crypto=require('crypto');
const {validJob}=require('./browser-worker.cjs');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
function createBridge({express,token,now=Date.now,timeoutMs=150000}) {
 if(!token)throw Error('Worker token required');
 const extensionToken=crypto.createHmac('sha256',token).update('epic-claim-extension-v1').digest('hex');
 const app=express();let current=null,lastSeen=0;
 app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
 app.use((req,res,next)=>{
  const host=req.get('host')||'';
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))return res.sendStatus(403);
  res.set('Cache-Control','no-store');res.set('X-Frame-Options','DENY');
  next();
 });
 const auth=secret=>(req,res,next)=>equal(req.get('authorization'),'Bearer '+secret)?next():res.sendStatus(401);
 app.get('/connect',(req,res)=>{
  if(req.get('sec-fetch-site')==='cross-site')return res.sendStatus(403);
  res.type('html').send('<!doctype html><title>Epic browser claims</title><style>body{font:18px system-ui;max-width:650px;margin:80px auto;background:#15181f;color:#eee}button{padding:12px;font:inherit}label{display:block;margin:24px 0}</style><h1>Epic browser claims</h1><p>Claims run in your regular Chrome session while Chrome and this Mac are running. Only explicitly free, zero-price games are submitted. Visible security checks pause for you.</p><label><input id="accept" type="checkbox"> Allow free-game checkout, including Epic’s EULA confirmation.</label><label><input id="isolate" type="checkbox"> Clear only Epic browser cookies locally before each claim, signing Epic tabs out.</label><button id="connect" data-token="'+extensionToken+'">Connect Epic Claim Helper</button><p id="status">Use Epic Claim Helper 1.1.0.</p>');
 });
 app.get('/health',auth(token),(_req,res)=>res.json({ok:true,mode:'extension',connected:lastSeen>0&&now()-lastSeen<90000,busy:!!current}));
 app.get('/extension/status',auth(extensionToken),(_req,res)=>{lastSeen=now();res.json({ok:true});});
 app.get('/extension/next',auth(extensionToken),(_req,res)=>{
  lastSeen=now();if(!current||current.assigned)return res.json({job:null});
  current.assigned=true;res.json({job:current.job});
 });
 app.post('/extension/otp',auth(extensionToken),async(req,res)=>{
  const b=req.body;
  if(!current||current.job.mode!=='recover'||b.id!==current.job.id||b.lease!==current.job.lease)return res.sendStatus(409);
  const email=current.job.email,since=current.job.startedAt;
  try{const r=await fetch('http://127.0.0.1:3999/api/accounts/'+encodeURIComponent(email)+'/otp?for=epic&since='+encodeURIComponent(since)+'&via=graph',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(23000)});const data=await r.json();res.json({ok:true,...(data.ok&&/^\d{6}$/.test(data.code||'')?{code:data.code}:{waiting:true})});}catch{res.json({ok:true,waiting:true});}
 });
 app.post('/extension/result',auth(extensionToken),(req,res)=>{
  lastSeen=now();const b=req.body;
  if(!current||b.id!==current.job.id||b.lease!==current.job.lease)return res.sendStatus(409);
  if(!['submitted','already_owned','needs_captcha','session_failed','reauthorized','region_unavailable','not_free','error'].includes(b.status))return res.sendStatus(400);
  if(b.status==='reauthorized'&&(current.job.mode!=='recover'||!(/^[a-f\d]{32}$/i).test(b.code||'')))return res.sendStatus(400);
  const finish=current.finish;current=null;finish({status:b.status,error:String(b.error||'').slice(0,300),...(b.status==='reauthorized'?{code:b.code}:{})});res.json({ok:true});
 });
 app.post('/recover',auth(token),(req,res)=>{
  const b=req.body;
  if(!(/^[a-f\d]{32}$/i).test(b.accountKey||'')||typeof b.displayName!=='string'||!b.displayName||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(b.email||'')||typeof b.password!=='string'||!b.password||b.password.length>256)return res.sendStatus(400);
  if(current)return res.status(409).json({status:'busy'});
  if(!lastSeen||now()-lastSeen>90000)return res.status(503).json({status:'worker_unavailable'});
  const job={id:crypto.randomUUID(),lease:crypto.randomBytes(24).toString('hex'),mode:'recover',accountKey:b.accountKey,displayName:b.displayName,email:b.email,password:b.password,startedAt:new Date(now()).toISOString()};
  const timer=setTimeout(()=>{if(current?.job.id===job.id){current=null;res.json({status:'error',error:'Account sign-in timed out'});}},240000);
  current={job,assigned:false,finish:result=>{clearTimeout(timer);if(!res.destroyed)res.json(result);}};
 });
 app.post('/claim',auth(token),(req,res)=>{
  const b=req.body;
  if(!validJob(b)||!b.displayName||String(b.displayName).length>100)return res.status(400).json({status:'error',error:'Invalid claim job'});
  if(current)return res.status(409).json({status:'busy',error:'Browser claim already in progress'});
  if(!lastSeen||now()-lastSeen>90000)return res.status(503).json({status:'worker_unavailable',error:'Connect Epic Claim Helper at http://127.0.0.1:8123/connect'});
  const job={id:crypto.randomUUID(),lease:crypto.randomBytes(24).toString('hex'),exchangeCode:b.exchangeCode,namespace:b.namespace,offerId:b.offerId,accountKey:b.accountKey,displayName:b.displayName};
  const timer=setTimeout(()=>{if(current?.job.id===job.id){current=null;res.json({status:'error',error:'Browser checkout timed out; verify library'});}},timeoutMs);
  current={job,assigned:false,finish:result=>{clearTimeout(timer);if(!res.destroyed)res.json(result);}};
 });
 return {app,extensionToken};
}
function start(){const {app}=createBridge({express:require('express'),token:process.env.CLAIM_WORKER_TOKEN});app.listen(Number(process.env.PORT||8123),'127.0.0.1',()=>console.log('Epic extension claim bridge ready'));}
if(require.main===module)start();
module.exports={createBridge,start};
