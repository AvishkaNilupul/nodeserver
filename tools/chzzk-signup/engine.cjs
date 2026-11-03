// Durable single-signup lifecycle; UI and extension share this serialized engine.
const crypto=require('crypto');
const {candidates}=require('./five-sim.cjs');
const TERMINAL=new Set(['CANCELED','TIMEOUT','BANNED','FINISHED']);
const safeError=e=>e?.name==='Error'&&e.public===true?e.message:'Operation failed. Keep this signup and retry.';
function problem(message){const e=Error(message);e.public=true;return e;}
function summary(s){return s?{id:s.id,username:s.username,status:s.status,stage:s.stage||'',createdAt:s.createdAt,completedAt:s.completedAt||null,attempts:s.attempts.length,maxAttempts:s.maxAttempts,maxPrice:s.maxPrice,budget:s.budget,spent:s.spent,order:s.order?{country:s.order.country,status:s.order.status,expires:s.order.expires,price:s.order.price}:null,uncertain:!!s.purchaseIntent,cloud:s.cloud||null}:null;}
class Engine {
  constructor({vault,provider,now=Date.now}){this.vault=vault;this.provider=provider;this.now=now;this.busy=false;}
  active(){return this.vault.data.sessions.find(s=>!['created','cancelled'].includes(s.status));}
  async exclusive(fn){if(this.busy)throw problem('Another signup operation is running.');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  save(){this.vault.save();}
  current(id){const s=this.active();if(!s||s.id!==id)throw problem('This signup is no longer active.');return s;}
  limits(id,{maxPrice,budget,maxAttempts}){return this.exclusive(()=>{
    const s=this.current(id);
    if(!Number.isFinite(maxPrice)||maxPrice<=0||maxPrice>1||!Number.isFinite(budget)||budget<s.spent||budget>5||!Number.isInteger(maxAttempts)||maxAttempts<s.attempts.length||maxAttempts>100)throw problem('Limits must cover purchases already made; maximum budget 5 and 100 attempts.');
    Object.assign(s,{maxPrice,budget,maxAttempts});this.save();return summary(s);
  });}
  start({name,birthday,maxPrice=.05,maxAttempts=10,budget=.25}) {
    if(this.active())throw problem('Resume or cancel the existing signup first.');
    if(typeof name!=='string'||!name.trim()||name.length>80||!/^\d{8}$/.test(birthday||''))throw problem('Enter a name and date of birth (YYYYMMDD).');
    const year=Number(birthday.slice(0,4)),month=Number(birthday.slice(4,6)),day=Number(birthday.slice(6)),d=new Date(Date.UTC(year,month-1,day));
    if(year<1900||d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||d.getTime()>=this.now())throw problem('Enter a valid date of birth.');
    if(!Number.isFinite(maxPrice)||maxPrice<=0||maxPrice>1||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10||!Number.isFinite(budget)||budget<maxPrice||budget>5)throw problem('Check price, attempt and signup budget limits.');
    const s={id:crypto.randomUUID(),username:'n'+crypto.randomBytes(7).toString('hex'),password:crypto.randomBytes(9).toString('base64url')+'aA7!',name:name.trim(),birthday,maxPrice,maxAttempts,budget,status:'signup',createdAt:new Date(this.now()).toISOString(),attempts:[],spent:0,order:null,purchaseIntent:null};
    this.vault.data.sessions.push(s);this.save();return s;
  }
  async refresh(s){
    if(!s.order)return null;
    const order=await this.provider.order(s.order.id);
    if(order.id!==s.order.id||order.phone!==s.order.phone)throw problem('5sim returned a different order.');
    s.order={...s.order,...order};this.save();return s.order;
  }
  async number(id){return this.exclusive(async()=>{
    const s=this.current(id);
    if(s.purchaseIntent)throw problem('Reconcile the uncertain purchase before buying another number.');
    if(s.order){
      await this.refresh(s);
      if(!TERMINAL.has(s.order.status))return s.order;
      if(s.order.sms?.length)throw problem('This order received a code. Resolve the existing signup before replacing it.');
      s.order=null;this.save();
    }
    if(s.attempts.length>=s.maxAttempts)throw problem('Number attempt limit reached. Resume manually or cancel this signup.');
    const remaining=s.budget-s.spent;
    const [prices,countries]=await Promise.all([this.provider.prices(),this.provider.countries()]);
    const choices=candidates(prices,countries,s.attempts,Math.min(s.maxPrice,remaining)).slice(0,5);
    if(!choices.length)throw problem('No alternative numbers fit the remaining budget.');
    for(const chosen of choices){
      s.purchaseIntent={country:chosen.country,prefix:chosen.prefix,at:this.now(),maxPrice:chosen.cost};this.save();
      let order;
      try{order=await this.provider.buy(chosen.country,chosen.cost);}catch(e){
        if(!e.ambiguous){s.purchaseIntent=null;this.save();}
        if(e.code==='NO_STOCK')continue;
        throw e;
      }
      this.adopt(s,order,chosen.prefix);
      if(order.price>chosen.cost+1e-8)throw problem('Provider exceeded the price cap. Cancel this order before continuing.');
      return s.order;
    }
    throw problem('The cheapest quoted numbers sold out. Check prices and resume; nothing else was bought.');
  });}
  adopt(s,order,prefix){
    s.order={...order,prefix};s.spent+=Number(order.price);s.attempts.push({id:order.id,country:order.country,price:order.price,at:new Date(this.now()).toISOString()});s.purchaseIntent=null;this.save();
  }
  async reconcile(id){return this.exclusive(async()=>{
    const s=this.current(id),intent=s.purchaseIntent;if(!intent)return;
    const history=await this.provider.history(),rows=Array.isArray(history)?history:history?.data;
    if(!Array.isArray(rows))throw problem('5sim order history is unavailable.');
    const matches=rows.filter(o=>o.product==='naver'&&o.country===intent.country&&Date.parse(o.created_at)>=intent.at-5000&&!s.attempts.some(a=>a.id===o.id));
    if(matches.length!==1)throw problem('Purchase is unresolved. Check 5sim history before continuing; no new number was bought.');
    this.adopt(s,matches[0],intent.prefix);
  });}
  async sms(id){return this.exclusive(async()=>{
    const s=this.current(id),o=await this.refresh(s);if(!o)throw problem('Get a number first.');
    const code=o.sms?.findLast(x=>typeof x.code==='string'&&/^\d{3,10}$/.test(x.code))?.code||null;
    return {code,status:o.status,expires:o.expires};
  });}
  async replace(id){return this.exclusive(async()=>{
    const s=this.current(id);if(s.purchaseIntent)throw problem('Reconcile the purchase first.');
    if(!s.order)return;
    await this.refresh(s);
    if(s.order.sms?.length)throw problem('SMS already arrived. Use its code before changing the number.');
    if(!TERMINAL.has(s.order.status)) {
      const cancelled=await this.provider.order(s.order.id,'cancel');
      s.order={...s.order,...cancelled};this.save();
      if(!TERMINAL.has(s.order.status))throw problem('Wait for cancellation or expiry before replacing the number.');
    }
    s.order=null;s.stage='Change the phone number in the same signup';this.save();
  });}
  async cancel(id){await this.replace(id);const s=this.current(id);s.status='cancelled';this.save();}
  async complete(id,{cookies,userIdHash,naverId}){return this.exclusive(async()=>{
    const s=this.current(id);
    if(naverId?.toLowerCase()!==s.username.toLowerCase()||!s.order||!s.order.sms?.length||typeof userIdHash!=='string'||!userIdHash)throw problem('Verify the assigned account and its SMS before saving.');
    if(!Array.isArray(cookies)||!['NID_AUT','NID_SES'].every(n=>cookies.some(c=>c.name===n&&typeof c.value==='string'&&c.value&&/^\.?naver\.com$/.test(c.domain||''))))throw problem('Naver login cookies are missing.');
    if(this.vault.data.accounts.some(a=>a.userIdHash===userIdHash))throw problem('That CHZZK account is already saved.');
    const a={...s,cookies:cookies.filter(c=>/^\.?naver\.com$/.test(c.domain||'')),userIdHash,status:'created',completedAt:new Date(this.now()).toISOString(),cloud:{state:'pending'},finishPending:true};
    this.vault.data.accounts.push(a);s.status='created';s.completedAt=a.completedAt;this.save();
    await this.finishOrders();return a;
  });}
  async finishOrders(){for(const a of this.vault.data.accounts.filter(a=>a.finishPending)) {
    try{const o=await this.provider.order(a.order.id,'finish');if(['FINISHED','TIMEOUT'].includes(o.status)){a.finishPending=false;this.save();}}catch{}
  }}
}
module.exports={Engine,summary,problem,safeError,TERMINAL};
