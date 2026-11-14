const crypto = require('crypto');
const net = require('net');
const fields = {firstName:80,lastName:80,dateOfBirth:10,country:2,notes:4000,
  phone:80,address:500,contactSource:40,contactCountry:2,
  creationCountry:2,creationCountrySource:40,creationIp:45,creationCity:120,creationRegion:120,creationObservedAt:30};
function cleanProfile(value={}) {
  const result={};
  for(const [key,max] of Object.entries(fields)) {
    const v=value?.[key];
    if(v!==undefined && (typeof v!=='string'||v.length>max||v.includes('\0')))throw Error('Invalid profile field');
    result[key]=v||'';
  }
  for(const key of ['country','creationCountry','contactCountry']) {
    if(result[key]&&!/^[A-Za-z]{2}$/.test(result[key]))throw Error('Invalid country');
    result[key]=result[key].toUpperCase();
  }
  return result;
}
function cleanLocation(value) {
  if(!value)return null;
  if(value.source!=='proxy-ip'||!net.isIP(value.ip)||!/^[A-Z]{2}$/.test(value.country||'')||value.country==='RU'||!Number.isFinite(Date.parse(value.observedAt)))throw Error('Invalid signup location');
  return {country:value.country,ip:value.ip,city:String(value.city||'').slice(0,120),region:String(value.region||'').slice(0,120),observedAt:new Date(value.observedAt).toISOString(),source:'proxy-ip'};
}
function creationProfile(value,location=null) {
  const profile=cleanProfile(value);
  if(!profile.creationCountry) {
    if(location)Object.assign(profile,{creationCountry:location.country,creationCountrySource:'proxy-ip',creationIp:location.ip,creationCity:location.city,creationRegion:location.region,creationObservedAt:location.observedAt});
    else if(profile.country)Object.assign(profile,{creationCountry:profile.country,creationCountrySource:'recorded-account-country'});
  }
  return profile;
}
function randomPhone(country) {
  const {getExampleNumber,parsePhoneNumberFromString}=require('libphonenumber-js/max');
  const examples=require('libphonenumber-js/mobile/examples');
  const example=getExampleNumber(country,examples);
  if(!example)throw Error('No phone-number format is available for '+country);
  const prefix=example.nationalNumber.slice(0,4),size=example.nationalNumber.length-prefix.length;
  for(let attempt=0;attempt<200;attempt++){
    const suffix=Array.from({length:size},()=>crypto.randomInt(0,10)).join('');
    const candidate=parsePhoneNumberFromString('+'+example.countryCallingCode+prefix+suffix);
    if(candidate?.country===country&&candidate.isValid()&&candidate.number!==example.number)return candidate.number;
  }
  throw Error('Could not generate a matching phone-number format for '+country);
}
function sampleContact(value) {
  const profile=creationProfile(value),country=profile.creationCountry||profile.country;
  if(!country)return profile;
  // Upgrade only our old synthetic identifiers. Never overwrite manual contacts.
  if(profile.contactSource==='synthetic-internal'&&/^TEST-[A-Z]{2}-[A-F0-9]{8}$/.test(profile.phone)) {
    return {...profile,phone:randomPhone(country),contactCountry:country};
  }
  if(profile.phone||profile.address)return profile;
  return {...profile,phone:randomPhone(country),address:crypto.randomInt(1,1000)+' Example Test Street, '+(profile.creationCity?profile.creationCity+', ':'')+country+' (fictional)',contactCountry:country,contactSource:'synthetic-internal'};
}
module.exports={fields,cleanProfile,cleanLocation,creationProfile,sampleContact,randomPhone};
