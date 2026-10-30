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
function sampleContact(value) {
  const profile=creationProfile(value),country=profile.creationCountry||profile.country;
  if(!country||profile.phone||profile.address)return profile;
  const suffix=crypto.randomBytes(4).toString('hex').toUpperCase();
  // Deliberately non-dialable identifiers. No third party's phone/address is used.
  return {...profile,phone:'TEST-'+country+'-'+suffix,address:crypto.randomInt(1,1000)+' Example Test Street, '+(profile.creationCity?profile.creationCity+', ':'')+country+' (fictional)',contactCountry:country,contactSource:'synthetic-internal'};
}
module.exports={fields,cleanProfile,cleanLocation,creationProfile,sampleContact};
