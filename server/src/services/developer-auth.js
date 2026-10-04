'use strict';
const crypto = require('crypto');
const { passwordWork } = require('./password-work');
const pool = require('../db');
const {normalizeEmail,validEmail}=require('./account-identity');
const registration=require('./registration-guard');
const staff=require('./staff-access');
const siteControls=require('./site-controls');
const COOKIE = 'ah_session';
const LEGAL_VERSION = '2026-10-04';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const origin = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const emailEnabled = () => !!(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM && origin());
const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && origin());
function cookieOptions() { return { httpOnly:true, secure:process.env.NODE_ENV==='production'||origin().startsWith('https:'), sameSite:'lax', path:'/' }; }
function setSessionCookie(res,token) { res.cookie(COOKIE,token,{...cookieOptions(),maxAge:86400000*7}); }
async function createSession(id, res, db = pool, options = {}) {
  const token = random(), ownTransaction = db === pool && options.inTransaction !== true;
  const client = ownTransaction ? await pool.connect() : db;
  try {
    if (ownTransaction) {
      await client.query('BEGIN'); await staff.lockAdminChanges(client);
      await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [id]);
    }
    await staff.assertActive(id, client);
    await client.query('INSERT INTO developer_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(token),id,new Date(Date.now()+86400000*7)]);
    if (ownTransaction) await client.query('COMMIT');
  } catch (error) { if (ownTransaction) await client.query('ROLLBACK'); throw error; }
  finally { if (ownTransaction) client.release(); }
  if(res) setSessionCookie(res,token);
  return token;
}
async function account(req) {
  const token=req.cookies?.[COOKIE];
  if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const {rows}=await pool.query(`SELECT a.discord_id,a.username,a.email FROM developer_sessions s JOIN developer_accounts a ON a.discord_id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.banned_at IS NULL AND (a.suspended_until IS NULL OR a.suspended_until<=now())`,[hash(token)]);
  return rows[0] || null;
}
async function passwordHash(password) {
  const salt=random(); const key=await passwordWork(password,salt);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [,salt,key]=(stored||'').split(':');
  // A real derivation for unknown users keeps login timing comparable.
  const actual=await passwordWork(password,salt||'unknown-account-timing-salt');
  return !!key && /^[a-f0-9]{128}$/.test(key) && crypto.timingSafeEqual(actual,Buffer.from(key,'hex'));
}
async function socialAccount(provider, subject, name, identity={}, creationContext, acceptedTerms=false) {
  if(!['discord','google'].includes(provider) || !subject || typeof subject!=='string' || subject.length>255) throw new Error('Invalid provider identity');
  // oauthVerified is supplied only by server callbacks after verifying the
  // provider response. No endpoint accepts this flag or subject from a body.
  const verifiedOAuth = identity.oauthVerified === true;
  const ownerProof = verifiedOAuth && provider==='discord' && subject===staff.ownerDiscordId();
  const client=await pool.connect();
  try {
    await client.query('BEGIN'); await staff.lockAdminChanges(client);
    const found=await client.query('SELECT account_id FROM developer_identities WHERE provider=$1 AND subject=$2',[provider,subject]);
    const legacy=provider==='discord'&&!found.rows[0]?await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1',[subject]):{rows:[]};
    const id=found.rows[0]?.account_id || legacy.rows[0]?.discord_id || crypto.randomUUID();
    if(found.rows[0] || legacy.rows[0]) {
      await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[id]);
      if(ownerProof) {
        const previous=(await client.query('SELECT banned_at,suspended_until FROM developer_accounts WHERE discord_id=$1',[id])).rows[0];
        if(previous?.banned_at || (previous?.suspended_until && new Date(previous.suspended_until)>new Date())) {
          await client.query("UPDATE developer_accounts SET banned_at=NULL,ban_reason='',suspended_until=NULL,suspension_reason='' WHERE discord_id=$1",[id]);
          await staff.invalidateSessions(id,client);
          await staff.audit(client,{actorId:id,actorRole:'OWNER',action:'owner.access.recovered',targetType:'account',targetId:id,before:previous,after:{banned_at:null,suspended_until:null},ip:creationContext?.ip});
        }
      }
      await staff.assertActive(id,client);
    } else {
      const email=normalizeEmail(identity.email);
      if(identity.emailVerified!==true||!validEmail(email)) {const e=new Error('A verified email is required to create your account.');e.code='VERIFIED_EMAIL_REQUIRED';throw e;}
      const duplicate=await client.query('SELECT discord_id FROM developer_accounts WHERE email=$1',[email]);
      if(duplicate.rows[0]) {const e=new Error('An account already uses this email. Sign in with its existing method.');e.code='ACCOUNT_EXISTS';throw e;}
      if(acceptedTerms!==true) {const e=new Error('Accept the Terms of Use and Privacy Policy before creating an account.');e.code='TERMS_REQUIRED';throw e;}
      const settings=await siteControls.getSettings({fresh:true,db:client});
      if(!settings.registrationsOpen&&!ownerProof) throw Object.assign(new Error('Account registration is currently closed.'),{code:'REGISTRATION_CLOSED',status:403});
      if(!ownerProof) await registration.reserve(client,creationContext);
      await client.query('INSERT INTO developer_accounts(discord_id,username,email,email_verified,terms_accepted_at,terms_version,privacy_version) VALUES($1,$2,$3,true,$4,$5,$5)',[id,String(name||'Developer').slice(0,80),email,new Date(),LEGAL_VERSION]);
    }
    if(found.rows[0]) {
      if(verifiedOAuth) await client.query('UPDATE developer_identities SET oauth_verified_at=now(),provider_username=$1 WHERE provider=$2 AND subject=$3',[String(identity.providerUsername||name||'').slice(0,80),provider,subject]);
    } else await client.query('INSERT INTO developer_identities(provider,subject,account_id,oauth_verified_at,provider_username) VALUES($1,$2,$3,$4,$5)',[provider,subject,id,verifiedOAuth?new Date():null,verifiedOAuth?String(identity.providerUsername||name||'').slice(0,80):null]);
    if(verifiedOAuth) await staff.afterVerifiedLogin(id,{provider,subject,ip:creationContext?.ip},client);
    await client.query('COMMIT'); return id;
  } catch(e) {
    await client.query('ROLLBACK');
    if(e.code==='23505') {
      const email=normalizeEmail(identity.email);const duplicate=await pool.query('SELECT discord_id FROM developer_accounts WHERE email=$1',[email]);
      if(duplicate.rows[0]) {const exists=new Error('An account already uses this email. Sign in with its existing method.');exists.code='ACCOUNT_EXISTS';throw exists;}
    }
    throw e;
  } finally {client.release();}
}
async function sendToken(id,email,purpose) {
  const token=random(); const tokenHash=hash(token);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[id]);
    const recent=await client.query('SELECT token_hash FROM developer_email_tokens WHERE account_id=$1 AND purpose=$2 AND expires_at>$3',[id,purpose,new Date(Date.now()+3540000)]);
    if(recent.rows[0]) {await client.query('COMMIT');return;}
    await client.query('INSERT INTO developer_email_tokens(token_hash,account_id,purpose,expires_at) VALUES($1,$2,$3,$4)',[tokenHash,id,purpose,new Date(Date.now()+3600000)]);
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  // Reserve delivery under the account lock, then release before contacting
  // the email provider. Concurrent resends cannot bypass the cooldown.
  const link=`${origin()}/${purpose==='verify'?'verify-email':'reset-password'}?token=${token}`;
  try {
    const result=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.AUTH_EMAIL_FROM,to:[email],subject:purpose==='verify'?'Verify your AUDIT HUB account':'Reset your AUDIT HUB password',text:`${purpose==='verify'?'Verify your email address':'Choose a new password'}: ${link}\n\nThis link expires in one hour. If you did not request this, ignore this message.`}),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!result.ok) throw new Error('Email delivery unavailable');
  } catch(e) {await pool.query('DELETE FROM developer_email_tokens WHERE token_hash=$1',[tokenHash]);throw e;}
}
module.exports={COOKIE,LEGAL_VERSION,hash,random,origin,emailEnabled,googleEnabled,cookieOptions,createSession,setSessionCookie,account,passwordHash,passwordMatches,socialAccount,sendToken};
