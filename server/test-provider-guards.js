'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
 const f=await startFixture();f.app.set('trust proxy',1);let checks=0;
 const security=require('./src/services/checkpoint-security'),providers=require('./src/services/checkpoint-providers');
 const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('OK '+label);};
 const request=async(route,method='GET',body,cookie='',headers={})=>{
   const r=await fetch(f.base+'/api/platform'+route,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,location:r.headers.get('location'),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),data:r.headers.get('content-type')?.includes('json')?await r.json():null};
 };
 const nativeFetch=global.fetch;let behavior='normal',external=0;
 global.fetch=async(url,options)=>{
   if(String(url).includes('work.ink/_api/v2/token/isValid/')){
     external++;const token=decodeURIComponent(new URL(url).pathname.split('/').pop());
     if(behavior==='throw')throw Error('Upstream failure');
     if(behavior==='malformed')return Response.json({valid:true});
     const info={token,linkId:10345,createdAt:Date.now(),expiresAfter:Date.now()+60000,byIp:'127.0.0.1'};
     if(behavior==='old')info.createdAt=Date.now()-600000;
     if(behavior==='future')info.createdAt=Date.now()+600000;
     if(behavior==='expired')info.expiresAfter=Date.now()-1;
     if(behavior==='ip')info.byIp='203.0.113.99';
     if(behavior==='link')info.linkId=999;
     if(behavior==='token')info.token='different-token';
     return Response.json({valid:behavior!=='invalid',info});
   }
   return nativeFetch(url,options);
 };
 async function project(provider='workink',owner=f.cookies[0]){
   const id=(await request('/projects','POST',{name:'Guard test'},owner)).data.project.id;
   const config=provider==='workink'?{provider,linkUrl:'https://work.ink/guard',linkId:'10345'}:provider==='lootlabs'?{provider,apiToken:'loot-test-token',count:2}:{provider,linkUrl:'https://linkvertise.com/123/456',apiToken:'b'.repeat(64)};
   const saved=await request('/projects/'+id+'/checkpoints','PUT',config,owner);
   return {id,callback:saved.data.postbackUrl};
 }
 const start=async id=>request('/checkpoints/'+id+'/start','POST',{});
 const state=async(s,headers={})=>request('/checkpoints/'+s.data.session+'/status','GET',undefined,s.cookie,headers);
 const complete=async(id,s,token)=>request('/checkpoints/'+id+'/return?session='+s.data.session+'&token='+token,'GET',undefined,s.cookie);
 try{
   check(security.ipHash('127.0.0.1')===security.ipHash('::ffff:127.0.0.1'),'IPv4 and mapped IPv6 share a canonical network binding');
   check(security.ipHash('2001:db8::1')===security.ipHash('2001:0db8:0:0:0:0:0:1'),'Equivalent IPv6 forms share a binding');
   check(!security.ipHash(['127.0.0.1'])&&!security.ipHash('not-an-ip'),'Malformed network proofs are rejected');
   const p=await project(),s=await start(p.id);
   const stored=(await f.pool.query('SELECT ip_hash FROM developer_checkpoints WHERE id=$1',[s.data.session])).rows[0];
   check(stored.ip_hash===security.ipHash('127.0.0.1')&&!stored.ip_hash.includes('127.0.0.1'),'Session stores an HMAC rather than a raw IP');
   for(const mode of ['old','future','expired','ip','link','token','malformed','throw','invalid']){
     behavior=mode;
     const returned=await complete(p.id,s,'guard-token-'+mode);
     check(returned.location?.includes('checkpoint=failed')&&(await state(s)).data.status==='pending','Work.ink rejects '+mode+' proof without issuing a key');
   }
   behavior='normal';
   const noCookie=await request('/checkpoints/'+p.id+'/return?session='+s.data.session+'&token=guard-valid-token');
   check(noCookie.status===403,'Proof cannot be submitted from another browser');
   const network=await request('/checkpoints/'+p.id+'/return?session='+s.data.session+'&token=guard-valid-token','GET',undefined,s.cookie,{'X-Forwarded-For':'203.0.113.99'});
   check(network.status===403,'Changing networks cannot redeem a stolen browser session');
   const before=external;
   const duplicate=await request('/checkpoints/'+p.id+'/return?session='+s.data.session+'&token=guard-valid-token&token=another-token','GET',undefined,s.cookie);
   check(duplicate.location?.includes('checkpoint=failed')&&external===before,'Duplicate query proofs are rejected before contacting the provider');
   const success=await complete(p.id,s,'guard-valid-token');
   check(!success.location.includes('checkpoint=failed')&&(await state(s)).data.status==='completed','A fresh, matching provider proof issues a key');
   const other=await project('workink',f.cookies[1]),s2=await start(other.id),calls=external;
   const replay=await complete(other.id,s2,'guard-valid-token');
   check(replay.location.includes('checkpoint=failed')&&(await state(s2)).data.status==='pending'&&calls===external,'Proof replay is refused across projects and developers before provider verification');
   const returnedKey=(await state(s)).data.key;
   check((await state(s)).data.key===returnedKey,'Repeated completed-session polls recover only the same key');
   check((await request('/checkpoints/'+s.data.session+'/status','GET',undefined,s.cookie,{'X-Forwarded-For':'203.0.113.99'})).status===403,'A stolen cookie cannot recover a key from another network');
   await f.pool.query('DELETE FROM developer_checkpoints WHERE id=$1',[s.data.session]);
   const retained=(await f.pool.query('SELECT proof_hash FROM developer_checkpoint_proof_uses WHERE proof_hash=$1',[security.proofHash('workink','guard-valid-token')])).rows;
   check(retained.length===1,'Consumed proof survives deletion of its original session');
   const afterCleanup=await complete(other.id,s2,'guard-valid-token');
   check(afterCleanup.location.includes('checkpoint=failed')&&(await state(s2)).data.status==='pending'&&calls===external,'Deleting an old session cannot enable a cross-project replay');
   const loot=await project('lootlabs'),ls=await start(loot.id);
   const callback=new URL(loot.callback);callback.searchParams.set('click_id',ls.data.session);callback.searchParams.set('unique_id','loot-guard-task');
   let response=await fetch(callback);check(response.status===403,'LootLabs postback requires the provider user IP');
   callback.searchParams.set('ip','203.0.113.99');response=await fetch(callback);check(response.status===403&&(await state(ls)).data.status==='pending','LootLabs rejects completed tasks from a different network');
   callback.searchParams.set('ip','127.0.0.1');check((await fetch(callback)).status===200&&(await state(ls)).data.completed===1,'Authenticated matching LootLabs task advances exactly one step');
   const ambiguous=new URL(callback);ambiguous.searchParams.set('sub_id','e'.repeat(64));
   check((await fetch(ambiguous)).status===400&&(await state(ls)).data.completed===1,'Conflicting LootLabs session identifiers cannot redirect a task');
   await fetch(callback);check((await state(ls)).data.completed===1,'Repeated LootLabs task is never counted twice');
   const loot2=await project('lootlabs',f.cookies[1]),ls2=await start(loot2.id),cross=new URL(loot2.callback);
   cross.searchParams.set('click_id',ls2.data.session);cross.searchParams.set('unique_id','loot-guard-task');cross.searchParams.set('ip','127.0.0.1');await fetch(cross);
   check((await state(ls2)).data.completed===0,'LootLabs task cannot be replayed in another project');
   callback.searchParams.set('unique_id','loot-guard-task-two');await fetch(callback);check((await state(ls)).data.status==='completed','All required LootLabs tasks are needed before key issuance');
   const l=await project('linkvertise'),lsv=await start(l.id);
   const bare=await request('/checkpoints/'+l.id+'/return','GET',undefined,lsv.cookie);
   check(bare.location.includes('checkpoint=failed')&&(await state(lsv)).data.status==='pending','Direct Linkvertise callback URL cannot unlock a key');
   const hash='a'.repeat(64);await request('/checkpoints/'+l.id+'/return?hash='+hash,'GET',undefined,lsv.cookie);
   const l2=await project('linkvertise',f.cookies[1]),otherNetwork={'X-Forwarded-For':'127.0.0.2'};
   const lv2=await request('/checkpoints/'+l2.id+'/start','POST',{},'',otherNetwork);
   const reused=await request('/checkpoints/'+l2.id+'/return?hash='+hash,'GET',undefined,lv2.cookie,otherNetwork);
   check(reused.location.includes('checkpoint=failed')&&(await state(lv2,otherNetwork)).data.status==='pending','Linkvertise hash cannot be replayed across projects');
   const oldFetch=global.fetch;
   global.fetch=async()=>Response.json({message:{loot_url:'https://attacker.example/return'}});
   try{await assert.rejects(()=>providers.prepareStart({name:'Test',id:p.id,lootlabs_token_enc:'x',lootlabs_token_iv:'y',checkpoint_count:1},'a'.repeat(64),f.base,()=>'',()=>'',()=>''));check(true,'Unexpected LootLabs redirect hosts are refused');}finally{global.fetch=oldFetch;}
   const proofs=(await f.pool.query('SELECT proof_hash FROM developer_checkpoint_proof_uses')).rows;
   check(proofs.length>0&&proofs.every(r=>/^[a-f0-9]{64}$/.test(r.proof_hash)),'Global replay history stores only proof hashes, without raw tokens or IPs');
   console.log('Provider anti-bypass: '+checks+' checks passed.');
 }finally{global.fetch=nativeFetch;await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
