const test = require('node:test');
const assert = require('node:assert/strict');
process.env.CRED_SECRET='epic-details-tests-only';
const express=require('express');
const {encrypt,decrypt}=require('../utils/secretBox');
const id='a'.repeat(24);
let stored={_id:id,accountId:'epic-id',displayName:'Example',label:'stock',refreshToken:encrypt('private-refresh-token'),email:encrypt('stock@example.com'),password:encrypt('old-password'),totpSecret:'',sold:true,libraryCount:1,library:[{title:'Owned Game'}],accountDetails:encrypt(JSON.stringify({notes:'private note',country:'CO'}))};
let lastSet, rejectUpdate = false;
function query(value){return{select(){return this;},lean:async()=>value};}
const modelId=require.resolve('../models/EpicAccount');
require.cache[modelId]={id:modelId,loaded:true,exports:{findById:got=>query(got===id?{...stored}:null),findOneAndUpdate:(_q,update,opts)=>{if(rejectUpdate)return query(null);assert.equal(opts.returnDocument,'after');lastSet=update.$set;stored={...stored,...lastSet};return query(stored);}}};
const app=express();app.use(express.json());app.use((req,res,next)=>{const role=req.get('X-Test-Role');if(role)req.session={admin:{role}};next();});app.use(require('../routes/epicAccountDetailsRoutes'));
let server,base;
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;});
test.after(()=>new Promise(r=>server.close(r)));
async function call(path='',method='GET',body,role='superadmin'){
 const res=await fetch(base+'/api/epic/accounts/'+id+'/details'+path,{method,headers:{'Content-Type':'application/json',...(role?{'X-Test-Role':role}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,cache:res.headers.get('cache-control'),data:await res.json()};
}
test('details and reveal require superadmin and never cache credentials',async()=>{
 assert.equal((await call('', 'GET',null,null)).status,401);
 assert.equal((await call('/reveal','POST',{},'seller')).status,403);
 const info=await call();assert.equal(info.status,200);assert.equal(info.cache,'no-store');
 assert.equal(info.data.account.email,'stock@example.com');assert.equal(info.data.account.hasPassword,true);
 assert.equal(JSON.stringify(info.data).includes('old-password'),false);
 assert.equal(JSON.stringify(info.data).includes('private-refresh-token'),false);
 const reveal=await call('/reveal','POST',{});assert.equal(reveal.cache,'no-store');assert.equal(reveal.data.password,'old-password');assert.equal(reveal.data.refreshToken,undefined);
});
test('saves encrypted credentials and profile without touching sold, library or OAuth state',async()=>{
 const token=stored.refreshToken;
 const out=await call('','PATCH',{label:'<stock>',email:'NEW@example.com',password:'new-password',firstName:'Jane',country:'jp',dateOfBirth:'1999-01-02',notes:'internal'});
 assert.equal(out.status,200);assert.equal(out.data.account.email,'new@example.com');
 assert.ok(stored.password.startsWith('enc:'));assert.equal(decrypt(stored.password),'new-password');
 assert.ok(stored.accountDetails.startsWith('enc:'));assert.equal(JSON.parse(decrypt(stored.accountDetails)).country,'JP');
 assert.equal(stored.sold,true);assert.equal(stored.libraryCount,1);assert.equal(stored.refreshToken,token);
 assert.equal(lastSet.refreshToken,undefined);assert.equal(lastSet.sold,undefined);
 assert.equal(JSON.stringify(out.data).includes('new-password'),false);
 const encryptedPassword=stored.password;
 await call('','PATCH',{password:'',totpSecret:'',notes:'updated'});assert.equal(stored.password,encryptedPassword);
});
test('rejects unsupported fields, malformed input and impossible recovery dates without writes',async()=>{
 const before=JSON.stringify(stored);
 for(const body of [{sold:false},{refreshToken:'replace'},{notes:{'$gt':''}},{country:'USA'},{email:'bad'},{dateOfBirth:'2024-02-31'},{password:'enc:v1:fake'},{notes:'x'.repeat(4001)}]) assert.equal((await call('','PATCH',body)).status,400);
 assert.equal(JSON.stringify(stored),before);
 const bad=await fetch(base+'/api/epic/accounts/invalid/details',{headers:{'X-Test-Role':'superadmin'}});assert.equal(bad.status,400);
 const missing=await fetch(base+'/api/epic/accounts/'+('b'.repeat(24))+'/details',{headers:{'X-Test-Role':'superadmin'}});assert.equal(missing.status,404);
});

test('rejects stale-editor conflicts without changing any stored details',async()=>{
 const before=JSON.stringify(stored);rejectUpdate=true;
 try{assert.equal((await call('','PATCH',{notes:'stale edit'})).status,409);assert.equal(JSON.stringify(stored),before);}
 finally{rejectUpdate=false;}
});
