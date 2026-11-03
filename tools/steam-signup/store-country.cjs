const {prepareProxy}=require('./regions.cjs');
const {createGuardMail}=require('../steam-booster/guard-mail.cjs');

// Read the wallet's explicit country. IP country, currency, and profile location
// are different signals and must never be substituted for this value.
function walletCountry(body,header){
  if(header?.proto?.eresult!==1)throw Error('Steam could not read the store country. Try again later.');
  const country=String(body?.wallet_country_code||'').toUpperCase();
  if(!/^[A-Z]{2}$/.test(country)||['XX','ZZ'].includes(country))throw Error('Steam has not returned a store country for this account.');
  return country;
}
// steam-user ships this protobuf but does not register the method in its
// convenience unified-method table. Encode/decode it explicitly on its transport.
function readWallet(client,callback){
  const schema=require('steam-user/protobufs/generated/_load.js');
  const EMsg=require('steam-user/enums/EMsg.js');
  const request=schema.CUserAccount_GetClientWalletDetails_Request.encode({wallet_region:1}).finish();
  client._send({msg:EMsg.ServiceMethodCallFromClient,proto:{target_job_name:'UserAccount.GetClientWalletDetails#1'}},request,(raw,header)=>{
    try{
      const bytes=Buffer.isBuffer(raw)?raw:raw.toBuffer();
      callback(null,schema.CUserAccount_GetWalletDetails_Response.decode(bytes),header);
    }catch{callback(Error('Steam could not read the store country. Try again later.'));}
  });
}
function createCountryChecker({prepare=prepareProxy,guardMail=createGuardMail(),createClient,timeoutMs=120000}={}){
  return async account=>{
    const exit=await prepare(account.requestedCountry||account.country);
    const url=new URL('http://'+exit.host+':'+exit.port);
    url.username=exit.username;url.password=exit.password;
    const make=createClient||(options=>{const SteamUser=require('steam-user');return new SteamUser(options);});
    const client=make({httpProxy:url.href,dataDirectory:null,autoRelogin:false,enablePicsCache:false});
    const since=new Date().toISOString();
    return new Promise((resolve,reject)=>{
      let settled=false,guardBusy=false,reading=false;
      const finish=(error,country)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        try{client.logOff();}catch{}
        error?reject(error):resolve({country,source:'steam-wallet-country',checkedAt:new Date().toISOString()});
      };
      const timer=setTimeout(()=>finish(Error('Steam country check timed out. Try again later.')),timeoutMs);
      client.on('error',()=>finish(Error('Steam sign-in failed. Check the saved credentials or try again later.')));
      client.on('disconnected',()=>finish(Error('Steam disconnected before the country check finished.')));
      client.on('steamGuard',(domain,callback,lastCodeWrong)=>{
        if(settled||guardBusy)return;
        if(!domain||lastCodeWrong)return finish(Error('Steam needs a valid Guard code or mobile approval before this account can be checked.'));
        guardBusy=true;
        guardMail.waitForCode(account.email,since,{timeoutMs:90000}).then(hit=>{if(!settled)callback(hit.code);}).catch(()=>finish(Error('Steam Guard email did not arrive. Check the Outlook reader and retry.'))).finally(()=>{guardBusy=false;});
      });
      client.on('loggedOn',()=>{
        if(settled||reading)return;reading=true;
        try{readWallet(client,(error,body,header)=>{
          if(settled)return;
          if(error)return finish(error);
          try{finish(null,walletCountry(body,header));}catch(e){finish(e);}
        });}catch{finish(Error('Steam country lookup is unavailable. Try again later.'));}
      });
      try{client.logOn({accountName:account.username,password:account.password});}catch{finish(Error('Steam sign-in could not start. Try again later.'));}
    });
  };
}
module.exports={createCountryChecker,walletCountry,readWallet};
