'use strict';
const pool=require('../db');
const {randomUUID}=require('crypto');
const ACTIONS=new Set(['bot.settings_updated','upload.clear','upload.review','upload.blocked','submission.approved','submission.rejected','submission.stale','project.quarantined','report.created','report.resolved','role.updated','auth.signup','auth.verified','auth.login','auth.logout','auth.reset','project.created','project.updated','project.token_rotated','license.issued','license.revoked','license.restored','license.device_reset','checkpoint.updated','checkpoint.start','checkpoint.complete','checkpoint.failed','listing.published','listing.unpublished','profile.updated','key_ui.updated']);
function privateText(value){
  if(typeof value!=='string')return '';
  return value.slice(0,500).replace(/https?:\/\/[^\s<>]+/gi,'[link removed]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email removed]').replace(/\b(?:ahp?_[a-zA-Z0-9_-]+|[a-f0-9]{32,})\b/gi,'[credential removed]').replace(/\b(?:token|secret|password|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,'[credential removed]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
}
function admins(){return new Set(String(process.env.MODERATION_ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));}
async function role(accountId,db=pool){
  if(!accountId)return 'user';
  if(admins().has(accountId))return 'admin';
  return (await db.query('SELECT role FROM developer_moderation_roles WHERE account_id=$1',[accountId])).rows[0]?.role||'user';
}
function findings(items){return (Array.isArray(items)?items:[]).slice(0,100).map(x=>({rule:/^[a-zA-Z0-9_.-]{1,80}$/.test(x.rule)?x.rule:'unknown',severity:['info','review','high'].includes(x.severity)?x.severity:'review',line:Number.isSafeInteger(x.line)&&x.line>0?x.line:null}));}
async function audit(db,event){
  if(!ACTIONS.has(event.action))throw new Error('Invalid audit action');
  const hash=/^[a-f0-9]{64}$/.test(event.hash||'')?event.hash:null;
  await db.query('INSERT INTO developer_moderation_audit(id,actor_id,action,project_id,version,build_hash,rule_ids,status_code,action_note,subject_id,role_value) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)',[randomUUID(),event.actorId||null,event.action,event.projectId||null,Number.isSafeInteger(event.version)?event.version:null,hash,JSON.stringify(findings(event.findings).map(x=>x.rule)),Number.isInteger(event.statusCode)&&event.statusCode>=100&&event.statusCode<=599?event.statusCode:null,privateText(event.note),typeof event.subjectId==='string'&&event.subjectId.length<=255?event.subjectId:null,['user','moderator','admin'].includes(event.role)?event.role:null]);
}
async function stage(db,project,build,scan,actorId){
  if(scan.status!=='review')throw new Error('Only review candidates can enter the queue');
  const id=randomUUID();
  await db.query(`INSERT INTO developer_moderation_submissions(id,project_id,owner_id,base_version,base_hash,version,content_enc,content_iv,build_hash,target_mode,place_id,builder_version,scanner_version,findings,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'pending')`,[id,project.id,actorId,project.version||0,project.build_hash||null,(project.version||0)+1,build.content_enc,build.content_iv,build.build_hash,build.target_mode,build.place_id||null,build.builder_version,scan.scannerVersion,JSON.stringify(findings(scan.findings))]);
  await audit(db,{actorId,action:'upload.review',projectId:project.id,version:(project.version||0)+1,hash:build.build_hash,findings:scan.findings});
  return id;
}
function approved(status){return status==='clear'||status==='approved';}
async function deliveryAllowed(projectId,version,hash,db=pool){
  const row=(await db.query('SELECT safety_status,safety_hash,version FROM developer_scripts WHERE project_id=$1',[projectId])).rows[0];
  return !!row&&approved(row.safety_status)&&row.version===version&&row.safety_hash===hash;
}
async function snapshotAllowed(projectId,status,hash,db=pool){
  const row=(await db.query('SELECT safety_status FROM developer_scripts WHERE project_id=$1',[projectId])).rows[0];
  return !!row&&row.safety_status!=='quarantined'&&approved(status)&&/^[a-f0-9]{64}$/.test(hash||'');
}
async function decide(id,decision,actorId,note){
  if(!['approve','reject'].includes(decision))return {error:'Invalid decision',status:400};
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[actorId]);
    const actorRole=await role(actorId,db);
    if(!['moderator','admin'].includes(actorRole)){await db.query('ROLLBACK');return {error:'Moderator access required',status:403};}
    const lookup=(await db.query('SELECT project_id FROM developer_moderation_submissions WHERE id=$1',[id])).rows[0];
    if(!lookup){await db.query('ROLLBACK');return {error:'Submission not found',status:404};}
    await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[lookup.project_id]);
    const s=(await db.query('SELECT * FROM developer_moderation_submissions WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(actorRole!=='admin'&&s.owner_id===actorId){await db.query('ROLLBACK');return {error:'Another moderator must review your release',status:403};}
    if(s.status!=='pending'){await db.query('ROLLBACK');return {error:'Submission already decided',status:409};}
    const current=(await db.query('SELECT version,build_hash FROM developer_scripts WHERE project_id=$1',[s.project_id])).rows[0];
    let state=decision==='reject'?'rejected':'approved';
    if(decision==='approve'&&((current?.version||0)!==s.base_version||(current?.build_hash||null)!==s.base_hash))state='stale';
    if(state==='approved'){
      await db.query(`INSERT INTO developer_scripts(project_id,content_enc,content_iv,version,validated,obfuscated,target_mode,place_id,builder_version,build_hash,safety_status,safety_hash,scanner_version)
       VALUES($1,$2,$3,$4,true,true,$5,$6,$7,$8,'approved',$8,$9)
       ON CONFLICT(project_id) DO UPDATE SET content_enc=$2,content_iv=$3,version=$4,validated=true,obfuscated=true,target_mode=$5,place_id=$6,builder_version=$7,build_hash=$8,safety_status='approved',safety_hash=$8,scanner_version=$9,updated_at=now()`,[s.project_id,s.content_enc,s.content_iv,s.version,s.target_mode,s.place_id,s.builder_version,s.build_hash,s.scanner_version]);
    }
    await db.query('UPDATE developer_moderation_submissions SET status=$2,content_enc=NULL,content_iv=NULL,decision_note=$3,decided_at=now() WHERE id=$1',[id,state,privateText(note)]);
    await audit(db,{actorId,action:'submission.'+state,projectId:s.project_id,version:s.version,hash:s.build_hash,findings:s.findings,note});
    await db.query('COMMIT');return state==='stale'?{error:'Active release changed. Upload again.',status:409}:{success:true,status:state};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
module.exports={role,audit,stage,decide,deliveryAllowed,snapshotAllowed,approved,findings,privateText,ACTIONS,isBootstrapAdmin:id=>admins().has(id),hasBootstrapAdmin:()=>admins().size>0};
