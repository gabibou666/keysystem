'use strict';
const {settleResponse}=require('./tests/script-jobs');
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
const {errorSummary,diagnosticUrl,diagnosticDirective}=require('./src/services/private-diagnostics');
async function run(){
  const f=await startFixture();let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
  const secrets=['PRIVATE_PROJECT_TITLE','PRIVATE_PROJECT_NOTES','PRIVATE_SCRIPT_BODY','PRIVATE_CUSTOMER_NOTE','private-developer@example.com','private-provider-api-token'];
  async function req(path,method='GET',body,cookie=f.cookies[0],headers={}){
    const r=await fetch(f.base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:f.base}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return settleResponse(f,r,cookie);
  }
  function clean(result){return secrets.every(secret=>!result.text.includes(secret));}
  try{
    check(diagnosticUrl('https://user:private-password@example.com/api/auth/google/callback?code=PRIVATE_CODE#PRIVATE_TOKEN')==='https://example.com/api/auth/google/callback','Diagnostics remove URL credentials, query strings and fragments');
    check(diagnosticUrl('/api/checkpoints/'+'a'.repeat(64)+'?secret=private')==='/api/checkpoints/:id','Diagnostics hide long identifiers in routes');
    check(diagnosticUrl('/api/auth/private-password?token=secret')==='/api/auth/:id','Diagnostics also hide unknown short route segments');
    check(diagnosticUrl('data:text/plain,PRIVATE_SCRIPT_BODY')==='(redacted)'&&diagnosticUrl('javascript:PRIVATE_SCRIPT_BODY')==='(redacted)','Diagnostics redact inline data and executable URLs');
    check(diagnosticDirective("script-src PRIVATE_TOKEN")==='script-src'&&diagnosticDirective('PRIVATE_TOKEN')==='(unknown)','CSP diagnostics accept only known directive names');
    const diagnosticError=new Error('PRIVATE_SECRET_MESSAGE');diagnosticError.code='ECONNREFUSED';
    check(errorSummary(diagnosticError)==='Error (ECONNREFUSED)'&&!errorSummary(diagnosticError).includes('PRIVATE_SECRET_MESSAGE'),'Diagnostics record error class and recognized code without message');
    const {createReporter,signature}=require('./src/services/alerts');
    const originalConsole=console.error,diagnosticLogs=[],notifications=[];console.error=(...args)=>diagnosticLogs.push(args.join(' '));
    try{
      await createReporter({send:async payload=>notifications.push(payload),now:()=>1000000,actif:true}).report(diagnosticError,{where:'express',route:'/api/callback?secret=PRIVATE_SECRET_ROUTE'});
      check(!JSON.stringify([...diagnosticLogs,...notifications,signature(diagnosticError)]).includes('PRIVATE_SECRET'),'Logs and injected notification transport receive no raw message or URL token');
    }finally{console.error=originalConsole;}
    await f.pool.query('UPDATE developer_accounts SET email=$1 WHERE discord_id=$2',['private-developer@example.com','900000000000000001']);
    const created=JSON.parse((await req('/api/platform/projects','POST',{name:'PRIVATE_PROJECT_TITLE'})).text);
    const id=created.project.id;secrets.push(created.apiToken);
    await req('/api/platform/projects/'+id,'PATCH',{name:'PRIVATE_PROJECT_TITLE',description:'PRIVATE_PROJECT_NOTES',durationHours:24,hwidBinding:true});
    await req('/api/platform/projects/'+id+'/script','PUT',{content:'return "PRIVATE_SCRIPT_BODY"'});
    const issued=JSON.parse((await req('/api/platform/projects/'+id+'/licenses','POST',{note:'PRIVATE_CUSTOMER_NOTE'})).text).licenses[0];secrets.push(issued.key);
    const checkpoint=JSON.parse((await req('/api/platform/projects/'+id+'/checkpoints','PUT',{provider:'lootlabs',apiToken:'private-provider-api-token',count:1})).text);
    secrets.push(new URL(checkpoint.postbackUrl).searchParams.get('secret'));
    const internal=(await f.pool.query('SELECT api_token_hash,lootlabs_token_enc,checkpoint_secret_hash FROM developer_projects WHERE id=$1',[id])).rows[0];secrets.push(...Object.values(internal));
    const encrypted=(await f.pool.query('SELECT content_enc,content_iv FROM developer_scripts WHERE project_id=$1',[id])).rows[0];secrets.push(...Object.values(encrypted));
    const keyHash=(await f.pool.query('SELECT key_hash FROM developer_licenses WHERE id=$1',[issued.id])).rows[0].key_hash;secrets.push(keyHash);
    const keyPage=await req('/api/platform/public/projects/'+id,'GET',undefined,'');
    check(keyPage.status===200&&JSON.parse(keyPage.text).project.name==='Script access'&&clean(keyPage),'Shared key page does not expose private project title or notes');
    check(clean(await req('/api/platform/v1/loader/'+id,'GET',undefined,'')),'Public protected loader contains no private source or credentials');
    const otherProject=JSON.parse((await req('/api/platform/projects','POST',{name:'Other developer'},f.cookies[1])).text).project.id;
    const matrix=[
      ['/api/platform/projects/'+id,'GET'],
      ['/api/platform/projects/'+id,'PATCH',{name:'Takeover',description:'Changed',durationHours:1,hwidBinding:false}],
      ['/api/platform/projects/'+id+'/script','PUT',{content:'return "overwrite"'}],
      ['/api/platform/projects/'+id+'/token','POST',{}],
      ['/api/platform/projects/'+id+'/licenses','POST',{}],
      ['/api/platform/projects/'+id+'/licenses/'+issued.id+'/revoke','POST',{}],
      ['/api/platform/projects/'+id+'/checkpoints','PUT',{provider:'lootlabs',apiToken:'new-private-token',count:1}],
      ['/api/catalog/projects/'+id,'PUT',{title:'Stolen',description:'',game:'',accessMode:'free',published:true}],
    ];
    for(const [path,method,body]of matrix){const r=await req(path,method,body,f.cookies[1]);check(r.status===404&&clean(r),'Other developer denied '+method+' '+path.replace(id,':project'));}
    const otherList=await req('/api/platform/projects','GET',undefined,f.cookies[1]);
    check(clean(otherList)&&!otherList.text.includes(id),'Other developer project list excludes private projects');
    const privateCatalog=await req('/api/catalog/scripts/'+id,'GET',undefined,'');
    check(privateCatalog.status===404&&clean(privateCatalog),'Unpublished script metadata is inaccessible');
    await req('/api/catalog/projects/'+id,'PUT',{title:'PUBLIC_TITLE',description:'PUBLIC_DESCRIPTION',game:'Public game',accessMode:'licensed',published:true});
    for(const path of ['/api/catalog/scripts','/api/catalog/scripts/'+id,'/api/catalog/me','/api/platform/me','/api/auth/options']){
      const r=await req(path,'GET',undefined,path==='/api/catalog/me'?f.cookies[1]:'');check(clean(r),'Safe response fields for '+path);
    }
    const publishedKeyPage=await req('/api/platform/public/projects/'+id,'GET',undefined,'');
    check(JSON.parse(publishedKeyPage.text).project.name==='PUBLIC_TITLE'&&JSON.parse(publishedKeyPage.text).project.description==='PUBLIC_DESCRIPTION'&&clean(publishedKeyPage),'Shared key page uses only explicitly published metadata');
    const source=await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'');check(source.status===404&&clean(source),'Licensed public listing does not expose source');
    const crossKey=await req('/api/platform/v1/check','POST',{projectId:otherProject,key:issued.key,hwid:'test-private-device',loadScript:true},'');
    check(crossKey.status===401&&clean(crossKey),'A valid key for another project cannot disclose script data');
    await req('/api/catalog/projects/'+id,'PUT',{title:'PUBLIC_TITLE',description:'PUBLIC_DESCRIPTION',game:'Public game',accessMode:'licensed',published:false});
    check(clean(await req('/api/platform/public/projects/'+id,'GET',undefined,''))&&(await req('/api/platform/public/projects/'+id,'GET',undefined,'')).text.includes('Script access'),'Withdrawing metadata restores neutral key page');
    for(const path of ['/api/catalog/scripts/'+id,'/api/platform/projects/'+id,'/api/auth/options']){
      const r=await req(path);check(r.headers.get('cache-control')==='no-store'&&r.headers.get('referrer-policy')==='no-referrer','Privacy headers present for '+path.replace(id,':project'));
    }
    const originalQuery=f.pool.query.bind(f.pool),originalError=console.error,logs=[];
    f.pool.query=async(sql,...args)=>{if(sql.includes('l.title AS public_title'))throw new Error('DATABASE_SECRET_PRIVATE: '+secrets.join(' '));return originalQuery(sql,...args);};
    console.error=(...args)=>logs.push(args.join(' '));
    try{const r=await req('/api/platform/public/projects/'+id,'GET',undefined,'');check(r.status===500&&clean(r)&&logs.every(log=>!log.includes('DATABASE_SECRET_PRIVATE')&&secrets.every(secret=>!log.includes(secret))),'Unexpected database errors expose no details in response or logs');}
    finally{f.pool.query=originalQuery;console.error=originalError;}
    console.log(`Data privacy: ${checks} checks passed with synthetic secrets and no production traffic.`);
  }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
