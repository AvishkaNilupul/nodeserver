// Use Steam's own page context for its javascript: controls. Isolated-world
// clicks inherit the extension CSP, which rejects those normal site links.
document.addEventListener('steam-signup-routine-click',event=>{
  const el=event.target;
  if(!(el instanceof HTMLAnchorElement)||!el.getAttribute('href')?.startsWith('javascript:'))return;
  const label=(el.innerText||'').trim().replace(/\s+/g,' ');
  if(/^(I am 16 years of age or older|Done|Continue)$/i.test(label)&&el.getClientRects().length)el.click();
});
// Inline keyboard handlers need the same page context as javascript: links.
document.addEventListener('steam-signup-field-keyup',event=>{
  const el=event.target;
  if(!(el instanceof HTMLInputElement)||!['accountname','password','reenter_password'].includes(el.id)||!el.getClientRects().length)return;
  el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Tab',code:'Tab'}));
});
// Strong accepted passwords deliberately hide #password_tag before adding a
// class. Read Steam's real availability result; never assign its validation flag.
document.addEventListener('steam-signup-validation',()=>{
  const password=document.getElementById('password');
  if(password)password.setAttribute('data-steam-password-available',String(globalThis.g_bPasswordAvailable===true));
});
