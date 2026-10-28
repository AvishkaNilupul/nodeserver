// UI submission, a worker timeout, and a captcha label aren't proof of ownership.
async function verifyClaimResult(result, namespace, readLibrary, {sleep=ms=>new Promise(r=>setTimeout(r,ms)), attempts=3}={}) {
  let checked=false;
  for(let i=0;i<attempts;i++) {
    try {
      const records=await readLibrary();checked=true;
      if(records.some(r=>r.namespace===namespace)) return {...result,status:result.status==='already_owned'?'already_owned':'claimed',error:'',verified:true};
    }catch{}
    if(i+1<attempts)await sleep(1500);
  }
  if(['claimed','already_owned','submitted'].includes(result.status)) return {status:'error',error:checked?'Checkout submitted but game ownership is not confirmed yet':'Could not verify game ownership; retry after library sync',verified:false};
  return {...result,verified:false};
}
module.exports={verifyClaimResult};
