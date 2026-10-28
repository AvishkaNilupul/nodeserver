// Normal browser checkout. Order ownership is verified by nodeserver afterwards.
const path = require('path');
const crypto = require('crypto');
function isFreeCheckout(text) {
  return /this is free/i.test(text) && /\$\s*0\.00\b/.test(text);
}
async function visibleChallenge(page) {
  if (await page.getByText(/one more step|please complete a security check/i).first().isVisible().catch(()=>false)) return true;
  for (const frame of page.frames()) {
    if (!/hcaptcha\.com/.test(frame.url()) || !/[?&#](?:frame=challenge|view=challenge)/.test(frame.url())) continue;
    const element = await frame.frameElement().catch(()=>null);
    if (element && await element.isVisible().catch(()=>false)) {
      const box = await element.boundingBox();
      if (box && box.width > 200 && box.height > 150) return true;
    }
  }
  return false;
}
async function checkout(page, job, {sleep=ms=>new Promise(r=>setTimeout(r,ms)), budget=90000}={}) {
  const checkoutUrl='https://store.epicgames.com/purchase?offers=1-'+job.namespace+'-'+job.offerId;
  await page.goto('https://www.epicgames.com/id/exchange?exchangeCode='+encodeURIComponent(job.exchangeCode)+'&redirectUrl='+encodeURIComponent(checkoutUrl),{waitUntil:'domcontentloaded',timeout:45000});
  const start=Date.now();let clicked=false;
  while(Date.now()-start<budget) {
    if (/\/id\/login/.test(page.url())) return {status:'session_failed',error:'Epic requested sign-in'};
    const text=await page.locator('body').innerText({timeout:3000}).catch(()=>'');
    if (/you already own|already in your library/i.test(text)) return {status:'already_owned'};
    // A hidden hCaptcha SDK frame is normal and does not mean a challenge.
    if (await visibleChallenge(page)) return {status:'needs_captcha',error:'Epic requested a visible security check'};
    if (clicked) {
      if (/#(?:\/receipt.*)?$/.test(page.url()) || /thanks for your order|successfully added|order is complete/i.test(text)) {
        return {status:'submitted'};
      }
      if (/purchase (declined|failed)|couldn.t process/i.test(text)) return {status:'error',error:'Epic reported a checkout failure'};
    } else {
      const button=page.getByRole('button',{name:/^add to library$/i});
      if (await button.isVisible().catch(()=>false)) {
        const checkoutText=await page.locator('body').innerText({timeout:3000});
        if (!isFreeCheckout(checkoutText)) return {status:'error',error:'Checkout was not confirmed free',checkoutText:checkoutText.replace(/\s+/g,' ').slice(0,600)};
        await button.click({timeout:5000});clicked=true;
      }
    }
    await sleep(1000);
  }
  return {status:clicked?'submitted':'error',error:clicked?'Checkout submitted; verify library':'Free checkout button did not appear'};
}
function validJob(b) {
  return b && ['exchangeCode','namespace','offerId','accountKey'].every(k=>/^[a-f\d]{32}$/i.test(b[k]||''));
}
function createApp({express,run,token}) {
  const app=express();app.use(express.json({limit:'16kb'}));let busy=false;
  app.use((req,res,next)=>{
    const given=Buffer.from(req.get('authorization')||''),expected=Buffer.from('Bearer '+token);
    if (!token || given.length!==expected.length || !crypto.timingSafeEqual(given,expected)) return res.sendStatus(401);
    next();
  });
  app.get('/health',(_req,res)=>res.json({ok:true,mode:'normal-browser',busy}));
  app.post('/claim',async(req,res)=>{
    if(!validJob(req.body))return res.status(400).json({status:'error',error:'Invalid claim job'});
    // Don't queue a five-minute exchange code behind another browser session.
    if(busy)return res.status(409).json({status:'busy',error:'Worker is processing another claim'});
    busy=true;
    try{res.json(await run(req.body));}catch{res.status(500).json({status:'error',error:'Browser checkout failed'});}finally{busy=false;}
  });return app;
}
async function start() {
  const express=require('express'),{chromium}=require('playwright');
  const app=createApp({express,token:process.env.CLAIM_WORKER_TOKEN,run:async job=>{
    const context=await chromium.launchPersistentContext(path.join(process.env.PROFILES_DIR||path.join(__dirname,'profiles'),'normal_'+job.accountKey),{
      channel:'chrome',headless:false,viewport:{width:1280,height:900},locale:'en-US',
    });
    try{return await checkout(context.pages()[0]||await context.newPage(),job);}finally{await context.close();}
  }});
  app.listen(Number(process.env.PORT||8123),'127.0.0.1',()=>console.log('Epic normal browser worker ready'));
}
if(require.main===module)start().catch(()=>{console.error('Worker startup failed');process.exitCode=1;});
module.exports={checkout,visibleChallenge,isFreeCheckout,validJob,createApp,start};
