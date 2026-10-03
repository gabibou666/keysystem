'use strict';
const express=require('express');
const crypto=require('crypto');
const rateLimit=require('express-rate-limit');
const pool=require('../db');
const auth=require('../services/developer-auth');
const google=require('../services/google-auth');
const router=express.Router();
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,status,error)=>res.status(status).json({success:false,error});
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(rateLimit({windowMs:900000,max:40,standardHeaders:true,legacyHeaders:false,message:{success:false,error:'Too many sign-in attempts. Try again in 15 minutes.'}}));
const mailLimiter=rateLimit({windowMs:900000,max:10,standardHeaders:true,legacyHeaders:false,message:{success:false,error:'Too many email requests. Try again in 15 minutes.'}});
router.use(['/signup','/resend','/forgot'],mailLimiter);
router.use((req,res,next)=>{
  if(req.method==='POST') {
    if(!req.is('application/json')) return fail(res,415,'JSON required');
    if((req.get('origin') && req.get('origin')!==new URL(auth.origin()).origin)||req.get('sec-fetch-site')==='cross-site') return fail(res,403,'Invalid origin');
  }
  next();
});
const normalizeEmail=value=>typeof value==='string'?value.trim().toLowerCase():'';
const validEmail=email=>email.length<=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
const validPassword=p=>typeof p==='string'&&p.length>=12&&Buffer.byteLength(p)<=128;
const message='If this address has an eligible account, an email will arrive shortly.';
router.get('/options',(req,res)=>res.json({success:true,google:auth.googleEnabled(),discord:!!(process.env.DISCORD_CLIENT_ID&&process.env.DISCORD_CLIENT_SECRET),email:auth.emailEnabled()}));
router.post('/signup',wrap(async(req,res)=>{
  if(!auth.emailEnabled()) return fail(res,503,'Email registration is not configured yet.');
  const email=normalizeEmail(req.body.email);const name=typeof req.body.name==='string'?req.body.name.trim():'';
  if(!validEmail(email)||!name||name.length>80||!validPassword(req.body.password)) return fail(res,400,'Enter your name, a valid email and a password of at least 12 characters (maximum 128 bytes).');
  const passwordHash=await auth.passwordHash(req.body.password);
  const existing=await pool.query('SELECT discord_id FROM developer_accounts WHERE email=$1',[email]);
  if(existing.rows[0]) return res.json({success:true,message:'Check your email to verify your account. If you already have an account, sign in or request a new verification email.'});
  const id=crypto.randomUUID();
  const result=await pool.query('INSERT INTO developer_accounts(discord_id,username,email,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING discord_id',[id,name,email,passwordHash]);
  if(result.rows[0]) await auth.sendToken(id,email,'verify');
  res.json({success:true,message:'Check your email to verify your account. If you already have an account, sign in or request a new verification email.'});
}));
router.post('/login',wrap(async(req,res)=>{
  const email=normalizeEmail(req.body.email);
  if(!validEmail(email)||typeof req.body.password!=='string'||Buffer.byteLength(req.body.password)>128) return fail(res,400,'Enter a valid email and password.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Password verification and session insertion share reset's account lock.
    const {rows}=await client.query('SELECT * FROM developer_accounts WHERE email=$1 FOR UPDATE',[email]);const user=rows[0];
    if(!await auth.passwordMatches(req.body.password,user?.password_hash)||!user?.email_verified) {
      await client.query('ROLLBACK');return fail(res,401,'Email or password incorrect, or email not verified.');
    }
    const token=await auth.createSession(user.discord_id,null,client);
    await client.query('COMMIT');auth.setSessionCookie(res,token);res.json({success:true});
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
router.post('/logout',wrap(async(req,res)=>{
  if(req.cookies?.[auth.COOKIE]) await pool.query('DELETE FROM developer_sessions WHERE token_hash=$1',[auth.hash(req.cookies[auth.COOKIE])]);
  res.clearCookie(auth.COOKIE,auth.cookieOptions());res.clearCookie('ks_user',{path:'/'});res.json({success:true});
}));
for(const [route,purpose] of [['resend','verify'],['forgot','reset']]) router.post('/'+route,wrap(async(req,res)=>{
  if(!auth.emailEnabled()) return fail(res,503,'Email delivery is not configured yet.');
  const email=normalizeEmail(req.body.email);if(!validEmail(email)) return fail(res,400,'Enter a valid email.');
  const {rows}=await pool.query('SELECT discord_id,email_verified,password_hash FROM developer_accounts WHERE email=$1',[email]);const user=rows[0];
  if(user?.password_hash && (purpose==='reset'?user.email_verified:!user.email_verified)) await auth.sendToken(user.discord_id,email,purpose);
  res.json({success:true,message});
}));
for(const purpose of ['verify','reset']) router.post('/'+purpose,wrap(async(req,res)=>{
  const token=req.body.token;
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)) return fail(res,400,'Invalid or expired link.');
  if(purpose==='reset'&&!validPassword(req.body.password)) return fail(res,400,'Use at least 12 characters (maximum 128 bytes).');
  const password=purpose==='reset'?await auth.passwordHash(req.body.password):null;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the account before consuming any token, consistently with login and
    // other resets. Two different tokens cannot hold locks in opposite order.
    const pending=await client.query('SELECT account_id FROM developer_email_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now()',[auth.hash(token),purpose]);
    if(!pending.rows[0]) {await client.query('ROLLBACK');return fail(res,400,'Invalid or expired link.');}
    await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[pending.rows[0].account_id]);
    // Atomic consume prevents replay and concurrent password-reset races.
    const {rows}=await client.query('DELETE FROM developer_email_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING account_id',[auth.hash(token),purpose]);
    if(!rows[0]) {await client.query('ROLLBACK');return fail(res,400,'Invalid or expired link.');}
    const id=rows[0].account_id;
    if(purpose==='verify') await client.query('UPDATE developer_accounts SET email_verified=true WHERE discord_id=$1',[id]);
    else {
      await client.query('UPDATE developer_accounts SET password_hash=$1 WHERE discord_id=$2',[password,id]);
      await client.query('DELETE FROM developer_sessions WHERE account_id=$1',[id]);
    }
    await client.query('DELETE FROM developer_email_tokens WHERE account_id=$1 AND purpose=$2',[id,purpose]);
    await client.query('COMMIT');res.json({success:true,message:purpose==='verify'?'Your email is verified. You can sign in.':'Password updated. Sign in with your new password.'});
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
router.get('/discord',(req,res)=>res.redirect('/api/discord/login?mode=developer'));
const googleRedirect=()=>auth.origin()+'/api/auth/google/callback';
router.get('/google',(req,res)=>{
  if(!auth.googleEnabled()) return res.redirect('/signup?error=google_unavailable');
  const state=auth.random(),nonce=auth.random(),verifier=auth.random();
  const exp=Date.now()+600000;const payload=Buffer.from(JSON.stringify({state,nonce,verifier,exp})).toString('base64url');
  const signed=payload+'.'+crypto.createHmac('sha256',process.env.HMAC_SECRET).update(payload).digest('hex');
  res.cookie('ah_google',signed,{...auth.cookieOptions(),path:'/api/auth/google',maxAge:600000});
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:googleRedirect(),response_type:'code',scope:'openid email profile',state,nonce,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})) url.searchParams.set(k,v);
  res.redirect(url.toString());
});
router.get('/google/callback',wrap(async(req,res)=>{
  const cookie=req.cookies?.ah_google;res.clearCookie('ah_google',{...auth.cookieOptions(),path:'/api/auth/google'});
  try {
    if(!auth.googleEnabled()||typeof cookie!=='string'||cookie.length>2000) throw new Error('Invalid state');
    const [payload,sig]=cookie.split('.');const expected=crypto.createHmac('sha256',process.env.HMAC_SECRET).update(payload).digest('hex');
    if(!/^[a-f0-9]{64}$/.test(sig||'')||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) throw new Error('Invalid state');
    const state=JSON.parse(Buffer.from(payload,'base64url').toString());
    if(state.exp<Date.now()||state.state!==req.query.state||typeof req.query.code!=='string'||req.query.code.length>4096) throw new Error('Invalid state');
    const result=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:req.query.code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:googleRedirect(),grant_type:'authorization_code',code_verifier:state.verifier}),signal:AbortSignal.timeout(15000)});
    if(!result.ok) throw new Error('OAuth exchange failed');
    const tokens=await result.json();const user=await google.verifyIdToken(tokens.id_token,state.nonce);
    const id=await auth.socialAccount('google',user.sub,user.name);await auth.createSession(id,res);
    res.redirect('/dashboard');
  } catch {res.redirect('/login?error=oauth_failed');}
}));
router.use((error,req,res,next)=>{
  // Never log provider responses, credentials, passwords or one-time tokens.
  if(error.code==='42P01'||error.code==='42703') return fail(res,503,'Account database setup is required.');
  fail(res,503,'Sign-in service temporarily unavailable. Please try again.');
});
module.exports=router;
