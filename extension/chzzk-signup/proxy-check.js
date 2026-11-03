(async()=>{
  try{
    const data=JSON.parse(document.body.innerText);
    if(data.success!==true||!data.ip||!data.country_code)throw Error();
    let result;
    for(let attempt=0;attempt<20;attempt++){
      result=await chrome.runtime.sendMessage({type:'proxy-observed',location:{ip:data.ip,country:data.country_code}});
      if(result?.error!=='Signup operation is running.')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!result?.ok)throw Error();
  }catch{const p=document.createElement('p');p.textContent='CHZZK: browser proxy verification failed. No signup page was opened.';document.body.prepend(p);}
})();
