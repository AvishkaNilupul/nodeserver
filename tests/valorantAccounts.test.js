const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {publicRow,buildUpdate,blockers}=require('../routes/valorantAccountRoutes')._internal;
const {createRouter}=require('../routes/valorantAccountRoutes');
const {validate,importAccount}=require('../tools/valorant-signup/cloud-import.cjs');
const {CloudSync,payload}=require('../tools/valorant-signup/cloud-sync.cjs');
const id='6f0000000000000000000001';
const base={_id:id,localId:'fixture-123',accountName:'Fixture',stage:'signup_pending',expectedShard:'AP',requestedCountry:'JP',proxyCountry:'JP',password:'secret',email:'private@example.test',birthDate:'1994-01-01'};
const pending={version:1,account:{localId:base.localId,accountName:base.accountName,status:'reserved',password:'fixture-secret',email:'fixture@outlook.com',birthDate:'1994-01-01',requestedCountry:'JP',proxyCountry:'JP',expectedShard:'AP'}};
test('public stock never discloses credentials and pending signup cannot pass checks',()=>{
  const row=publicRow(base);assert.ok(!JSON.stringify(row).includes('private@example.test'));assert.ok(!JSON.stringify(row).includes('secret'));assert.equal(row.password,undefined);assert.equal(row.birthDate,undefined);
  assert.ok(row.blockers.includes('Signup unfinished'));
  assert.throws(()=>buildUpdate({regionCheck:{country:'JP',shard:'AP',evidence:'Riot profile'}},base),/Complete signup/);
  assert.throws(()=>buildUpdate({loginVerified:true},base),/Complete signup/);
  assert.equal(blockers({...base,stage:'stock',country:'JP',shard:'AP',regionCheckedAt:new Date(),loginVerifiedAt:new Date(),emailVerified:true}).length,0);
  assert.ok(blockers({...base,stage:'listed',country:'JP',shard:'AP',regionCheckedAt:new Date(),loginVerifiedAt:new Date(),emailVerified:true}).length);
});
test('observed region requires explicit evidence; numeric unknown is distinct from zero',()=>{
  assert.throws(()=>buildUpdate({regionCheck:{country:'JP',shard:'AP',evidence:''}},{stage:'stock'}),/evidence/);
  assert.throws(()=>buildUpdate({level:'20'},{stage:'stock'}),/Invalid level/);
  assert.deepEqual(buildUpdate({level:null,skinCount:0,agentCount:null},{stage:'stock'}),{level:null,skinCount:0,agentCount:null});
  const patch=buildUpdate({regionCheck:{country:'JP',shard:'AP',evidence:'Read Riot profile and game region'},loginVerified:true,emailVerified:true},{stage:'stock'});
  assert.equal(patch.shard,'AP');assert.ok(patch.regionCheckedAt instanceof Date);assert.ok(patch.loginVerifiedAt instanceof Date);
  assert.equal(patch.stage,undefined);
});
test('import preserves one identity, promotes only pending rows, and never overwrites listed/sold data',async()=>{
  const map=new Map();const collection={
    async updateOne(filter,update){let a=map.get(filter.localId);
      if(!a&&update.$setOnInsert){if([...map.values()].some(x=>x.loginKey===update.$setOnInsert.loginKey)){const e=Error('duplicate');e.code=11000;throw e;}a={_id:id,...structuredClone(update.$setOnInsert)};map.set(filter.localId,a);}
      if(a&&(!filter.stage||filter.stage===a.stage)&&(!filter.loginKey||filter.loginKey===a.loginKey)&&update.$set)Object.assign(a,update.$set);return{};
    },async findOne(filter){const a=map.get(filter.localId);return a&&a.loginKey===filter.loginKey?a:null;},
  };
  const run=account=>importAccount({payload:account,collection,encrypt:v=>'encrypted:'+v});
  assert.equal((await run(pending)).stage,'signup_pending');assert.equal(map.size,1);
  const row=map.get(base.localId);assert.equal(row.country,null);assert.equal(row.shard,null);assert.equal(row.level,null);assert.match(row.password,/^encrypted:/);
  row.notes='Keep operator notes';const completed={version:1,account:{...pending.account,status:'created',completedAt:'2026-11-03T18:00:00Z'}};
  assert.equal((await run(completed)).stage,'stock');assert.equal(map.size,1);assert.equal(row.notes,'Keep operator notes');
  row.stage='sold';row.soldAt=new Date();await run(completed);assert.equal(row.stage,'sold');
  await assert.rejects(run({version:1,account:{...completed.account,localId:'another-123'}}),/Duplicate/);assert.equal(map.size,1);
  assert.throws(()=>validate({version:1,account:{...completed.account,completedAt:null}}),/Missing completion/);
});
test('upload retries a pending signup then uploads completion despite the earlier successful pending upload',async()=>{
  let time=0,calls=0;const s={id:'fixture-123',username:'Fixture',password:'secret',email:'fixture@outlook.com',birthDate:'1994-01-01',requestedCountry:'JP',expectedShard:'AP',creationLocation:{country:'JP'},status:'reserved'};
  const vault={data:{sessions:[s],accounts:[]},save(){}};
  const sync=new CloudSync({vault,now:()=>time,upload:async session=>{calls++;if(calls===1)throw Error('offline');return{cloudId:id,localId:session.id};}});
  await sync.runDue();assert.equal(s.cloud.state,'pending');assert.equal(calls,1);
  time=60001;await sync.runDue();assert.equal(s.cloud.syncedStatus,'reserved');assert.equal(calls,2);
  await sync.runDue();assert.equal(calls,2);s.status='created';s.completedAt='2026-11-03T18:00:00Z';vault.data.accounts.push({...s});
  await sync.runDue();assert.equal(calls,3);assert.equal(s.cloud.syncedStatus,'created');assert.equal(vault.data.accounts[0].cloud.syncedStatus,'created');
  assert.equal(payload(s).account.status,'created');
});
test('admin API denies anonymous/non-superadmin access and records actual category refusal without publishing',async t=>{
  let checks=0,stored=null;
  const query=data=>({sort(){return this;},limit(){return this;},lean:async()=>data});
  const AccountModel={find:()=>query([base]),findById:()=>query(base)};
  const StateModel={findById:()=>query(stored),updateOne:async(_q,u)=>{stored=u.$set;}};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session=req.get('x-test-role')?{admin:{role:req.get('x-test-role')}}:{};next();});
  app.use(createRouter({AccountModel,StateModel,eld:{epicPermission:async game=>{assert.equal(game,'32');checks++;return{canSell:false,epicIsHighRisk:true,allowHighRiskOffers:false,error:''};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const url='http://127.0.0.1:'+server.address().port,headers={Accept:'application/json','Content-Type':'application/json','x-test-role':'superadmin'};
  assert.equal((await fetch(url+'/api/valorant/accounts',{headers:{Accept:'application/json'}})).status,401);
  assert.equal((await fetch(url+'/api/valorant/accounts',{headers:{...headers,'x-test-role':'admin'}})).status,403);
  const data=await fetch(url+'/api/valorant/accounts',{headers}).then(r=>r.json());assert.equal(data.summary.completed,0);assert.equal(data.summary.pending,1);assert.equal(data.summary.ready,0);assert.equal(data.accounts[0].password,undefined);
  const checked=await fetch(url+'/api/valorant/eldorado/check',{method:'POST',headers,body:'{}'}).then(r=>r.json());
  assert.equal(checked.permission.canSell,false);assert.equal(stored.restricted,true);assert.equal(checks,1);
});
