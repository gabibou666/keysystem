'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
 const f=await startFixture(),crypto=require('./src/services/crypto'),safety=require('./src/services/script-safety'),service=require('./src/services/script-revalidation');
 let checks=0;const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('OK '+label);};
 const ids=[];
 async function seed(code,source=code,status='clear',hash=crypto.sha256(code)){
  const id=randomUUID(),enc=crypto.encryptAES(code),original=source===null?{}:crypto.encryptAES(source);
  await f.pool.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4)',[id,'900000000000000001','Revalidation fixture',crypto.sha256(id)]);
  await f.pool.query('INSERT INTO developer_scripts(project_id,content_enc,content_iv,version,validated,build_hash,safety_hash,safety_status,original_content_enc,original_content_iv) VALUES($1,$2,$3,1,true,$4,$4,$5,$6,$7)',[id,enc.enc,enc.iv,hash,status,original.enc||null,original.iv||null]);
  ids.push(id);return id;
 }
 async function status(id){return (await f.pool.query('SELECT safety_status FROM developer_scripts WHERE project_id=$1',[id])).rows[0]?.safety_status;}
 const opaque='local bytes={'+Array(1100).fill(42).join(',')+'};while true do local op=bytes[1] end';
 try{
  const plain=await seed('return 1'),danger=await seed('os.execute("NEVER_EXECUTE")'),approved=await seed(opaque,opaque,'approved'),held=await seed(opaque),missing=await seed('return 2',null),changed=await seed('return 3','return 3','approved','a'.repeat(64)),quarantined=await seed('return 4','return 4','quarantined');
  const sourceDanger=await seed('return 5','os.execute("NEVER_EXECUTE")','approved');
  const oldClearApproval=await seed('return 42','return 42','approved');
  const first=await service.runOnce();
  check(first.errors===0&&first.examined===9,'Sweep covers existing versions without production or code execution');
  check(await status(oldClearApproval)==='clear','A readable legacy approval becomes clear only after fresh automatic source and output scans');
  check(await require('./src/services/moderation').deliveryAllowed(oldClearApproval,1,crypto.sha256('return 42')),'Fresh verification persists the exact proof required for delivery');
  check(await status(plain)==='clear','Readable original and delivery remain clear');
  check(await status(danger)==='quarantined','High finding quarantines an already active version');
  check(await status(approved)==='quarantined','Previous human approval cannot exempt an opaque release');
  check(await status(held)==='quarantined','Opaque active releases are refused automatically');
  check(await status(missing)==='quarantined','Missing legacy original cannot be reconstructed or auto-approved');
  check(await status(changed)==='quarantined','Delivery integrity mismatch overrides existing approval');
  check(await status(quarantined)==='quarantined','Static clear result cannot release a manually quarantined version');
  check(await status(sourceDanger)==='quarantined','High finding in the original overrides an approval on clear output');
  check((await service.runOnce()).examined===0,'Current metadata avoids unnecessary scans until the next daily interval');
  const meta=(await f.pool.query('SELECT findings,scanner_version FROM developer_script_revalidation')).rows;
  check(meta.every(r=>r.scanner_version===safety.SCANNER_VERSION)&&!JSON.stringify(meta).includes('NEVER_EXECUTE'),'Stored findings contain metadata and no source');
  const hub=randomUUID();await f.pool.query('INSERT INTO developer_hubs(id,owner_id,slug,name,published_at) VALUES($1,$2,$3,$4,now())',[hub,'900000000000000001','revalidation-hub','Fixture']);
  const snap=crypto.encryptAES('os.execute("SNAPSHOT_NEVER_EXECUTE")'),snapHash=crypto.sha256('os.execute("SNAPSHOT_NEVER_EXECUTE")');
  await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,access_mode,published_at,snapshot_content_enc,snapshot_content_iv,script_version,safety_hash,safety_status) VALUES($1,$2,$3,'free',now(),$4,$5,1,$6,'approved')",[plain,hub,'Snapshot',snap.enc,snap.iv,snapHash]);
  check((await service.runOnce()).quarantined===1,'Previously approved malicious free snapshot is independently quarantined');
  check(await status(plain)==='clear','Snapshot quarantine does not overwrite a different safe active release');
  const oldSnapshot=await seed('return 8'),oldEnc=crypto.encryptAES(opaque);
  await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,access_mode,published_at,snapshot_content_enc,snapshot_content_iv,snapshot_validated,script_version,safety_hash,safety_status) VALUES($1,$2,$3,'free',now(),$4,$5,true,7,$6,'approved')",[oldSnapshot,hub,'Approved snapshot',oldEnc.enc,oldEnc.iv,crypto.sha256(opaque)]);
  await service.runOnce();
  check((await f.pool.query('SELECT safety_status FROM developer_listings WHERE project_id=$1',[oldSnapshot])).rows[0].safety_status==='quarantined','Previous human approval cannot exempt an old snapshot without its original');
  await f.pool.query("UPDATE developer_listings SET safety_status='clear' WHERE project_id=$1",[oldSnapshot]);
  await f.pool.query('UPDATE developer_script_revalidation SET checked_at=$2 WHERE project_id=$1',[oldSnapshot,new Date(Date.now()-2*86400000)]);
  await service.runOnce();
  check((await f.pool.query('SELECT safety_status FROM developer_listings WHERE project_id=$1',[oldSnapshot])).rows[0].safety_status==='quarantined','An unapproved old opaque snapshot is refused automatically');
  const retainedSnapshot=await seed('return 100'),snapshotCode='return 99',snapshotEnc=crypto.encryptAES(snapshotCode),snapshotOriginal=crypto.encryptAES(snapshotCode);
  await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,access_mode,published_at,snapshot_content_enc,snapshot_content_iv,snapshot_original_content_enc,snapshot_original_content_iv,snapshot_validated,script_version,safety_hash,safety_status) VALUES($1,$2,'Retained source','free',now(),$3,$4,$5,$6,true,7,$7,'clear')",[retainedSnapshot,hub,snapshotEnc.enc,snapshotEnc.iv,snapshotOriginal.enc,snapshotOriginal.iv,crypto.sha256(snapshotCode)]);
  await service.runOnce();
  check((await f.pool.query('SELECT safety_status FROM developer_listings WHERE project_id=$1',[retainedSnapshot])).rows[0].safety_status==='clear','An old free snapshot is rescanned with its own retained original after a different private upload');
  check(await require('./src/services/moderation').snapshotAllowed(retainedSnapshot,'clear',crypto.sha256(snapshotCode)),'The old snapshot retains an exact automatic proof and remains deliverable');
  await f.pool.query('UPDATE developer_listings SET snapshot_original_content_iv=NULL WHERE project_id=$1',[retainedSnapshot]);
  await f.pool.query('UPDATE developer_script_revalidation SET checked_at=$2 WHERE project_id=$1',[retainedSnapshot,new Date(Date.now()-2*86400000)]);
  await service.runOnce();
  check((await f.pool.query('SELECT safety_status FROM developer_listings WHERE project_id=$1',[retainedSnapshot])).rows[0].safety_status==='quarantined','An incomplete retained source cannot fall back to a different private original');
  // Change the release exactly when the scanner returns, before the lock/recheck.
  const race=await seed('return 6'),nativeScan=safety.scanScript;let replace;
  safety.scanScript=(code,options)=>{
   const result=nativeScan(code,options);
   if(code==='return 6'&&!replace){const enc=crypto.encryptAES('return 7');replace=f.pool.query("UPDATE developer_scripts SET version=2,content_enc=$2,content_iv=$3,original_content_enc=$2,original_content_iv=$3,build_hash=$4,safety_hash=$4,safety_status='approved' WHERE project_id=$1",[race,enc.enc,enc.iv,crypto.sha256('return 7')]);}
   return result;
  };
  try{const raced=await service.runOnce();await replace;check(raced.stale===1,'An old scan cannot update a replacement version');}finally{safety.scanScript=nativeScan;}
  const latest=(await f.pool.query('SELECT version,safety_status,scanner_version FROM developer_scripts WHERE project_id=$1',[race])).rows[0];
  check(latest.version===2&&latest.safety_status==='approved'&&!latest.scanner_version,'Version, approval and scan metadata survive a stale result');
  const sharedA=service.runOnce(),sharedB=service.runOnce();check(sharedA===sharedB,'Concurrent callers coalesce to a single local sweep');await sharedA;
  await f.pool.query("UPDATE developer_script_revalidation SET checked_at=$1",[new Date(Date.now()-2*86400000)]);
  check((await service.runOnce({limit:1})).examined<=2,'Per-run scan count is bounded across current and snapshot phases');
  await f.pool.query('DELETE FROM developer_scripts WHERE project_id=$1',[danger]);
  await f.pool.query('DELETE FROM developer_projects WHERE id=$1',[danger]);
  check((await f.pool.query('SELECT project_id FROM developer_script_revalidation WHERE project_id=$1',[danger])).rows.length===0,'Account/project deletion cascades scan metadata');
  console.log('Script revalidation: '+checks+' checks passed; isolated DB, static scans and explicit race injection. Real multi-connection locks not simulated.');
 }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
