'use strict';
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {startFixture}=require('./tests/platform-fixture');
async function run() {
  const f=await startFixture();let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
  const nativeFetch=global.fetch;const mailbox=[];
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'test-google-key',alg:'RS256',use:'sig'};
  let googleToken;
  global.fetch=async(url,options)=>{
    if(String(url)==='https://api.resend.com/emails') {mailbox.push(JSON.parse(options.body));return new Response('{"id":"test-mail"}',{status:200});}
    if(String(url)==='https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({keys:[jwk]}),{status:200});
    if(String(url)==='https://oauth2.googleapis.com/token') return new Response(JSON.stringify({id_token:googleToken}),{status:200});
    return nativeFetch(url,options);
  };
  async function post(route,body,cookie='',origin=f.base) {const r=await fetch(f.base+'/api/auth/'+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const emailToken=()=>new URL(mailbox.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  function signedToken(nonce,overrides={}) {
    const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:process.env.GOOGLE_CLIENT_ID,sub:'google-subject-1',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce,name:'Google Developer',email:'google-developer@example.com',email_verified:true,...overrides})).toString('base64url');
    return header+'.'+payload+'.'+crypto.sign('RSA-SHA256',Buffer.from(header+'.'+payload),privateKey).toString('base64url');
  }
  try {
    delete process.env.RESEND_API_KEY;delete process.env.AUTH_EMAIL_FROM;delete process.env.GOOGLE_CLIENT_ID;delete process.env.GOOGLE_CLIENT_SECRET;
    const options=await (await fetch(f.base+'/api/auth/options')).json();check(!options.google&&!options.email,'Unconfigured providers are accurately reported');
    check((await post('signup',{})).status===503,'Email signup blocked without delivery configuration');
    process.env.RESEND_API_KEY='test-only';process.env.AUTH_EMAIL_FROM='AUDIT HUB <test@example.com>';
    for(const acceptedTerms of [undefined,false,'true']) check((await post('signup',{name:'Email Developer',email:' Dev@Example.com ',password:'long-test-password-123',acceptedTerms})).status===400,'Registration requires explicit boolean acceptance: '+String(acceptedTerms));
    check(!(await f.pool.query('SELECT * FROM developer_accounts WHERE email=$1',['dev@example.com'])).rows.length&&mailbox.length===0,'Missing agreement creates no account and sends no email');
    check((await post('signup',{name:'Email Developer',email:' Dev@Example.com ',password:'long-test-password-123',acceptedTerms:true})).status===200&&mailbox.length===1,'Registration sends a verification email');
    const stored=(await f.pool.query('SELECT * FROM developer_accounts WHERE email=$1',['dev@example.com'])).rows[0];
    check(stored.password_hash.startsWith('scrypt:')&&!stored.email_verified&&!stored.discord_id.match(/^\d+$/),'Email account uses a hashed password and independent identity');
    check(stored.terms_accepted_at&&stored.terms_version==='2026-10-04'&&stored.privacy_version==='2026-10-04','New email account records agreement date and document versions');
    const firstToken=emailToken();
    check((await f.pool.query('SELECT token_hash FROM developer_email_tokens')).rows.every(t=>t.token_hash!==firstToken),'One-time email tokens stored only as hashes');
    check((await post('login',{email:'dev@example.com',password:'long-test-password-123'})).status===401,'Unverified email cannot access workspace');
    check((await post('verify',{token:firstToken})).status===200,'Verification activates account');
    check((await post('verify',{token:firstToken})).status===400,'Verification cannot be replayed');
    check((await post('login',{email:'dev@example.com',password:'incorrect'})).status===401,'Wrong password rejected');
    const login=await post('login',{email:'dev@example.com',password:'long-test-password-123'});
    check(login.status===200&&login.cookie.startsWith('ah_session='),'Verified email creates a server session');
    const project=await fetch(f.base+'/api/platform/projects',{method:'POST',headers:{'Content-Type':'application/json',Cookie:login.cookie,Origin:f.base},body:JSON.stringify({name:'Email project'})});
    check(project.status===201,'Email developer can create a project');
    const list=await (await fetch(f.base+'/api/platform/projects',{headers:{Cookie:f.cookies[0]}})).json();check(list.projects.length===0,'Other developer cannot see the email account project');
    check((await post('signup',{name:'Other',email:'DEV@example.com',password:'long-test-password-123',acceptedTerms:true})).status===200&&mailbox.length===1,'Duplicate email does not create an account or send another verification');
    check((await post('forgot',{email:'dev@example.com'})).status===200,'Password recovery sends a reset email');
    const reset=emailToken();
    check((await post('reset',{token:reset,password:'short'})).status===400,'Weak password rejected without consuming reset token');
    check((await post('reset',{token:reset,password:'new-strong-password-456'})).status===200,'Password reset accepted');
    check((await post('reset',{token:reset,password:'new-strong-password-456'})).status===400,'Password reset cannot be replayed');
    check((await fetch(f.base+'/api/platform/projects',{headers:{Cookie:login.cookie}})).status===401,'Password reset revokes previous sessions');
    const nextLogin=await post('login',{email:'dev@example.com',password:'new-strong-password-456'});
    check(nextLogin.status===200,'New password signs in');
    check((await post('logout',{},nextLogin.cookie,'https://evil.example')).status===403,'Cross-origin auth mutations rejected');
    await post('logout',{},nextLogin.cookie);check((await fetch(f.base+'/api/platform/projects',{headers:{Cookie:nextLogin.cookie}})).status===401,'Logout revokes the session on the server');
    process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';
    const noAgreement=await fetch(f.base+'/api/auth/google',{redirect:'manual'});const unsignedAgreement=new URL(noAgreement.headers.get('location'));
    googleToken=signedToken(unsignedAgreement.searchParams.get('nonce'));
    const noAgreementCallback=await fetch(f.base+'/api/auth/google/callback?code=test&state='+unsignedAgreement.searchParams.get('state'),{redirect:'manual',headers:{Cookie:noAgreement.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}});
    check(noAgreementCallback.headers.get('location')==='/signup?error=terms_required'&&!(await f.pool.query('SELECT * FROM developer_identities WHERE provider=$1',['google'])).rows.length,'Google cannot create a new account without agreement');
    const begin=await fetch(f.base+'/api/auth/google?acceptedTerms=1',{redirect:'manual'});const oauth=new URL(begin.headers.get('location'));const googleCookie=begin.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    check(oauth.hostname==='accounts.google.com'&&oauth.searchParams.get('code_challenge_method')==='S256','Google authorization uses official endpoint and PKCE');
    googleToken=signedToken(oauth.searchParams.get('nonce'));
    const callback=f.base+'/api/auth/google/callback?code=test&state='+oauth.searchParams.get('state');
    const missing=await fetch(callback,{redirect:'manual'});check(missing.headers.get('location')==='/login?error=oauth_failed','Google rejects callback without browser-bound state');
    const signedCookie=googleCookie.split('; ').find(value=>value.startsWith('ah_google='));const [payload,signature]=decodeURIComponent(signedCookie.slice('ah_google='.length)).split('.');
    const forgedPayload=JSON.parse(Buffer.from(payload,'base64url').toString());forgedPayload.acceptedTerms=false;
    const tampered='ah_google='+Buffer.from(JSON.stringify(forgedPayload)).toString('base64url')+'.'+signature;
    const forgedAgreement=await fetch(callback,{redirect:'manual',headers:{Cookie:tampered}});check(forgedAgreement.headers.get('location')==='/login?error=oauth_failed','Google agreement cannot be altered independently of signed state');
    const success=await fetch(callback,{redirect:'manual',headers:{Cookie:googleCookie}});check(success.headers.get('location')==='/dashboard'&&success.headers.get('set-cookie').includes('ah_session='),'Valid Google signature and claims create a developer session');
    const googleAccount=(await f.pool.query('SELECT a.* FROM developer_accounts a JOIN developer_identities i ON i.account_id=a.discord_id WHERE i.provider=$1',['google'])).rows[0];
    check(googleAccount.terms_accepted_at&&googleAccount.terms_version==='2026-10-04','Google account records agreement');
    const returnBegin=await fetch(f.base+'/api/auth/google',{redirect:'manual'});const returning=new URL(returnBegin.headers.get('location'));googleToken=signedToken(returning.searchParams.get('nonce'));
    const returningCallback=await fetch(f.base+'/api/auth/google/callback?code=test&state='+returning.searchParams.get('state'),{redirect:'manual',headers:{Cookie:returnBegin.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}});
    check(returningCallback.headers.get('location')==='/dashboard','Existing Google account can sign in without re-accepting documents');
    googleToken=signedToken(oauth.searchParams.get('nonce'));
    const verifier=require('./src/services/google-auth');
    for(const [label,overrides,nonce] of [['Wrong audience',{aud:'another-app'},oauth.searchParams.get('nonce')],['Wrong issuer',{iss:'https://evil.example'},oauth.searchParams.get('nonce')],['Expired token',{exp:1},oauth.searchParams.get('nonce')],['Wrong nonce',{},'different']]) {await assert.rejects(()=>verifier.verifyIdToken(signedToken(oauth.searchParams.get('nonce'),overrides),nonce));check(true,label+' rejected');}
    const bad=googleToken.slice(0,-10)+'AAAAAAAAAA';await assert.rejects(()=>verifier.verifyIdToken(bad,oauth.searchParams.get('nonce')));check(true,'Forged Google signature rejected');
    const social=require('./src/services/developer-auth');const id=await social.socialAccount('google','google-subject-1','Updated name');const other=await social.socialAccount('discord','google-subject-1','Other provider',{email:'another-provider@example.com',emailVerified:true},undefined,true);check(id!==other,'Different providers cannot impersonate matching subjects');
    console.log(`Developer auth: ${checks} checks passed without production email or OAuth calls.`);
  } finally {global.fetch=nativeFetch;await f.close();}
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
