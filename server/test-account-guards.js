'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
const identity=require('./src/services/account-identity');
async function run() {
  const f=await startFixture();const auth=require('./src/services/developer-auth');
  const registration=require('./src/services/registration-guard');let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
  const nativeFetch=global.fetch,mailbox=[];
  global.fetch=async(url,options)=>String(url)==='https://api.resend.com/emails'?(mailbox.push(JSON.parse(options.body)),new Response('{"id":"test"}',{status:200})):nativeFetch(url,options);
  const post=async(email,cookie='')=>{
    const r=await fetch(f.base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.base,Cookie:cookie},body:JSON.stringify({name:'Developer',email,password:'strong-password-for-tests',acceptedTerms:true})});
    return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
  };
  async function reserve(keys){const c=await f.pool.connect();try{await c.query('BEGIN');await registration.reserve(c,keys);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  try {
    process.env.RESEND_API_KEY='test-only';process.env.AUTH_EMAIL_FROM='test@example.com';
    check(identity.normalizeEmail(' First.Last+tag@GMAIL.com ')==='firstlast@gmail.com','Gmail dots and plus aliases resolve to one address');
    check(identity.normalizeEmail('First.Last@googlemail.com')==='firstlast@gmail.com','Googlemail alias resolves to Gmail');
    check(identity.normalizeEmail('First.Last+tag@company.com')==='first.last+tag@company.com','Other domains keep dots and plus addresses');
    const first=await post('First.Last+one@gmail.com');check(first.status===200,'First developer registration succeeds');
    const duplicate=await post('firstlast+two@gmail.com',first.cookie);
    check(duplicate.status===200&&mailbox.length===1,'Gmail aliases do not create another account or reveal account existence');
    const rows=await f.pool.query('SELECT discord_id,email,password_hash FROM developer_accounts WHERE email=$1',['firstlast@gmail.com']);
    check(rows.rows.length===1,'Database stores one canonical Gmail account');
    const original=rows.rows[0];
    check((await post('different@example.com',first.cookie)).status===429,'One browser cannot create a second account in 24 hours');
    check(!(await f.pool.query('SELECT discord_id FROM developer_accounts WHERE email=$1',['different@example.com'])).rows.length,'Blocked browser does not create an account');
    await assert.rejects(()=>auth.socialAccount('google','same-email-google','Google',{email:'first.last+oauth@gmail.com',emailVerified:true}),{code:'ACCOUNT_EXISTS'});checks++;console.log('OK Google cannot create a second account for an existing email');
    await assert.rejects(()=>auth.socialAccount('discord','same-email-discord','Discord',{email:'FirstLast@gmail.com',emailVerified:true}),{code:'ACCOUNT_EXISTS'});checks++;console.log('OK Discord cannot create a second account for an existing email');
    check((await f.pool.query('SELECT password_hash FROM developer_accounts WHERE discord_id=$1',[original.discord_id])).rows[0].password_hash===original.password_hash,'Duplicate OAuth does not replace credentials or take over an account');
    await assert.rejects(()=>auth.socialAccount('google','unverified-google','Bad',{email:'unverified@example.com',emailVerified:false}),{code:'VERIFIED_EMAIL_REQUIRED'});checks++;console.log('OK Unverified provider email cannot create a developer account');
    await assert.rejects(()=>auth.socialAccount('google','no-agreement-google','No agreement',{email:'no-agreement@example.com',emailVerified:true}),{code:'TERMS_REQUIRED'});checks++;console.log('OK New OAuth identity requires explicit legal agreement');
    const google=await auth.socialAccount('google','verified-google','Google',{email:'unique-google@example.com',emailVerified:true},undefined,true);
    check(await auth.socialAccount('google','verified-google','Return')===google,'Returning provider identity signs into its original account');
    const legacy=await auth.socialAccount('discord','900000000000000001','Legacy');
    check(legacy==='900000000000000001','Existing Discord account IDs remain unchanged');
    const races=await Promise.allSettled(['racing-google-a','racing-google-b'].map(sub=>auth.socialAccount('google',sub,'Race',{email:'race@example.com',emailVerified:true},undefined,true)));
    check(races.filter(r=>r.status==='fulfilled').length===1&&(await f.pool.query('SELECT discord_id FROM developer_accounts WHERE email=$1',['race@example.com'])).rows.length===1,'Concurrent OAuth registrations cannot duplicate an email');
    for(let i=0;i<5;i++) await reserve({network:'test-network',browser:'test-browser-'+i});
    await assert.rejects(()=>reserve({network:'test-network',browser:'sixth-browser'}),{code:'ACCOUNT_CREATION_LIMIT'});checks++;console.log('OK Network limit survives a fresh browser cookie');
    await f.pool.query('UPDATE developer_registration_limits SET window_start=$1 WHERE quota_key=$2',[new Date(Date.now()-86400001),'network:test-network']);
    await reserve({network:'test-network',browser:'after-window'});check(true,'Creation window resets after 24 hours');
    const fakeResponse={cookie(name,value){this.value=value;}};
    registration.context({ip:'203.0.113.9',cookies:{ah_registration:'a'.repeat(64)+'.'+'0'.repeat(64)}},fakeResponse);
    check(fakeResponse.value&&!fakeResponse.value.startsWith('a'.repeat(64)), 'A forged browser signature is replaced');
    const quotaRows=(await f.pool.query('SELECT quota_key FROM developer_registration_limits')).rows;
    check(quotaRows.every(r=>!r.quota_key.includes('127.0.0.1')),'Registration quotas do not store raw IP addresses');
    const token=new URL(mailbox[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    const verify=await fetch(f.base+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.base},body:JSON.stringify({token})});
    assert.equal(verify.status,200);
    const login=await fetch(f.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.base,Cookie:first.cookie},body:JSON.stringify({email:'first.last+signin@gmail.com',password:'strong-password-for-tests'})});
    check(login.status===200,'Creation limits and Gmail aliases do not block existing-account login');
    console.log(`Account guards: ${checks} checks passed (isolated database; real multi-connection locks not simulated).`);
  } finally {global.fetch=nativeFetch;await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
