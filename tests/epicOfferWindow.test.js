const test=require('node:test'),assert=require('node:assert/strict');
const {offerState,live}=require('../utils/epicOfferWindow');
test('dates govern giveaway rollover even with stale feed flags',()=>{
 const offer={active:true,upcoming:true,startDate:new Date(1000),endDate:new Date(2000)};
 assert.equal(offerState(offer,999),'upcoming');assert.equal(live(offer,1000),true);
 assert.equal(offerState({...offer,upcoming:false},2000),'expired');
 assert.equal(live({...offer,active:false},1500),false);
 assert.equal(live({...offer,startDate:'broken'},1500),false);
 assert.equal(live({active:true,upcoming:true},1500),false);
});
