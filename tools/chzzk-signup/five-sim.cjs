// 5sim activation API. Purchases are deliberately never retried by the transport.
class ProviderError extends Error {
  constructor(message, {ambiguous=false, code='PROVIDER'}={}) { super(message); this.ambiguous=ambiguous; this.code=code; }
}
function candidates(prices, countries, attempts=[], maxPrice=.05) {
  const rows=[];
  for(const [country, operators] of Object.entries(prices.naver||{})) {
    const prefixes=Object.keys(countries[country]?.prefix||{});
    if(prefixes.length!==1)continue;
    const available=Object.entries(operators).filter(([,p])=>Number(p.count)>0&&Number(p.cost)>0&&Number(p.cost)<=maxPrice);
    if(!available.length)continue;
    available.sort((a,b)=>Number(a[1].cost)-Number(b[1].cost));
    rows.push({country,prefix:prefixes[0],label:countries[country].text_en||country,cost:Number(available[0][1].cost)});
  }
  rows.sort((a,b)=>a.cost-b.cost||a.country.localeCompare(b.country));
  const last=attempts.at(-1);
  // Owner: every failed SMS switches country, retaining the browser signup.
  if(last) {
    const tried=new Set(attempts.map(a=>a.country)),fresh=rows.filter(r=>!tried.has(r.country));
    if(fresh.length)return fresh;
    const alternate=rows.filter(r=>r.country!==last.country);
    if(alternate.length)return alternate;
    return [];
  }
  return rows;
}
class FiveSim {
  constructor({token,fetchImpl=fetch,timeoutMs=20000}={}){this.token=token;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;}
  async request(endpoint,{authenticated=true,purchase=false}={}) {
    if(authenticated&&!this.token)throw new ProviderError('Set the 5sim API key in local settings.');
    let response,text;
    try {
      response=await this.fetch('https://5sim.net/v1/'+endpoint,{headers:{Accept:'application/json',...(authenticated?{Authorization:'Bearer '+this.token}:{})},redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
      text=await response.text();
    }catch {throw new ProviderError(purchase?'Purchase response missing. Reconcile the order before retrying.':'5sim is unavailable. Retry the same operation.',{ambiguous:purchase});}
    if(!response.ok)throw new ProviderError(response.status===401?'5sim rejected the API key.':response.status===400?'5sim refused the request. Check balance, stock and order state.':'5sim service error.',{ambiguous:purchase&&response.status>=500});
    let data;try{data=JSON.parse(text);}catch{
      if(purchase&&text.trim()==='no free phones')throw new ProviderError('No numbers available in this country.',{code:'NO_STOCK'});
      throw new ProviderError('5sim returned an unexpected response.',{ambiguous:purchase});
    }
    return data;
  }
  profile(){return this.request('user/profile');}
  prices(){return this.request('guest/prices?product=naver',{authenticated:false});}
  countries(){return this.request('guest/countries',{authenticated:false});}
  async buy(country,maxPrice){
    if(!/^[a-z]+$/.test(country)||!Number.isFinite(maxPrice)||maxPrice<=0)throw new ProviderError('Invalid purchase selection.');
    const order=await this.request('user/buy/activation/'+country+'/any/naver?maxPrice='+encodeURIComponent(maxPrice),{purchase:true});
    if(!Number.isSafeInteger(order?.id)||!/^\+\d{7,15}$/.test(order.phone||'')||!Number.isFinite(order.price)||order.price<=0||!Number.isFinite(Date.parse(order.expires))||order.product!=='naver'||order.country!==country)throw new ProviderError('Unrecognized purchase result. Reconcile before retrying.',{ambiguous:true});
    return order;
  }
  order(id,action='check'){
    if(!Number.isSafeInteger(Number(id))||Number(id)<=0||!['check','cancel','finish'].includes(action))throw new ProviderError('Invalid order action.');
    return this.request('user/'+action+'/'+id);
  }
  history(){return this.request('user/orders?category=activation&limit=100&offset=0&order=id&reverse=true');}
}
module.exports={FiveSim,ProviderError,candidates};
