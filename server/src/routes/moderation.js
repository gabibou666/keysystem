'use strict';
const express=require('express'),rateLimit=require('express-rate-limit');
const {randomUUID}=require('crypto');
const pool=require('../db'),auth=require('../services/developer-auth'),moderation=require('../services/moderation');
const router=express.Router(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,status,error)=>res.status(status).json({success:false,error});
router.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
router.use(rateLimit({windowMs:60000,max:120,standardHeaders:true,legacyHeaders:false,message:{success:false,error:'Too many requests'}}));
router.use(wrap(async(req,res,next)=>{req.account=await auth.account(req);if(!req.account)return fail(res,401,'Sign in first');req.moderationRole=await moderation.role(req.account.discord_id);next();}));
function staff(req,res,next){if(!['admin','moderator'].includes(req.moderationRole))return fail(res,403,'Moderator access required');next();}
function admin(req,res,next){if(req.moderationRole!=='admin')return fail(res,403,'Administrator access required');next();}
function mutation(req,res,next){
  const expected=new URL(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).origin;
  if(req.get('origin')!==expected||req.get('sec-fetch-site')==='cross-site')return fail(res,403,'Invalid origin');
  if(!req.is('application/json'))return fail(res,415,'JSON required');
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return fail(res,400,'JSON object required');
  if(req.body.note!==undefined&&(typeof req.body.note!=='string'||req.body.note.length>500))return fail(res,400,'Note too long');
  next();
}
const pageOf=req=>{const n=Number(req.query.page||1);return Number.isSafeInteger(n)&&n>0&&n<=10000?n:null;};
async function transaction(fn){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
router.get('/me',(req,res)=>res.json({success:true,role:req.moderationRole,accountId:req.account.discord_id}));
router.get('/overview',staff,wrap(async(req,res)=>{
  const pending=(await pool.query("SELECT count(*) AS total FROM developer_moderation_submissions WHERE status='pending'")).rows[0];
  const reports=(await pool.query("SELECT count(*) AS total FROM developer_moderation_reports WHERE status='open'")).rows[0];
  const quarantined=(await pool.query("SELECT count(*) AS total FROM developer_scripts WHERE safety_status='quarantined'")).rows[0];
  res.json({success:true,pending:Number(pending.total),reports:Number(reports.total),quarantined:Number(quarantined.total)});
}));
router.get('/queue',staff,wrap(async(req,res)=>{
  const page=pageOf(req);if(!page)return fail(res,400,'Invalid page');
  const total=Number((await pool.query("SELECT count(*) AS total FROM developer_moderation_submissions WHERE status='pending'")).rows[0].total);
  const rows=(await pool.query("SELECT id,project_id,base_version,version,build_hash,scanner_version,findings,status,created_at FROM developer_moderation_submissions WHERE status='pending' ORDER BY created_at,id LIMIT 25 OFFSET $1",[(page-1)*25])).rows;
  res.json({success:true,items:rows.map(s=>({id:s.id,projectId:s.project_id,baseVersion:s.base_version,version:s.version,hash:s.build_hash,scannerVersion:s.scanner_version,findings:moderation.findings(s.findings),status:s.status,createdAt:s.created_at})),total,page,pages:Math.ceil(total/25)});
}));
router.post('/submissions/:id/decision',mutation,staff,wrap(async(req,res)=>{
  if(!UUID.test(req.params.id))return fail(res,404,'Submission not found');
  const result=await moderation.decide(req.params.id,req.body.decision,req.account.discord_id,req.body.note);
  if(result.error)return fail(res,result.status,result.error);res.json(result);
}));
router.post('/projects/:id/quarantine',mutation,staff,wrap(async(req,res)=>{
  if(!UUID.test(req.params.id))return fail(res,404,'Project not found');
  if(!Number.isSafeInteger(req.body.expectedVersion)||!/^[a-f0-9]{64}$/.test(req.body.expectedHash||''))return fail(res,400,'Version and hash required');
  const result=await transaction(async db=>{
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.account.discord_id]);
    if(!['moderator','admin'].includes(await moderation.role(req.account.discord_id,db)))return {error:'Moderator access required',status:403};
    await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[req.params.id]);
    const s=(await db.query('SELECT version,build_hash FROM developer_scripts WHERE project_id=$1',[req.params.id])).rows[0];
    if(!s)return {error:'Release not found',status:404};
    if(s.version!==req.body.expectedVersion||s.build_hash!==req.body.expectedHash)return {error:'Release changed. Reload first.',status:409};
    await db.query("UPDATE developer_scripts SET safety_status='quarantined' WHERE project_id=$1",[req.params.id]);
    await db.query("UPDATE developer_listings SET safety_status='quarantined' WHERE project_id=$1",[req.params.id]);
    await moderation.audit(db,{actorId:req.account.discord_id,action:'project.quarantined',projectId:req.params.id,version:s.version,hash:s.build_hash,note:req.body.note});return {success:true};
  });if(result.error)return fail(res,result.status,result.error);res.json(result);
}));
router.post('/reports',mutation,rateLimit({windowMs:3600000,max:10,keyGenerator:req=>req.account.discord_id,standardHeaders:true,legacyHeaders:false}),wrap(async(req,res)=>{
  const {projectId,category,description}=req.body;
  if(!UUID.test(projectId||'')||!['malware','privacy','misleading','other'].includes(category)||description!==undefined&&(typeof description!=='string'||description.length>500))return fail(res,400,'Invalid report');
  const result=await transaction(async db=>{
    const visible=(await db.query('SELECT l.project_id FROM developer_listings l JOIN developer_hubs h ON h.id=l.hub_id WHERE l.project_id=$1 AND l.published_at IS NOT NULL AND h.published_at IS NOT NULL',[projectId])).rows[0];
    if(!visible)return {error:'Published script not found',status:404};
    // Serialize duplicate reports for one account without storing its IP.
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.account.discord_id]);
    const old=(await db.query("SELECT id FROM developer_moderation_reports WHERE project_id=$1 AND reporter_id=$2 AND status='open'",[projectId,req.account.discord_id])).rows[0];
    if(old)return {success:true,id:old.id,duplicate:true};
    const id=randomUUID();await db.query('INSERT INTO developer_moderation_reports(id,project_id,reporter_id,reason,description) VALUES($1,$2,$3,$4,$5)',[id,projectId,req.account.discord_id,category,moderation.privateText(description)]);
    await moderation.audit(db,{actorId:req.account.discord_id,action:'report.created',projectId});return {success:true,id};
  });if(result.error)return fail(res,result.status,result.error);res.json(result);
}));
router.get('/reports',staff,wrap(async(req,res)=>{
  const page=pageOf(req),status=req.query.status||'open';if(!page||!['open','resolved'].includes(status))return fail(res,400,'Invalid report filter');
  const total=Number((await pool.query('SELECT count(*) AS total FROM developer_moderation_reports WHERE status=$1',[status])).rows[0].total);
  const rows=(await pool.query('SELECT id,project_id,reason,description,status,created_at FROM developer_moderation_reports WHERE status=$1 ORDER BY created_at,id LIMIT 25 OFFSET $2',[status,(page-1)*25])).rows;
  res.json({success:true,items:rows.map(r=>({id:r.id,projectId:r.project_id,category:r.reason,status:r.status,description:r.description,createdAt:r.created_at})),total,page,pages:Math.ceil(total/25)});
}));
router.post('/reports/:id/resolve',mutation,staff,wrap(async(req,res)=>{
  if(!UUID.test(req.params.id))return fail(res,404,'Report not found');
  const result=await transaction(async db=>{
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.account.discord_id]);
    if(!['moderator','admin'].includes(await moderation.role(req.account.discord_id,db)))return {error:'Moderator access required',status:403};
    const report=(await db.query('SELECT id,project_id,status FROM developer_moderation_reports WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!report)return {error:'Report not found',status:404};
    if(report.status==='resolved')return {success:true};
    await db.query("UPDATE developer_moderation_reports SET status='resolved',resolution_note=$2,resolved_at=now() WHERE id=$1",[report.id,moderation.privateText(req.body.note)]);
    await moderation.audit(db,{actorId:req.account.discord_id,action:'report.resolved',projectId:report.project_id,note:req.body.note});return {success:true};
  });if(result.error)return fail(res,result.status,result.error);res.json(result);
}));
router.get('/audit',staff,wrap(async(req,res)=>{
  const page=pageOf(req),action=req.query.action||null;if(!page||action&&!moderation.ACTIONS.has(action))return fail(res,400,'Invalid audit filter');
  const clause=action?' WHERE action=$1':'',args=action?[action]:[];
  const total=Number((await pool.query('SELECT count(*) AS total FROM developer_moderation_audit'+clause,args)).rows[0].total);
  const rows=(await pool.query('SELECT id,actor_id,action,project_id,version,build_hash,rule_ids,status_code,action_note,subject_id,role_value,created_at FROM developer_moderation_audit'+clause+` ORDER BY created_at DESC,id LIMIT 50 OFFSET $${args.length+1}`,[...args,(page-1)*50])).rows;
  res.json({success:true,items:rows.map(r=>({id:r.id,actorId:r.actor_id,action:r.action,projectId:r.project_id,version:r.version,hash:r.build_hash,details:{rules:r.rule_ids,statusCode:r.status_code,note:r.action_note,subjectId:r.subject_id,role:r.role_value},createdAt:r.created_at})),total,page,pages:Math.ceil(total/50)});
}));
router.put('/accounts/:id/role',mutation,admin,wrap(async(req,res)=>{
  const nextRole=req.body.role;
  if(!['user','moderator','admin'].includes(nextRole)||req.params.id.length>255)return fail(res,400,'Invalid role');
  const result=await transaction(async db=>{
    // A revocation cannot race this authorization decision. Use consistent account lock order.
    // A common account lock serializes administrator-count checks across independent targets.
    await db.query('SELECT discord_id FROM developer_accounts ORDER BY discord_id LIMIT 1 FOR UPDATE');
    for(const accountId of [...new Set([req.account.discord_id,req.params.id])].sort())await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[accountId]);
    if(await moderation.role(req.account.discord_id,db)!=='admin')return {error:'Administrator access required',status:403};
    if(moderation.isBootstrapAdmin(req.params.id)&&nextRole!=='admin')return {error:'This administrator is managed by server configuration',status:409};
    const target=(await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!target)return {error:'Account not found',status:404};
    if(nextRole!=='admin'&&!moderation.hasBootstrapAdmin()&&await moderation.role(target.discord_id,db)==='admin'){
      const remaining=Number((await db.query("SELECT count(*) AS total FROM developer_moderation_roles WHERE role='admin'")).rows[0].total);
      if(remaining<=1)return {error:'At least one administrator must remain',status:409};
    }
    if(nextRole==='user')await db.query('DELETE FROM developer_moderation_roles WHERE account_id=$1',[target.discord_id]);
    else await db.query('INSERT INTO developer_moderation_roles(account_id,role) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET role=$2,updated_at=now()',[target.discord_id,nextRole]);
    await moderation.audit(db,{actorId:req.account.discord_id,action:'role.updated',subjectId:target.discord_id,role:nextRole});return {success:true};
  });if(result.error)return fail(res,result.status,result.error);res.json(result);
}));
module.exports=router;
