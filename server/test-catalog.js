'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  const f=await startFixture();let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
  async function req(path,method='GET',body,cookie=f.cookies[0],extra={}){
    const r=await fetch(f.base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:f.base}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
  }
  const cat=(path,...args)=>req('/api/catalog'+path,...args);
  const hub={name:'Public hub',slug:'public-hub',description:'Script collection',published:false};
  const listing={title:'Public title',description:'Public description',game:'Game',accessMode:'licensed',published:false};
  try{
    check((await cat('/me','GET',undefined,'')).status===401,'Anonymous cannot edit or inspect owner catalogue');
    check((await cat('/me')).data.hub===null,'New developer has no public hub');
    check((await cat('/me','PUT',hub,f.cookies[0],{Origin:'https://evil.example'})).status===403,'Cross-origin catalogue mutation rejected');
    check((await cat('/me','PUT',{...hub,slug:'bad/slug'})).status===400,'Invalid slug rejected');
    check((await cat('/me','PUT',hub)).status===200,'Owner creates a private hub');
    check((await cat('/hubs','GET',undefined,'')).data.total===0&&(await cat('/hubs/public-hub','GET',undefined,'')).status===404,'Private hub hidden from catalogue and direct URL');
    check((await cat('/me','PUT',hub,f.cookies[1])).status===409,'Hub slug unique across developers');
    await cat('/me','PUT',{...hub,published:true});
    const project=(await req('/api/platform/projects','POST',{name:'Private project',description:'Private notes'})).data.project.id;
    check((await cat('/projects/'+project,'PUT',{...listing,published:true})).status===400,'Cannot publish without a saved script');
    await req('/api/platform/projects/'+project+'/script','PUT',{content:'return "original-public-source"',targetMode:'single',placeId:123});
    check((await cat('/projects/'+project,'PUT',listing)).status===200,'Owner creates a draft listing');
    check((await cat('/scripts/'+project,'GET',undefined,'')).status===404,'Draft listing unavailable at public detail URL');
    check((await cat('/scripts','GET',undefined,'')).data.total===0,'Draft script excluded from direct script directory');
    check((await cat('/hubs?q=Game','GET',undefined,'')).data.total===0,'Draft game metadata excluded from public search');
    check((await cat('/projects/'+project,'PUT',{...listing,published:true},f.cookies[1])).status===404,'Other developer cannot publish someone else’s project');
    await cat('/projects/'+project,'PUT',{...listing,published:true});
    const result=await cat('/hubs?q=Public&sort=recent&page=1','GET',undefined,'');
    check(result.status===200&&result.data.hubs.length===1&&result.data.hubs[0].scriptCount===1,'Public hub search reports published script count');
    const scripts=await cat('/scripts','GET',undefined,'');
    check(scripts.status===200&&scripts.data.total===1&&scripts.data.listings[0].projectId===project&&scripts.data.page===1&&scripts.data.pages===1,'Script directory directly lists published scripts with pagination');
    for(const query of ['Public title','Public description','Game','Developer 1']){
      check((await cat('/scripts?q='+encodeURIComponent(query),'GET',undefined,'')).data.total===1,'Script search matches '+query);
    }
    check((await cat('/scripts?q=%25','GET',undefined,'')).data.total===0,'Script search percent remains literal');
    check((await cat('/scripts?q='+encodeURIComponent("' OR 1=1 --"),'GET',undefined,'')).data.total===0,'Script search is parameterized');
    check((await cat('/scripts?sort=name','GET',undefined,'')).status===200&&(await cat('/scripts?sort=unsafe','GET',undefined,'')).status===400,'Script directory sort uses a whitelist');
    check((await cat('/scripts?page=0','GET',undefined,'')).status===400&&(await cat('/scripts?page=10001','GET',undefined,'')).status===400,'Script directory page is bounded');
    check((await cat('/scripts?page=2','GET',undefined,'')).data.listings.length===0,'Script directory supports empty later pages');
    const hubId=(await f.pool.query('SELECT id FROM developer_hubs WHERE owner_id=$1',['900000000000000001'])).rows[0].id;
    const savedScript=(await f.pool.query('SELECT content_enc,content_iv FROM developer_scripts WHERE project_id=$1',[project])).rows[0];
    const initialBuild=require('./src/services/crypto').decryptAES(savedScript.content_enc,savedScript.content_iv);
    const extraIds=[];
    for(let i=1;i<=24;i++){
      const id='20000000-0000-4000-8000-'+String(i).padStart(12,'0');extraIds.push(id);
      await f.pool.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4)',[id,'900000000000000001','Pagination '+i,'test-hash']);
      await f.pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,safety_status) VALUES($1,$2,$3,'clear')",[id,savedScript.content_enc,savedScript.content_iv]);
      await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,published_at,snapshot_validated,snapshot_obfuscated,safety_status) VALUES($1,$2,$3,$4,true,true,'clear')",[id,hubId,'Pagination '+String(i).padStart(2,'0'),new Date()]);
    }
    const firstPage=(await cat('/scripts?sort=name','GET',undefined,'')).data;
    const secondPage=(await cat('/scripts?sort=name&page=2','GET',undefined,'')).data;
    check(firstPage.total===25&&firstPage.pages===2&&firstPage.listings.length===24&&secondPage.listings.length===1,'Directory pagination enforces 24 scripts per page');
    check(new Set([...firstPage.listings,...secondPage.listings].map(l=>l.projectId)).size===25&&firstPage.listings[0].title==='Pagination 01','Name pagination is deterministic with no duplicated scripts');
    for(const id of extraIds){
      await f.pool.query('DELETE FROM developer_listings WHERE project_id=$1',[id]);
      await f.pool.query('DELETE FROM developer_scripts WHERE project_id=$1',[id]);
      await f.pool.query('DELETE FROM developer_projects WHERE id=$1',[id]);
    }
    check((await cat('/hubs?q=Game','GET',undefined,'')).data.total===1,'Hub search includes published listing game');
    check((await cat('/hubs?q=%25','GET',undefined,'')).data.total===0,'Search percent is literal, not a wildcard');
    check((await cat('/hubs?q='+encodeURIComponent("' OR 1=1 --"),'GET',undefined,'')).data.total===0,'Search input remains a SQL parameter');
    check((await cat('/hubs?sort=name','GET',undefined,'')).status===200,'Name sort supported');
    check((await cat('/hubs?page=0','GET',undefined,'')).status===400&&(await cat('/hubs?sort=unsafe','GET',undefined,'')).status===400,'Catalogue pagination and sort validated');
    const detail=await cat('/scripts/'+project,'GET',undefined,'');
    check(detail.data.listing.title==='Public title'&&detail.data.listing.accessMode==='licensed'&&detail.data.listing.loaderUrl.includes('/api/platform/v1/loader/'),'Licensed listing exposes existing protected loader');
    const metadata=JSON.stringify(detail.data);
    check(!/content_enc|snapshot|password|email|apiToken|checkpointSecret|checkpointCallback|original-public-source/.test(metadata),'Public metadata contains no script or credentials');
    check(detail.data.listing.claimUrl===null&&!detail.data.listing.checkpointsConfigured,'Manual-license project has no unavailable key-page link');
    await req('/api/platform/projects/'+project+'/checkpoints','PUT',{provider:'lootlabs',apiToken:'test-only-lootlabs-token',count:1});
    const configured=(await cat('/scripts/'+project,'GET',undefined,'')).data.listing;
    check(configured.checkpointsConfigured&&configured.claimUrl===f.base+'/claim?project='+project,'Configured checkpoints expose a working key-page destination');
    check((await cat('/scripts/'+project+'/source','GET',undefined,'')).status===404,'Licensed script cannot be downloaded publicly');
    check((await req('/api/platform/projects/'+project,'PATCH',{name:'Private updated name',description:'Private updated notes',durationHours:24,hwidBinding:true})).status===200,'Private project metadata update succeeds');
    check((await cat('/scripts/'+project)).data.listing.title==='Public title','Private project edits do not change published metadata');
    await cat('/projects/'+project,'PUT',{...listing,accessMode:'free',published:true});
    const source=await cat('/scripts/'+project+'/source','GET',undefined,'');
    check(source.status===200&&source.data===initialBuild&&source.headers.get('content-type').startsWith('text/plain')&&source.headers.get('cache-control')==='no-store'&&source.headers.get('x-content-type-options')==='nosniff','Explicit free publication serves source as noncached plain text');
    await req('/api/platform/projects/'+project+'/script','PUT',{content:'return "private-next-version"'});
    check((await cat('/scripts/'+project+'/source','GET',undefined,'')).data===initialBuild,'Private script update does not silently replace published free snapshot');
    await cat('/projects/'+project,'PUT',{...listing,accessMode:'free',published:false});
    check((await cat('/scripts/'+project,'GET',undefined,'')).status===404&&(await cat('/scripts/'+project+'/source','GET',undefined,'')).status===404,'Withdrawing listing hides detail and public source');
    check((await cat('/scripts','GET',undefined,'')).data.total===0,'Withdrawing script removes it from direct directory');
    check((await cat('/hubs/public-hub','GET',undefined,'')).data.listings.length===0,'Withdrawn listings absent from hub page');
    await cat('/projects/'+project,'PUT',{...listing,accessMode:'free',published:true});
    await cat('/me','PUT',hub);
    check((await cat('/hubs','GET',undefined,'')).data.total===0&&(await cat('/scripts/'+project+'/source','GET',undefined,'')).status===404,'Withdrawing hub hides its published listings and free source');
    check((await cat('/scripts','GET',undefined,'')).data.total===0,'Private author page hides its scripts from direct directory');
    check((await cat('/me')).data.listings.length===1,'Owner can still inspect unpublished listings');
    const stored=(await f.pool.query('SELECT snapshot_content_enc FROM developer_listings WHERE project_id=$1',[project])).rows[0];
    check(!stored.snapshot_content_enc.includes('private-next-version'),'Published script snapshot remains encrypted in database');
    const auth=require('./src/services/developer-auth');
    async function developer(id,name){
      await f.pool.query('INSERT INTO developer_accounts(discord_id,username) VALUES($1,$2)',[id,name]);
      return auth.COOKIE+'='+await auth.createSession(id);
    }
    const directCookie=await developer('900000000000000003','Direct author');
    const directId=(await req('/api/platform/projects','POST',{name:'Direct project'},directCookie)).data.project.id;
    check((await cat('/projects/'+directId,'PUT',{...listing,title:'Direct release',published:true},directCookie)).status===400&&(await cat('/me','GET',undefined,directCookie)).data.hub===null,'Rejected publication without source creates no author profile');
    await req('/api/platform/projects/'+directId+'/script','PUT',{content:'return "direct-release"'},directCookie);
    check((await cat('/projects/'+directId,'PUT',{...listing,title:'Direct release',published:true},directCookie)).status===200,'Developer publishes first script without creating a hub');
    const directProfile=(await cat('/me','GET',undefined,directCookie)).data.hub;
    check(directProfile.published&&directProfile.author==='Direct author'&&directProfile.slug.length<=48&&(await cat('/scripts?q=Direct%20release','GET',undefined,'')).data.total===1,'Direct publication creates a public author profile and searchable script');
    check((await cat('/projects/'+directId,'PUT',{...listing,published:false},f.cookies[1])).status===404,'Other developer cannot withdraw an automatically profiled script');
    const draftCookie=await developer('900000000000000004','Draft author');
    const draftId=(await req('/api/platform/projects','POST',{name:'Draft project'},draftCookie)).data.project.id;
    await req('/api/platform/projects/'+draftId+'/script','PUT',{content:'return "draft-release"'},draftCookie);
    await cat('/projects/'+draftId,'PUT',{...listing,title:'Automatic draft',published:false},draftCookie);
    check(!(await cat('/me','GET',undefined,draftCookie)).data.hub.published&&(await cat('/scripts?q=Automatic%20draft','GET',undefined,'')).data.total===0,'First draft creates only a private author profile');
    await cat('/projects/'+draftId,'PUT',{...listing,title:'Automatic draft',published:true},draftCookie);
    check((await cat('/scripts?q=Automatic%20draft','GET',undefined,'')).data.total===1,'Publishing a draft activates its automatic author profile');
    await cat('/me','PUT',{name:'Private author page',slug:'private-author',description:'Not public',published:false},draftCookie);
    await cat('/projects/'+draftId,'PUT',{...listing,title:'Automatic draft',published:true},draftCookie);
    check(!(await cat('/me','GET',undefined,draftCookie)).data.hub.published&&(await cat('/scripts?q=Automatic%20draft','GET',undefined,'')).data.total===0,'Publishing never reopens an explicitly private author profile');
    console.log(`Catalogue: ${checks} checks passed without production traffic.`);
  }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
