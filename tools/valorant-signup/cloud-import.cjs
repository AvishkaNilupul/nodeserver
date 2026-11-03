function validate(payload) {
  const a = payload?.account;
  if (payload?.version !== 1 || !a || !/^[a-z0-9_-]{6,64}$/i.test(a.localId||'') || !/^[a-z0-9_]{3,64}$/i.test(a.accountName||'')) throw Error('Invalid identity');
  if (!['reserved','created'].includes(a.status)) throw Error('Invalid signup state');
  if (typeof a.password !== 'string' || !a.password || a.password.length>256 || a.password.startsWith('enc:')) throw Error('Invalid credential');
  if (typeof a.email !== 'string' || a.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw Error('Invalid inbox');
  for (const value of [a.requestedCountry,a.proxyCountry]) if (!/^[A-Z]{2}$/.test(value||'')) throw Error('Invalid country');
  if (!['NA','EU','AP','LATAM','BR','KR'].includes(a.expectedShard)) throw Error('Invalid shard');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.birthDate||'')) throw Error('Invalid birth date');
  if (a.status === 'created' && (typeof a.completedAt !== 'string' || !a.completedAt)) throw Error('Missing completion');
  const signedUpAt = a.status === 'created' ? new Date(a.completedAt) : null;
  if (a.status==='created' && !Number.isFinite(signedUpAt.getTime())) throw Error('Missing completion');
  return {...a,loginKey:a.accountName.toLowerCase(),email:a.email.toLowerCase(),signedUpAt};
}
async function importAccount({payload,collection,encrypt,now=()=>new Date()}) {
  const a=validate(payload),time=now();
  const row={localId:a.localId,loginKey:a.loginKey,accountName:a.accountName,password:encrypt(a.password),email:encrypt(a.email),birthDate:encrypt(a.birthDate),
    requestedCountry:a.requestedCountry,proxyCountry:a.proxyCountry,expectedShard:a.expectedShard,
    country:null,shard:null,regionCheckedAt:null,regionEvidence:'',riotId:'',puuid:'',emailVerified:false,loginVerifiedAt:null,
    level:null,rank:'Unknown',skinCount:null,agentCount:null,stage:a.status==='created'?'stock':'signup_pending',
    signedUpAt:a.signedUpAt,importedAt:time,notes:'',listingId:'',listingUrl:'',priceUsd:null,soldAt:null,createdAt:time,updatedAt:time};
  try {await collection.updateOne({localId:a.localId},{$setOnInsert:row},{upsert:true});}
  catch(e){if(e.code!==11000)throw e;}
  // Completion can promote only its own pending record, never listed/sold stock.
  if(a.status==='created') await collection.updateOne({localId:a.localId,loginKey:a.loginKey,stage:'signup_pending'},{$set:{stage:'stock',signedUpAt:a.signedUpAt,updatedAt:time}});
  const saved=await collection.findOne({localId:a.localId,loginKey:a.loginKey},{projection:{_id:1,stage:1}});
  if(!saved)throw Error('Duplicate or missing account');
  return {success:true,localId:a.localId,cloudId:String(saved._id),stage:saved.stage};
}
if(require.main===module){
  const mongoose=require('mongoose');
  (async()=>{try{
    require('dotenv').config({quiet:true});let text='';
    for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>16384)throw Error('Payload too large');}
    const payload=JSON.parse(text);validate(payload);
    await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});
    await require('../../models/ValorantAccount').init();
    console.log(JSON.stringify(await importAccount({payload,collection:mongoose.connection.db.collection('valorantaccounts'),encrypt:require('../../utils/secretBox').encrypt})));
  }catch{console.log(JSON.stringify({success:false,message:'Valorant import failed'}));process.exitCode=1;}finally{await mongoose.disconnect();}})();
}
module.exports={validate,importAccount};
