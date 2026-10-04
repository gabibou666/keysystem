'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('crypto');
const {startFixture}=require('./tests/platform-fixture');
const {waitJob}=require('./tests/script-jobs');
async function run(){
 const f=await startFixture();let checks=0;
 const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
 const cipher=require('./src/services/crypto'),queue=require('./src/services/publication-queue'),engine=require('./src/services/script-builder');
 const nativeBuild=engine.build;let releaseGate,testIp=1;
 // Distinct simulated networks isolate rate-limit windows between scenarios.
 f.app.set('trust proxy',1);
 async function req(path,method='GET',body,cookie=f.cookies[0],extra={}){
  const r=await fetch(f.base+path,{method,headers:{'X-Forwarded-For':'198.51.100.'+testIp,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:f.base}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
 }
 async function submit(id,body){const r=await req('/api/platform/projects/'+id+'/script','PUT',body);assert.equal(r.status,202,JSON.stringify(r.data));return r.data;}
 async function finish(id,body){const r=await submit(id,body);return waitJob(f,id,r.jobId,f.cookies[0]);}
 const publish=(id,body={})=>req('/api/catalog/projects/'+id,'PUT',{title:'Actual queued release',description:'Isolated database test',game:'',accessMode:'free',published:true,...body});
 function gate(){let reached;const entered=new Promise(resolve=>{reached=resolve;});const blocked=new Promise(resolve=>{releaseGate=resolve;});engine.build=async(...args)=>{reached();await blocked;return nativeBuild(...args);};return {entered};}
 async function resetRate(){testIp++;await f.pool.query('UPDATE developer_script_jobs SET created_at=$1',[new Date(Date.now()-3600000)]);}
 async function retainedHistory(sql,args,ready,label){
  const deadline=Date.now()+10000;let rows;
  // pg-mem exposes the terminal UPDATE before the surrounding retention
  // transaction commits. Wait for its actual invariant, not an arbitrary delay.
  do{
   rows=(await f.pool.query(sql,args)).rows;if(ready(rows))return rows;
   await new Promise(resolve=>setTimeout(resolve,20));
  }while(Date.now()<deadline);
  assert.fail(label+' never reached its retention bound');
 }
 try{
  const created=await req('/api/platform/projects','POST',{name:'Durable script pipeline'}),id=created.data.project.id;
  const source='-- PRIVATE_OWNER_COMMENT\nlocal privateOwnerVariable="queued-original"\nreturn privateOwnerVariable';
  const accepted=await submit(id,{content:source,filename:'owner-original.lua'});
  check(accepted.queued&&accepted.job.status==='queued'&&!accepted.job.obfuscate&&accepted.job.obfuscationLevel===null,'Upload immediately returns a durable 202 job with obfuscation disabled');
  const stored=(await f.pool.query('SELECT * FROM developer_script_jobs WHERE id=$1',[accepted.jobId])).rows[0];
  check(stored.original_content_enc&&!stored.original_content_enc.includes('PRIVATE_OWNER_COMMENT')&&cipher.decryptAES(stored.original_content_enc,stored.original_content_iv)===source,'Accepted original is encrypted before the response');
  check(!JSON.stringify(accepted).includes('content_enc')&&!JSON.stringify(accepted).includes('worker_token')&&!JSON.stringify(accepted).includes('PRIVATE_OWNER_COMMENT'),'Job projection contains progress and options without source or worker credentials');
  const first=await waitJob(f,id,accepted.jobId,f.cookies[0]);
  check(first.status==='succeeded'&&first.result.validated&&!first.result.obfuscated&&first.originalSizeBytes===Buffer.byteLength(source)&&first.outputSizeBytes===Buffer.byteLength(source),'Real compiler validates None mode and records byte counts');
  check(first.logs.every(x=>/^\d{4}-/.test(x.date)&&['info','warning','error'].includes(x.level))&&first.progress===100,'Owner receives dated progress logs and a terminal result');
  const current=(await f.pool.query('SELECT * FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  check(current.original_content_iv!==current.content_iv&&cipher.decryptAES(current.content_enc,current.content_iv)===source,'Current original and delivery use separate authenticated encryption');
  const detail=await req('/api/platform/projects/'+id);
  check(detail.data.script.originalAvailable&&detail.data.script.filename==='owner-original.lua'&&detail.data.script.originalSizeBytes===Buffer.byteLength(source)&&!detail.data.script.obfuscated,'Owner detail exposes honest source/build metadata');
  const download=await req('/api/platform/projects/'+id+'/source');
  check(download.data===source&&download.headers.get('content-disposition').includes('owner-original.lua')&&download.headers.get('cache-control')==='no-store','Owner downloads the exact original with private response headers');
  check((await req('/api/platform/projects/'+id+'/source','GET',undefined,f.cookies[1])).status===404&&(await req('/api/platform/projects/'+id+'/jobs','GET',undefined,f.cookies[1])).status===404,'Another account cannot read originals or job logs');
  check((await req('/api/platform/projects/'+id+'/jobs/'+accepted.jobId+'/source','GET',undefined,'')).status===401,'Anonymous original access is refused');
  check((await req('/api/platform/projects/'+id+'/script','PUT',{content:source},f.cookies[0],{Origin:'https://foreign.test'})).status===403,'Upload checks origin before queue admission');
  check((await req('/api/platform/projects/'+id+'/script','PUT',{content:source,obfuscate:'true'})).status===400,'Obfuscation flag is a boolean, never truthy coercion');
  check((await req('/api/platform/projects/'+id+'/script','PUT',{content:'x'.repeat(8*1024*1024+1)})).status===400,'Actual UTF-8 source size above 8 MiB is rejected');
  const published=await publish(id,{obfuscate:true,obfuscationLevel:'standard'});
  check(published.status===202&&published.data.job.kind==='publish','Publication runs through the same durable pipeline');
  let standard=await waitJob(f,id,published.data.jobId,f.cookies[0]);
  if(standard.status==='review'){
    check(standard.result.pendingReview&&!standard.result.published,'Opaque Standard output is held without automatic publication');
    process.env.MODERATION_ADMIN_IDS='900000000000000002';
    const staff=await req('/admin/api/session','POST',{confirmation:'ACTIVATE'},f.cookies[1]);assert.equal(staff.status,200);
    const staffCookie=f.cookies[1]+'; '+staff.headers.getSetCookie().find(x=>x.startsWith('ah_admin_session=')).split(';')[0];
    const approval=await req('/api/moderation/submissions/'+standard.result.submissionId+'/decision','POST',{decision:'approve',note:'Explicit approval of this controlled Standard fixture.'},staffCookie,{'X-CSRF-Token':staff.data.csrfToken});
    check(approval.status===200,'Independent staff explicitly approves the exact Standard build');
    standard=await waitJob(f,id,published.data.jobId,f.cookies[0]);
    check(standard.result.securityStatus==='approved','Approved Standard build retains the human decision');
  }
  check(standard.status==='succeeded'&&standard.result.obfuscated&&standard.result.published,'Real Standard build is atomically published after any required review');
  const standardDetail=await req('/api/platform/projects/'+id);
  const standardListing=(await req('/api/catalog/me')).data.listings.find(item=>item.projectId===id);
  check(standardDetail.status===200&&standardDetail.data.script.validated&&standardDetail.data.script.obfuscated&&standardDetail.data.script.obfuscationLevel==='standard'&&standardDetail.data.script.version===standard.result.version&&standardListing?.scriptVersion===standard.result.version,'Current script and published snapshot expose the real promoted Standard metadata');
  const publicSource=await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'');
  check(publicSource.status===200&&!publicSource.data.includes('PRIVATE_OWNER_COMMENT')&&!publicSource.data.includes('privateOwnerVariable'),'Public delivery serves the transformed copy rather than the retained original');
  check((await req('/api/platform/projects/'+id+'/source')).data===source,'Publishing never replaces the retained owner original with its transformed output');
  const unsupported=await finish(id,{content:'local sum=0; for key,value in pairs({a=1}) do sum=sum+value end; return sum',obfuscate:true,obfuscationLevel:'strong'});
  check(unsupported.status==='failed'&&unsupported.error.code==='SCRIPT_UNSUPPORTED_STRONG'&&unsupported.error.message.includes('Standard')&&(await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data===publicSource.data,'Unsupported Strong syntax fails explicitly without fallback or publication change');
  const invalid=await finish(id,{content:'local broken = (',filename:'invalid.lua'});
  check(invalid.status==='failed'&&invalid.error.code==='SCRIPT_INVALID'&&(await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data===publicSource.data,'Compiler failure preserves the current public delivery');
  check((await req('/api/platform/projects/'+id+'/jobs/'+invalid.id+'/source')).data==='local broken = (','Owner can recover a failed submission original');
  const blocked=await finish(id,{content:'os.execute("never-run-this")'});
  check(blocked.status==='failed'&&blocked.error.code==='SECURITY_BLOCKED'&&blocked.result.findings.some(x=>x.rule==='process_execution'),'Original safety scan blocks unsafe process execution without running it');
  check((await req('/api/platform/projects/'+id+'/source')).data===source,'A blocked candidate cannot replace the current original');
  const {entered}=gate();const cancelAccepted=await submit(id,{content:'return "cancelled replacement"'});await entered;
  check((await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data===publicSource.data,'Current public delivery remains available while a real build is pending');
  const cancelled=await req('/api/platform/projects/'+id+'/jobs/'+cancelAccepted.jobId+'/cancel','POST',{});
  check(cancelled.status===200&&cancelled.data.job.status==='cancelled','Owner explicitly cancels a processing job');
  releaseGate();engine.build=nativeBuild;
  await new Promise(resolve=>setTimeout(resolve,50));
  check((await req('/api/platform/projects/'+id+'/source')).data===source,'Cancelled worker cannot save its result');
  await resetRate();
  const opaque='loadstring(game:HttpGet("https://example.test/static-release.lua"))()';
  const review=await finish(id,{content:opaque});
  check(review.status==='review'&&review.result.pendingReview&&!review.result.published,'Opaque originals require independent review while the previous build stays active');
  process.env.MODERATION_ADMIN_IDS='900000000000000002';
  const activation=await req('/admin/api/session','POST',{confirmation:'ACTIVATE'},f.cookies[1]);
  const adminCookie=f.cookies[1]+'; '+activation.headers.getSetCookie().find(x=>x.startsWith('ah_admin_session=')).split(';')[0];
  const approve=await req('/api/moderation/submissions/'+review.result.submissionId+'/decision','POST',{decision:'approve'},adminCookie,{'X-CSRF-Token':activation.data.csrfToken});
  check(approve.status===200,'Independent staff approves the actual staged build');
  const approved=await req('/api/platform/projects/'+id);
  check(approved.data.script.originalAvailable&&!approved.data.script.obfuscated&&approved.data.script.securityStatus==='approved'&&(await req('/api/platform/projects/'+id+'/source')).data===opaque,'Review promotion copies the original and actual None metadata without claiming obfuscation');
  const republish=await publish(id);
  const republished=await waitJob(f,id,republish.data.jobId,f.cookies[0]);
  check(republished.status==='succeeded'&&republished.result.published,'An identical independently approved release can be republished after validation');
  const waitingPublication=await publish(id,{obfuscate:true,obfuscationLevel:'standard'});
  const pendingPublication=await waitJob(f,id,waitingPublication.data.jobId,f.cookies[0]);
  check(pendingPublication.status==='review'&&(await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data===opaque,'Changed transformed publication waits for review without replacing the published snapshot');
  const approvedPublish=await req('/api/moderation/submissions/'+pendingPublication.result.submissionId+'/decision','POST',{decision:'approve'},adminCookie,{'X-CSRF-Token':activation.data.csrfToken});
  const finalPublish=(await req('/api/platform/projects/'+id+'/jobs/'+pendingPublication.id)).data.job;
  check(approvedPublish.status===200&&finalPublish.status==='succeeded'&&finalPublish.result.published&&!(await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data.includes('example.test'),'Review approval atomically completes the requested transformed publication');
  const stalePublication=await publish(id,{obfuscate:true,obfuscationLevel:'standard'});
  const publicationReview=await waitJob(f,id,stalePublication.data.jobId,f.cookies[0]);
  assert.equal(publicationReview.status,'review');
  const beforeStale=(await f.pool.query('SELECT version,content_enc FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  await req('/api/catalog/projects/'+id,'PUT',{title:'Withdraw during review',description:'',game:'',accessMode:'free',published:false});
  const staleApproval=await req('/api/moderation/submissions/'+publicationReview.result.submissionId+'/decision','POST',{decision:'approve'},adminCookie,{'X-CSRF-Token':activation.data.csrfToken});
  const staleReviewJob=(await req('/api/platform/projects/'+id+'/jobs/'+publicationReview.id)).data.job;
  const afterStale=(await f.pool.query('SELECT version,content_enc FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  check(staleApproval.status===409&&staleReviewJob.status==='failed'&&staleReviewJob.error.code==='RELEASE_CHANGED'&&afterStale.version===beforeStale.version&&afterStale.content_enc===beforeStale.content_enc,'A changed publication becomes a terminal stale review before any source/build replacement');
  await resetRate();
  const {entered:raceEntered}=gate();const race=await submit(id,{content:'return "stale worker"'});await raceEntered;
  await f.pool.query('UPDATE developer_scripts SET version=version+1 WHERE project_id=$1',[id]);releaseGate();engine.build=nativeBuild;
  const stale=await waitJob(f,id,race.jobId,f.cookies[0]);
  check(stale.status==='failed'&&stale.error.code==='RELEASE_CHANGED','A changed owner release invalidates the in-flight result');
  const {entered:banEntered}=gate();const banRace=await submit(id,{content:'return "restricted worker"'});await banEntered;
  await f.pool.query('UPDATE developer_accounts SET banned_at=now() WHERE discord_id=$1',['900000000000000001']);releaseGate();engine.build=nativeBuild;
  // Polling is deliberately refused to banned accounts; inspect isolated DB.
  for(let n=0;n<100;n++){const row=(await f.pool.query('SELECT status FROM developer_script_jobs WHERE id=$1',[banRace.jobId])).rows[0];if(row.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,20));}
  const banResult=(await f.pool.query('SELECT status,error_code FROM developer_script_jobs WHERE id=$1',[banRace.jobId])).rows[0];
  check(banResult.status==='failed'&&banResult.error_code==='PROJECT_UNAVAILABLE','Account ban is rechecked atomically before saving');
  await f.pool.query('UPDATE developer_accounts SET banned_at=NULL WHERE discord_id=$1',['900000000000000001']);
  const exportResponse=await req('/api/account/export');
  check(exportResponse.data.originalSources.some(x=>x.source===opaque)&&exportResponse.data.scriptJobs.some(x=>x.source==='local broken = (')&&!JSON.stringify(exportResponse.data).includes('original_content_enc'),'Authenticated export includes retained original sources and historical jobs without ciphertext');
  // Recovery test stores an actual source and simulates an expired worker lease.
  const recoveryId=randomUUID(),encrypted=cipher.encryptAES('return "recovered durable job"');
  const active=(await f.pool.query('SELECT version,build_hash,safety_status FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  await f.pool.query("INSERT INTO developer_script_jobs(id,project_id,owner_id,kind,status,original_content_enc,original_content_iv,original_size_bytes,expected_version,expected_hash,expected_safety,worker_token,lease_expires_at,attempts) VALUES($1,$2,$3,'upload','processing',$4,$5,$6,$7,$8,$9,$10,$11,1)",[recoveryId,id,'900000000000000001',encrypted.enc,encrypted.iv,Buffer.byteLength('return "recovered durable job"'),active.version,active.build_hash,active.safety_status,randomUUID(),new Date(Date.now()-1000)]);
  queue.wake();const recovered=await waitJob(f,id,recoveryId,f.cookies[0]);
  check(recovered.status==='succeeded','A crashed processing lease is recovered from the durable database');
  // Retention uses immutable byte counters produced at real admission above.
  // Small encrypted fixture bodies exercise history bounds without asking
  // pg-mem to parse multi-megabyte SQL string literals.
  for(let n=0;n<125;n++){
   const text='return '+n,enc=cipher.encryptAES(text);
   await f.pool.query("INSERT INTO developer_script_jobs(id,project_id,owner_id,kind,status,original_content_enc,original_content_iv,original_size_bytes,created_at) VALUES($1,$2,$3,'upload','succeeded',$4,$5,$6,$7)",[randomUUID(),id,'900000000000000001',enc.enc,enc.iv,Buffer.byteLength(text),new Date(Date.now()-86400000+n)]);
  }
  await resetRate();
  const retained=await finish(id,{content:'return "history boundary"'});
  const history=await retainedHistory("SELECT id,original_content_enc,original_size_bytes FROM developer_script_jobs WHERE project_id=$1 AND status IN ('succeeded','failed','cancelled') AND worker_token IS NULL",[id],rows=>rows.length<=100&&rows.filter(x=>x.original_content_enc).length<=20,'Finished project history');
  check(retained.status==='succeeded'&&history.length<=100&&history.filter(x=>x.original_content_enc).length<=20,'Finished job metadata is capped at 100 and historical originals at 20 per project');
  const old=history.find(x=>!x.original_content_enc);
  check((await req('/api/platform/projects/'+id+'/jobs/'+old.id)).data.job.originalAvailable===false&&(await req('/api/platform/projects/'+id+'/jobs/'+old.id+'/source')).data.code==='ORIGINAL_UNAVAILABLE','Purged historical originals are honestly reported unavailable');
  check((await req('/api/platform/projects/'+id+'/source')).data==='return "history boundary"','Pruning job history never removes the current owner original');
  const newest=(await f.pool.query('SELECT id FROM developer_script_jobs WHERE project_id=$1 AND original_content_enc IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 6',[id])).rows;
  for(const row of newest)await f.pool.query('UPDATE developer_script_jobs SET original_size_bytes=8388608 WHERE id=$1',[row.id]);
  await resetRate();await finish(id,{content:'return "byte budget"'});
  const remaining=await retainedHistory("SELECT original_size_bytes FROM developer_script_jobs WHERE owner_id=$1 AND original_content_enc IS NOT NULL AND status IN ('succeeded','failed','cancelled') AND worker_token IS NULL",['900000000000000001'],rows=>rows.reduce((sum,row)=>sum+row.original_size_bytes,0)<=32*1024*1024,'Finished account sources');
  check(remaining.reduce((sum,row)=>sum+row.original_size_bytes,0)<=32*1024*1024,'Historical source byte counters enforce the 32 MiB account budget');
  const project2=(await req('/api/platform/projects','POST',{name:'Deletion race'})).data.project.id;
  await finish(project2,{content:'return "before admin deletion"'});
  const deletionEntered=gate();const deleting=await submit(project2,{content:'return "worker cannot resurrect this"'});await deletionEntered.entered;
  const scriptDeleted=await req('/admin/api/scripts/'+project2+'/delete','POST',{confirmation:'DELETE',reason:'Isolated test deletion'},adminCookie,{'X-CSRF-Token':activation.data.csrfToken});
  check(scriptDeleted.status===200&&Number((await f.pool.query('SELECT count(*) AS total FROM developer_script_jobs WHERE project_id=$1',[project2])).rows[0].total)===0,'Staff script deletion purges every retained job original');
  const slotDuringDelete=(await f.pool.query('SELECT worker_token,expires_at FROM developer_script_worker_lease WHERE id=1')).rows[0];
  check(slotDuringDelete.worker_token&&new Date(slotDuringDelete.expires_at)>new Date(),'Physical job deletion preserves the global worker lease until its process exits');
  releaseGate();engine.build=nativeBuild;await new Promise(resolve=>setTimeout(resolve,50));
  const removed=(await f.pool.query('SELECT disabled,deleted_at,original_content_enc,content_enc FROM developer_scripts WHERE project_id=$1',[project2])).rows[0];
  check(removed.disabled&&removed.deleted_at&&!removed.original_content_enc&&!removed.content_enc&&(await req('/api/platform/projects/'+project2+'/source')).status===404,'An in-flight worker cannot resurrect an administratively deleted source');
  // A surviving remote lease must delay a new worker even without a job FK.
  const remoteToken=randomUUID();await f.pool.query('UPDATE developer_script_worker_lease SET worker_token=$1,expires_at=$2 WHERE id=1',[remoteToken,new Date(Date.now()+200)]);
  const delayed=await submit(id,{content:'return \"after remote lease\"'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const delayedRow=(await f.pool.query('SELECT status FROM developer_script_jobs WHERE id=$1',[delayed.jobId])).rows[0];
  check(delayedRow.status==='queued'&&(await f.pool.query('SELECT worker_token FROM developer_script_worker_lease WHERE id=1')).rows[0].worker_token===remoteToken,'An unexpired remote worker lease prevents another process from claiming new work');
  check((await waitJob(f,id,delayed.jobId,f.cookies[0])).status==='succeeded','Durable queued work resumes after the stale remote lease expires');
  const del=await req('/api/account','DELETE',{confirmation:'DELETE'});
  check(del.status===200&&Number((await f.pool.query('SELECT count(*) AS total FROM developer_script_jobs WHERE project_id=$1',[id])).rows[0].total)===0,'Account deletion removes jobs and all retained originals');
  console.log('Script jobs: '+checks+' checks passed with the real compiler and isolated database.');
 }finally{releaseGate?.();engine.build=nativeBuild;await f.close();}
}
run().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
