'use strict';
const express = require('express');
const nodeCrypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const crypto = require('../services/crypto');
const auth = require('../services/developer-auth');
const providers = require('../services/checkpoint-providers');
const checkpointSecurity=require('../services/checkpoint-security');
const scriptJobs = require('../services/publication-queue');
const moderation=require('../services/moderation');
const siteControls=require('../services/site-controls');
const scriptMetrics=require('../services/script-metrics');
const {errorSummary}=require('../services/private-diagnostics');
const router = express.Router();
router.use(require('../services/moderation-http-audit').middleware('platform'));
const checkpointStartLimiter = rateLimit({ windowMs: 600000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many checkpoint starts. Try again in 10 minutes.' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ success: false, error });
const site = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Try again in a minute.' } }));

// Browser mutations use JSON + a same-origin check. Public SDK checks are exempt.
function sameOrigin(req, res, next) {
  if (!req.is('application/json')) return fail(res, 415, 'JSON required');
  const origin = req.get('origin');
  if (origin && origin !== new URL(site(req)).origin) return fail(res, 403, 'Invalid origin');
  if (req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'Invalid origin');
  next();
}
const requireDeveloper = wrap(async (req, res, next) => {
  req.developer = await auth.account(req);
  if (!req.developer) return fail(res, 401, 'Sign in to your developer account to continue.');
  req.developerId = req.developer.discord_id; next();
});
const ownProject = wrap(async (req, res, next) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1 AND owner_id=$2', [req.params.projectId, req.developerId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  if (rows[0].deleted_at) return fail(res, 404, 'Project not found');
  if (req.method !== 'GET' && rows[0].disabled) return fail(res, 403, 'This project was disabled by the site team. Contact support.');
  req.project = rows[0]; next();
});
function projectView(p) {
  const provider = p.checkpoint_provider || 'lootlabs';
  return { id: p.id, name: p.name, description: p.description, durationHours: p.duration_hours,
    hwidBinding: p.hwid_binding, checkpointProvider: provider,
    keyUiMode:p.key_ui_mode||'custom', keyUiLayout:p.key_ui_layout||'compact',
    keyUiColor:p.key_ui_color||'violet', keyUiButtonSize:p.key_ui_button_size||'medium',
    checkpointLinkUrl: p.checkpoint_link_url, checkpointLinkId: p.checkpoint_link_id,
    checkpointsConfigured: checkpointConfigured(p),
    checkpointCount: p.checkpoint_count, createdAt: p.created_at, disabled: p.disabled === true };
}
function checkpointConfigured(p) {
  if (!p) return false;
  switch (p.checkpoint_provider || 'lootlabs') {
    case 'lootlabs': return !!p.lootlabs_token_enc;
    case 'workink': return !!(p.checkpoint_link_url && p.checkpoint_link_id);
    case 'linkvertise': case 'linkunlocker': return !!(p.checkpoint_link_url && p.checkpoint_token_enc);
    default: return false;
  }
}
function sameCheckpointConfig(a, b) {
  return !!b && ['checkpoint_provider', 'checkpoint_link_url', 'checkpoint_link_id',
    'checkpoint_token_enc', 'lootlabs_token_enc', 'checkpoint_secret_hash', 'checkpoint_count']
    .every(field => a[field] === b[field]);
}
// A project-scoped HMAC makes the callback retrievable by its owner without
// storing a plaintext secret or changing the existing database schema.
function callbackSecret(project) {
  if (!project.checkpoint_secret_hash) return null;
  return nodeCrypto.createHmac('sha256', process.env.HMAC_SECRET)
    .update('checkpoint-callback:v1:' + project.id + ':' + project.checkpoint_secret_hash).digest('hex');
}
function callbackUrl(req, project) {
  const secret = (project.checkpoint_provider || 'lootlabs') === 'lootlabs' && callbackSecret(project);
  return secret ? `${site(req)}/api/platform/checkpoints/${project.id}/postback?secret=${secret}` : null;
}
router.get('/v1/loader/:projectId', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  if (!await siteControls.projectAvailable(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT p.*,s.target_mode,s.place_id FROM developer_projects p LEFT JOIN developer_scripts s ON s.project_id=p.id WHERE p.id=$1', [req.params.projectId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  res.type('text/plain').send(require('../services/platform-loader').loader(req.params.projectId, site(req),loaderOptions(rows[0],req)));
}));
function loaderOptions(p,req){
  return {targetMode:p.target_mode,placeId:p.place_id?Number(p.place_id):null,
    keyUiMode:p.key_ui_mode,keyUiLayout:p.key_ui_layout,keyUiColor:p.key_ui_color,keyUiButtonSize:p.key_ui_button_size,
    claimUrl:checkpointConfigured(p)?`${site(req)}/claim?project=${p.id}`:null};
}
router.get('/v1/sdk/:projectId',wrap(async(req,res)=>{
  if(!UUID.test(req.params.projectId))return fail(res,404,'Project not found');
  if(!await siteControls.projectAvailable(req.params.projectId))return fail(res,404,'Project not found');
  const {rows}=await pool.query('SELECT p.*,s.target_mode,s.place_id FROM developer_projects p LEFT JOIN developer_scripts s ON s.project_id=p.id WHERE p.id=$1',[req.params.projectId]);
  if(!rows[0])return fail(res,404,'Project not found');
  res.type('text/plain').send(require('../services/platform-loader').sdk(req.params.projectId,site(req),loaderOptions(rows[0],req)));
}));
router.get('/me', wrap(async (req, res) => {
  const user = await auth.account(req);
  const canModerate=!!user && require('../services/staff-access').isStaff(await require('../services/staff-access').role(user.discord_id));
  const warnings=user?(await pool.query('SELECT reason,created_at FROM developer_account_warnings WHERE account_id=$1 ORDER BY created_at DESC LIMIT 20',[user.discord_id])).rows:[];
  res.json({ success: true, loggedIn: !!user, username: user?.username, canManageBot:!!user && await moderation.role(user.discord_id)==='admin', canModerate, warnings });
}));
router.get('/projects', requireDeveloper, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT p.*,COALESCE(l.licenses,0) AS licenses,COALESCE(e.validations,0) AS validations,COALESCE(m.views,0) AS views,COALESCE(m.executions,0) AS executions
    FROM developer_projects p
    LEFT JOIN developer_script_metrics m ON m.project_id=p.id
    LEFT JOIN (SELECT project_id,COUNT(*)::int AS licenses FROM developer_licenses
      WHERE project_id IN (SELECT id FROM developer_projects WHERE owner_id=$1) GROUP BY project_id) l ON l.project_id=p.id
    LEFT JOIN (SELECT project_id,COUNT(*)::int AS validations FROM developer_events
      WHERE success=true AND project_id IN (SELECT id FROM developer_projects WHERE owner_id=$1) GROUP BY project_id) e ON e.project_id=p.id
    WHERE p.owner_id=$1 ORDER BY p.created_at DESC`, [req.developerId]);
  res.json({ success: true, projects: rows.map(p => ({ ...projectView(p), ...scriptMetrics.view(p),licenses: p.licenses, validations: p.validations })) });
}));
router.post('/projects', sameOrigin, requireDeveloper, wrap(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return fail(res, 400, 'Project name must contain 1–80 characters.');
  const token = 'ahp_' + crypto.randomToken(32);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = (await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [req.developerId])).rows[0];
    if (!account) { await client.query('ROLLBACK'); return fail(res, 401, 'Sign in again to continue.'); }
    const count = await client.query('SELECT COUNT(*)::int AS count FROM developer_projects WHERE owner_id=$1', [req.developerId]);
    if (count.rows[0].count >= 10) { await client.query('ROLLBACK'); return fail(res, 409, 'Your account can have up to 10 projects.'); }
    const { rows } = await client.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4) RETURNING *',
      [nodeCrypto.randomUUID(), req.developerId, name, crypto.hashToken(token)]);
    await client.query('COMMIT'); res.status(201).json({ success: true, project: projectView(rows[0]), apiToken: token });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/projects/:projectId', requireDeveloper, ownProject, wrap(async (req, res) => {
  const id = req.project.id;
  const [licenses, events, script, stats,submissions,metrics,securityChecks] = await Promise.all([
    pool.query('SELECT id,key_prefix,note,expires_at,revoked,(hwid_hash IS NOT NULL) AS bound,created_at FROM developer_licenses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100', [id]),
    pool.query('SELECT success,reason,executor,created_at FROM developer_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30', [id]),
    pool.query('SELECT version,build_hash,updated_at,validated,obfuscated,target_mode,place_id,safety_status,safety_hash,scanner_version,filename,original_size_bytes,output_size_bytes,obfuscation_level,(original_content_enc IS NOT NULL) AS original_available FROM developer_scripts WHERE project_id=$1', [id]),
    pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE NOT revoked AND expires_at>now())::int AS active FROM developer_licenses WHERE project_id=$1`, [id]),
    pool.query("SELECT id,status,findings,created_at FROM developer_moderation_submissions WHERE project_id=$1 AND owner_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 10",[id,req.developerId]),
    pool.query('SELECT views,executions FROM developer_script_metrics WHERE project_id=$1',[id]),
    pool.query('SELECT target_kind,checked_at,result,findings FROM developer_script_revalidation WHERE project_id=$1 ORDER BY checked_at DESC',[id]),
  ]);
  const automaticVerified=!!script.rows[0]&&await moderation.deliveryAllowed(id,script.rows[0].version,script.rows[0].build_hash);
  res.json({ success: true, project: { ...projectView(req.project), checkpointCallbackUrl: callbackUrl(req, req.project), checkpointSetup: providers.setup(req.project, site(req), callbackUrl(req, req.project)) }, licenses: licenses.rows, events: events.rows,
    metrics:scriptMetrics.view(metrics.rows[0]),securityChecks:securityChecks.rows.map(c=>({target:c.target_kind,checkedAt:c.checked_at,result:c.result,findings:moderation.findings(c.findings)})),pendingSubmissions:submissions.rows.map(s=>({id:s.id,status:s.status,findings:moderation.findings(s.findings),createdAt:s.created_at})),
    script: script.rows[0] ? {version:script.rows[0].version,updated_at:script.rows[0].updated_at,updatedAt:script.rows[0].updated_at,filename:script.rows[0].filename,originalAvailable:script.rows[0].original_available,originalSizeBytes:script.rows[0].original_size_bytes,outputSizeBytes:script.rows[0].output_size_bytes,obfuscationLevel:script.rows[0].obfuscation_level,validated:script.rows[0].validated,obfuscated:script.rows[0].obfuscated,securityStatus:script.rows[0].safety_status,securityHash:script.rows[0].safety_hash,scannerVersion:script.rows[0].scanner_version,automaticVerified,targetMode:script.rows[0].target_mode,placeId:script.rows[0].place_id?Number(script.rows[0].place_id):null} : null, stats: stats.rows[0] });
}));
router.patch('/projects/:projectId', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { name, description, durationHours, hwidBinding } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof description !== 'string' || description.length > 500 ||
    !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 8760 || typeof hwidBinding !== 'boolean') return fail(res, 400, 'Invalid project settings.');
  const { rows } = await pool.query('UPDATE developer_projects SET name=$1,description=$2,duration_hours=$3,hwid_binding=$4 WHERE id=$5 AND owner_id=$6 RETURNING *',
    [name.trim(), description, durationHours, hwidBinding, req.project.id, req.developerId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  res.json({ success: true, project: projectView(rows[0]) });
}));
router.put('/projects/:projectId/key-ui',sameOrigin,requireDeveloper,ownProject,wrap(async(req,res)=>{
  const {keyUiMode,keyUiLayout,keyUiColor,keyUiButtonSize}=req.body||{};
  if(!['custom','builtin'].includes(keyUiMode)||!['compact','card','sidebar'].includes(keyUiLayout)||!['violet','blue','green','rose','amber'].includes(keyUiColor)||!['small','medium','large'].includes(keyUiButtonSize))return fail(res,400,'Choose valid key interface options.');
  const {rows}=await pool.query('UPDATE developer_projects SET key_ui_mode=$1,key_ui_layout=$2,key_ui_color=$3,key_ui_button_size=$4 WHERE id=$5 AND owner_id=$6 RETURNING *',[keyUiMode,keyUiLayout,keyUiColor,keyUiButtonSize,req.project.id,req.developerId]);
  if(!rows[0])return fail(res,404,'Project not found');
  res.json({success:true,project:projectView(rows[0])});
}));
router.post('/projects/:projectId/token', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const apiToken = 'ahp_' + crypto.randomToken(32);
  const changed = await pool.query('UPDATE developer_projects SET api_token_hash=$1 WHERE id=$2 AND owner_id=$3 RETURNING id', [crypto.hashToken(apiToken), req.project.id, req.developerId]);
  if (!changed.rows[0]) return fail(res, 404, 'Project not found');
  res.json({ success: true, apiToken });
}));
router.put('/projects/:projectId/script', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const job = await scriptJobs.enqueue({projectId:req.project.id,ownerId:req.developerId,content:req.body.content,filename:req.body.filename,body:req.body});
  res.status(202).json({success:true,queued:true,jobId:job.id,job});
}));
router.get('/projects/:projectId/jobs',requireDeveloper,ownProject,wrap(async(req,res)=>{
  const limit=Number(req.query.limit||10);
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)return fail(res,400,'Choose a job limit between 1 and 20.');
  res.json({success:true,jobs:await scriptJobs.list(req.project.id,req.developerId,limit)});
}));
router.get('/projects/:projectId/jobs/:jobId',requireDeveloper,ownProject,wrap(async(req,res)=>{
  if(!UUID.test(req.params.jobId))return fail(res,404,'Job not found.');
  const job=await scriptJobs.get(req.project.id,req.developerId,req.params.jobId);
  if(!job)return fail(res,404,'Job not found.');res.json({success:true,job});
}));
router.post('/projects/:projectId/jobs/:jobId/cancel',sameOrigin,requireDeveloper,ownProject,wrap(async(req,res)=>{
  if(!UUID.test(req.params.jobId))return fail(res,404,'Job not found.');
  res.json({success:true,job:await scriptJobs.cancel(req.project.id,req.developerId,req.params.jobId)});
}));
function sendOriginal(req,res,value){
  res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff');
  res.set('Content-Disposition',`attachment; filename="script.lua"; filename*=UTF-8''${encodeURIComponent(value.filename||'script.lua')}`);
  res.type('text/plain; charset=utf-8').send(value.code);
}
router.get('/projects/:projectId/source',requireDeveloper,ownProject,wrap(async(req,res)=>sendOriginal(req,res,await scriptJobs.original(req.project.id,req.developerId))));
router.get('/projects/:projectId/jobs/:jobId/source',requireDeveloper,ownProject,wrap(async(req,res)=>{
  if(!UUID.test(req.params.jobId))return fail(res,404,'Job not found.');
  sendOriginal(req,res,await scriptJobs.original(req.project.id,req.developerId,req.params.jobId));
}));
const issueLicenses = wrap(async (req, res) => {
  const hours = req.body.durationHours ?? req.project.duration_hours;
  const count = req.body.count ?? 1;
  const note = req.body.note ?? '';
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760 || !Number.isInteger(count) || count < 1 || count > 50 || typeof note !== 'string' || note.length > 200) return fail(res, 400, 'Invalid license settings.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedProject = await client.query('SELECT id,api_token_hash FROM developer_projects WHERE id=$1 FOR UPDATE', [req.project.id]);
    if (!lockedProject.rows[0]) { await client.query('ROLLBACK'); return fail(res, 404, 'Project not found'); }
    if (!await siteControls.projectAvailable(req.project.id, client)) { await client.query('ROLLBACK'); return fail(res, 403, 'This project is unavailable.'); }
    if (req.apiTokenHash && lockedProject.rows[0]?.api_token_hash !== req.apiTokenHash) {
      await client.query('ROLLBACK'); return fail(res, 401, 'Invalid API token');
    }
    const total = await client.query('SELECT COUNT(*)::int AS count FROM developer_licenses WHERE project_id=$1', [req.project.id]);
    if (total.rows[0].count + count > 10000) { await client.query('ROLLBACK'); return fail(res, 409, 'Project license limit reached (10,000).'); }
    const licenses = [];
    for (let i = 0; i < count; i++) {
      const key = 'ah_' + crypto.randomToken(24);
      const { rows } = await client.query(`INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+($6::text || ' hours')::interval) RETURNING id,expires_at`,
      [nodeCrypto.randomUUID(), req.project.id, crypto.hashToken(key), key.slice(0, 11), note, hours]);
      licenses.push({ ...rows[0], key });
    }
    await client.query('COMMIT'); res.status(201).json({ success: true, licenses });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.post('/projects/:projectId/licenses', sameOrigin, requireDeveloper, ownProject, issueLicenses);
router.post('/projects/:projectId/licenses/:licenseId/:action', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { licenseId, action } = req.params;
  if (!UUID.test(licenseId) || !['revoke','restore','reset-device'].includes(action)) return fail(res, 400, 'Invalid license action.');
  const assignment = { revoke: 'revoked=true', restore: 'revoked=false', 'reset-device': 'hwid_hash=NULL' }[action];
  const result = await pool.query(`UPDATE developer_licenses SET ${assignment} WHERE id=$1 AND project_id=$2${action==='restore'?' AND admin_revoked=false':''} RETURNING id`, [licenseId, req.project.id]);
  if (!result.rows[0]) return fail(res, 404, 'License not found or restricted by the site team');
  res.json({ success: true });
}));

