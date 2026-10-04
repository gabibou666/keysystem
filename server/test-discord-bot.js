'use strict';
const assert=require('node:assert/strict'),express=require('express');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  process.env.MODERATION_ADMIN_IDS='900000000000000001';delete process.env.BOT_API_URL;delete process.env.BOT_API_SECRET;
  const f=await startFixture(),app=express();app.use(express.json());
  const id='123456789012345678',channel='223456789012345678',role='323456789012345678',secret='test-only-bot-secret-'+ 'x'.repeat(32);let mode='ok',calls=0,saved;
  const native=global.fetch;
  app.use((req,res,next)=>{calls++;assert.equal(req.get('authorization'),'Bearer '+secret);if(mode==='unauthorized')return res.status(401).json({error:'PRIVATE_TOKEN_UNSAFE'});if(mode==='redirect')return res.redirect(f.base+'/never-forward-secret');if(mode==='oversize')return res.json({payload:'x'.repeat(1048577)});next();});
  app.get('/api/status',(req,res)=>res.json({success:true,online:true,bot_name:'Community <script> bot',ws_latency_ms:25,uptime_seconds:10,token:'PRIVATE_TOKEN_UNSAFE',guilds:[{id,name:'Community server',member_count:20,channels:[{id:channel,name:'welcome'}],categories:[],roles:[{id:role,name:'Verified'}],private_source:'PRIVATE_TOKEN_UNSAFE'}]}));
  app.get('/api/guilds/:id/settings',(req,res)=>res.json({success:true,settings:{welcome_channel_id:channel,verified_role_id:role,verification_type:'code',automod_enabled:1,welcome_message:'Welcome {user}',token:'PRIVATE_TOKEN_UNSAFE'}}));
  app.post('/api/guilds/:id/settings',(req,res)=>{saved=req.body;res.json({success:true});});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log('OK '+label);};
  async function req(route='/status',method='GET',body,index=0,origin=f.base){const r=await native(f.base+'/api/bot'+route,{method,headers:{...(index===null?{}:{Cookie:f.cookies[index]}),Origin:origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
  try{
    check((await req('/status','GET',undefined,null)).status===401,'Anonymous bot API denied');
    check((await req('/status','GET',undefined,1)).status===403,'Ordinary developer bot API denied');
    await f.pool.query("INSERT INTO developer_moderation_roles(account_id,role) VALUES($1,'moderator')",['900000000000000002']);
    check((await req('/status','GET',undefined,1)).status===403&&calls===0,'Website moderator cannot administer global bot');
    check((await req()).data.configured===false,'Missing connection is accurately reported');
    process.env.BOT_API_URL='http://127.0.0.1:'+server.address().port;process.env.BOT_API_SECRET=secret;
    const status=(await req()).data;check(status.online&&status.guilds.length===1&&status.latency===25,'Admin reads live bot status');
    check(!JSON.stringify(status).includes('PRIVATE_TOKEN_UNSAFE'),'Unlisted bot fields excluded from browser');
    check((await req('/guilds/'+id+'/settings')).data.settings.welcome_channel_id===channel,'Channel IDs remain exact strings');
    check((await req('/guilds/'+id+'/settings')).data.settings.automod_enabled===true,'Bot integer flags normalized for browser');
    const before=calls;
    check((await req('/guilds/'+id+'/settings','PUT',{automod_enabled:false},0,'https://evil.example')).status===403&&calls===before,'Cross-origin mutation never reaches bot');
    check((await req('/guilds/invalid/settings')).status===400,'Invalid guild cannot create arbitrary upstream path');
    check((await req('/guilds/'+id+'/settings','PUT',{BOT_API_SECRET:'forged'})).status===400,'Unknown secret field rejected');
    check((await req('/guilds/'+id+'/settings','PUT',{verified_role_id:323456789012345678})).status===400,'Rounded numeric Discord IDs rejected');
    check((await req('/guilds/'+id+'/settings','PUT',{automod_enabled:'false'})).status===400,'String booleans rejected');
    check((await req('/guilds/'+id+'/settings','PUT',{welcome_message:'x'.repeat(2001)})).status===400,'Welcome message bounded');
    check((await req('/guilds/'+id+'/settings','PUT',{automod_enabled:false,welcome_channel_id:null,verification_type:'button'})).status===200&&saved.automod_enabled===false&&saved.welcome_channel_id===null,'Admin updates bot settings with explicit values');
    check((await f.pool.query("SELECT action FROM developer_moderation_audit WHERE action='bot.settings_updated'")).rows.length===1,'Bot setting change audited without message contents');
    mode='unauthorized';const denied=await req();check(denied.status===502&&!JSON.stringify(denied.data).includes('PRIVATE_TOKEN_UNSAFE'),'Upstream private errors suppressed');
    mode='redirect';check((await req()).status===502,'Bot credential never follows redirects');
    mode='oversize';check((await req()).status===502,'Oversized bot response bounded');
    mode='ok';const bridge=require('./src/services/discord-bot');process.env.BOT_API_URL='https://example.com/unsafe';check(!bridge.configuration(),'Bot API cannot include arbitrary base path');
    process.env.BOT_API_URL='https://user:password@example.com';check(!bridge.configuration(),'Credentials in configured URL rejected');
    process.env.NODE_ENV='production';process.env.BOT_API_URL='http://127.0.0.1:5000';check(!bridge.configuration(),'Production bridge requires HTTPS');process.env.NODE_ENV='test';
    process.env.BOT_API_SECRET='ks_discord_bot_secret_2026';check(!bridge.configuration(),'Old shared default fails closed');
    if(process.argv.includes('--ui')){
      process.env.BOT_API_URL='http://127.0.0.1:'+server.address().port;process.env.BOT_API_SECRET=secret;
      const {chromium}=require('@playwright/test'),fs=require('fs'),path=require('path'),browser=await chromium.launch({headless:true});
      try{
        const admin=await browser.newContext({viewport:{width:390,height:844}});await admin.addCookies([{name:'ah_session',value:f.cookies[0].split('=')[1],url:f.base}]);const page=await admin.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(f.base+'/discord-bot');await page.getByText('Connected',{exact:true}).waitFor();await page.locator('#botGuild').selectOption(id);await page.locator('#botSettingsPanel').waitFor({state:'visible'});
        check(await page.locator('#botWelcomeChannel').inputValue()===channel,'Admin UI loads live server settings');await page.locator('#botWelcomeMessage').fill('Welcome to AUDIT HUB, {user}');await page.locator('#botAutoMod').uncheck();await page.locator('#botSave').click();await page.getByText('Server settings saved.',{exact:true}).waitFor();check(saved.welcome_message==='Welcome to AUDIT HUB, {user}'&&!saved.automod_enabled,'UI persists exact settings');
        check(await page.locator('#botName script').count()===0,'Bot name cannot inject HTML');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Bot dashboard fits mobile width');
        const artifacts=path.join(__dirname,'../artifacts/discord-bot');fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
        const user=await browser.newContext();await user.addCookies([{name:'ah_session',value:f.cookies[1].split('=')[1],url:f.base}]);const deniedPage=await user.newPage();await deniedPage.goto(f.base+'/discord-bot');await deniedPage.locator('#botDenied').waitFor({state:'visible'});check(!await deniedPage.locator('#botWorkspace').isVisible(),'Moderator UI cannot see global server data');check(errors.length===0,'Bot interface has no browser errors');
        delete process.env.BOT_API_URL;await page.goto(f.base+'/discord-bot');await page.locator('#botSetup').waitFor({state:'visible'});check((await page.locator('#botConnection').textContent())==='Not configured','Missing live hosting configuration explained in UI');
      }finally{await browser.close();}
    }
    console.log(checks+' Discord bot checks passed');
  }finally{await new Promise(r=>server.close(r));await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
