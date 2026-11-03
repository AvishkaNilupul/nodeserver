// SSH/stdin-only, insert-only bridge into the existing CHZZK farm.
function validate(p){
  if(p?.version!==1||typeof p.localId!=='string'||p.localId.length>64||!p.localId||typeof p.userIdHash!=='string'||p.userIdHash.length>128||!p.userIdHash||!Array.isArray(p.cookies)||p.cookies.length>100)throw Error('Invalid import');
  if(!p.cookies.every(c=>/^\.?naver\.com$/.test(c.domain||'')&&typeof c.name==='string'&&/^[\w.-]+$/.test(c.name)&&typeof c.value==='string'&&c.value.length<16384&&!/[\r\n;]/.test(c.value)))throw Error('Invalid cookies');
  if(!['NID_AUT','NID_SES'].every(n=>p.cookies.some(c=>c.name===n&&c.value)))throw Error('Missing login');
  return p;
}
async function importAccount({payload,Account,client,jar,encrypt,now=()=>new Date()}){
  const p=validate(payload),who=await client.userStatus();
  if(who.userIdHash!==p.userIdHash||!who.loggedIn)throw Error('Wrong login');
  const time=now(),cookies=jar.cookies(),persistent=cookies.find(c=>c.name==='NID_AUT');
  const doc={userIdHash:who.userIdHash,nickname:String(who.nickname||'').slice(0,120),cookies:encrypt(JSON.stringify(cookies)),cookieAt:time,cookieKind:persistent?.expirationDate?'persistent':'session',cookieExpiresAt:persistent?.expirationDate?new Date(persistent.expirationDate*1000):null,deviceId:cookies.find(c=>c.name==='ba.uuid')?.value||'',status:'ok',lastCheckedAt:time,penalties:who.penalties?.length||0,sold:false,paused:false,note:'Local generator '+p.localId,progress:{},createdAt:time};
  let r;try{r=await Account.updateOne({userIdHash:p.userIdHash},{$setOnInsert:doc},{upsert:true,timestamps:false});}catch(e){if(e.code!==11000)throw e;r={upsertedCount:0};}
  const saved=await Account.findOne({userIdHash:p.userIdHash}).select('_id').lean();
  if(!saved)throw Error('Not persisted');
  return{success:true,localId:p.localId,cloudId:String(saved._id),inserted:r.upsertedCount===1,alreadyPresent:r.upsertedCount!==1};
}
if(require.main===module){
  const mongoose=require('mongoose');
  (async()=>{try{
    require('dotenv').config({quiet:true});let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>90000)throw Error('Import too large');}
    const payload=validate(JSON.parse(text));
    const {getTransport}=require('../../utils/chzzk/http'),{makeClient}=require('../../utils/chzzk/client'),{createJarStore}=require('../../utils/chzzk/jarStore');
    if(!process.env.CHZZK_PROXY_URL)throw Error('CHZZK egress not configured');
    const transport=getTransport(),country=await makeClient({transport}).egressCountry();
    if(!(process.env.CHZZK_COUNTRIES||'JP,KR,FR').split(',').map(s=>s.trim()).includes(country))throw Error('Egress refused');
    const jar=createJarStore({cookies:payload.cookies}),client=makeClient({jar,transport});
    await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});
    console.log(JSON.stringify(await importAccount({payload,Account:require('../../models/ChzzkAccount'),client,jar,encrypt:require('../../utils/secretBox').encrypt})));
  }catch{console.log(JSON.stringify({success:false,message:'Farm import failed; local account remains saved.'}));process.exitCode=1;}finally{await mongoose.disconnect();}})();
}
module.exports={validate,importAccount};
