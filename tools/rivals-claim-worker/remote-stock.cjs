// Executed by stock-import.cjs through SSH on stdin. REQUEST and SAFETY are
// supplied by that transport. No marketplace connector, cookie persistence,
// scanner loop, bot reconfiguration or server restart is involved.
async function runRemote(request,safety,{load=require}={}){
 load('dotenv').config({quiet:true});
 const mongoose=load('mongoose');
 const {decrypt}=load('./utils/secretBox');
 const objectId=x=>{if(!/^[a-f\d]{24}$/i.test(x||''))throw Error('Invalid account id');return new mongoose.Types.ObjectId(x);};
 const jobId=request.id;
 if(!/^[\w-]{8,100}$/.test(jobId||''))throw Error('Invalid job id');
 await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,autoIndex:false});
 try{
  const db=mongoose.connection.db,steamId=objectId(request.steamId),twitchId=objectId(request.twitchId);
  const preparations=db.collection('rivalspreparations');
  const previous=await preparations.findOne({_id:jobId});
  const steam=await db.collection('steamaccounts').findOne({_id:steamId});
  const twitch=await db.collection('botaccounts').findOne({_id:twitchId});
  if(!steam||!twitch)throw Error('Selected account is missing');
  const output=manifest=>({id:jobId,holdId:manifest.holdId,holdVerified:true,holdCheckedAt:new Date().toISOString(),
    steam:{id:String(steamId),login:steam.accountName,password:decrypt(steam.password),email:decrypt(steam.email)},
    twitch:{id:String(twitchId),login:twitch.login,password:decrypt(twitch.credPassword)},expectedRewards:manifest.expectedRewards});
  if(previous){
    if(String(previous.steamId)!==String(steamId)||String(previous.twitchId)!==String(twitchId)||previous.status!=='held')throw Error('Existing preparation requires recovery');
    const own=await db.collection('droplogs').countDocuments({account:twitchId,soldSetId:previous.holdId,soldToUsername:'manual',soldAt:{$ne:null}});
    if(own<previous.reservedCount||steam.stage!=='problem'||!String(steam.notes).includes(jobId))throw Error('Preparation hold changed');
    if(request.action==='prepare')return {pending:false,state:'already-imported',id:jobId,steamId:String(steamId),twitchId:String(twitchId)};
    return output(previous);
  }
  const boosts=await db.collection('steamboosts').find({steamAccountId:steamId},{projection:{state:1,logoutAt:1}}).toArray();
  const count=(collection,filter)=>db.collection(collection).countDocuments(filter,{limit:1,maxTimeMS:5000});
  const exactLogin=new RegExp('^'+twitch.login.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i');
  const pool=await db.collection('availableaccounts').find({$or:[{usernameLower:twitch.login.toLowerCase()},{username:exactLogin},{clientSecret:twitch.clientSecret}]},{projection:{manualSold:1,soldGames:1,usageHistory:1,status:1,claimedNote:1}}).toArray();
  const marker='Internal Rivals claim hold '+jobId+' / Twitch '+String(twitchId);
  const notes=String(steam.notes||'');
  const snapshot={version:1,steam:{stage:steam.stage,holdNote:notes.includes(marker)||notes.includes('Internal Rivals claim canary hold'),soldAt:steam.soldAt},
    steamListingRefs:await count('steamlistings',{accounts:{$elemMatch:{steamAccountId:steamId,state:{$ne:'removed'}}}}),
    steamSaleRefs:await count('steamsales',{'accounts.steamAccountId':steamId}),
    steamG2gRefs:await count('steamg2gunits',{steamAccountId:steamId,state:{$ne:'removed'}}),
    steamBoostActive:boosts.some(b=>['queued','boosting','stopping'].includes(b.state)),steamLogoutAt:boosts.find(b=>['stopped','ready'].includes(b.state)&&b.logoutAt)?.logoutAt,steamNeverBoosted:boosts.length===0,
    otherPreparationRefs:await count('rivalspreparations',{$or:[{steamId},{twitchId}],_id:{$ne:jobId}}),
    twitchTwins:await db.collection('botaccounts').countDocuments({$or:[{login:exactLogin},{clientSecret:twitch.clientSecret}]}),twitch:{...twitch,hasPassword:!!twitch.credPassword},
    twitchCommittedDrops:await count('droplogs',{login:exactLogin,soldAt:{$ne:null}}),
    twitchConnectedDrops:await count('droplogs',{login:exactLogin,connected:true}),
    twitchListingRefs:await count('marketplacelistings',{$or:[{accountId:String(twitchId)},{accountLogin:exactLogin},{'units.accountId':String(twitchId)},{'units.login':exactLogin},{'units.accountLogin':exactLogin}]}),
    twitchLeaseRefs:await count('renteraccounts',{$or:[{login:exactLogin},{username:exactLogin},{clientSecret:twitch.clientSecret}]}),
    twitchResellerRefs:await count('reselleraccounts',{login:exactLogin,status:{$ne:'returned'}}),
    twitchUnclaimedRefs:await count('unclaimedaccounts',{$or:[{loginLower:twitch.login.toLowerCase()},{login:exactLogin}]}),pool};
  const inv=await load('./utils/twitchInventory').fetchInventory(twitch.clientSecret);
  snapshot.liveLogin=inv.login;snapshot.liveTwitchId=inv.twitchId;
  snapshot.liveRewards=inv.drops.filter(d=>/^marvel rivals$/i.test(d.game));
  if(request.action==='prepare'){
    safety.assertPreparationSafe(snapshot);
    if(notes.includes('Internal Rivals claim hold ')&&!notes.includes(marker))throw Error('Steam account already has another preparation hold');
    if(steam.stage==='problem'&&!notes.includes(marker))throw Error('Steam account needs its existing problem reviewed');
    // Claim the intent before stopping. Comparing the original notes prevents two
    // concurrent jobs from adopting the same Steam account with different pairs.
    if(!notes.includes(marker)){
      const claimed=await db.collection('steamaccounts').updateOne({_id:steamId,stage:steam.stage,notes:steam.notes??'',soldAt:null},{$set:{notes:(notes+'\n'+marker).trim(),updatedAt:new Date()}});
      if(claimed.modifiedCount!==1)throw Error('Steam hold changed');
    }
    const active=boosts.filter(b=>['queued','boosting','stopping'].includes(b.state));
    if(active.length){
      if(steam.stage!=='boosting'||active.length!==1)throw Error('Steam booster state needs review');
      if(active[0].state!=='stopping')await load('./utils/steamBoost').stop(String(active[0]._id),'Rivals claim preparation '+jobId,'rivals-claim-worker');
      return {pending:true,state:'waiting-logout',id:jobId,steamId:String(steamId),twitchId:String(twitchId)};
    }
    if(boosts.length&&!snapshot.steamLogoutAt)throw Error('Steam booster has not acknowledged logout');
    if(steam.stage==='stock'){
      const claimed=await db.collection('steamaccounts').updateOne({_id:steamId,stage:'stock',notes:{$regex:marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')},soldAt:null},{$set:{stage:'problem',updatedAt:new Date()}});
      if(claimed.modifiedCount!==1)throw Error('Steam hold changed');
    }else if(steam.stage!=='problem')throw Error('Steam booster has not returned the account to stock');
    return {pending:false,state:'held-for-import',id:jobId,steamId:String(steamId),twitchId:String(twitchId)};
  }
  safety.assertStockSafe(snapshot);
  const liveIds=new Set(snapshot.liveRewards.map(r=>r.benefitId));
  const rows=await db.collection('droplogs').find({account:twitchId,game:/^marvel rivals$/i,connected:{$ne:true},soldAt:null,benefitId:{$in:[...liveIds]},awardedAt:{$gte:new Date(Date.now()-170*86400000)}}).toArray();
  const costumes=rows.filter(r=>/Costume/i.test(r.name));
  if(!costumes.length)throw Error('No live sellable costume was verified');
  const holdId=new mongoose.Types.ObjectId().toString();
  const preparation={_id:jobId,holdId,steamId,twitchId,twitchLogin:twitch.login,status:'reserving',createdAt:new Date(),expectedRewards:costumes.map(r=>({id:r.benefitId,name:r.name})),reservedCount:rows.length};
  await preparations.insertOne(preparation);
  const set={_id:holdId,name:'Internal Rivals claim canary',items:rows.map(r=>({itemKey:r.itemKey,game:r.game}))};
  const won=await load('./utils/dropReservation').reserveSetOnAccount(twitchId,set,{soldToUsername:'manual',soldToAdminId:'rivals-claim-worker',soldSetId:holdId,realSale:false});
  if(!won)throw Error('Stock was taken concurrently; preparation retained for review');
  const foreign=await count('droplogs',{login:exactLogin,soldAt:{$ne:null},soldSetId:{$ne:holdId}});
  if(foreign)throw Error('A concurrent commitment needs review');
  const updated=await db.collection('steamaccounts').updateOne({_id:steamId,stage:'problem'},{$set:{notes:(steam.notes+'\nPreparation '+jobId+'; paired Twitch '+twitch.login).slice(-2000),updatedAt:new Date()}});
  if(updated.matchedCount!==1)throw Error('Steam hold changed');
  await preparations.updateOne({_id:jobId,status:'reserving'},{$set:{status:'held',heldAt:new Date()}});
  return output(preparation);
 }finally{await mongoose.disconnect();}
}
module.exports={runRemote};
