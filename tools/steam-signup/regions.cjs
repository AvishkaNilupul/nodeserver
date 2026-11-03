const crypto=require('crypto'),net=require('net');
const {readProxy,lookupExit}=require('../../utils/epicLocalProxy');
const {sampleContact}=require('../../utils/epicAccountLocation');
// ProxyScrape Regular Residential's published country-targeting catalog.
// https://docs.proxyscrape.com/proxies/residential/country-targeting
const COUNTRY_CODES='AE AF AL AM AR AT AU AW AZ BA BD BE BG BH BR BS BY CA CH CL CM CN CO CR CY CZ DE DK DO DZ EC EE EG ES ET FI FR GB GE GH GR GT GY HK HR HU ID IE IL IN IQ IR IT JP JM KE KH KR KW KZ LK LT LV MA MD ME MG MN MU MX MY MZ NG NL NO NP NZ OM PA PE PH PK PL PR PS PT PY QA RO RS RU SA SE SG SI SK SN SO SR SV SY TH TJ TN TR TT TW UA UG US UZ VE VN ZA ZM'.split(' ');
const names=new Intl.DisplayNames(['en'],{type:'region'});
const countries=COUNTRY_CODES.map(code=>({code,name:names.of(code)})).sort((a,b)=>a.name.localeCompare(b.name));
function cleanCountry(value){if(typeof value!=='string'||!COUNTRY_CODES.includes(value))throw Error('Choose a supported proxy country');return value;}
function targetProxy(country,read=readProxy){
  cleanCountry(country);const p=read();
  if(p.host.toLowerCase()!=='rp.scrapegw.com')throw Error('Steam region targeting requires the configured ProxyScrape residential provider');
  const base=p.username.replace(/-(?:country)-[a-z]{2}(?=-|$)/ig,'').replace(/-(?:state|city)-[^-]+/ig,'').replace(/-(?:sessid|session)-[a-z0-9]+/ig,'').replace(/-lifetime-\d+/ig,'');
  return {...p,username:base+'-country-'+country.toLowerCase()+'-session-'+crypto.randomBytes(8).toString('hex')+'-lifetime-30'};
}
async function readCloudProxy(){
  const axios=require('axios');
  const http=axios.create({baseURL:'http://127.0.0.1:3999',proxy:false,timeout:30000});
  const {data:capabilities}=await http.get('/api/pool/capabilities');
  if(capabilities.authority!=='cloud')throw Error('Connect the cloud Outlook pool before preparing a proxy');
  const {data}=await http.post('/api/epic/proxy',{});
  if(!data.ok||!data.proxy)throw Error('Cloud residential proxy is unavailable');
  return data.proxy;
}
async function prepareProxy(country,{read=readCloudProxy,lookup=lookupExit}={}){
  cleanCountry(country);
  const seed=await read();
  for(let attempt=0;attempt<2;attempt++){
    const p=targetProxy(country,()=>seed);const location=await lookup(p);
    if(location.country===country && net.isIP(location.ip))return {...p,location,expiresAt:new Date(Date.now()+25*60000).toISOString()};
  }
  throw Error('The proxy exit did not match '+country+'; no inbox was reserved');
}
function browserLocation(value,proxy){
  if(!value||!net.isIP(value.ip)||value.ip!==proxy.location.ip||value.country!==proxy.location.country||Date.parse(proxy.expiresAt)<=Date.now())throw Error('Browser proxy verification failed; no inbox was reserved');
  return {ip:value.ip,country:value.country,city:String(value.city||'').slice(0,120),region:String(value.region||'').slice(0,120),observedAt:new Date().toISOString(),source:'browser-proxy-ip'};
}
function contactFor(country,location){
  const p=sampleContact({country:cleanCountry(country),creationCountry:country,creationCity:location?.city||''});
  return {phone:p.phone,address:p.address,country,source:'synthetic-internal',smsCapable:false};
}
module.exports={countries,cleanCountry,targetProxy,prepareProxy,browserLocation,contactFor};
