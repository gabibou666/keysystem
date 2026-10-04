'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  const f=await startFixture();const crypto=require('./src/services/crypto');let checks=0;
  const check=(value,label)=>{assert.ok(value,label);checks++;console.log('OK '+label);};
  async function req(path,method='GET',body,cookie=f.cookies[0],origin=f.base){
    const r=await fetch(f.base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),Origin:origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  }
  try{
    const id=(await req('/api/platform/projects','POST',{name:'Metrics'})).data.project.id;
    const other=(await req('/api/platform/projects','POST',{name:'Independent'},f.cookies[1])).data.project.id;
    const hub=randomUUID(),code=crypto.encryptAES('return 42'),hash=crypto.sha256('return 42');
    await f.pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,validated,obfuscated,safety_status,build_hash,safety_hash) VALUES($1,$2,$3,true,false,'clear',$4,$4)",[id,code.enc,code.iv,hash]);
    await f.pool.query("INSERT INTO developer_hubs(id,owner_id,slug,name,published_at) VALUES($1,$2,'metrics-creator','Creator',now())",[hub,'900000000000000001']);
    await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,access_mode,published_at,snapshot_content_enc,snapshot_content_iv,snapshot_validated,safety_status,safety_hash) VALUES($1,$2,'Metrics script','licensed',now(),$3,$4,true,'clear',$5)",[id,hub,code.enc,code.iv,hash]);
    const path='/api/catalog/scripts/'+id;
    check((await req(path)).data.listing.views===0,'Reading metadata does not manufacture a view');
    check((await req(path+'/view','POST',{},'', 'https://foreign.example')).status===403,'Foreign-origin view refused');
    check((await req('/api/catalog/scripts/'+other+'/view','POST',{})).status===404,'Private scripts cannot receive public views');
    check((await req(path+'/view','POST',{},'')).data.views===1,'Visible detail view counted');
    const repeated=await req(path+'/view','POST',{},'');check(repeated.data.views===1,'Repeated network view counted only once per day');
    const issued=await req('/api/platform/projects/'+id+'/licenses','POST',{count:1,durationHours:24,note:''});
    const key=issued.data.licenses[0].key,executionId=randomUUID(),body={projectId:id,key,hwid:'test-device-12345678',loadScript:true,executionId};
    check((await req('/api/platform/v1/check','POST',{...body,key:'ah_'+'0'.repeat(48)})).status===401,'Invalid key refused');
    check((await req('/api/platform/v1/check','POST',{...body,loadScript:false})).status===200,'Validation-only succeeds');
    check((await req('/api/platform/projects/'+id)).data.metrics.executions===0,'Invalid keys and validation-only do not increment execution count');
    check((await req('/api/platform/v1/check','POST',{...body,executionId:'forged'})).status===400,'Malformed load identity refused');
    check((await req('/api/platform/v1/check','POST',body)).data.script==='return 42','Valid key delivers script');
    check((await req('/api/platform/projects/'+id)).data.metrics.executions===1,'Script delivery increments execution once');
    await req('/api/platform/v1/check','POST',body);
    check((await req('/api/platform/projects/'+id)).data.metrics.executions===1,'Loader retry cannot duplicate execution');
    await req('/api/platform/v1/check','POST',{...body,executionId:randomUUID()});
    check((await req(path)).data.listing.executions===2,'A new loader session increments public count');
    check((await req('/api/platform/projects/'+id,'GET',undefined,f.cookies[1])).status===404,'Another tenant cannot inspect private project metrics');
    check((await req('/api/platform/projects/'+other,'GET',undefined,f.cookies[1])).data.metrics.executions===0,'Metrics remain project-scoped');
    check((await req('/api/platform/projects')).data.projects.find(p=>p.id===id).executions===2,'Workspace cards include aggregate metrics');
    await f.pool.query("UPDATE developer_scripts SET safety_status='quarantined' WHERE project_id=$1",[id]);
    check((await req('/api/platform/v1/check','POST',{...body,executionId:randomUUID()})).status===403,'Quarantined delivery refused');
    check((await req(path+'/view','POST',{})).status===404,'Quarantined public view refused');
    check((await req('/api/platform/projects/'+id)).data.metrics.executions===2,'Quarantine never increments execution');
    await f.pool.query("UPDATE developer_scripts SET safety_status='clear' WHERE project_id=$1",[id]);
    await f.pool.query("UPDATE developer_listings SET access_mode='free' WHERE project_id=$1",[id]);
    await fetch(f.base+path+'/source',{method:'HEAD'});check((await req(path)).data.listing.executions===2,'HEAD probes never count as a free execution');
    const free=await fetch(f.base+path+'/source');check(free.status===200&&await free.text()==='return 42','Free delivery also counted');
    await fetch(f.base+path+'/source');check((await req(path)).data.listing.executions===3,'Free deliveries deduplicate daily network requests');
    await fetch(f.base+'/api/catalog/scripts/'+id.toUpperCase()+'/source');check((await req(path)).data.listing.executions===3,'Alternate UUID casing cannot duplicate a free execution');
    await f.pool.query("UPDATE developer_listings SET access_mode='licensed' WHERE project_id=$1",[id]);
    const receipts=(await f.pool.query('SELECT receipt_hash,expires_at FROM developer_script_metric_receipts')).rows;
    check(receipts.every(r=>/^[a-f0-9]{64}$/.test(r.receipt_hash))&&!JSON.stringify(receipts).includes(key)&&!JSON.stringify(receipts).includes('127.0.0.1'),'Receipts never contain keys, device identifiers or raw addresses');
    check(receipts.every(r=>new Date(r.expires_at)>new Date()&&new Date(r.expires_at)-Date.now()<=48*60*60*1000),'Deduplication receipts expire after 48 hours');
    const loader=await fetch(f.base+'/api/platform/v1/loader/'+id);const source=await loader.text();
    require('luaparse').parse(source,{luaVersion:'5.3'});
    check(source.includes('GenerateGUID(false)')&&source.includes('executionId=executionId')&&!source.includes(key),'Loader includes a retry identity without embedding a private key');
    if(process.argv.includes('--ui')){
      const {chromium}=require('@playwright/test'),browser=await chromium.launch({headless:true});
      try{
        const context=await browser.newContext({viewport:{width:390,height:844}});await context.addCookies([{name:'ah_session',value:f.cookies[0].split('=')[1],url:f.base}]);
        const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(f.base+'/scripts/'+id);await page.locator('#catalogScript .script-metrics').waitFor();
        check((await page.locator('#catalogScript .script-metrics').textContent()).includes('3 executions'),'Public detail displays actual counters');
        await page.goto(f.base+'/dashboard');await page.locator('#projectSelect').selectOption(id);await page.locator('#projectScriptMetrics').waitFor({state:'attached'});
        check((await page.locator('#projectScriptMetrics').textContent()).includes('3 executions'),'Developer sees project counters');
        check(errors.length===0,'Metrics UI has no browser errors');
        await page.goto(f.base+'/scripts');await page.locator('.catalog-script-card .script-metrics').waitFor();
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Catalogue counters fit mobile width');
      }finally{await browser.close();}
    }
    console.log(checks+' script metrics checks passed');
  }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