// Secret server-side token; it must never be embedded in a distributed Lua script.
router.post('/v1/projects/:projectId/licenses', wrap(async (req, res, next) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (!/^ahp_[a-f0-9]{64}$/.test(token)) return fail(res, 401, 'Invalid API token');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1 AND api_token_hash=$2', [req.params.projectId, crypto.hashToken(token)]);
  if (!rows[0]) return fail(res, 401, 'Invalid API token');
  req.project = rows[0]; req.developerId = rows[0].owner_id; req.apiTokenHash = crypto.hashToken(token);
  // Delegate to the authenticated issuance handler, not browser authentication.
  await issueLicenses(req, res, next);
}));

router.post('/v1/check', wrap(async (req, res) => {
  const { projectId, key, hwid, executor } = req.body || {};
  if(req.body?.executionId!==undefined&&(typeof req.body.executionId!=='string'||!scriptMetrics.UUID.test(req.body.executionId)))return fail(res,400,'Invalid execution ID');
  if (typeof projectId !== 'string' || typeof key !== 'string' || !UUID.test(projectId) || !/^ah_[a-f0-9]{48}$/.test(key)) return fail(res, 400, 'Invalid key or project');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Hold the project before its licence. Account deletion removes licences
    // after locking projects; this also protects the validation-event FK.
    const project = await client.query('SELECT hwid_binding FROM developer_projects WHERE id=$1 FOR KEY SHARE', [projectId]);
    if (!project.rows[0]) { await client.query('ROLLBACK'); return res.status(401).json({ success: false, reason: 'invalid_key' }); }
    if (!await siteControls.projectAvailable(projectId, client)) { await client.query('ROLLBACK'); return res.status(403).json({ success: false, reason: 'project_unavailable' }); }
    const result = await client.query('SELECT * FROM developer_licenses WHERE project_id=$1 AND key_hash=$2 FOR UPDATE', [projectId, crypto.hashToken(key)]);
    const license = result.rows[0];
    let reason = !license ? 'invalid_key' : license.revoked ? 'revoked' : new Date(license.expires_at).getTime() <= Date.now() ? 'expired' : null;
    let hwidHash = null;
    if (!reason && project.rows[0].hwid_binding) {
      if (typeof hwid !== 'string' || hwid.trim().length < 8 || hwid.length > 256) reason = 'hwid_required';
      else { hwidHash = crypto.hashToken(projectId + ':' + hwid.trim()); if (license.hwid_hash && license.hwid_hash !== hwidHash) reason = 'bound_to_other_device'; }
    }
    const script = !reason ? await client.query('SELECT content_enc,content_iv,version,validated,obfuscated,safety_status,build_hash FROM developer_scripts WHERE project_id=$1 AND disabled=false AND deleted_at IS NULL', [projectId]) : { rows: [] };
    if (!reason && req.body.loadScript === true && !script.rows[0]) reason = 'no_script';
    if (!reason && req.body.loadScript === true && (!script.rows[0].validated)) reason = 'build_required';
    if(!reason&&script.rows[0]&&!await moderation.deliveryAllowed(projectId,script.rows[0].version,script.rows[0].build_hash,client))reason='security_review_required';
    let content;
    if(!reason&&req.body.loadScript===true){
      content=crypto.decryptAES(script.rows[0].content_enc,script.rows[0].content_iv);
      if(crypto.sha256(content)!==script.rows[0].build_hash){reason='security_review_required';content=undefined;}
    }
    if (!license) { await client.query('ROLLBACK'); return res.status(401).json({ success: false, reason }); }
    if (!reason && hwidHash && !license.hwid_hash) await client.query('UPDATE developer_licenses SET hwid_hash=$1 WHERE id=$2', [hwidHash, license.id]);
    await client.query('INSERT INTO developer_events(project_id,license_id,success,reason,executor) VALUES($1,$2,$3,$4,$5)',
      [projectId, license.id, !reason, reason || 'valid', typeof executor === 'string' ? executor.slice(0, 40) : '']);
    if(content!==undefined)await scriptMetrics.record(client,projectId,'executions',scriptMetrics.executionReceipt(license.id,req.body.executionId||nodeCrypto.randomUUID()));
    await client.query('COMMIT');
    if (reason) return res.status(403).json({ success: false, reason });
    res.json({ success: true, expiresAt: license.expires_at, script: content, version: script.rows[0]?.version });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.put('/projects/:projectId/checkpoints', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { count, linkUrl, linkId } = req.body;
  const provider = req.body.provider || 'lootlabs';
  if (typeof provider !== 'string' || !Object.hasOwn(providers.names, provider)) return fail(res, 400, 'Unsupported checkpoint provider.');
  if (req.body.apiToken !== undefined && typeof req.body.apiToken !== 'string') return fail(res, 400, 'Provide a valid provider API token.');
  const sameProvider = provider === (req.project.checkpoint_provider || 'lootlabs');
  const savedToken = sameProvider && (provider === 'lootlabs' ? req.project.lootlabs_token_enc : req.project.checkpoint_token_enc);
  const savedIv = provider === 'lootlabs' ? req.project.lootlabs_token_iv : req.project.checkpoint_token_iv;
  const savedPlainToken = savedToken ? crypto.decryptAES(savedToken, savedIv) : '';
  const apiToken = typeof req.body.apiToken === 'string' && req.body.apiToken.trim() ? req.body.apiToken.trim() :
    savedPlainToken;
  const link = provider === 'lootlabs' ? null : providers.safeLink(linkUrl, provider);
  if (provider !== 'lootlabs' && !link) return fail(res, 400, 'Provide a valid HTTPS link from the selected provider.');
  if (provider === 'workink' && (typeof linkId !== 'string' || !/^[0-9]{1,20}$/.test(linkId))) return fail(res, 400, 'Provide the numeric Work.ink link ID.');
  if (provider === 'lootlabs' && (typeof apiToken !== 'string' || apiToken.trim().length < 8 || apiToken.length > 500 || !Number.isInteger(count) || count < 1 || count > 5)) return fail(res, 400, 'Provide your LootLabs API token and 1–5 tasks.');
  if (['linkvertise','linkunlocker'].includes(provider) && (typeof apiToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(apiToken.trim()))) return fail(res, 400, 'Provide a 64-character provider API token.');
  const token = provider === 'workink' ? null : savedToken && apiToken === savedPlainToken ? { enc: savedToken, iv: savedIv } : crypto.encryptAES(apiToken.trim());
  const secretHash = provider === 'lootlabs' ? (sameProvider && req.project.checkpoint_secret_hash || crypto.hashToken(crypto.randomToken(32))) : null;
  const updatedConfig = { checkpoint_provider: provider, checkpoint_link_url: link, checkpoint_link_id: provider === 'workink' ? linkId : null,
    checkpoint_token_enc: provider === 'lootlabs' ? null : token?.enc || null, lootlabs_token_enc: provider === 'lootlabs' ? token.enc : null,
    checkpoint_secret_hash: secretHash, checkpoint_count: provider === 'lootlabs' ? count : 1 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = (await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [req.developerId])).rows[0];
    if (!account) { await client.query('ROLLBACK'); return fail(res, 401, 'Sign in again to continue.'); }
    const current = await client.query('SELECT * FROM developer_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE', [req.project.id, req.developerId]);
    if (!current.rows[0]) { await client.query('ROLLBACK'); return fail(res, 404, 'Project not found'); }
    if (!sameCheckpointConfig(req.project, current.rows[0])) { await client.query('ROLLBACK'); return fail(res, 409, 'Checkpoint settings changed. Refresh this project and try again.'); }
    await client.query(`UPDATE developer_projects SET checkpoint_provider=$1,checkpoint_link_url=$2,checkpoint_link_id=$3,
    checkpoint_token_enc=$4,checkpoint_token_iv=$5,lootlabs_token_enc=$6,lootlabs_token_iv=$7,
    checkpoint_secret_hash=$8,checkpoint_count=$9 WHERE id=$10 AND owner_id=$11`,
    [provider, link, provider === 'workink' ? linkId : null, provider === 'lootlabs' ? null : token?.enc || null,
      provider === 'lootlabs' ? null : token?.iv || null, provider === 'lootlabs' ? token.enc : null,
      provider === 'lootlabs' ? token.iv : null, secretHash,
      provider === 'lootlabs' ? count : 1, req.project.id, req.developerId]);
    // Keep receipts for replay detection, while preventing older pending flows
    // from completing against new provider credentials or task requirements.
    if (!sameCheckpointConfig(req.project, updatedConfig)) await client.query('UPDATE developer_checkpoints SET expires_at=now() WHERE project_id=$1 AND tasks_done<tasks_required', [req.project.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const configured = { id: req.project.id, checkpoint_provider: provider, checkpoint_secret_hash: secretHash };
  res.json({ success: true, provider, setup: providers.setup(configured, site(req), callbackUrl(req, configured)), postbackUrl: callbackUrl(req, configured),
    targetUrl: provider === 'linkvertise' ? `${site(req)}/api/platform/checkpoints/${req.project.id}/return` : null });
}));
router.get('/public/projects/:projectId', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  if (!await siteControls.projectAvailable(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query(`SELECT p.id,p.duration_hours,p.checkpoint_count,p.checkpoint_provider,p.checkpoint_link_url,p.checkpoint_link_id,p.checkpoint_token_enc,p.lootlabs_token_enc,
    l.title AS public_title,l.description AS public_description FROM developer_projects p
    LEFT JOIN (SELECT listing.project_id,listing.title,listing.description FROM developer_listings listing
      JOIN developer_hubs h ON h.id=listing.hub_id WHERE listing.published_at IS NOT NULL AND h.published_at IS NOT NULL) l ON l.project_id=p.id
    WHERE p.id=$1`, [req.params.projectId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  // A shared key page must not expose private project names or notes.
  res.json({ success: true, project: { id: rows[0].id, name: rows[0].public_title || 'Script access', description: rows[0].public_description || '',
    durationHours: rows[0].duration_hours, checkpointCount: rows[0].checkpoint_count,
    checkpointProvider: rows[0].checkpoint_provider || 'lootlabs', available: checkpointConfigured(rows[0]) } });
}));
router.post('/checkpoints/:projectId/start', sameOrigin, checkpointStartLimiter, wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  if (!await siteControls.projectAvailable(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1', [req.params.projectId]);
  const p = rows[0]; if (!checkpointConfigured(p)) return fail(res, 409, 'The developer has not configured checkpoints yet.');
  const ipHash=checkpointSecurity.ipHash(req.ip);
  if(!ipHash)return fail(res,403,'Checkpoint network could not be verified. Try again.');
  const id = crypto.randomToken(32), browser = crypto.randomToken(32);
  let started;
  try { started = await providers.prepareStart(p, id, site(req), crypto.decryptAES, crypto.randomToken, crypto.hashToken); }
  catch { return fail(res, 502, `${providers.names[p.checkpoint_provider || 'lootlabs']} could not create your link. Contact the developer.`); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedProject = await client.query('SELECT * FROM developer_projects WHERE id=$1 FOR UPDATE', [p.id]);
    if (!await siteControls.projectAvailable(p.id, client)) { await client.query('ROLLBACK'); return fail(res, 404, 'Project not found'); }
    if (!sameCheckpointConfig(p, lockedProject.rows[0])) {
      await client.query('ROLLBACK'); return fail(res, 409, 'Checkpoint settings changed. Start again.');
    }
    await client.query(`INSERT INTO developer_checkpoints(id,project_id,browser_hash,tasks_required,duration_hours,provider,provider_reference,return_proof_hash,ip_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, p.id, crypto.hashToken(browser), p.checkpoint_count, p.duration_hours, started.provider, started.reference, started.proofHash,ipHash]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const cookieOptions = { httpOnly: true, secure: req.secure || site(req).startsWith('https:'), sameSite: 'lax', path: '/api/platform/checkpoints', maxAge: 1800000 };
  res.cookie('ah_checkpoint_' + id, browser, cookieOptions);
  res.cookie('ah_checkpoint_current_' + p.id, id, cookieOptions);
  res.json({ success: true, session: id, url: started.url });
}));
router.get('/checkpoints/:projectId/return', wrap(async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  if (!await siteControls.projectAvailable(req.params.projectId)) return fail(res, 404, 'Project not found');
  if(req.query.session!==undefined&&typeof req.query.session!=='string')return fail(res,403,'Checkpoint session invalid.');
  const id = typeof req.query.session === 'string' ? req.query.session : req.cookies?.['ah_checkpoint_current_' + req.params.projectId];
  if (!/^[a-f0-9]{64}$/.test(id || '')) return fail(res, 403, 'Checkpoint session missing.');
  const browser = req.cookies?.['ah_checkpoint_' + id];
  if (!browser) return fail(res, 403, 'Open this page in the browser used to start the checkpoint.');
  const [projectResult, sessionResult] = await Promise.all([
    pool.query('SELECT * FROM developer_projects WHERE id=$1', [req.params.projectId]),
    pool.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND browser_hash=$3 AND expires_at>now()',
      [id, req.params.projectId, crypto.hashToken(browser)]),
  ]);
  const project = projectResult.rows[0], session = sessionResult.rows[0];
  if (!project || !session || session.provider !== project.checkpoint_provider) return fail(res, 403, 'Checkpoint session invalid or expired.');
  if(!checkpointSecurity.ipMatches(session,req.ip))return fail(res,403,'Your network changed. Start a new checkpoint using the same browser and network.');
  const claim = `${site(req)}/claim?project=${project.id}&session=${id}`;
  if (session.tasks_done >= session.tasks_required){req.checkpointOutcome='checkpoint.complete';return res.redirect(303, claim);}
  const proof=checkpointSecurity.returnProof(session.provider,req.query);
  if(!proof)return res.redirect(303,claim+'&checkpoint=failed');
  const receipt=crypto.hashToken(`${session.provider}:${proof}`),globalProof=checkpointSecurity.proofHash(session.provider,proof);
  if((await pool.query('SELECT proof_hash FROM developer_checkpoint_proof_uses WHERE proof_hash=$1',[globalProof])).rows.length)return res.redirect(303,claim+'&checkpoint=failed');
  let valid;
  try { valid = await providers.verifyReturn(project, session, req.query, crypto.decryptAES, crypto.hashToken); }
  catch { return res.redirect(303, claim + '&checkpoint=failed'); }
  if (!valid) return res.redirect(303, claim + '&checkpoint=failed');
  // A provider proof may advance only one session across all projects. Do not
  // include the session ID, which would make replay produce a fresh receipt.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE', [project.id]);
    if (!await siteControls.projectAvailable(project.id, client)) { await client.query('ROLLBACK'); return fail(res, 404, 'Project not found'); }
    const locked = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND browser_hash=$3 AND expires_at>now() FOR UPDATE',
      [id, project.id, crypto.hashToken(browser)]);
    if (!locked.rows[0] || locked.rows[0].provider !== session.provider) { await client.query('ROLLBACK'); return fail(res, 403, 'Checkpoint session invalid or expired.'); }
    if(locked.rows[0].tasks_done>=locked.rows[0].tasks_required){await client.query('COMMIT');return res.redirect(303,claim);}
    const consumed=await client.query('INSERT INTO developer_checkpoint_proof_uses(proof_hash) VALUES($1) ON CONFLICT DO NOTHING RETURNING proof_hash',[globalProof]);
    if(!consumed.rows.length){await client.query('ROLLBACK');return res.redirect(303,claim+'&checkpoint=failed');}
    const inserted = await client.query('INSERT INTO developer_checkpoint_receipts(project_id,receipt_id,checkpoint_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt_id',
      [project.id, receipt, id]);
    if (inserted.rows[0]) await client.query('UPDATE developer_checkpoints SET tasks_done=LEAST(tasks_done+1,tasks_required) WHERE id=$1', [id]);
    req.checkpointOutcome=inserted.rows[0]||locked.rows[0].tasks_done>=locked.rows[0].tasks_required?'checkpoint.complete':'checkpoint.failed';
    await client.query('COMMIT');
    res.redirect(303, !inserted.rows[0] && locked.rows[0].tasks_done < locked.rows[0].tasks_required ? claim + '&checkpoint=failed' : claim);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/checkpoints/:projectId/postback', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId) || typeof req.query.secret !== 'string' || !/^[a-f0-9]{64}$/.test(req.query.secret)) return fail(res, 403, 'Invalid callback');
  const identifiers=['sub_id','click_id','puid'].filter(name=>req.query[name]!==undefined).map(name=>req.query[name]);
  const receipt=req.query.unique_id,session=identifiers[0];
  if(identifiers.some(value=>typeof value!=='string'||value!==session))return fail(res,400,'Ambiguous callback session.');
  if (typeof receipt !== 'string' || receipt.length < 1 || receipt.length > 200 || typeof session!=='string'||!/^[a-f0-9]{64}$/.test(session)) return fail(res, 400, 'Missing receipt or session');
  if(!checkpointSecurity.ipHash(req.query.ip))return fail(res,403,'Callback network proof missing or invalid.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query("SELECT id,checkpoint_secret_hash FROM developer_projects WHERE id=$1 AND checkpoint_provider='lootlabs' FOR UPDATE", [req.params.projectId]);
    const stored = project.rows[0];
    if (!stored || !await siteControls.projectAvailable(stored.id, client)) { await client.query('ROLLBACK'); return fail(res, 403, 'Invalid callback'); }
    const derived = stored && callbackSecret(stored);
    const valid = derived && (nodeCrypto.timingSafeEqual(Buffer.from(req.query.secret, 'hex'), Buffer.from(derived, 'hex')) ||
      nodeCrypto.timingSafeEqual(Buffer.from(crypto.hashToken(req.query.secret), 'hex'), Buffer.from(stored.checkpoint_secret_hash, 'hex')));
    if (!valid) { await client.query('ROLLBACK'); return fail(res, 403, 'Invalid callback'); }
    const { rows } = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND expires_at>now() FOR UPDATE', [session, req.params.projectId]);
    if (!rows[0] || rows[0].provider !== 'lootlabs') { await client.query('ROLLBACK'); return fail(res, 403, 'Invalid callback'); }
    if(!checkpointSecurity.ipMatches(rows[0],req.query.ip)){await client.query('ROLLBACK');return fail(res,403,'Callback network proof invalid.');}
    if(rows[0].tasks_done>=rows[0].tasks_required){await client.query('COMMIT');return res.json({success:true});}
    const globalProof=checkpointSecurity.proofHash('lootlabs',receipt);
    const consumed=await client.query('INSERT INTO developer_checkpoint_proof_uses(proof_hash) VALUES($1) ON CONFLICT DO NOTHING RETURNING proof_hash',[globalProof]);
    if(!consumed.rows.length){await client.query('COMMIT');return res.json({success:true});}
    const inserted = await client.query('INSERT INTO developer_checkpoint_receipts(project_id,receipt_id,checkpoint_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt_id', [req.params.projectId, receipt, session]);
    if (inserted.rows[0]) await client.query('UPDATE developer_checkpoints SET tasks_done=LEAST(tasks_done+1,tasks_required) WHERE id=$1', [session]);
    req.checkpointOutcome='checkpoint.complete';
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/checkpoints/:session/status', wrap(async (req, res) => {
  const id = req.params.session;
  if (!/^[a-f0-9]{64}$/.test(id)) return fail(res, 404, 'Session not found');
  const browser = req.cookies?.['ah_checkpoint_' + id];
  if (!browser) return fail(res, 403, 'Open this page in the browser used to start the checkpoint.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionProject = await client.query('SELECT project_id FROM developer_checkpoints WHERE id=$1 AND browser_hash=$2', [id, crypto.hashToken(browser)]);
    if (!sessionProject.rows[0]) { await client.query('ROLLBACK'); return fail(res, 410, 'Session expired. Start again.'); }
    await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE', [sessionProject.rows[0].project_id]);
    if (!await siteControls.projectAvailable(sessionProject.rows[0].project_id, client)) { await client.query('ROLLBACK'); return fail(res, 410, 'Project unavailable.'); }
    const { rows } = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND browser_hash=$2 AND expires_at>now() FOR UPDATE', [id, crypto.hashToken(browser)]);
    const c = rows[0];
    if (!c) { await client.query('ROLLBACK'); return fail(res, 410, 'Session expired. Start again.'); }
    if(c.ip_hash&&!checkpointSecurity.ipMatches(c,req.ip)){await client.query('ROLLBACK');return fail(res,403,'Your network changed. Start a new checkpoint using the same browser and network.');}
    if (c.tasks_done < c.tasks_required) { await client.query('COMMIT'); return res.json({ success: true, status: 'pending', completed: c.tasks_done, required: c.tasks_required }); }
    let key = c.key_enc ? crypto.decryptAES(c.key_enc, c.key_iv) : null;
    if (!key) {
      const total = await client.query('SELECT COUNT(*)::int AS count FROM developer_licenses WHERE project_id=$1', [c.project_id]);
      if (total.rows[0].count >= 10000) { await client.query('ROLLBACK'); return fail(res, 409, 'Project license limit reached. Contact the developer.'); }
      key = 'ah_' + crypto.randomToken(24);
      await client.query(`INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+($6::text || ' hours')::interval)`, [nodeCrypto.randomUUID(), c.project_id, crypto.hashToken(key), key.slice(0, 11), `${providers.names[c.provider] || 'Provider'} checkpoint`, c.duration_hours]);
      const encrypted = crypto.encryptAES(key);
      await client.query('UPDATE developer_checkpoints SET key_enc=$1,key_iv=$2 WHERE id=$3', [encrypted.enc, encrypted.iv, id]);
      await moderation.audit(client,{action:'license.issued',projectId:c.project_id});
    }
    await client.query('COMMIT'); res.json({ success: true, status: 'completed', key });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.use((error, req, res, next) => {
  if(error.status&&error.code)return res.status(error.status).json({success:false,code:error.code,error:error.message});
  if (res.headersSent) return next(error);
  if(['SCRIPT_INVALID','SCRIPT_BUSY','SCRIPT_TIMEOUT','SCRIPT_UNAVAILABLE'].includes(error.code)) {
    const status=error.code==='SCRIPT_INVALID'?400:error.code==='SCRIPT_TIMEOUT'?422:503;
    if(status===503)res.set('Retry-After','2');return fail(res,status,error.message);
  }
  console.error('[platform]', errorSummary(error));
  fail(res, error.code === '42P01' ? 503 : 500, error.code === '42P01' ? 'Developer platform setup is pending. Please try again later.' : 'The request could not be completed. Try again.');
});
module.exports = router;
