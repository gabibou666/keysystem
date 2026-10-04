'use strict';
const pool=require('../db');
const {randomUUID}=require('crypto');
const ACTIONS=new Set(['script.rechecked','bot.settings_updated','account.deleted','upload.clear','upload.review','upload.blocked','submission.approved','submission.rejected','submission.stale','project.quarantined','report.created','report.resolved','role.updated','auth.signup','auth.verified','auth.login','auth.logout','auth.reset','project.created','project.updated','project.token_rotated','license.issued','license.revoked','license.restored','license.device_reset','checkpoint.updated','checkpoint.start','checkpoint.complete','checkpoint.failed','listing.published','listing.unpublished','profile.updated','key_ui.updated']);
function privateText(value){
  if(typeof value!=='string')return '';
  return value.slice(0,500).replace(/https?:\/\/[^\s<>]+/gi,'[link removed]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email removed]').replace(/\b(?:ahp?_[a-zA-Z0-9_-]+|[a-f0-9]{32,})\b/gi,'[credential removed]').replace(/\b(?:token|secret|password|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,'[credential removed]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
}
async function lockAdminChanges(db){return require('./staff-access').lockAdminChanges(db);}
async function role(accountId,db=pool){
  const current=await require('./staff-access').role(accountId,db);
  return ['OWNER','CO_OWNER','ADMIN'].includes(current)?'admin':current==='MODERATOR'?'moderator':'user';
}
function findings(items){return (Array.isArray(items)?items:[]).slice(0,100).map(x=>({rule:/^[a-zA-Z0-9_.-]{1,80}$/.test(x.rule)?x.rule:'unknown',severity:['info','review','high'].includes(x.severity)?x.severity:'review',line:Number.isSafeInteger(x.line)&&x.line>0?x.line:null}));}
async function audit(db,event){
  if(!ACTIONS.has(event.action))throw new Error('Invalid audit action');
  const hash=/^[a-f0-9]{64}$/.test(event.hash||'')?event.hash:null;
  const erased="($2::text IS NOT NULL AND actor.actor_ref IS NULL) OR ($4::uuid IS NOT NULL AND project.project_ref IS NULL) OR ($10::text IS NOT NULL AND subject.subject_ref IS NULL)";
  await db.query(`INSERT INTO developer_moderation_audit(id,actor_id,action,project_id,version,build_hash,rule_ids,status_code,action_note,subject_id,role_value)
    SELECT $1,actor.actor_ref,$3,project.project_ref,CASE WHEN ${erased} THEN NULL ELSE $5::integer END,CASE WHEN ${erased} THEN NULL ELSE $6::text END,$7::jsonb,$8::integer,CASE WHEN ${erased} THEN '' ELSE $9::text END,subject.subject_ref,CASE WHEN ${erased} THEN NULL ELSE $11::text END
    FROM (SELECT 1 AS anchor) base LEFT JOIN (SELECT discord_id AS actor_ref FROM developer_accounts) actor ON actor.actor_ref=$2 LEFT JOIN (SELECT id AS project_ref FROM developer_projects) project ON project.project_ref=$4 LEFT JOIN (SELECT discord_id AS subject_ref FROM developer_accounts) subject ON subject.subject_ref=$10`,[randomUUID(),event.actorId||null,event.action,event.projectId||null,Number.isSafeInteger(event.version)?event.version:null,hash,JSON.stringify(findings(event.findings).map(x=>x.rule)),Number.isInteger(event.statusCode)&&event.statusCode>=100&&event.statusCode<=599?event.statusCode:null,privateText(event.note),typeof event.subjectId==='string'&&event.subjectId.length<=255?event.subjectId:null,['user','moderator','admin'].includes(event.role)?event.role:null]);
}
async function stage(){
  throw Object.assign(new Error('Human review submissions are disabled. Submit readable source for automatic verification.'),{status:409,code:'AUTOMATIC_VERIFICATION_ONLY'});
}
function approved(status){return status==='clear';}
async function recordAutomaticClear(db,projectId,kind,version,hash,items=[]){
  if(!['current','free_snapshot'].includes(kind)||!Number.isSafeInteger(version)||version<1||!/^[a-f0-9]{64}$/.test(hash||''))throw new Error('Invalid automatic scan proof');
  await db.query(`INSERT INTO developer_script_revalidation(project_id,target_kind,content_version,content_hash,scanner_version,checked_at,result,findings)
   VALUES($1,$2,$3,$4,$5,now(),'clear',$6::jsonb) ON CONFLICT(project_id,target_kind) DO UPDATE SET content_version=$3,content_hash=$4,scanner_version=$5,checked_at=now(),result='clear',findings=$6::jsonb`,
   [projectId,kind,version,hash,require('./script-safety').SCANNER_VERSION,JSON.stringify(findings(items))]);
}
async function deliveryAllowed(projectId,version,hash,db=pool){
  const row=(await db.query(`SELECT s.safety_status,s.safety_hash,s.build_hash,s.version,s.validated,s.scanner_version,
    r.result AS proof_result,r.content_version AS proof_version,r.content_hash AS proof_hash,r.scanner_version AS proof_scanner
    FROM developer_scripts s LEFT JOIN developer_script_revalidation r ON r.project_id=s.project_id AND r.target_kind='current' WHERE s.project_id=$1`,[projectId])).rows[0];
  const scanner=require('./script-safety').SCANNER_VERSION;
  return !!row&&approved(row.safety_status)&&row.validated===true&&row.version===version&&row.safety_hash===hash&&row.build_hash===hash&&row.scanner_version===scanner
    &&row.proof_result==='clear'&&row.proof_version===version&&row.proof_hash===hash&&row.proof_scanner===scanner;
}
async function snapshotAllowed(projectId,status,hash,db=pool){
  if(!approved(status)||!/^[a-f0-9]{64}$/.test(hash||''))return false;
  const row=(await db.query(`SELECT s.safety_status AS current_status,l.safety_status,l.safety_hash,l.script_version,l.snapshot_validated,
    r.result,r.content_version,r.content_hash,r.scanner_version FROM developer_listings l JOIN developer_scripts s ON s.project_id=l.project_id
    LEFT JOIN developer_script_revalidation r ON r.project_id=l.project_id AND r.target_kind='free_snapshot' WHERE l.project_id=$1 AND l.access_mode='free' AND l.published_at IS NOT NULL`,[projectId])).rows[0];
  return !!row&&row.current_status!=='quarantined'&&approved(row.safety_status)&&row.snapshot_validated===true&&row.safety_hash===hash
    &&row.result==='clear'&&row.content_version===row.script_version&&row.content_hash===hash&&row.scanner_version===require('./script-safety').SCANNER_VERSION;
}
async function decide(id,decision,actorId,note,request){
  if(!['approve','reject'].includes(decision))return {error:'Invalid decision',status:400};
  if(decision==='approve')return {error:'Human approval is unavailable. Submit readable source for automatic verification.',code:'AUTOMATIC_VERIFICATION_ONLY',status:409};
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await lockAdminChanges(db);
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[actorId]);
    const access=require('./staff-access'),actor=await access.getStaff(actorId,db);
    const actorRole=actor.role;
    if(!actor.active||!access.isStaff(actorRole)){await db.query('ROLLBACK');return {error:'Moderator access required',status:403};}
    const lookup=(await db.query('SELECT project_id FROM developer_moderation_submissions WHERE id=$1',[id])).rows[0];
    if(!lookup){await db.query('ROLLBACK');return {error:'Submission not found',status:404};}
    const owner=(await db.query('SELECT owner_id FROM developer_projects WHERE id=$1',[lookup.project_id])).rows[0];
    if(!owner){await db.query('ROLLBACK');return {error:'Project not found',status:404};}
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[owner.owner_id]);
    if(!access.canAct(actorRole,await access.role(owner.owner_id,db))){await db.query('ROLLBACK');return {error:'You can act only on roles strictly below your own.',status:403};}
    await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[lookup.project_id]);
    const s=(await db.query('SELECT * FROM developer_moderation_submissions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!s){await db.query('ROLLBACK');return {error:'Submission not found',status:404};}
    if(s.status!=='pending'){await db.query('ROLLBACK');return {error:'Submission already decided',status:409};}
    let state='rejected';
    if(s.job_id)state=await require('./publication-queue').reviewDecision(db,s,state);
    await db.query('UPDATE developer_moderation_submissions SET status=$2,content_enc=NULL,content_iv=NULL,decision_note=$3,decided_at=now() WHERE id=$1',[id,state,privateText(note)]);
    await audit(db,{actorId,action:'submission.'+state,projectId:s.project_id,version:s.version,hash:s.build_hash,findings:s.findings,note});
    await access.audit(db,{actorId,actorRole,action:'submission.'+state,targetType:'project',targetId:s.project_id,reason:privateText(note),before:{version:s.base_version},after:{version:s.version,status:state},ip:request?.ip||''});
    await db.query('COMMIT');return state==='stale'?{error:'Active release changed. Upload again.',status:409}:{success:true,status:state};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
module.exports={role,audit,stage,decide,recordAutomaticClear,deliveryAllowed,snapshotAllowed,approved,findings,privateText,ACTIONS,lockAdminChanges,isBootstrapAdmin:id=>new Set(String(process.env.MODERATION_ADMIN_IDS||'').split(',').map(x=>x.trim())).has(id),hasBootstrapAdmin:()=>!!String(process.env.MODERATION_ADMIN_IDS||'').trim()};
