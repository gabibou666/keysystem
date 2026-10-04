'use strict';
// Isolated test application: no .env loading and no production database/network.
const { newDb, DataType } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodeCrypto = require('crypto');
async function startFixture(port = 0, preview = false, seedDemo = false) {
  process.env.NODE_ENV = 'test';
  process.env.HMAC_SECRET = nodeCrypto.randomBytes(32).toString('hex');
  process.env.AES_KEY = nodeCrypto.randomBytes(32).toString('hex');
  const db = newDb();
  // SQL compatibility only: pg-mem does not implement transaction locks. The
  // dedicated concurrency test supplies a lock adapter and states that limit.
  db.public.registerFunction({ name:'pg_advisory_xact_lock', args:[DataType.integer,DataType.integer], returns:DataType.integer, impure:true, implementation:()=>0 });
  db.public.registerFunction({ name:'length', args:[DataType.text], returns:DataType.integer, implementation:x=>x.length });
  db.public.registerFunction({ name:'split_part', args:[DataType.text,DataType.text,DataType.integer], returns:DataType.text, implementation:(text,separator,index)=>text.split(separator)[index-1]||'' });
  db.public.registerFunction({ name:'replace', args:[DataType.text,DataType.text,DataType.text], returns:DataType.text, implementation:(text,from,to)=>text.split(from).join(to) });
  db.public.registerFunction({ name:'trim', args:[DataType.text], returns:DataType.text, implementation:text=>text.trim() });
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-platform.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-signup.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-account-legal-consent.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zaccount-guards.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zcheckpoint-providers.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zhubs.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zscript-builds.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zui.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zprofiles.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zmoderation.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-developer-zprovider-guards.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-account-audit-privacy.sql'),'utf8'));
  // PostgreSQL enforces the audit trigger in production. pg-mem supports the
  // additive schema, but not procedural triggers; only that marked block is omitted.
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-admin-dashboard.sql'),'utf8')
    .replace(/-- BEGIN POSTGRES ADMIN AUDIT GUARD[\s\S]*?-- END POSTGRES ADMIN AUDIT GUARD/, ''));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-script-jobs.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-script-metrics.sql'),'utf8'));
  db.public.none(fs.readFileSync(path.join(__dirname,'../db/migration-script-revalidation.sql'),'utf8'));
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  require.cache[require.resolve('../src/db')] = { id:require.resolve('../src/db'), filename:require.resolve('../src/db'), loaded:true, exports:pool };
  const discord = require('../src/services/discord');
  const auth = require('../src/services/developer-auth');
  const app = express();
  const webSecurity=require('../src/services/web-security');
  app.use(webSecurity.platformHeaders);
  app.use(webSecurity.parseCookies);
  require('../src/services/script-upload-http')(app);
  app.use('/api/auth',webSecurity.authJsonParser);
  app.use('/admin/api',webSecurity.authJsonParser);
  app.use(express.json({limit:'2mb'}));
  app.use(webSecurity.bodyError);
  if (preview) app.get('/__preview/sign-in',async(req,res)=>{await auth.createSession('900000000000000001',res);res.redirect('/dashboard');});
  if (preview) app.get('/__preview/admin-sign-in',async(req,res)=>{
    const subject = process.env.OWNER_DISCORD_ID || '899294059225579531';
    await pool.query("INSERT INTO developer_identities(provider,subject,account_id,oauth_verified_at) VALUES('discord',$1,$2,$3) ON CONFLICT(provider,subject) DO UPDATE SET oauth_verified_at=$3", [subject, '900000000000000001', new Date()]);
    await auth.createSession('900000000000000001',res); res.redirect('/admin');
  });
  app.use('/admin/api', require('../src/routes/admin'));
  app.use('/admin', require('../src/routes/admin-page')({ assetVersion: 'test', siteUrl: process.env.PUBLIC_URL || 'http://localhost', preview }));
  const siteControls=require('../src/services/site-controls');
  siteControls.invalidateSettings();
  app.use('/api/platform', siteControls.enforceMaintenance, require('../src/routes/platform'));
  app.use('/api/discord', require('../src/routes/discord').router);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/catalog', siteControls.enforceMaintenance, require('../src/routes/catalog'));
  app.use('/api/moderation', require('../src/routes/moderation'));
  app.use('/api/bot',require('../src/routes/discord-bot'));
