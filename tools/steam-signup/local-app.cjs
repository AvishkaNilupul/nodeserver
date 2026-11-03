const express = require('express');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const {LocalVault} = require('../epic-signup/local-vault.cjs');
const {createMail} = require('./mail.cjs');
const {countries,cleanCountry,prepareProxy,browserLocation,contactFor}=require('./regions.cjs');
const {CloudSync,createSteamSshUploader,loadCloudTarget}=require('./cloud-sync.cjs');
const {createCountryChecker}=require('./store-country.cjs');
const DEFAULT_DIR = path.join(os.homedir(),'Library','Application Support','SteamAccountGenerator');
function createApp({dataDir=DEFAULT_DIR,port=4108,mail=createMail(),prepare=prepareProxy,cloudUploader=null,checkStoreCountry=createCountryChecker()}={}) {
  const vault = new LocalVault(dataDir), app = express(),tickets=new Map();
  // Finished accounts upload to the server's Steam accounts page (docs/STEAM-ACCOUNTS.md).
  const cloudSync=cloudUploader?new CloudSync({vault,upload:cloudUploader}):null;
  const token = crypto.randomBytes(32).toString('base64url');
  const reportFile=path.join(dataDir,'proxy-region-test.json');
  let report={testedAt:null,results:[]};try{report=JSON.parse(fs.readFileSync(reportFile,'utf8'));}catch{}
  let starting = false,preparing=false,countryCheckBusy=false;
  const countryChecks=new Map();
  const origins = new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]);
  const same = (a,b) => typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    if (!['127.0.0.1:'+port,'localhost:'+port].includes(req.get('host'))) return res.sendStatus(403);
    const origin = req.get('origin');
    if (origin && !origins.has(origin) && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return res.sendStatus(403);
    if (req.get('sec-fetch-site')==='cross-site' && !origin?.startsWith('chrome-extension://')) return res.sendStatus(403);
    res.set({'Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    next();
  });
  app.use(express.json({limit:'8kb'}));
  const auth = (req,res,next) => same(req.get('X-Local-Token'),token) ? next() : res.sendStatus(403);
  const meta = a => ({id:a.id,email:a.email,username:a.username,country:a.country,requestedCountry:a.requestedCountry,creationLocation:a.creationLocation,storeCountry:a.storeCountry||null,storeCountryCheckedAt:a.storeCountryCheckedAt||null,storeCountryCheck:countryChecks.get(a.id)||null,contact:a.contact?{country:a.contact.country,source:a.contact.source}:null,status:a.status,createdAt:a.createdAt,completedAt:a.completedAt,mailPending:!!a.mailPending,cloud:a.cloud?{state:a.cloud.state,uploadedAt:a.cloud.uploadedAt||null,lastError:a.cloud.lastError||''}:null});
  const active = () => vault.data.sessions.find(s => s.status!=='created' && s.status!=='cancelled');
  function consumeTicket(body) {
    const p=tickets.get(body.ticket);if(!p)throw Error('Test the regional proxy again');
    const location=browserLocation(body.browserLocation,p);tickets.delete(body.ticket);return {proxy:p,location};
  }
  function saveReport(country,result){report.testedAt=new Date().toISOString();report.results=report.results.filter(r=>r.requested!==country).concat({requested:country,...result,testedAt:report.testedAt});fs.writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});}
  app.get('/health',(_req,res)=>res.json({ok:true,service:'steam-signup'}));
  app.get('/',(_req,res)=>res.type('html').send(fs.readFileSync(path.join(__dirname,'local.html'),'utf8').replace('__TOKEN__',token)));
  app.get('/ui.js',(_req,res)=>res.sendFile(path.join(__dirname,'ui.js')));
  app.get('/style.css',(_req,res)=>res.sendFile(path.join(__dirname,'style.css')));
  app.get('/api/regions',auth,(_req,res)=>res.json({ok:true,countries,report}));
  app.post('/api/proxy/prepare',auth,async(req,res,next)=>{
    if(preparing)return res.status(409).json({ok:false,error:'A proxy test is already running'});
    preparing=true;let country;
    try {
      country=cleanCountry(req.body.country);
      for(const [id,p] of tickets)if(Date.parse(p.expiresAt)<=Date.now())tickets.delete(id);
      if(tickets.size>=8)tickets.delete(tickets.keys().next().value);
      const proxy=await prepare(country);const ticket=crypto.randomUUID();tickets.set(ticket,proxy);
      saveReport(country,{observed:proxy.location.country,matched:true,city:proxy.location.city});
      res.json({ok:true,ticket,proxy});
    }catch(e){if(country)saveReport(country,{matched:false,error:'Proxy exit unavailable or did not match'});next(e);}finally{preparing=false;}
  });
  app.get('/api/state',auth,async(_req,res,next)=>{
    try {let pool;try {pool=await mail.status();}catch {pool={error:'Outlook reader is unavailable'};}
      res.json({ok:true,pool,accounts:vault.data.accounts.map(meta),active:active()?meta(active()):null,cloudEnabled:!!cloudSync});
    } catch(e) {next(e);}
  });
  app.post('/api/start',auth,async(req,res,next)=>{
    if (starting || active()) return res.status(409).json({ok:false,error:'Resume the existing signup before starting another'});
    starting=true;
    try {
      const {proxy,location}=consumeTicket(req.body),country=location.country;
      const contact=req.body.sampleContact===true?contactFor(country,location):null;
      const email=await mail.reserve();
      const s={id:crypto.randomUUID(),email,username:email.split('@')[0].replace(/[^a-z0-9_]/gi,'').slice(0,18)+'_'+crypto.randomBytes(4).toString('hex'),password:crypto.randomBytes(18).toString('base64url')+'!7aA',country:null,requestedCountry:country,creationLocation:location,storeCountry:null,contact,proxy,automation:{autoSubmit:req.body.autoSubmit===true,autoAcceptAgreement:req.body.autoSubmit===true,autoClickCaptcha:req.body.autoSubmit===true},status:'reserved',createdAt:new Date().toISOString()};
      vault.data.sessions.push(s);vault.save();res.json({ok:true,session:s});
    }catch(e){next(e);}finally{starting=false;}
  });
  app.post('/api/resume',auth,(req,res,next)=>{
    const s=active();if(!s)return res.status(404).json({ok:false,error:'No interrupted signup'});
    try {
      const {proxy,location}=consumeTicket(req.body);
      if(location.country!==(s.requestedCountry||s.country))throw Error('Resume must use the original signup country');
      s.proxy=proxy;s.lastResumeLocation=location;s.lastResumedAt=new Date().toISOString();if(req.body.autoSubmit===true)s.automation={autoSubmit:true,autoAcceptAgreement:true,autoClickCaptcha:true};vault.save();res.json({ok:true,session:s});
    }catch(e){next(e);}
  });
  app.post('/api/session/:id/country',auth,(req,res)=>{
    const s=active();if(!s||s.id!==req.params.id)return res.sendStatus(404);
    if(!/^[A-Z]{2}$/.test(req.body.country||''))return res.sendStatus(400);
    s.country=req.body.country;vault.save();res.json({ok:true});
  });
  app.post('/api/session/:id/verification',auth,async(req,res,next)=>{
    const s=active();if(!s||s.id!==req.params.id)return res.sendStatus(404);
    try {const url=await mail.verify(s);res.json({ok:true,url});}catch(e){next(e);}
  });
  app.post('/api/session/:id/complete',auth,async(req,res,next)=>{
    const s=vault.data.sessions.find(s=>s.id===req.params.id);if(!s)return res.sendStatus(404);
    try {
      if(s.status!=='created') {
        if(req.body.url!=='https://store.steampowered.com/?created_account=1')return res.sendStatus(400);
        s.status='created';s.completedAt=new Date().toISOString();s.mailPending=true;
        s.regionMatch=s.country===s.requestedCountry&&s.creationLocation?.country===s.requestedCountry;
        if(!vault.data.accounts.some(a=>a.id===s.id)){
          const {proxy,...account}=s;vault.data.accounts.push({...account,source:'extension'});
        }
        vault.save();
        const saved=vault.data.accounts.find(a=>a.id===s.id);if(cloudSync&&saved){cloudSync.enqueue(saved);cloudSync.wake();}
      }
      if(s.mailPending){await mail.complete(s);s.mailPending=false;const a=vault.data.accounts.find(a=>a.id===s.id);if(a)a.mailPending=false;vault.save();}
      res.json({ok:true});
    }catch(e){next(e);}
  });
  app.post('/api/accounts/:id/store-country',auth,(req,res)=>{
    const a=vault.data.accounts.find(a=>a.id===req.params.id);
    if(!a)return res.status(404).json({ok:false,error:'Saved account not found'});
    if(countryCheckBusy)return res.status(409).json({ok:false,error:'A store country check is already running. Wait for it to finish.'});
    countryCheckBusy=true;countryChecks.set(a.id,{state:'checking',message:'Signing in to Steam and reading store country…'});
    res.status(202).json({ok:true});
    Promise.resolve().then(()=>checkStoreCountry(a)).then(result=>{
      if(!/^[A-Z]{2}$/.test(result.country||'')||result.source!=='steam-wallet-country'||!Number.isFinite(Date.parse(result.checkedAt)))throw Error('Steam did not return a verified country.');
      a.storeCountry=result.country;a.storeCountryCheckedAt=result.checkedAt;a.storeCountrySource=result.source;
      const session=vault.data.sessions.find(s=>s.id===a.id);
      if(session)Object.assign(session,{storeCountry:a.storeCountry,storeCountryCheckedAt:a.storeCountryCheckedAt,storeCountrySource:a.storeCountrySource});
      vault.save();countryChecks.set(a.id,{state:'done',message:'Store country checked.'});
    }).catch(e=>{
      // Only the checker's deliberate messages may reach the page; never library
      // errors that could include proxy URLs, tokens or account credentials.
      const message=/^Steam (?:could not read|has not returned|country check timed out|sign-in failed|needs a valid Guard|Guard email did not arrive|disconnected before|country lookup is unavailable|sign-in could not start|did not return a verified)/.test(e.message||'')?e.message:'Steam country check failed. Try again later.';
      countryChecks.set(a.id,{state:'error',message});
    }).finally(()=>{countryCheckBusy=false;});
  });
  app.post('/api/accounts/:id/contact',auth,(req,res,next)=>{
    const a=vault.data.accounts.find(a=>a.id===req.params.id);if(!a)return res.sendStatus(404);
    try {if(!a.contact){a.contact=contactFor(a.creationLocation?.country||a.country,a.creationLocation);vault.save();}res.json({ok:true,contact:a.contact});}catch(e){next(e);}
  });
  app.post('/api/accounts/:id/reveal',auth,(req,res)=>{
    const a=vault.data.accounts.find(a=>a.id===req.params.id);
    if(!a)return res.sendStatus(404);res.json({ok:true,email:a.email,username:a.username,password:a.password,contact:a.contact||null,creationLocation:a.creationLocation||null,country:a.country,storeCountry:a.storeCountry||null});
  });
  app.post('/api/cloud/retry',auth,(_req,res)=>{
    if(!cloudSync)return res.status(503).json({ok:false,error:'Server upload is not configured'});
    for(const a of vault.data.accounts)cloudSync.enqueue(a,{force:true});cloudSync.wake();res.json({ok:true});
  });
  app.use((err,_req,res,_next)=>res.status(503).json({ok:false,error:/^(Choose|The proxy exit|Browser proxy|Test the regional|Resume must|Could not verify|Steam region targeting|Residential proxy configuration)/.test(err.message)?err.message:'Signup operation failed. Check the Outlook reader and resume the same signup.'}));
  return {app,vault,token,cloudSync};
}
if(require.main===module){const target=loadCloudTarget(DEFAULT_DIR);const {app,cloudSync}=createApp({cloudUploader:target?createSteamSshUploader(target):null});app.listen(4108,'127.0.0.1',()=>{cloudSync?.start();console.log('Steam generator: http://127.0.0.1:4108'+(cloudSync?' · server upload on':' · server upload off (no cloud.json)'));});}
module.exports={createApp,DEFAULT_DIR};
