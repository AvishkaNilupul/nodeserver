// Loopback-only operator app; credentials remain in an encrypted local vault.
const express=require('express'),crypto=require('crypto'),fs=require('fs'),path=require('path'),os=require('os');
const {LocalVault}=require('./vault.cjs'),{FiveSim,ProviderError}=require('./five-sim.cjs'),{Engine,summary,safeError}=require('./engine.cjs'),{Queue,uploader}=require('./cloud.cjs');
const DEFAULT_DIR=path.join(os.homedir(),'Library/Application Support/ChzzkAccountGenerator');
function createApp({dataDir=DEFAULT_DIR,port=4109,provider,upload}={}){
  const vault=new LocalVault(dataDir);let settings={};
  try{settings=JSON.parse(fs.readFileSync(path.join(dataDir,'settings.json'),'utf8'));}catch{}
  provider=provider||new FiveSim({token:settings.fiveSimToken});
  const engine=new Engine({vault,provider}),queue=new Queue(vault,upload===undefined?uploader(dataDir):upload),app=express(),token=crypto.randomBytes(32).toString('base64url');
  const same=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const origin=req.get('origin');
    if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.get('host'))||origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(origin)&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return res.sendStatus(403);
    if(req.get('sec-fetch-site')==='cross-site'&&!origin?.startsWith('chrome-extension://'))return res.sendStatus(403);
    res.set({'Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});next();
  });
  app.use(express.json({limit:'90kb'}));
  const auth=(req,res,next)=>same(req.get('X-Local-Token'),token)?next():res.sendStatus(403);
  app.get('/health',(_req,res)=>res.json({ok:true,service:'chzzk-signup'}));
  app.get('/',(_req,res)=>res.type('html').send(fs.readFileSync(path.join(__dirname,'local.html'),'utf8').replace('__TOKEN__',token)));
  for(const f of ['ui.js','style.css'])app.get('/'+f,(_req,res)=>res.sendFile(path.join(__dirname,f)));
  app.use('/api',auth);
  app.get('/api/state',(_req,res)=>res.json({ok:true,active:summary(engine.active()),accounts:vault.data.accounts.map(summary),cloudEnabled:!!queue.upload}));
  app.get('/api/provider',async(_req,res,next)=>{try{
    const [profile,prices,countries]=await Promise.all([provider.profile(),provider.prices(),provider.countries()]);
    res.json({ok:true,balance:profile.balance,offers:require('./five-sim.cjs').candidates(prices,countries,[],1).slice(0,20)});
  }catch(e){next(e);}});
  app.post('/api/start',async(req,res,next)=>{try{const s=await engine.exclusive(()=>engine.start(req.body));res.json({ok:true,session:summary(s)});}catch(e){next(e);}});
  app.post('/api/session/:id/identity',(req,res,next)=>{try{
    const s=engine.current(req.params.id);res.json({ok:true,identity:{id:s.id,username:s.username,password:s.password,name:s.name,birthday:s.birthday}});
  }catch(e){next(e);}});
  app.post('/api/session/:id/stage',(req,res,next)=>{try{const s=engine.current(req.params.id);s.stage=String(req.body.stage||'').slice(0,120);engine.save();res.json({ok:true});}catch(e){next(e);}});
  app.post('/api/session/:id/limits',async(req,res,next)=>{try{res.json({ok:true,session:await engine.limits(req.params.id,req.body)});}catch(e){next(e);}});
  for(const action of ['number','sms','replace','reconcile','cancel'])app.post('/api/session/:id/'+action,async(req,res,next)=>{try{
    const result=await engine[action](req.params.id);res.json({ok:true,result:action==='number'?{phone:result.phone,prefix:result.prefix,country:result.country,expires:result.expires}:result});
  }catch(e){next(e);}});
  app.post('/api/session/:id/complete',async(req,res,next)=>{try{const a=await engine.complete(req.params.id,req.body);res.json({ok:true,account:summary(a)});queue.run().catch(()=>{});}catch(e){next(e);}});
  app.post('/api/accounts/:id/reveal',(req,res)=>{
    const a=vault.data.accounts.find(a=>a.id===req.params.id);if(!a)return res.sendStatus(404);
    res.json({ok:true,username:a.username,password:a.password});
  });
  app.post('/api/cloud/retry',(_req,res)=>{for(const a of vault.data.accounts)if(a.cloud?.state!=='uploaded')a.cloud={...a.cloud,nextAttemptAt:0};vault.save();queue.run().catch(()=>{});res.json({ok:true});});
  app.use((e,_req,res,_next)=>res.status(400).json({ok:false,error:e instanceof ProviderError?e.message:safeError(e)}));
  return{app,vault,engine,queue,token};
}
if(require.main===module){const {app,queue,engine}=createApp();app.listen(4109,'127.0.0.1',()=>{queue.start();engine.finishOrders().catch(()=>{});console.log('CHZZK generator: http://127.0.0.1:4109');});}
module.exports={createApp,DEFAULT_DIR};
