const test=require('node:test'),assert=require('node:assert/strict');
const {readProxy,verifiedProxy}=require('../utils/epicLocalProxy');
const {creationProfile,cleanLocation,sampleContact}=require('../utils/epicAccountLocation');
test('Russian or untargeted ProxyScrape configurations target US; existing non-RU targeting remains',()=>{
 const env={RES_HOST:'rp.scrapegw.com',RES_PORT:'6060',RES_PASS:'test'};
 for(const user of ['user','user-country-ru-city-moscow-session-old-lifetime-5']){
  const p=readProxy({...env,RES_USER:user},'/private/tmp/not-a-proxy-config');assert.match(p.username,/-country-us-session-[a-f0-9]+-lifetime-30$/);assert.doesNotMatch(p.username,/-country-ru|-city-moscow/);
 }
 assert.match(readProxy({...env,RES_USER:'user-country-jp'},'/private/tmp/not-a-proxy-config').username,/-country-jp-/);
});
test('exit verification rejects Russian and unknown exits without leaking proxy credentials',async()=>{
 let reads=0;const read=()=>({username:'private',password:'private',id:++reads});
 const selected=await verifiedProxy({read,lookup:async p=>({country:p.id===1?'RU':'JP',ip:'203.0.113.1'})});assert.equal(selected.location.country,'JP');assert.equal(reads,2);
 await assert.rejects(verifiedProxy({read,lookup:async()=>({country:'RU',ip:'203.0.113.2'})}),/Russian/);
 await assert.rejects(verifiedProxy({read,lookup:async()=>({country:'',ip:'203.0.113.2'})}),/unknown/);
});
test('historical account country is never presented as a measured creation IP',()=>{
 const p=creationProfile({country:'jp'});assert.equal(p.creationCountry,'JP');assert.equal(p.creationCountrySource,'recorded-account-country');assert.equal(p.creationIp,'');
 const loc=cleanLocation({source:'proxy-ip',country:'US',ip:'203.0.113.4',city:'Test City',observedAt:'2026-10-30T00:00:00Z'});
 const measured=creationProfile({country:'US'},loc);assert.equal(measured.creationCountrySource,'proxy-ip');assert.equal(measured.creationIp,loc.ip);
 assert.throws(()=>cleanLocation({...loc,country:'RU'}));assert.throws(()=>cleanLocation({...loc,ip:'not-ip'}));
});
test('sample generation is marked fictional, preserves manual contacts and does not invent unknown country',()=>{
 const first=sampleContact({country:'JP'}),again=sampleContact(first);assert.equal(first.contactSource,'synthetic-internal');assert.match(first.phone,/^\+81\d+$/);assert.match(first.address,/fictional/);assert.deepEqual(again,first);
 assert.equal(sampleContact({phone:'existing',country:'JP'}).phone,'existing');assert.equal(sampleContact({}).phone,'');
});

test('random numbers match every recorded account country and old identifiers migrate idempotently',()=>{
 const {randomPhone}=require('../utils/epicAccountLocation'),{parsePhoneNumberFromString}=require('libphonenumber-js/max');
 for(const country of ['CO','JP','BD','GB','PE','US','AR','AE','RU','BR','KZ','TH']) {
  const values=new Set();
  for(let i=0;i<20;i++){const phone=randomPhone(country),parsed=parsePhoneNumberFromString(phone);assert.equal(parsed.country,country);assert.equal(parsed.isValid(),true);assert.match(phone,/^\+[1-9]\d{5,14}$/);values.add(phone);}
  assert.ok(values.size>1);
 }
 const before={country:'US',phone:'TEST-US-8A73539D',address:'Keep this address',contactSource:'synthetic-internal'};
 const migrated=sampleContact(before);assert.match(migrated.phone,/^\+1\d{10}$/);assert.equal(migrated.address,before.address);assert.deepEqual(sampleContact(migrated),migrated);
 assert.equal(sampleContact({...before,contactSource:'manual'}).phone,before.phone);
});
