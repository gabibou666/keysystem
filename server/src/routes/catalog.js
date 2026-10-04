'use strict';
const express=require('express'),rateLimit=require('express-rate-limit');
const pool=require('../db'),auth=require('../services/developer-auth'),crypto=require('../services/crypto');
const {randomUUID}=require('crypto');
const scriptJobs=require('../services/publication-queue');
const profileFields=require('../services/public-profile').fields;
const moderation=require('../services/moderation');
const metrics=require('../services/script-metrics');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,status,error)=>res.status(status).json({success:false,error});
const origin=req=>(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
const hubColumns='h.id,h.slug,h.name,h.description,h.discord_url,h.website_url,h.avatar_theme,h.created_at,h.published_at,h.updated_at,a.username AS author';
const checkpointConfiguredSql=`CASE COALESCE(p.checkpoint_provider,'lootlabs')
  WHEN 'lootlabs' THEN p.lootlabs_token_enc IS NOT NULL AND length(p.lootlabs_token_enc)>0
  WHEN 'workink' THEN p.checkpoint_link_url IS NOT NULL AND length(p.checkpoint_link_url)>0 AND p.checkpoint_link_id IS NOT NULL AND length(p.checkpoint_link_id)>0
  WHEN 'linkvertise' THEN p.checkpoint_link_url IS NOT NULL AND length(p.checkpoint_link_url)>0 AND p.checkpoint_token_enc IS NOT NULL AND length(p.checkpoint_token_enc)>0
  WHEN 'linkunlocker' THEN p.checkpoint_link_url IS NOT NULL AND length(p.checkpoint_link_url)>0 AND p.checkpoint_token_enc IS NOT NULL AND length(p.checkpoint_token_enc)>0
  ELSE false END`;
const listingColumns=`l.project_id,l.title,l.description,l.game,l.access_mode,l.mobile_support,l.published_at,l.updated_at,h.discord_url,
  COALESCE(m.views,0) AS views,COALESCE(m.executions,0) AS executions,
  CASE WHEN l.access_mode='licensed' THEN s.version ELSE l.script_version END AS script_version,
  CASE WHEN l.access_mode='licensed' THEN s.target_mode ELSE l.target_mode END AS target_mode,
  CASE WHEN l.access_mode='licensed' THEN s.place_id ELSE l.place_id END AS place_id,
  CASE WHEN l.access_mode='licensed' THEN COALESCE(s.validated,false) ELSE l.snapshot_validated END AS snapshot_validated,
  CASE WHEN l.access_mode='licensed' THEN COALESCE(s.obfuscated,false) ELSE l.snapshot_obfuscated END AS snapshot_obfuscated,
  CASE WHEN l.access_mode='licensed' THEN s.safety_status ELSE l.safety_status END AS security_status,
  p.key_ui_mode,h.slug AS hub_slug,h.name AS hub_name,a.username AS author,${checkpointConfiguredSql} AS checkpoints_configured`;
const joinListings='FROM developer_listings l JOIN developer_hubs h ON h.id=l.hub_id JOIN developer_accounts a ON a.discord_id=h.owner_id JOIN developer_projects p ON p.id=l.project_id LEFT JOIN developer_scripts s ON s.project_id=p.id LEFT JOIN developer_script_metrics m ON m.project_id=p.id';
const publisherActive="a.banned_at IS NULL AND (a.suspended_until IS NULL OR a.suspended_until<=now())";
const projectActive="p.disabled=false AND p.hidden=false AND p.deleted_at IS NULL AND s.disabled=false AND s.deleted_at IS NULL";
const publicListing=`l.published_at IS NOT NULL AND h.published_at IS NOT NULL AND l.snapshot_validated=true AND l.safety_status IN ('clear','approved') AND s.safety_status IN ('clear','approved') AND ${publisherActive} AND ${projectActive}`;
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(rateLimit({windowMs:60000,max:120,standardHeaders:true,legacyHeaders:false,message:{success:false,error:'Too many requests. Try again in a minute.'}}));
const owner=wrap(async(req,res,next)=>{
  req.account=await auth.account(req);if(!req.account)return fail(res,401,'Sign in to your developer account to continue.');next();
});
function sameOrigin(req,res,next){
  if(!req.is('application/json'))return fail(res,415,'JSON required');
  if((req.get('origin')&&req.get('origin')!==new URL(origin(req)).origin)||req.get('sec-fetch-site')==='cross-site')return fail(res,403,'Invalid origin');
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return fail(res,400,'A JSON object is required.');next();
}
const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0);
function hubView(row){return {id:row.id,slug:row.slug,name:row.name,description:row.description,author:row.author,discordUrl:row.discord_url||null,websiteUrl:row.website_url||null,avatarTheme:row.avatar_theme||'orbit',joinedAt:row.created_at,scriptCount:row.script_count||0,published:!!row.published_at,publishedAt:row.published_at,updatedAt:row.updated_at};}
function listingView(row,req){
  const base=origin(req),free=row.access_mode==='free';
  return {projectId:row.project_id,hubSlug:row.hub_slug,hubName:row.hub_name,author:row.author,title:row.title,description:row.description,game:row.target_mode==='universal'?'Universal':row.game,accessMode:row.access_mode,published:!!row.published_at,publishedAt:row.published_at,updatedAt:row.updated_at,scriptVersion:row.script_version,
    ...metrics.view(row),mobileSupport:row.mobile_support||'unknown',hasKeySystem:!free,discordUrl:row.discord_url||null,securityStatus:row.security_status,
    ...(free?{}:{keyUiMode:row.key_ui_mode||'custom'}),
    targetMode:row.target_mode,placeId:row.place_id?Number(row.place_id):null,validated:row.snapshot_validated,obfuscated:row.snapshot_obfuscated,
    checkpointsConfigured:!!row.checkpoints_configured,loaderUrl:free?`${base}/api/catalog/scripts/${row.project_id}/source`:`${base}/api/platform/v1/loader/${row.project_id}`,claimUrl:!free&&row.checkpoints_configured?`${base}/claim?project=${row.project_id}`:null};
}
router.get('/me',owner,wrap(async(req,res)=>{
  const hub=(await pool.query(`SELECT ${hubColumns} FROM developer_hubs h JOIN developer_accounts a ON a.discord_id=h.owner_id WHERE h.owner_id=$1`,[req.account.discord_id])).rows[0];
  const listings=hub?(await pool.query(`SELECT ${listingColumns} ${joinListings} WHERE h.owner_id=$1 ORDER BY l.updated_at DESC`,[req.account.discord_id])).rows:[];
  res.json({success:true,hub:hub?hubView({...hub,script_count:listings.filter(l=>l.published_at).length}):null,listings:listings.map(l=>listingView(l,req))});
}));
router.put('/me',sameOrigin,owner,wrap(async(req,res)=>{
  const {name,slug,description,published}=req.body;
  let profile;
  try{profile=profileFields(req.body);}catch{return fail(res,400,'Enter a valid HTTPS website, Discord invite and profile theme.');}
  if(!text(name,80,true)||typeof slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length<3||slug.length>48||!text(description,1000)||typeof published!=='boolean')return fail(res,400,'Enter a hub name, a slug of 3–48 lowercase letters, numbers or hyphens, and a description up to 1000 characters.');
  const client=await pool.connect();
  try{
  await client.query('BEGIN');
  const account=(await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.account.discord_id])).rows[0];
  if(!account){await client.query('ROLLBACK');return fail(res,401,'Sign in again to continue.');}
  const row=(await client.query(`INSERT INTO developer_hubs(id,owner_id,slug,name,description,published_at,discord_url,website_url,avatar_theme) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(owner_id) DO UPDATE SET slug=$3,name=$4,description=$5,published_at=CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE COALESCE(developer_hubs.published_at,$6) END,discord_url=$7,website_url=$8,avatar_theme=$9,auto_profile=false,updated_at=now() RETURNING id,slug,name,description,discord_url,website_url,avatar_theme,created_at,published_at,updated_at`,[randomUUID(),req.account.discord_id,slug,name.trim(),description,published?new Date():null,profile.discordUrl,profile.websiteUrl,profile.avatarTheme])).rows[0];
  await moderation.audit(client,{action:'profile.updated',actorId:req.account.discord_id});
  await client.query('COMMIT');res.json({success:true,hub:hubView({...row,author:req.account.username})});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.put('/projects/:projectId',sameOrigin,owner,wrap(async(req,res)=>{
  const {title,description,game,accessMode,published}=req.body;
  const mobileSupport=req.body.mobileSupport===undefined?'unknown':req.body.mobileSupport;
  if(!['yes','no','unknown'].includes(mobileSupport))return fail(res,400,'Choose a mobile compatibility declaration.');
  if(!UUID.test(req.params.projectId))return fail(res,404,'Project not found.');
  if(!text(title,80,true)||!text(description,2000)||!text(game,100)||!['licensed','free'].includes(accessMode)||typeof published!=='boolean')return fail(res,400,'Enter valid listing details and an access mode.');
  if(published){
    const project=(await pool.query('SELECT id FROM developer_projects WHERE id=$1 AND owner_id=$2',[req.params.projectId,req.account.discord_id])).rows[0];
    if(!project)return fail(res,404,'Project not found.');
    const job=await scriptJobs.enqueue({projectId:project.id,ownerId:req.account.discord_id,body:req.body,publication:{title:title.trim(),description,game:game.trim(),accessMode,mobileSupport}});
    return res.status(202).json({success:true,queued:true,jobId:job.id,job});
  }
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize creation of the optional author profile for this developer.
    const account=(await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[req.account.discord_id])).rows[0];
    if(!account){await client.query('ROLLBACK');return fail(res,401,'Sign in again to continue.');}
    let hub=(await client.query('SELECT id,auto_profile,published_at FROM developer_hubs WHERE owner_id=$1 FOR UPDATE',[req.account.discord_id])).rows[0];
    const project=(await client.query('SELECT id,disabled,hidden,deleted_at FROM developer_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE',[req.params.projectId,req.account.discord_id])).rows[0];
    if(!project){await client.query('ROLLBACK');return fail(res,404,'Project not found.');}
    if(project.disabled || project.hidden || project.deleted_at){await client.query('ROLLBACK');return fail(res,403,'This publication was restricted by the site team. Contact support.');}
    const script=(await client.query('SELECT content_enc,content_iv,version,validated,obfuscated,target_mode,place_id,safety_status,safety_hash FROM developer_scripts WHERE project_id=$1',[project.id])).rows[0];
    if(published&&!script){await client.query('ROLLBACK');return fail(res,400,'Upload a script before publishing this listing.');}
    if(published&&!moderation.approved(script.safety_status)){await client.query('ROLLBACK');return fail(res,409,'This release is held for moderation.');}
    if(!hub){
      const id=randomUUID();
      hub=(await client.query(`INSERT INTO developer_hubs(id,owner_id,slug,name,description,published_at,auto_profile) VALUES($1,$2,$3,$4,'',$5,true)
        ON CONFLICT(owner_id) DO NOTHING RETURNING id,auto_profile,published_at`,[id,req.account.discord_id,'creator-'+id,String(req.account.username||'Developer').slice(0,80),published?new Date():null])).rows[0];
      if(!hub)hub=(await client.query('SELECT id,auto_profile,published_at FROM developer_hubs WHERE owner_id=$1 FOR UPDATE',[req.account.discord_id])).rows[0];
    }
    if(published&&hub.auto_profile&&!hub.published_at)await client.query('UPDATE developer_hubs SET published_at=$1,updated_at=now() WHERE id=$2',[new Date(),hub.id]);
    await client.query(`INSERT INTO developer_listings(project_id,hub_id,title,description,game,access_mode,published_at,snapshot_content_enc,snapshot_content_iv,script_version,snapshot_validated,snapshot_obfuscated,target_mode,place_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(project_id) DO UPDATE SET hub_id=$2,title=$3,description=$4,game=$5,access_mode=$6,
      published_at=CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE COALESCE(developer_listings.published_at,$7) END,snapshot_content_enc=$8,snapshot_content_iv=$9,script_version=$10,snapshot_validated=$11,snapshot_obfuscated=$12,target_mode=$13,place_id=$14,updated_at=now()`,
      [project.id,hub.id,title.trim(),description,script?.target_mode==='single'?game.trim():'Universal',accessMode,published?new Date():null,script?.content_enc||null,script?.content_iv||null,script?.version||null,!!script?.validated,!!script?.obfuscated,script?.target_mode||'universal',script?.place_id||null]);
    await client.query('UPDATE developer_listings SET mobile_support=$1,safety_status=$2,safety_hash=$3 WHERE project_id=$4',[mobileSupport,script?.safety_status||'unreviewed',script?.safety_hash||null,project.id]);
    await moderation.audit(client,{action:published?'listing.published':'listing.unpublished',actorId:req.account.discord_id,projectId:project.id,version:script?.version,hash:script?.safety_hash});
    const listing=(await client.query(`SELECT ${listingColumns} ${joinListings} WHERE l.project_id=$1`,[project.id])).rows[0];
    await client.query('COMMIT');res.json({success:true,listing:listingView(listing,req)});
  } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
router.get('/hubs',wrap(async(req,res)=>{
  const page=Number(req.query.page||1),q=req.query.q||'',sort=req.query.sort||'recent';
  if(!Number.isSafeInteger(page)||page<1||page>10000||typeof q!=='string'||q.length>100||!['recent','name'].includes(sort))return fail(res,400,'Invalid catalogue search or page.');
  // Escape LIKE wildcards so a user search is treated as literal text.
  const query='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  const eligible=`l.published_at IS NOT NULL AND l.snapshot_validated=true AND l.safety_status IN ('clear','approved') AND s.safety_status IN ('clear','approved') AND ${projectActive}`;
  const eligibleFrom='FROM developer_listings l JOIN developer_scripts s ON s.project_id=l.project_id JOIN developer_projects p ON p.id=l.project_id';
  const where=`h.published_at IS NOT NULL AND ${publisherActive} AND (h.name ILIKE $1 OR h.description ILIKE $1 OR a.username ILIKE $1 OR h.id IN (SELECT l.hub_id ${eligibleFrom} WHERE ${eligible} AND l.game ILIKE $1))`;
  const total=(await pool.query(`SELECT count(*)::int AS total FROM developer_hubs h JOIN developer_accounts a ON a.discord_id=h.owner_id WHERE ${where}`,[query])).rows[0].total;
  const order=sort==='name'?'h.name ASC,h.id':'h.published_at DESC,h.id';
  const hubs=(await pool.query(`SELECT ${hubColumns},COALESCE(counts.script_count,0) AS script_count FROM developer_hubs h JOIN developer_accounts a ON a.discord_id=h.owner_id
    LEFT JOIN (SELECT l.hub_id,count(*)::int AS script_count ${eligibleFrom} WHERE ${eligible} GROUP BY l.hub_id) counts ON counts.hub_id=h.id
    WHERE ${where} ORDER BY ${order} LIMIT 24 OFFSET $2`,[query,(page-1)*24])).rows;
  res.json({success:true,hubs:hubs.map(hubView),page,total,pages:Math.ceil(total/24)});
}));
router.get('/hubs/:slug',wrap(async(req,res)=>{
  if(typeof req.params.slug!=='string'||req.params.slug.length>60)return fail(res,404,'Hub not found.');
  const hub=(await pool.query(`SELECT ${hubColumns} FROM developer_hubs h JOIN developer_accounts a ON a.discord_id=h.owner_id WHERE h.slug=$1 AND h.published_at IS NOT NULL AND ${publisherActive}`,[req.params.slug])).rows[0];
  if(!hub)return fail(res,404,'Hub not found.');
  const listings=(await pool.query(`SELECT ${listingColumns} ${joinListings} WHERE h.id=$1 AND ${publicListing} ORDER BY l.published_at DESC,l.project_id`,[hub.id])).rows;
  res.json({success:true,hub:hubView({...hub,script_count:listings.length}),listings:listings.map(l=>listingView(l,req))});
}));
router.get('/scripts',wrap(async(req,res)=>{
  const page=Number(req.query.page||1),q=req.query.q||'',sort=req.query.sort||'recent';
  if(!Number.isSafeInteger(page)||page<1||page>10000||typeof q!=='string'||q.length>100||!['recent','name'].includes(sort))return fail(res,400,'Invalid catalogue search or page.');
  const query='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  const where=`${publicListing} AND (l.title ILIKE $1 OR l.description ILIKE $1 OR l.game ILIKE $1 OR a.username ILIKE $1)`;
  const total=(await pool.query(`SELECT count(*)::int AS total ${joinListings} WHERE ${where}`,[query])).rows[0].total;
  const order=sort==='name'?'l.title ASC,l.project_id':'l.published_at DESC,l.project_id';
  const listings=(await pool.query(`SELECT ${listingColumns} ${joinListings} WHERE ${where} ORDER BY ${order} LIMIT 24 OFFSET $2`,[query,(page-1)*24])).rows;
  res.json({success:true,listings:listings.map(l=>listingView(l,req)),page,total,pages:Math.ceil(total/24)});
}));
router.get('/scripts/:projectId',wrap(async(req,res)=>{
  if(!UUID.test(req.params.projectId))return fail(res,404,'Script not found.');
  const listing=(await pool.query(`SELECT ${listingColumns} ${joinListings} WHERE l.project_id=$1 AND ${publicListing}`,[req.params.projectId])).rows[0];
  if(!listing)return fail(res,404,'Script not found.');res.json({success:true,listing:listingView(listing,req)});
}));
router.post('/scripts/:projectId/view',sameOrigin,wrap(async(req,res)=>{
  if(req.get('origin')!==new URL(origin(req)).origin)return fail(res,403,'Invalid origin');
  if(!UUID.test(req.params.projectId))return fail(res,404,'Script not found.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR KEY SHARE',[req.params.projectId]);
    const listing=(await client.query(`SELECT l.project_id ${joinListings} WHERE l.project_id=$1 AND ${publicListing}`,[req.params.projectId])).rows[0];
    if(!listing){await client.query('ROLLBACK');return fail(res,404,'Script not found.');}
    await metrics.record(client,listing.project_id,'views',metrics.visitorReceipt(req,listing.project_id));
    const counts=(await client.query('SELECT views,executions FROM developer_script_metrics WHERE project_id=$1',[listing.project_id])).rows[0];
    await client.query('COMMIT');res.json({success:true,...metrics.view(counts)});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.get('/scripts/:projectId/source',wrap(async(req,res)=>{
  if(!UUID.test(req.params.projectId))return fail(res,404,'Script not found.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR KEY SHARE',[req.params.projectId]);
    const listing=(await client.query(`SELECT l.snapshot_content_enc,l.snapshot_content_iv ${joinListings} WHERE l.project_id=$1 AND ${publicListing} AND l.access_mode='free'`,[req.params.projectId])).rows[0];
    if(!listing?.snapshot_content_enc){await client.query('ROLLBACK');return fail(res,404,'Script not found.');}
    const content=crypto.decryptAES(listing.snapshot_content_enc,listing.snapshot_content_iv);
    if(req.method!=='HEAD')await metrics.record(client,req.params.projectId,'executions',metrics.visitorReceipt(req,req.params.projectId,'executions'));
    await client.query('COMMIT');
    res.set('X-Content-Type-Options','nosniff').type('text/plain').send(content);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.use((error,req,res,next)=>{
  if(error.status&&error.code)return res.status(error.status).json({success:false,code:error.code,error:error.message});
  if(['SCRIPT_INVALID','SCRIPT_BUSY','SCRIPT_TIMEOUT','SCRIPT_UNAVAILABLE'].includes(error.code)){
    const status=error.code==='SCRIPT_INVALID'?400:error.code==='SCRIPT_TIMEOUT'?422:503;
    if(status===503)res.set('Retry-After','2');return fail(res,status,error.message);
  }
  if(error.code==='23505')return fail(res,409,'This hub slug is already in use. Choose another slug.');
  if(error.code==='42P01'||error.code==='42703')return fail(res,503,'Catalogue database setup is required.');
  fail(res,503,'Catalogue temporarily unavailable.');
});
module.exports=router;
