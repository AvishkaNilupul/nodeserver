const test=require('node:test'),assert=require('node:assert/strict');
const {verifyClaimResult}=require('../utils/epicClaimResult');
const options={sleep:async()=>{}};
test('library ownership overrides a worker timeout or false captcha error',async()=>{
 for(const status of ['error','needs_captcha','captcha_unsupported','submitted']) {
  const result=await verifyClaimResult({status,error:'timeout'},'game',async()=>[{namespace:'game'}],options);
  assert.equal(result.status,'claimed');assert.equal(result.verified,true);assert.equal(result.error,'');
 }
});
test('UI success alone cannot mark a claim complete',async()=>{
 for(const status of ['claimed','already_owned','submitted'])assert.equal((await verifyClaimResult({status},'game',async()=>[],options)).status,'error');
});
test('waits for delayed entitlement propagation',async()=>{
 let calls=0;const result=await verifyClaimResult({status:'submitted'},'game',async()=>++calls===3?[{namespace:'game'}]:[],options);
 assert.equal(result.status,'claimed');assert.equal(calls,3);
});
test('library outage does not convert a challenge into success',async()=>{
 const result=await verifyClaimResult({status:'needs_captcha'},'game',async()=>{throw Error('offline');},options);
 assert.equal(result.status,'needs_captcha');assert.equal(result.verified,false);
});
