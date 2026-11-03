const test=require('node:test'),assert=require('node:assert/strict');
process.env.CRED_SECRET='chzzk-credential-tests-only';
const box=require('../utils/secretBox');
const {saveCredentials,importAccount,validate}=require('../tools/chzzk-signup/cloud-import.cjs');
const payload={version:1,action:'credentials',localId:'signup-1',cloudId:'0123456789abcdef01234567',userIdHash:'user-hash',credentials:{username:'test_owner',password:'Test-pass>123'}};
function fixture(overrides={}){
  const row={_id:payload.cloudId,userIdHash:payload.userIdHash,note:'Local generator '+payload.localId,sold:true,paused:true,cookies:'existing-cookie-jar',...overrides};
  const writes=[];let selected='';
  const matches=(q,r)=>Object.entries(q).every(([key,value])=>key==='$and'?value.every(v=>matches(v,r)):key==='$or'?value.some(v=>matches(v,r)):value&&typeof value==='object'&&'$exists'in value?(r[key]!==undefined)===value.$exists:r[key]===value);
  const Account={
    updateOne:async(q,u,o)=>{writes.push({q,u,o});if(matches(q,row)){Object.assign(row,u.$set);return{modifiedCount:1,upsertedCount:0};}return{modifiedCount:0,upsertedCount:0};},
    findOne:q=>({select:s=>{selected=s;return{lean:async()=>matches(q,row)?structuredClone(row):null};}}),
  };
  return{row,writes,Account,selected:()=>selected};
}
const save=(f,p=payload)=>saveCredentials({payload:p,Account:f.Account,...box});
test('backfill encrypts credentials while preserving sold, paused, cookies and timestamps',async()=>{
  const f=fixture(),r=await save(f);
  assert.equal(r.credentialsSaved,true);assert.equal(f.row.loginUsername,'test_owner');
  assert.ok(box.isEncrypted(f.row.loginPasswordEnc));assert.equal(box.decrypt(f.row.loginPasswordEnc),payload.credentials.password);
  assert.equal(f.row.sold,true);assert.equal(f.row.paused,true);assert.equal(f.row.cookies,'existing-cookie-jar');
  assert.deepEqual(Object.keys(f.writes[0].u.$set).sort(),['loginPasswordEnc','loginSavedAt','loginUsername']);assert.equal(f.writes[0].o.timestamps,false);
  assert.equal(f.selected(),'+loginPasswordEnc loginUsername');assert.ok(!JSON.stringify(r).includes(payload.credentials.password));
});
test('retries preserve ciphertext; conflicting credentials cannot overwrite a saved password',async()=>{
  const f=fixture();await save(f);const encrypted=f.row.loginPasswordEnc;
  await save(f);assert.equal(f.row.loginPasswordEnc,encrypted);
  await assert.rejects(save(f,{...payload,credentials:{...payload.credentials,password:'Different-pass1'}}),/different credentials/);
  assert.equal(f.row.loginPasswordEnc,encrypted);
});
test('wrong account, hash or generator provenance never gets credentials or an upsert',async()=>{
  for(const override of [{_id:'fedcba9876543210fedcba98'},{userIdHash:'other'},{note:'manual import'}]){
    const f=fixture(override);await assert.rejects(save(f),/target missing/);assert.equal(f.row.loginPasswordEnc,undefined);assert.equal(f.writes[0].o.upsert,undefined);
  }
});
test('invalid payloads fail before writing and password is excluded from ordinary model queries',async()=>{
  for(const change of [{cloudId:'invalid'},{credentials:{username:'bad',password:'short'}},{credentials:{username:'test_owner',password:'Test\npass123'}}]){
    const f=fixture();await assert.rejects(save(f,{...payload,...change}),/Invalid/);assert.equal(f.writes.length,0);
  }
  assert.equal(require('../models/ChzzkAccount').schema.path('loginPasswordEnc').options.select,false);
});
test('ordinary cookie import also saves credentials without changing existing account lifecycle',async()=>{
  const f=fixture(),cookies=['NID_AUT','NID_SES'].map(name=>({name,value:'test-cookie',domain:'.naver.com'}));
  const p={...payload,cookies};delete p.action;
  const r=await importAccount({payload:p,Account:f.Account,client:{userStatus:async()=>({loggedIn:true,userIdHash:p.userIdHash})},jar:{cookies:()=>cookies},...box});
  assert.equal(r.credentialsSaved,true);assert.equal(r.alreadyPresent,true);assert.equal(f.row.sold,true);assert.equal(f.row.cookies,'existing-cookie-jar');
  assert.throws(()=>validate({...p,credentials:{username:'test_owner',password:''}}),/Invalid credentials/);
});
