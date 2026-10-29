const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){let fetches=0,writes=0,pings=0;const module={exports:{}};
 const model={estimatedDocumentCount:async()=>1,findOneAndUpdate:async()=>{writes++;return {upcoming:true};},updateMany:async()=>{},updateOne:async()=>{}};
 const el={id:'offer',namespace:'ns',promotions:{upcomingPromotionalOffers:[{promotionalOffers:[{startDate:new Date(Date.now()-1000).toISOString(),endDate:new Date(Date.now()+60000).toISOString(),discountSetting:{discountPercentage:0}}]}]}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicWatcher'),'utf8'),{module,exports:module.exports,Date,Set,Math,Number,console,setTimeout,clearTimeout,require:n=>{
  if(n==='axios')return {get:async()=>{fetches++;await Promise.resolve();return {data:{data:{Catalog:{searchStore:{elements:[el]}}}}};}};
  if(n.includes('EpicFreebie'))return model;
  if(n==='./telegram')return {sendTelegram:async()=>pings++};
  throw Error('Unexpected side effect: '+n);
 }});return {api:module.exports,counts:()=>({fetches,writes,pings})};}
test('known giveaway boundary schedules before the fallback poll',()=>{
 const {api}=setup();assert.equal(api.nextDelay([{startDate:new Date(10000)}],1000),10000);
 assert.equal(api.nextDelay([],1000),15*60000);
});
test('concurrent silent refreshes share a fetch and do not claim or send messages',async()=>{
 const s=setup();await Promise.all([s.api.refreshIfStale({notify:false}),s.api.refreshIfStale({notify:false})]);
 assert.deepEqual(s.counts(),{fetches:1,writes:1,pings:0});
 assert.equal(s.api.status().lastCounts.live,1);
 await s.api.refreshIfStale({notify:false});assert.equal(s.counts().fetches,1);
});
