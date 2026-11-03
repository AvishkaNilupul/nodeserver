(async()=>{
  try{
    // Other installed signup helpers can prepend their own status to body.
    // Chrome keeps the actual JSON response in pre; never parse their banners.
    const data=JSON.parse(document.querySelector('pre')?.textContent || document.body.innerText);
    if(data.success!==true||!data.ip||!data.country_code)throw Error('Proxy check returned no location');
    const result=await chrome.runtime.sendMessage({type:'proxy-observed',location:{ip:data.ip,country:data.country_code,city:data.city,region:data.region}});
    if(!result?.ok)throw Error(result?.error||'This proxy check is not assigned to a signup');
  }catch(e){const text=document.createElement('p');text.textContent='Valorant Signup: '+e.message;document.body.prepend(text);}
})();
