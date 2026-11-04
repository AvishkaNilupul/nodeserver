const test=require('node:test'),assert=require('node:assert/strict');
const safety=require('../tools/rivals-claim-worker/stock-safety.cjs');
const {runRemote}=require('../tools/rivals-claim-worker/remote-stock.cjs');
function fixture({stage='boosting',boostState='boosting',logoutAt=null,refs=false,connected=false,notes='',previous=false}={}){
 const request={id:'rivals-batch-test-0001',steamId:'a'.repeat(24),twitchId:'b'.repeat(24),action:'prepare'};
 const steam={_id:request.steamId,stage,accountName:'test_steam',notes,password:'private',email:'private'};
 const twitch={_id:request.twitchId,login:'test_twitch',clientSecret:'private-token',credPassword:'private',lastScanStatus:'ok',copiedCount:0};
 const boosts=boostState?[{_id:'c'.repeat(24),state:boostState,logoutAt}]:[];
 const writes=[],stops=[];
 const db={collection(name){return{
  async findOne(){return name==='steamaccounts'?steam:name==='botaccounts'?twitch:name==='rivalspreparations'&&previous?{steamId:request.steamId,twitchId:request.twitchId,status:'held',holdId:'hold',reservedCount:1}:null;},
  find(){return{async toArray(){return name==='steamboosts'?boosts:[];}}},
  async countDocuments(){return name==='botaccounts'||name==='droplogs'&&previous?1:name==='steamlistings'&&refs?1:0;},
  async updateOne(filter,update){writes.push({name,filter,update});Object.assign(steam,update.$set);return{modifiedCount:1,matchedCount:1};}
 };}};
 class ObjectId{constructor(value){this.value=value||'d'.repeat(24);}toString(){return this.value;}}
 const load=name=>({dotenv:{config(){}},mongoose:{Types:{ObjectId},connection:{db},async connect(){},async disconnect(){}},'./utils/secretBox':{decrypt:x=>x},'./utils/twitchInventory':{async fetchInventory(){return{login:'test_twitch',twitchId:'42',drops:[{game:'Marvel Rivals',benefitId:'costume',connected}]}}},'./utils/steamBoost':{async stop(...args){stops.push(args)}}})[name];
 return{request,steam,twitch,writes,stops,run:()=>runRemote(request,safety,{load})};
}
test('preparation requests canonical boost stop and never forces an online account into problem',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.state,'waiting-logout');assert.equal(f.stops.length,1);assert.equal(f.steam.stage,'boosting');assert(f.steam.notes.includes(f.request.id));assert(!JSON.stringify(r).includes('private'));
});
test('a pending stop is idempotent and does not repeat stop or claim stock',async()=>{
 const f=fixture({boostState:'stopping'});assert.equal((await f.run()).pending,true);assert.equal(f.stops.length,0);assert.equal(f.steam.stage,'boosting');
});
test('listed stock, marketplace references and linked Twitch rewards prevent any writes',async()=>{
 for(const args of [{stage:'listed'},{refs:true},{connected:true}]){const f=fixture(args);await assert.rejects(f.run());assert.equal(f.writes.length,0);assert.equal(f.stops.length,0);}
});
test('a different durable intent or unrelated problem account is never adopted',async()=>{
 for(const args of [{notes:'Internal Rivals claim hold other-job / Twitch other-id'},{stage:'problem',boostState:null}]){const f=fixture(args);await assert.rejects(f.run());assert.equal(f.writes.length,0);}
});
test('completed booster logout allows stock to become an exclusive preparation hold',async()=>{
 const f=fixture({stage:'stock',boostState:'stopped',logoutAt:new Date()});const r=await f.run();assert.equal(r.state,'held-for-import');assert.equal(f.steam.stage,'problem');assert.equal(f.stops.length,0);assert(f.writes.at(-1).filter.notes.$regex);
});
test('stopped without actual logout acknowledgement cannot enter preparation',async()=>{
 const f=fixture({stage:'stock',boostState:'stopped'});await assert.rejects(f.run(),/acknowledged logout/);assert.equal(f.steam.stage,'stock');
});
test('fresh never-boosted accounts can be held without fabricating a logout receipt',async()=>{
 const f=fixture({stage:'stock',boostState:null});assert.equal((await f.run()).state,'held-for-import');assert.equal(f.steam.stage,'problem');
});
test('prepare retry after import returns metadata only and never reveals the saved pair credentials',async()=>{
 const f=fixture({stage:'problem',boostState:null,notes:'Preparation rivals-batch-test-0001',previous:true});const r=await f.run();assert.equal(r.state,'already-imported');assert(!JSON.stringify(r).includes('private'));assert(!('steam' in r));assert.equal(f.writes.length,0);
});