app.use('/api/site', require('../src/routes/site'));
  app.use('/api/account', require('../src/routes/account'));
  const web = path.join(__dirname,'../../web');
  app.get(['/hubs','/hubs/:slug','/developers/:slug','/scripts/:projectId'],(req,res)=>{
    const name='hubs';
    res.type('html').send(fs.readFileSync(path.join(web,name+'.html'),'utf8').replaceAll('__V__','test').replaceAll('__SITE__',process.env.PUBLIC_URL));
  });
  app.get(['/', '/dashboard','/moderation','/discord-bot','/docs','/claim','/hubs','/hubs/:slug','/scripts','/scripts/:projectId','/signup','/login','/verify-email','/reset-password','/terms','/privacy','/cookies','/changelog','/legal'], (req,res) => {
    const name=req.path==='/'?'index':/^\/(hubs|scripts)(\/|$)/.test(req.path)?'hubs':req.path.slice(1);
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
  if (seedDemo) {
    // Disposable data for the manual local preview only; automated fixtures
    // retain their own controlled datasets. No provider or email is contacted.
    const cipher = require('../src/services/crypto');
    // Fictional owner access and a private example belong only to this manual
    // preview fixture. Production startup never loads this file or its routes.
    await pool.query("INSERT INTO developer_identities(provider,subject,account_id,oauth_verified_at) VALUES('discord',$1,$2,$3)", [process.env.OWNER_DISCORD_ID || '899294059225579531', identities[0], new Date()]);
    const exampleId = nodeCrypto.randomUUID(), example = '-- Local preview example\nlocal message = "Your scripts. Your rules."\nreturn message\n';
    const exampleBuild = cipher.encryptAES(example), exampleOriginal = cipher.encryptAES(example);
    await pool.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4)', [exampleId, identities[0], 'AUDIT HUB demo', auth.hash(auth.random())]);
    await pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,original_content_enc,original_content_iv,filename,original_size_bytes,output_size_bytes,validated,obfuscated,target_mode,safety_status,build_hash,safety_hash) VALUES($1,$2,$3,$4,$5,'preview.luau',$6,$6,true,false,'universal','clear',$7,$7)", [exampleId, exampleBuild.enc, exampleBuild.iv, exampleOriginal.enc, exampleOriginal.iv, Buffer.byteLength(example), auth.hash(example)]);
    const hubId = nodeCrypto.randomUUID();
    await pool.query("INSERT INTO developer_hubs(id,owner_id,slug,name,published_at) VALUES($1,$2,'local-creator','Local Creator',now())", [hubId, identities[1]]);
    for (let i = 0; i < 3; i++) {
      const projectId = nodeCrypto.randomUUID();
      await pool.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4)', [projectId, identities[1], ['Orion universal', 'Atlas license kit', 'Nova release'][i], auth.hash(auth.random())]);
      const code = 'return "Local demonstration build"', encrypted = cipher.encryptAES(code);
      await pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,validated,obfuscated,target_mode,safety_status,build_hash,safety_hash) VALUES($1,$2,$3,true,false,'universal','clear',$4,$4)", [projectId, encrypted.enc, encrypted.iv, auth.hash(code)]);
      await pool.query('UPDATE developer_scripts SET original_content_enc=$2,original_content_iv=$3,filename=$4,original_size_bytes=$5,output_size_bytes=$5 WHERE project_id=$1', [projectId, encrypted.enc, encrypted.iv, 'script.lua', Buffer.byteLength(code)]);
      if (i === 0) await pool.query("INSERT INTO developer_listings(project_id,hub_id,title,access_mode,published_at,snapshot_validated,snapshot_obfuscated,safety_status,safety_hash) VALUES($1,$2,'Orion universal','licensed',now(),true,false,'clear',$3)", [projectId, hubId, auth.hash(code)]);
      if (i === 0) await pool.query("INSERT INTO developer_moderation_reports(id,project_id,reporter_id,reason,description) VALUES($1,$2,$3,'other','Local demonstration report for interface review.')", [nodeCrypto.randomUUID(), projectId, identities[0]]);
      for (let j = 0; j < 4 + i; j++) await pool.query('INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [nodeCrypto.randomUUID(), projectId, auth.hash(auth.random()), 'ah_preview_', 'Local preview', new Date(Date.now() + 7 * 86400000), new Date(Date.now() - (i * 4 + j) * 86400000)]);
    }
  }
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
      return Response.json({valid:!target.includes('invalid'),info:{linkId:10345,token:decodeURIComponent(new URL(target).pathname.split('/').pop()),createdAt:Date.now(),byIp:'127.0.0.1',expiresAfter:Date.now()+60000}});
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
  require('../src/services/publication-queue').start();
  return { app, db, pool, server, base, cookies, providerCalls, close:async()=>{await require('../src/services/publication-queue').stop();global.fetch=nativeFetch;await new Promise(r=>server.close(r));await require('../src/services/moderation-http-audit').flush();await pool.end();} };
}
module.exports={ startFixture };
if(require.main===module) startFixture(Number(process.env.TEST_PORT)||3215,true,true).then(f=>console.log('Isolated platform preview: '+f.base)).catch(e=>{console.error(e.message);process.exit(1);});
