const express=require('express'),crypto=require('crypto'),path=require('path'),os=require('os');
const {LocalVault}=require('./local-vault.cjs');
const {CloudSync,createSshUploader}=require('./cloud-sync.cjs');
const identityFactory=require('../../utils/epicIdentityFactory'),mailboxProvider=require('../../utils/epicMailbox');
const epic=require('../../utils/epicClient');
const DEFAULT_DIR=path.join(os.homedir(),'Library','Application Support','EpicAccountGenerator');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function createLocalApp({dataDir=DEFAULT_DIR,port=4107,cloudUploader=null,exchangeAuthCode=epic.exchangeAuthCode,getProfile=async token=>(await require('axios').get('https://account-public-service-prod.ol.epicgames.com/account/api/public/account/'+encodeURIComponent(token.account_id),{headers:{Authorization:'bearer '+token.access_token},timeout:15000})).data}={}) {
  const vault=new LocalVault(dataDir),app=express(),uiToken=crypto.randomBytes(32).toString('base64url'),busy=new Set();
  const cloudSync=cloudUploader?new CloudSync({vault,upload:cloudUploader}):null;
  const origins=new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]);
  app.disable('x-powered-by');app.use((req,res,next)=>{
    if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.get('host')))return res.sendStatus(403);
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('X-Frame-Options','DENY');
    const callback=/^\/api\/epic\/(accounts\/from-extension|signup\/[^/]+\/status)$/.test(req.path);
    const origin=req.get('origin');
    if(origin&&!origins.has(origin)&&!(callback&&origin.startsWith('chrome-extension://')))return res.sendStatus(403);
    if(req.get('sec-fetch-site')==='cross-site'&&!callback)return res.sendStatus(403);
    next();
  });app.use(express.json({limit:'24kb'}));
  const ui=(req,res,next)=>equal(req.get('X-Local-Token'),uiToken)?next():res.status(403).json({success:false,message:'Open the local generator page again to reconnect'});
  function bearer(req,res,next) {
    const session=vault.data.sessions.find(s=>s.sessionId===(req.params.sessionId||req.body.sessionId));
    const token=(req.get('authorization')||'').replace(/^Bearer /,'');
    if(!session||new Date(session.expiresAt)<=new Date()||!equal(digest(token),session.bearerHash))return res.status(401).json({success:false,message:'Invalid or expired signup session'});
    req.signup=session;next();
  }
  function response(s,token,login=false){return{sessionId:s.sessionId,bearer:token,identity:s.identity,redirectUrl:epic.REDIRECT_URL,login,mailbox:{address:s.identity.email,provider:'outlook-local',reservedAt:s.reservedAt}};}
  function metadata(a){return{_id:a._id,accountId:a.accountId,displayName:a.displayName,email:a.email,createdAt:a.createdAt,source:a.source||'local',hasPassword:!!a.password,profile:a.profile||{},status:a.status||'saved',cloud:a.cloud?{state:a.cloud.state,uploadedAt:a.cloud.uploadedAt,cloudId:a.cloud.cloudId,lastError:a.cloud.lastError}:null};}
  app.get('/health',(_req,res)=>res.json({ok:true,mode:'local',storage:'encrypted-local-vault'}));
  app.get('/api/epic/signup/health',ui,(_req,res)=>res.json({success:true,provider:'outlook-local',mode:'local',extensionVersion:'1.3.0'}));
  app.get('/api/local/status',ui,async(_req,res)=>{
    let mailReady=false,proxyReady=false;
    try{mailReady=(await require('axios').get('http://127.0.0.1:3999/',{timeout:3000})).status===200;}catch{}
    try{proxyReady=!!require('../../utils/epicLocalProxy').readProxy();}catch{}
    res.json({success:true,mailReady,proxyReady,cloudEnabled:!!cloudSync});
  });
  app.get('/api/local/accounts',ui,(_req,res)=>res.json({success:true,accounts:vault.data.accounts.map(metadata)}));
  app.post('/api/local/cloud/retry',ui,(_req,res)=>{if(!cloudSync)return res.status(503).json({success:false,message:'Cloud upload is not configured'});for(const a of vault.data.accounts)cloudSync.enqueue(a,{force:true});cloudSync.wake();res.json({success:true});});
  app.post('/api/local/accounts/:id/reveal',ui,(req,res)=>{
    const a=vault.data.accounts.find(a=>a._id===req.params.id);if(!a)return res.status(404).json({success:false,message:'Account not found'});
    res.json({success:true,email:a.email,password:a.password||'',totpSecret:a.totpSecret||'',profile:a.profile||{},displayName:a.displayName});
  });
  app.post('/api/epic/signup/start',ui,(req,res)=>{
    try {
      const box=mailboxProvider.allocate(req.body.mailbox),identity={...identityFactory.build(),email:box.address};
      const token=crypto.randomBytes(32).toString('base64url'),s={sessionId:crypto.randomUUID(),bearerHash:digest(token),identity,status:'identity_ready',reservedAt:box.providerMeta.reservedAt,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};
      vault.data.sessions=vault.data.sessions.filter(s=>new Date(s.expiresAt)>new Date());vault.data.sessions.push(s);vault.save();res.json({success:true,session:response(s,token)});
    }catch{res.status(400).json({success:false,message:'Reserve a recent Outlook inbox through the extension first'});}
  });
  app.get('/api/epic/signup/recent',ui,(_req,res)=>res.json({success:true,sessions:[...vault.data.sessions].reverse().map(s=>({sessionId:s.sessionId,status:s.status,email:s.identity.email,displayName:s.identity.displayName,createdAt:s.createdAt,lastError:s.lastError||'',epicAccountId:s.epicAccountId}))}));
  app.post('/api/epic/signup/:sessionId/resume',ui,(req,res)=>{
    const s=vault.data.sessions.find(s=>s.sessionId===req.params.sessionId);
    if(!s||new Date(s.expiresAt)<=new Date())return res.status(404).json({success:false,message:'Local signup expired or not found'});
    if(s.status==='verified')return res.status(409).json({success:false,message:'This account is already saved locally'});
    const token=crypto.randomBytes(32).toString('base64url');s.bearerHash=digest(token);s.status='identity_ready';s.lastError='';s.reservedAt=new Date().toISOString();vault.save();res.json({success:true,session:response(s,token,req.body.mode==='login')});
  });
  app.post('/api/epic/signup/:sessionId/status',bearer,(req,res)=>{
    const s=req.signup;if(s.status==='verified'||!['wizard_open','awaiting_captcha','awaiting_otp','awaiting_eula','sms_required','throttled','failed'].includes(req.body.status))return res.status(400).json({success:false,message:'Invalid signup transition'});
    s.status=req.body.status;s.lastError=typeof req.body.lastError==='string'?req.body.lastError.slice(0,500):'';vault.save();res.json({success:true});
  });
  app.post('/api/epic/accounts/from-extension',bearer,async(req,res)=>{
    const s=req.signup;
    if(s.status==='verified')return res.json({success:true,account:{_id:s.epicAccountId}});
    if(busy.has(s.sessionId))return res.status(409).json({success:false,message:'Saving this account is already in progress'});
    if(!/^[a-f\d]{32}$/i.test(req.body.authorizationCode||''))return res.status(400).json({success:false,message:'Invalid Epic authorization code'});
    busy.add(s.sessionId);
    try {
      const token=await exchangeAuthCode(req.body.authorizationCode),profile=await getProfile(token);
      if(profile.email?.toLowerCase()!==s.identity.email.toLowerCase())throw Error('wrong-account');
      let a=vault.data.accounts.find(a=>a.accountId===token.account_id);
      if(!a){a={_id:crypto.randomBytes(12).toString('hex'),accountId:token.account_id,createdAt:new Date().toISOString()};vault.data.accounts.push(a);}
      Object.assign(a,{displayName:token.displayName||s.identity.displayName,email:s.identity.email,password:s.identity.password,refreshToken:token.refresh_token,refreshExpiresAt:token.refresh_expires_at,source:'local-generator',status:'saved',profile:{firstName:s.identity.firstName,lastName:s.identity.lastName,dateOfBirth:s.identity.dateOfBirth,country:profile.country||s.identity.country}});
      s.status='verified';s.epicAccountId=a._id;s.lastError='';vault.save();if(cloudSync){cloudSync.enqueue(a);cloudSync.wake();}res.json({success:true,account:metadata(a)});
    }catch(e){s.lastError=e.message==='wrong-account'?'Epic signed into a different email address. Sign out and recover this signup.':'Could not finish Epic authorization. Recover this signup to try again.';s.status='failed';vault.save();res.status(502).json({success:false,message:s.lastError});}
    finally{busy.delete(s.sessionId);}
  });
  app.get('/',(_req,res)=>res.redirect('/epic-accounts.html'));
  app.get('/epic-accounts.html',(_req,res)=>res.type('html').send(require('fs').readFileSync(path.join(__dirname,'local.html'),'utf8').replace('__LOCAL_TOKEN__',uiToken)));
  app.get('/epic-signup-panel.js',(_req,res)=>res.sendFile(path.resolve(__dirname,'../../public/epic-signup-panel.js'),{dotfiles:'allow'}));
  app.get('/local-ui.js',(_req,res)=>res.sendFile(path.join(__dirname,'local-ui.js'),{dotfiles:'allow'}));
  app.use((err,_req,res,_next)=>res.status(400).json({success:false,message:'Invalid local request'}));
  return{app,vault,uiToken,cloudSync};
}
function startLocalApp(){const {app,cloudSync}=createLocalApp({cloudUploader:createSshUploader()});app.listen(4107,'127.0.0.1',()=>{cloudSync.start();console.log('Local Epic generator: http://127.0.0.1:4107/epic-accounts.html');});}
if(require.main===module)startLocalApp();
module.exports={createLocalApp,startLocalApp,DEFAULT_DIR};
