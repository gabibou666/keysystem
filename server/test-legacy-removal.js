'use strict';
const assert=require('node:assert/strict'),{spawn}=require('child_process');
async function run(){
  const base='http://127.0.0.1:3158';
  const child=spawn(process.execPath,['src/index.js'],{cwd:__dirname,windowsHide:true,env:{...process.env,NODE_ENV:'test',PORT:'3158',PUBLIC_URL:base,SCHEDULERS:'off',DATABASE_URL:'postgresql://test:test@127.0.0.1:1/unused',HMAC_SECRET:'a'.repeat(64),AES_KEY:'b'.repeat(64),DISCORD_WEBHOOK_URL:'',RESEND_API_KEY:'',GOOGLE_CLIENT_ID:'',DISCORD_CLIENT_ID:''},stdio:'ignore'});
  let checks=0;
  try{
    let ready=false;
    for(let i=0;i<60;i++){
      if(child.exitCode!==null)throw Error('Server failed to start');
      try{if((await fetch(base+'/ping')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready,'Server starts with new modules only');checks++;
    for(const route of ['/hub','/getkey','/getkey/callback','/verify','/admin','/robux','/api/stats/public','/api/key/start','/api/robux/config','/api/admin/auth','/api/discord/status','/ads.js','/guard.js','/site-config.js','/design.css','/app-admin.js']){
      assert.equal((await fetch(base+route)).status,404,'Legacy route '+route+' disabled');checks++;
    }
    for(const route of ['/','/scripts','/docs','/dashboard','/claim','/signup','/login','/verify-email','/reset-password','/terms','/privacy','/cookies','/legal','/changelog']){
      const r=await fetch(base+route),html=await r.text();
      assert.equal(r.status,200,route);assert.ok(!html.includes('__V__')&&!html.includes('__SITE__'));
      assert.ok(r.headers.get('content-security-policy').includes("script-src-attr 'none'"));
      assert.ok(!/ad-init|site-config|\/getkey|\/robux|\/design.css|on(?:click|change)=/.test(html));checks++;
    }
    const sitemap=await(await fetch(base+'/sitemap.xml')).text();
    assert.ok(sitemap.includes('/scripts')&&!/getkey|robux/.test(sitemap));checks++;
    // Cleanup never queries/deletes historical records, even on an existing DB.
    const statements=[];
    require.cache[require.resolve('./src/db')]={exports:{query:async sql=>{statements.push(sql);return {rowCount:0};}}};
    await require('./src/services/purge').purgeNow();
    const purgedTables=statements.map(sql=>sql.match(/DELETE FROM (developer_[a-z_]+)/)?.[1]).sort();
    assert.deepEqual(purgedTables,['developer_registration_limits','developer_sessions','developer_email_tokens','developer_script_metric_receipts','developer_admin_sessions','developer_events','developer_checkpoints'].sort());
    assert.ok(statements.find(sql=>sql.includes('developer_script_metric_receipts')).includes('expires_at < now()'));checks++;
    console.log('Legacy removal: '+checks+' checks passed; old routes gone, current pages/CSP/SEO and developer-only purge intact.');
  }finally{
    child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
