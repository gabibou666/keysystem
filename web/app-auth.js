'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const mode=location.pathname.slice(1);
  const signup=mode==='signup',verify=mode==='verify-email',reset=mode==='reset-password';
  let token=new URLSearchParams(location.search).get('token');
  if(token) history.replaceState(null,'',location.pathname);
  const notice=(text,error=false)=>{$('authMessage').textContent=text;$('authMessage').classList.toggle('error',error);$('authMessage').hidden=false;};
  const request=async(route,data)=>{const response=await fetch('/api/auth/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok) throw Error(result.error||'Please try again.');return result;};
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
  const error=new URLSearchParams(location.search).get('error');if(error)notice(error==='google_unavailable'?'Google sign-in is currently unavailable. Choose another available method.':'Sign-in could not be completed. Please try again.',true);
  $('authForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('submitAuth');button.disabled=true;
    try {
      const result=await request(verify?'verify':reset?'reset':signup?'signup':'login',{name:$('nameInput').value,email:$('emailInput').value,password:$('passwordInput').value,token});
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
