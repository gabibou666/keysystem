'use strict';
// Static verification only: no execution, network access or source in logs.
const pool=require('../db'),crypto=require('./crypto'),safety=require('./script-safety'),moderation=require('./moderation');
const DAY=24*60*60*1000,BATCH=16;
let active=null,stopScheduler=null;
const yieldLoop=()=>new Promise(resolve=>setImmediate(resolve));
function unsafe(rule){return {status:'blocked',hash:null,scannerVersion:safety.SCANNER_VERSION,findings:[{rule,severity:'high',line:1}]};}
function decrypt(enc,iv,max){
 if(typeof enc!=='string'||enc.length>Math.ceil((max+16)*4/3)+8)throw Error('Invalid encrypted payload');
 return crypto.decryptAES(enc,iv);
}
function inspect(row){
 try{
  const code=decrypt(row.content_enc,row.content_iv,32*1024*1024);
  let after=safety.scanScript(code,{phase:'output'});
  if(after.status==='blocked')return after;
  if(!/^[a-f0-9]{64}$/.test(row.build_hash||'')||after.hash!==row.build_hash)return unsafe('release_integrity_mismatch');
  if(row.validated!==true)after={...after,status:'review',findings:[...after.findings,{rule:'syntax_validation_unavailable',severity:'review',line:1}]};
  if(row.original_content_enc&&row.original_content_iv){
   const source=decrypt(row.original_content_enc,row.original_content_iv,safety.MAX_BYTES);
   return safety.combineScans(safety.scanScript(source,{phase:'source'}),after);
  }
  return {...after,status:'review',findings:[...after.findings,{rule:'original_unavailable',severity:'review',line:1}]};
 }catch{return unsafe('release_unreadable');}
}
const TABLES={current:'developer_scripts',free_snapshot:'developer_listings'};
async function load(db,kind,id,locked=false){
 const table=TABLES[kind];
 if(kind==='current')return (await db.query(`SELECT s.*,p.owner_id FROM ${table} s JOIN developer_projects p ON p.id=s.project_id WHERE s.project_id=$1${locked?' FOR UPDATE':''}`,[id])).rows[0];
 const row=(await db.query(`SELECT l.*,p.owner_id FROM ${table} l JOIN developer_projects p ON p.id=l.project_id WHERE l.project_id=$1 AND l.access_mode='free' AND l.published_at IS NOT NULL${locked?' FOR UPDATE':''}`,[id])).rows[0];
 if(!row)return null;
 const current=(await db.query('SELECT version,build_hash,original_content_enc,original_content_iv FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
 // New publications retain their own encrypted source. Legacy fallback is
 // allowed only for the exact release, never for a newer private original.
 const retained=row.snapshot_original_content_enc!=null||row.snapshot_original_content_iv!=null;
 const exact=current?.version===row.script_version&&current.build_hash===row.safety_hash;
 return {...row,validated:row.snapshot_validated,content_enc:row.snapshot_content_enc,content_iv:row.snapshot_content_iv,version:row.script_version,build_hash:row.safety_hash,
  original_content_enc:retained?row.snapshot_original_content_enc:exact?current.original_content_enc:null,
  original_content_iv:retained?row.snapshot_original_content_iv:exact?current.original_content_iv:null};
}
function same(a,b){return !!b&&['version','build_hash','content_enc','content_iv','original_content_enc','original_content_iv'].every(key=>(a[key]??null)===(b[key]??null));}
function decision(row,scan){
 if(row.safety_status==='quarantined'||scan.status!=='clear'||scan.scannerVersion!==safety.SCANNER_VERSION||scan.hash!==row.build_hash)return 'quarantined';
 if(!['clear','approved','unreviewed','review'].includes(row.safety_status))return 'quarantined';
 return 'clear';
}
async function save(kind,before,scan){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='10s'");
  const project=(await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[before.project_id])).rows[0];
  if(!project){await db.query('ROLLBACK');return 'stale';}
  const row=await load(db,kind,before.project_id,true);
  if(!same(before,row)){await db.query('ROLLBACK');return 'stale';}
  const result=decision(row,scan),findings=moderation.findings(scan.findings);
  if(kind==='current')await db.query('UPDATE developer_scripts SET safety_status=$2,safety_hash=$3,scanner_version=$4 WHERE project_id=$1',[row.project_id,result,row.build_hash,safety.SCANNER_VERSION]);
  else await db.query('UPDATE developer_listings SET safety_status=$2 WHERE project_id=$1',[row.project_id,result]);
  await db.query(`INSERT INTO developer_script_revalidation(project_id,target_kind,content_version,content_hash,scanner_version,checked_at,result,findings)
   VALUES($1,$2,$3,$4,$5,now(),$6,$7::jsonb) ON CONFLICT(project_id,target_kind) DO UPDATE SET content_version=$3,content_hash=$4,scanner_version=$5,checked_at=now(),result=$6,findings=$7::jsonb`,
   [row.project_id,kind,row.version,row.build_hash,safety.SCANNER_VERSION,result,JSON.stringify(findings)]);
  await moderation.audit(db,{action:'script.rechecked',projectId:row.project_id,version:row.version,hash:row.build_hash,findings,note:kind+': '+result});
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
async function candidates(kind,limit){
 const current=kind==='current',table=TABLES[kind],version=current?'s.version':'s.script_version',hash=current?'s.build_hash':'s.safety_hash';
 const where=current?"s.deleted_at IS NULL":"s.access_mode='free' AND s.published_at IS NOT NULL";
 return (await pool.query(`SELECT s.project_id FROM ${table} s LEFT JOIN developer_script_revalidation r ON r.project_id=s.project_id AND r.target_kind=$1
  WHERE ${where} AND (r.project_id IS NULL OR r.checked_at<$2 OR r.scanner_version<>$3 OR r.content_version<>${version} OR COALESCE(r.content_hash,'')<>COALESCE(${hash},''))
  ORDER BY r.checked_at ASC NULLS FIRST,s.project_id LIMIT $4`,[kind,new Date(Date.now()-DAY),safety.SCANNER_VERSION,limit])).rows;
}
function runOnce(options={}){
 if(active)return active;
 active=(async()=>{
  const limit=Number.isInteger(options.limit)?Math.max(1,Math.min(BATCH,options.limit)):BATCH;
  const results={examined:0,clear:0,approved:0,review:0,quarantined:0,stale:0,errors:0,more:false};
  for(const kind of ['current','free_snapshot']){
   const rows=await candidates(kind,limit);if(rows.length===limit)results.more=true;
   for(const item of rows){
    await yieldLoop();const row=await load(pool,kind,item.project_id);if(!row){results.stale++;continue;}
    const scan=inspect(row);results.examined++;
    try{results[await save(kind,row,scan)]++;}catch{results.errors++;}
   }
  }
  return results;
 })().finally(()=>{active=null;});return active;
}
function startScheduler(){
 if(stopScheduler)return stopScheduler;
 if(process.env.SCHEDULERS==='off')return ()=>{};
 let stopped=false,timer,interval,retries=0;
 function schedule(delay){if(!stopped){clearTimeout(timer);timer=setTimeout(tick,delay).unref();}}
 function retry(){if(++retries<=3)schedule(30000*retries);}
 async function tick(){
  if(stopped)return;
  try{
   const result=await runOnce();
   if(result.errors||result.stale)retry();
   else {retries=0;if(result.more)schedule(5000);}
  }catch{console.error('[script-revalidation] static verification temporarily unavailable');retry();}
 }
 schedule(15000);interval=setInterval(()=>{retries=0;tick();},DAY).unref();
 stopScheduler=()=>{stopped=true;clearTimeout(timer);clearInterval(interval);stopScheduler=null;};return stopScheduler;
}
module.exports={runOnce,startScheduler,inspect,decision};
