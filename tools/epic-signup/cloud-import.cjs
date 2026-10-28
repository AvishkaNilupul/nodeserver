// Private SSH import command. No HTTP route or website session is exposed.
function validate(payload) {
  const a=payload?.account;
  if(payload?.version!==1||!a||!/^[a-f\d]{32}$/i.test(a.accountId||''))throw Error('Invalid account');
  for(const [key,max] of Object.entries({displayName:100,email:254,password:256,totpSecret:256,refreshToken:16384})) {
    if(a[key]!==undefined&&(typeof a[key]!=='string'||a[key].length>max||a[key].includes('\0')||a[key].startsWith('enc:')))throw Error('Invalid credential field');
  }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email||'')||!a.password||!a.refreshToken)throw Error('Incomplete account');
  const profile={};
  for(const [key,max] of Object.entries({firstName:80,lastName:80,dateOfBirth:10,country:2,notes:4000})) {
    const value=a.profile?.[key];if(value!==undefined&&(typeof value!=='string'||value.length>max))throw Error('Invalid profile');profile[key]=value||'';
  }
  return{...a,profile};
}
async function importAccount({payload,collection,encrypt,now=()=>new Date()}) {
  const a=validate(payload),time=now();
  // Only an insert may set credentials. Retries cannot overwrite sold state,
  // a cloud-rotated token, library data, labels or manually edited details.
  const document={accountId:a.accountId,displayName:a.displayName||'',label:'generated-'+time.toISOString().slice(0,10),source:'generated',status:'ok',sold:false,email:encrypt(a.email.toLowerCase()),password:encrypt(a.password),totpSecret:encrypt(a.totpSecret||''),refreshToken:encrypt(a.refreshToken),refreshExpiresAt:a.refreshExpiresAt&&!Number.isNaN(Date.parse(a.refreshExpiresAt))?new Date(a.refreshExpiresAt):null,accountDetails:encrypt(JSON.stringify(a.profile)),detailsUpdatedAt:time,createdAt:time,updatedAt:time,library:[],libraryCount:0,libraryValueUsd:0,autoClaimCount:0,autoClaimLog:[]};
  let result;
  try{result=await collection.updateOne({accountId:a.accountId},{$setOnInsert:document},{upsert:true});}
  catch(e){if(e.code!==11000)throw e;result={upsertedCount:0};}
  const saved=await collection.findOne({accountId:a.accountId},{projection:{_id:1,displayName:1}});
  if(!saved)throw Error('Import not persisted');
  return{success:true,accountId:a.accountId,cloudId:String(saved._id),displayName:saved.displayName,inserted:result.upsertedCount===1,alreadyPresent:result.upsertedCount!==1};
}
if(require.main===module){
  const mongoose=require('mongoose');
  (async()=>{try{
    require('dotenv').config({quiet:true});let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>65536)throw Error('Payload too large');}
    const payload=JSON.parse(text);validate(payload);
    await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});
    console.log(JSON.stringify(await importAccount({payload,collection:mongoose.connection.db.collection('epicaccounts'),encrypt:require('../../utils/secretBox').encrypt})));
  }catch{console.log(JSON.stringify({success:false,message:'Cloud import could not be completed'}));process.exitCode=1;}finally{await mongoose.disconnect();}})();
}
module.exports={importAccount,validate};
