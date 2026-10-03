'use strict';
// Isolated test application: no .env loading and no production database/network.
const { newDb, DataType } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodeCrypto = require('crypto');
async function startFixture(port = 0, preview = false) {
  process.env.NODE_ENV = 'test';
  process.env.HMAC_SECRET = nodeCrypto.randomBytes(32).toString('hex');
  process.env.AES_KEY = nodeCrypto.randomBytes(32).toString('hex');
  const db = newDb();
  db.public.registerFunction({ name:'length', args:[DataType.text], returns:DataType.integer, implementation:x=>x.length });
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-platform.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-signup.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zcheckpoint-providers.sql'),'utf8'));
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  require.cache[require.resolve('../src/db')] = { id:require.resolve('../src/db'), filename:require.resolve('../src/db'), loaded:true, exports:pool };
  const discord = require('../src/services/discord');
  const auth = require('../src/services/developer-auth');
  const app = express();
  app.use(express.json({limit:'2mb'}));
  app.use((req,res,next) => { req.cookies={}; for(const part of (req.headers.cookie||'').split(';')) { const at=part.indexOf('='); if(at>=0) req.cookies[part.slice(0,at).trim()]=decodeURIComponent(part.slice(at+1)); } next(); });
  if (preview) app.get('/__preview/sign-in',async(req,res)=>{await auth.createSession('900000000000000001',res);res.redirect('/dashboard');});
  app.use('/api/platform', require('../src/routes/platform'));
  app.use('/api/discord', require('../src/routes/discord').router);
  app.use('/api/auth', require('../src/routes/auth'));
  const web = path.join(__dirname,'../../web');
  app.get(['/', '/dashboard','/docs','/claim','/hub','/signup','/login','/verify-email','/reset-password'], (req,res) => {
    const name=req.path==='/'?'index':req.path.slice(1);
    let html=fs.readFileSync(path.join(web,name+'.html'),'utf8').replaceAll('__V__','test').replaceAll('__SITE__',process.env.PUBLIC_URL);
    if(preview) html=html.replaceAll('/api/discord/login?mode=developer','/__preview/sign-in').replace('</body>','<div style="position:fixed;bottom:12px;right:12px;z-index:99;padding:7px 12px;background:#292032;border:1px solid #5b456d;border-radius:6px;font:11px sans-serif;color:#e6d5fa">Local preview · Test data only</div></body>');
    res.type('html').send(html);
  });
  app.use(express.static(web));
  app.use((err,req,res,next) => { console.error(err.message.split('\n')[0]); res.status(500).json({success:false,error:'Test fixture error'}); });
  const server = await new Promise(resolve => { const s=app.listen(port,'127.0.0.1',()=>resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_URL=base;
  const identities = ['900000000000000001','900000000000000002'];
  for(const id of identities) await pool.query('INSERT INTO developer_accounts(discord_id,username) VALUES($1,$2)',[id,'Developer '+id.slice(-1)]);
  const cookies=[];
  for(const id of identities) cookies.push(auth.COOKIE+'='+await auth.createSession(id));
  const nativeFetch=global.fetch;
  const providerCalls=[];
  global.fetch=async(url,options)=>{
    if(String(url)==='https://creators.lootlabs.gg/api/public/content_locker') {
      providerCalls.push(options);
      return new Response(JSON.stringify({type:'created',message:[{loot_url:'https://loot-link.com/s?test=1'}]}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    const target=String(url);
    if(target.startsWith('https://work.ink/_api/v2/override?')) {
      providerCalls.push({provider:'workink-override',destination:new URL(target).searchParams.get('destination')});
      return Response.json({sr:'test_workink_override_code_123'});
    }
    if(target.startsWith('https://work.ink/_api/v2/token/isValid/')) {
      providerCalls.push({provider:'workink-verify',url:target});
      return Response.json({valid:!target.includes('invalid'),info:{linkId:10345,expiresAfter:Date.now()+60000}});
    }
    if(target.startsWith('https://publisher.linkvertise.com/api/v1/anti_bypassing?')) {
      providerCalls.push({provider:'linkvertise-verify',url:target});
      return new Response(new URL(target).searchParams.get('hash')==='a'.repeat(64)?'TRUE':'FALSE');
    }
    if(target==='https://linkunlocker.com/api/public/url_encryptor') {
      providerCalls.push({provider:'linkunlocker-encrypt',destination:JSON.parse(options.body).destination_url});
      return Response.json({hash:'encrypted_destination_1234567890'});
    }
    if(target.startsWith('https://linkunlocker.com/api/public/hash/validate?')) {
      providerCalls.push({provider:'linkunlocker-verify',url:target});
      return Response.json({valid:true});
    }
    return nativeFetch(url,options);
  };
  return { app, db, pool, server, base, cookies, providerCalls, close:async()=>{global.fetch=nativeFetch;await new Promise(r=>server.close(r));await pool.end();} };
}
module.exports={ startFixture };
if(require.main===module) startFixture(Number(process.env.TEST_PORT)||3215,true).then(f=>console.log('Isolated platform preview: '+f.base)).catch(e=>{console.error(e.message);process.exit(1);});
