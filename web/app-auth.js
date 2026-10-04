'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const mode=location.pathname.replace(/\.html$/,'').slice(1);
  const signup=mode==='signup',verify=mode==='verify-email',reset=mode==='reset-password';
  const terms=document.querySelector('#acceptedTerms');
  const termsCopy={en:{accept:'I accept the ',terms:'Terms of Use',and:' and the ',privacy:'Privacy Policy',required:'Accept the Terms of Use and Privacy Policy before creating an account.'},fr:{accept:'J’accepte les ',terms:'Conditions d’utilisation',and:' et la ',privacy:'Politique de confidentialité',required:'Acceptez les Conditions d’utilisation et la Politique de confidentialité avant de créer un compte.'}};
  const language=()=>{try{const value=localStorage.getItem('audit-hub-language');if(value==='en'||value==='fr')return value;}catch{}return(navigator.language||'').toLowerCase().startsWith('fr')?'fr':'en';};
  let authLanguage=language();
  const translateTerms=()=>{if(!terms)return;const t=termsCopy[authLanguage];for(const [key,value]of Object.entries(t)){const node=document.querySelector('[data-terms-copy="'+key+'"]');if(node)node.textContent=value;}};
  translateTerms();
  document.addEventListener('audit-hub:language',event=>{if(event.detail?.language==='en'||event.detail?.language==='fr'){authLanguage=event.detail.language;translateTerms();}});
  let token=new URLSearchParams(location.search).get('token');
  if(token) history.replaceState(null,'',location.pathname);
  const notice=(text,error=false)=>{$('authMessage').textContent=text;$('authMessage').classList.toggle('error',error);$('authMessage').hidden=false;};
  const request=async(route,data)=>{const response=await fetch('/api/auth/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok) throw Error(result.error||'Please try again.');return result;};
  if(signup&&terms) {
    const syncSocial=()=>{for(const provider of ['google','discord']){const button=$(provider+'Auth');if(button.hasAttribute('href'))button.href='/api/auth/'+provider+(terms.checked?'?acceptedTerms=1':'');}};
    terms.addEventListener('change',syncSocial);
    for(const provider of ['google','discord'])$(provider+'Auth').addEventListener('click',event=>{
      if(!$(provider+'Auth').hasAttribute('href'))return;
      if(!terms.checked){event.preventDefault();terms.reportValidity();notice(termsCopy[authLanguage].required,true);terms.focus();}
      else syncSocial();
    });
  }
  const titles={signup:['Create your workspace.','Create projects, publish Lua scripts and choose how users receive a license.'],login:['Welcome back.','Use the sign-in method you chose when creating your account to find your projects.'],'verify-email':['Verify your email.','Confirm your address, then sign in to create your first project.'],'reset-password':['Choose a new password.','Use at least 12 characters. Saving a new password signs out your existing sessions.']};
  const [title,copy]=titles[mode]||titles.login;
  $('authTitle').textContent=title;$('authCopy').textContent=copy;
  $('nameField').hidden=!signup;$('nameInput').required=signup;
  $('emailField').hidden=verify||reset;$('emailInput').required=!verify&&!reset;
  $('passwordField').hidden=verify;$('passwordInput').required=!verify;
  $('passwordInput').autocomplete=signup||reset?'new-password':'current-password';
  $('passwordInput').minLength=signup||reset?12:1;
  $('socialOptions').hidden=verify||reset;$('authDivider').hidden=verify||reset;
  $('submitAuth').textContent=verify?'Verify email':reset?'Save new password':signup?'Create account':'Sign in';
  $('switchCopy').textContent=signup?'Already have an account?':'New to AUDIT HUB?';
  $('switchLink').textContent=signup?'Sign in':'Create an account';$('switchLink').href=signup?'/login':'/signup';
  $('emailHelp').hidden=signup||verify||reset;
  if(verify||reset) {if(!token) {notice('This link is missing its token. Request a new email from the sign-in page.',true);$('submitAuth').disabled=true;}}
  else fetch('/api/auth/options').then(r=>r.json()).then(options=>{
    for(const provider of ['google','discord']) {const button=$(provider+'Auth');if(!options[provider]) {button.removeAttribute('href');button.setAttribute('aria-disabled','true');button.classList.add('provider-disabled');}}
    if(!options.google||!options.discord||!options.email) {$('setupNote').hidden=false;$('setupNote').textContent='Choose an available sign-in method below. Use the same method each time you return.';}
    if(!options.email) {$('emailStatus').hidden=false;$('emailStatus').textContent=signup?'Email registration is currently unavailable. Choose an available sign-in method above.':'Verification emails and password recovery are currently unavailable. Existing email accounts can still sign in.';if(signup)$('submitAuth').disabled=true;for(const el of document.querySelectorAll('[data-email-help]'))el.disabled=true;}
  }).catch(()=>notice('Unable to load sign-in options. Please refresh.',true));
  const error=new URLSearchParams(location.search).get('error');if(error)notice({terms_required:termsCopy[authLanguage].required,google_unavailable:'Google sign-in is currently unavailable. Choose another available method.',account_exists:'An account already uses this email. Sign in using the method you originally chose.',verified_email_required:'Verify your email in your Google or Discord account before creating a workspace.',account_creation_limit:'Account creation limit reached. Sign in to your existing account or try again tomorrow.',registration_closed:authLanguage==='fr'?'Les inscriptions sont temporairement fermées.':'Account registration is currently closed.',account_banned:authLanguage==='fr'?'Ce compte a été banni. Contactez le support.':'This account has been banned. Contact support.',account_suspended:authLanguage==='fr'?'Ce compte est temporairement suspendu. Contactez le support.':'This account is temporarily suspended. Contact support.'}[error]||'Sign-in could not be completed. Please try again.',true);
  $('authForm').addEventListener('submit',async event=>{
    event.preventDefault();if(signup&&(!terms||!terms.checked)){if(terms){terms.reportValidity();terms.focus();}notice(termsCopy[authLanguage].required,true);return;}const button=$('submitAuth');button.disabled=true;
    try {
      const result=await request(verify?'verify':reset?'reset':signup?'signup':'login',{name:$('nameInput').value,email:$('emailInput').value,password:$('passwordInput').value,token,...(signup?{acceptedTerms:terms.checked}:{})});
      $('passwordInput').value='';
      if(!signup&&!verify&&!reset) {location.assign('/dashboard');return;}
      notice(result.message);if(verify||reset) {token=null;$('authForm').hidden=true;$('successLogin').hidden=false;}
    } catch(e){notice(e.message,true);} finally {button.disabled=false;}
  });
  for(const button of document.querySelectorAll('[data-email-help]')) button.addEventListener('click',async()=>{
    if(!$('emailInput').reportValidity())return;
    button.disabled=true;try {const result=await request(button.dataset.emailHelp,{email:$('emailInput').value});notice(result.message);}catch(e){notice(e.message,true);}finally{button.disabled=false;}
  });
})();
