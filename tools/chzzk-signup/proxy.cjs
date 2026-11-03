// Credentials stay in the existing protected local configuration and encrypted
// signup vault. Never put provider responses or proxy URLs in public errors.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),net=require('net');
const {problem}=require('./engine.cjs');
function readProxy({env=process.env,filename=path.join(os.homedir(),'epic-claim/.env')}={}){
  let saved={};if(fs.existsSync(filename))saved=require('dotenv').parse(fs.readFileSync(filename));
  const get=k=>env[k]||saved[k]||'',host=get('RES_HOST'),port=Number(get('RES_PORT')),username=get('RES_USER'),password=get('RES_PASS');
  if(!/^[a-z0-9.-]+$/i.test(host)||!Number.isInteger(port)||port<1||port>65535||!username||!password)throw problem('Configure the existing residential proxy before starting CHZZK signup.');
  if(host.toLowerCase()!=='rp.scrapegw.com')throw problem('CHZZK signup requires the configured residential proxy provider.');
  let base=username.replace(/-(?:sessid|session)-[a-z0-9]+/ig,'').replace(/-lifetime-\d+/ig,'');
  if(!/-country-[a-z]{2}(?:-|$)/i.test(base))base+='-country-us';
  return{scheme:'http',host,port,username:base+'-session-'+crypto.randomBytes(8).toString('hex')+'-lifetime-30',password,country:base.match(/-country-([a-z]{2})(?:-|$)/i)[1].toUpperCase()};
}
async function lookupExit(proxy){
  const url=new URL('http://'+proxy.host+':'+proxy.port);url.username=proxy.username;url.password=proxy.password;
  try{
    const {HttpsProxyAgent}=require('https-proxy-agent');
    const {data}=await require('axios').get('https://ipwho.is/',{httpsAgent:new HttpsProxyAgent(url),proxy:false,timeout:10000,maxRedirects:0,maxContentLength:16384});
    if(data.success!==true||!net.isIP(data.ip)||!/^[A-Z]{2}$/.test(data.country_code||''))throw Error();
    return{ip:data.ip,country:data.country_code};
  }catch{throw problem('The residential proxy could not be verified. No signup page was opened.');}
}
async function prepareProxy({read=readProxy,lookup=lookupExit,now=Date.now}={}){
  const proxy=read(),location=await lookup(proxy);
  if(location.country!==proxy.country)throw problem('The residential proxy country did not match its configuration.');
  return{...proxy,location,ticket:crypto.randomBytes(24).toString('base64url'),expiresAt:new Date(now()+25*60000).toISOString()};
}
function verifyBrowser(proxy,ticket,location,now=Date.now){
  if(!proxy||proxy.ticket!==ticket||!Number.isFinite(Date.parse(proxy.expiresAt))||Date.parse(proxy.expiresAt)<=now()||!net.isIP(location?.ip||'')||location.ip!==proxy.location.ip||location.country!==proxy.location.country)throw problem('Browser proxy verification failed. Keep signup stopped and test the proxy again.');
  return{country:location.country,verifiedAt:new Date(now()).toISOString(),expiresAt:proxy.expiresAt};
}
module.exports={readProxy,lookupExit,prepareProxy,verifyBrowser};
