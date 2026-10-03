'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const pool = require('../db');
const COOKIE = 'ah_session';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const origin = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const emailEnabled = () => !!(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM && origin());
const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && origin());
function cookieOptions() { return { httpOnly:true, secure:origin().startsWith('https:'), sameSite:'lax', path:'/' }; }
function setSessionCookie(res,token) { res.cookie(COOKIE,token,{...cookieOptions(),maxAge:86400000*7}); }
async function createSession(id, res, db = pool) {
  const token = random();
  await db.query('INSERT INTO developer_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(token),id,new Date(Date.now()+86400000*7)]);
  if(res) setSessionCookie(res,token);
  return token;
}
async function account(req) {
  const token=req.cookies?.[COOKIE];
  if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const {rows}=await pool.query(`SELECT a.discord_id,a.username,a.email FROM developer_sessions s JOIN developer_accounts a ON a.discord_id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash(token)]);
  return rows[0] || null;
}
async function passwordHash(password) {
  const salt=random(); const key=await scrypt(password,salt,64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [,salt,key]=(stored||'').split(':');
  // A real derivation for unknown users keeps login timing comparable.
  const actual=await scrypt(password,salt||'unknown-account-timing-salt',64);
  return !!key && /^[a-f0-9]{128}$/.test(key) && crypto.timingSafeEqual(actual,Buffer.from(key,'hex'));
}
async function socialAccount(provider, subject, name) {
  if(!subject || typeof subject!=='string' || subject.length>255) throw new Error('Invalid provider identity');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query('SELECT account_id FROM developer_identities WHERE provider=$1 AND subject=$2',[provider,subject]);
    if(found.rows[0]) { await client.query('COMMIT'); return found.rows[0].account_id; }
    // Preserve the accounts created by the original Discord-only platform.
    const legacy=provider==='discord'?await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1',[subject]):{rows:[]};
    const id=legacy.rows[0]?.discord_id || crypto.randomUUID();
    if(!legacy.rows[0]) await client.query('INSERT INTO developer_accounts(discord_id,username) VALUES($1,$2)',[id,String(name||'Developer').slice(0,80)]);
    await client.query('INSERT INTO developer_identities(provider,subject,account_id) VALUES($1,$2,$3)',[provider,subject,id]);
    await client.query('COMMIT'); return id;
  } catch(e) {
    await client.query('ROLLBACK');
    if(e.code==='23505') {const {rows}=await pool.query('SELECT account_id FROM developer_identities WHERE provider=$1 AND subject=$2',[provider,subject]);if(rows[0]) return rows[0].account_id;}
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
    const result=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.AUTH_EMAIL_FROM,to:[email],subject:purpose==='verify'?'Verify your AUDIT HUB account':'Reset your AUDIT HUB password',text:`${purpose==='verify'?'Verify your email address':'Choose a new password'}: ${link}\n\nThis link expires in one hour. If you did not request this, ignore this message.`}),signal:AbortSignal.timeout(15000)});
    if(!result.ok) throw new Error('Email delivery unavailable');
  } catch(e) {await pool.query('DELETE FROM developer_email_tokens WHERE token_hash=$1',[tokenHash]);throw e;}
}
module.exports={COOKIE,hash,random,origin,emailEnabled,googleEnabled,cookieOptions,createSession,setSessionCookie,account,passwordHash,passwordMatches,socialAccount,sendToken};
