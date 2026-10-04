'use strict';
const pool = require('../db');
const { randomUUID } = require('crypto');
const crypto = require('./crypto');
const builder = require('./script-builder');
const moderation = require('./moderation');
const { scanScript, combineScans, SCANNER_VERSION } = require('./script-safety');
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
// One worker leaves room for Node and the scanner on the 512 MiB hosting plan.
const WORKERS = 1;
const LEASE_MS = 120000;
const controllers = new Map();
const running = new Set();
let started = false, stopping = false, timer, pumping = false, pumpTask = null, retries = 0;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const safeMessages = {
 SCRIPT_UNSUPPORTED_STRONG: 'Strong obfuscation cannot safely transform these Lua/Luau constructs. Choose Standard or None.',
 SCRIPT_INVALID: 'The script has invalid or unsupported Lua/Luau syntax.',
 SCRIPT_TIMEOUT: 'The build exceeded its time limit. The previous release remains active.',
 SCRIPT_RESOURCE_LIMIT: 'The build exceeded its memory or size limit.',
 SCRIPT_CANCELLED: 'The build was cancelled.',
 SCRIPT_BUSY: 'The build service is busy. Please try again later.',
 SCRIPT_UNAVAILABLE: 'The build tools are temporarily unavailable.',
 SECURITY_BLOCKED: 'This release was blocked by security checks.',
 SECURITY_UNVERIFIED: 'Automatic verification could not establish an acceptable release. Simplify the readable source and its dependencies, then submit again. Human approval is unavailable.',
 RELEASE_CHANGED: 'The active release or publication changed. Submit the script again.',
 PROJECT_UNAVAILABLE: 'The account or project was restricted while this job was running.'
};
const log = (level, message) => ({ date: new Date().toISOString(), level, message });
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function view(row) {
 if (!row) return null;
 return { id: row.id, projectId: row.project_id, kind: row.kind, status: row.status,
  progress: row.progress, filename: row.filename, obfuscate: row.obfuscate,
  obfuscationLevel: row.obfuscate ? row.obfuscation_level : null, originalAvailable: row.original_available===undefined ? !!row.original_content_enc : row.original_available,
  originalSizeBytes: row.original_size_bytes, outputSizeBytes: row.output_size_bytes,
  buildDurationMs: row.build_duration_ms, createdAt: row.created_at,
  startedAt: row.started_at, finishedAt: row.finished_at,
  logs: json(row.logs) || [], result: json(row.result) || null,
  ...(row.error_code ? { error: { code: row.error_code, message: row.error_message } } : {}) };
}
const fields = '(original_content_enc IS NOT NULL) AS original_available,id,project_id,kind,status,progress,filename,obfuscate,obfuscation_level,original_size_bytes,output_size_bytes,build_duration_ms,created_at,started_at,finished_at,logs,result,error_code,error_message';
function options(body = {}) {
 const obfuscate = body.obfuscate === undefined ? false : body.obfuscate;
 const level = body.obfuscationLevel === undefined ? 'standard' : body.obfuscationLevel;
 const targetMode = body.targetMode === undefined ? 'universal' : body.targetMode;
 const placeId = targetMode === 'single' ? Number(body.placeId) : null;
 if (typeof obfuscate !== 'boolean' || !['standard', 'strong'].includes(level) || !['universal', 'single'].includes(targetMode) || targetMode === 'single' && (!Number.isSafeInteger(placeId) || placeId <= 0) || targetMode==='universal' && body.placeId!==undefined && body.placeId!==null) throw fault(400, 'SCRIPT_OPTIONS', 'Choose a valid obfuscation level and target game.');
 return { obfuscate, obfuscationLevel: level, targetMode, placeId };
}
function filename(value) {
 if (value === undefined) return 'script.lua';
 if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f/\\]/.test(value)) throw fault(400, 'SCRIPT_FILENAME', 'Choose a filename of up to 120 characters without folders.');
 return value.trim();
}
function sourceCheck(source) {
 if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > MAX_SOURCE || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(source)) throw fault(400, 'SCRIPT_SOURCE_LIMIT', 'Provide a valid UTF-8 Lua/Luau source of up to 8 MiB.');
}
async function connect() {
 let expired = false, timeout;
 const pending = pool.connect();
 pending.then(db => { if (expired) db.release(); }).catch(() => {});
 try { return await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; reject(fault(503, 'SCRIPT_BUSY', safeMessages.SCRIPT_BUSY)); }, 5000); })]); }
 finally { clearTimeout(timeout); }
}
async function query(text,values){
 const db=await connect();let discarded=false;
 try{return await db.query({text,values,query_timeout:10000});}
 catch(error){discarded=true;db.release(true);throw error;}
 finally{if(!discarded)db.release();}
}
async function transaction(fn) {
 const db = await connect();
 try { await db.query('BEGIN'); await db.query("SET LOCAL statement_timeout = '10s'"); await db.query("SET LOCAL lock_timeout = '5s'"); const result = await fn(db); await db.query('COMMIT'); return result; }
 catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
 finally { db.release(); }
}
async function available(db, projectId, ownerId, publishing = false) {
 const account = (await db.query('SELECT discord_id,username,banned_at,suspended_until FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [ownerId])).rows[0];
 const project = (await db.query('SELECT id,owner_id,disabled,hidden,deleted_at FROM developer_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE', [projectId, ownerId])).rows[0];
 const script = (await db.query('SELECT * FROM developer_scripts WHERE project_id=$1', [projectId])).rows[0];
 if (!account || !project) throw fault(404, 'PROJECT_UNAVAILABLE', 'Project not found.');
 if (account.banned_at || account.suspended_until && new Date(account.suspended_until) > new Date() || project.disabled || project.deleted_at || publishing && project.hidden || script && (script.disabled || script.deleted_at)) throw fault(403, 'PROJECT_UNAVAILABLE', safeMessages.PROJECT_UNAVAILABLE);
 return { account, project, script };
}
async function enqueue({ projectId, ownerId, content, filename: name, body = {}, publication = null }) {
 const selected = options(body), abortAfter=[];
 const job = await transaction(async db => {
  // Admission is serialized separately from owner/project locks so the global
  // queue bound holds across processes without keeping a lock during builds.
  await db.query('SELECT pg_advisory_xact_lock(1732517019,2)');
  const { script } = await available(db, projectId, ownerId, !!publication);
  let input = content;
  if (publication) {
   if(!script)throw fault(400,'SCRIPT_REQUIRED','Upload a source script before publishing.');
   if(script&&(!moderation.approved(script.safety_status)||script.scanner_version!==SCANNER_VERSION||script.safety_hash!==script.build_hash))throw fault(409,'SECURITY_REVIEW_REQUIRED','This release has not passed current automatic verification. Upload a readable replacement.');
   if (!script?.original_content_enc || !script.original_content_iv) throw fault(409, 'ORIGINAL_UNAVAILABLE', 'Upload the original source before publishing this older release.');
   input = crypto.decryptAES(script.original_content_enc, script.original_content_iv);
   name = script.filename || 'script.lua';
   // Publication uses the current source's game unless explicitly supplied.
   if (body.targetMode === undefined) { selected.targetMode = script.target_mode; selected.placeId = script.place_id ? Number(script.place_id) : null; }
  }
  sourceCheck(input); name = filename(name);
  const recent = Number((await db.query('SELECT count(*) AS total FROM developer_script_jobs WHERE owner_id=$1 AND created_at>$2', [ownerId, new Date(Date.now() - 600000)])).rows[0].total);
  if (recent >= 12) throw fault(429, 'SCRIPT_RATE_LIMIT', 'You can submit up to 12 script jobs in 10 minutes.');
  const total = Number((await db.query("SELECT count(*) AS total FROM developer_script_jobs WHERE status IN ('queued','processing')")).rows[0].total);
  const owned = Number((await db.query("SELECT count(*) AS total FROM developer_script_jobs WHERE owner_id=$1 AND project_id<>$2 AND status IN ('queued','processing')", [ownerId, projectId])).rows[0].total);
  if (total >= 50 || owned >= 2) throw fault(429, 'SCRIPT_QUEUE_FULL', 'The build queue is full. Wait for your current jobs to finish.');
  const previous = (await db.query("SELECT id FROM developer_script_jobs WHERE project_id=$1 AND status IN ('queued','processing','review')", [projectId])).rows;
  for (const old of previous) { await cancelIn(db, old.id, 'Replaced by a newer job.'); abortAfter.push(old.id); }
  await pruneHistory(db,ownerId);
  const listing = (await db.query('SELECT updated_at FROM developer_listings WHERE project_id=$1', [projectId])).rows[0];
  const encrypted = crypto.encryptAES(input), id = randomUUID();
  const row = (await db.query(`INSERT INTO developer_script_jobs(id,project_id,owner_id,kind,original_content_enc,original_content_iv,original_size_bytes,filename,obfuscate,obfuscation_level,target_mode,place_id,expected_version,expected_hash,expected_safety,expected_listing_updated_at,publication,logs)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb) RETURNING *`,
   [id, projectId, ownerId, publication ? 'publish' : 'upload', encrypted.enc, encrypted.iv, Buffer.byteLength(input), name, selected.obfuscate, selected.obfuscationLevel, selected.targetMode, selected.placeId, script?.version || 0, script?.build_hash || null, script?.safety_status || null, listing?.updated_at || null, publication ? JSON.stringify(publication) : null, JSON.stringify([log('info', 'Original source encrypted and job queued.')])])).rows[0];
  return view(row);
 });
 for(const id of abortAfter)controllers.get(id)?.abort();
 start(); wake(); return job;
}
async function cancelIn(db, id, message) {
 const row = (await db.query('SELECT logs FROM developer_script_jobs WHERE id=$1', [id])).rows[0];
 if (!row) return;
 await db.query("UPDATE developer_script_jobs SET status='cancelled',finished_at=now(),logs=$2::jsonb WHERE id=$1 AND status IN ('queued','processing','review')", [id, JSON.stringify([...(json(row.logs) || []), log('warning', message)].slice(-80))]);
 await db.query("UPDATE developer_moderation_submissions SET status='stale',content_enc=NULL,content_iv=NULL,decided_at=now() WHERE job_id=$1 AND status='pending'", [id]);
}
async function cancel(projectId, ownerId, id) {
 const result = await transaction(async db => {
  await available(db, projectId, ownerId);
  const row = (await db.query('SELECT '+fields+' FROM developer_script_jobs WHERE id=$1 AND project_id=$2 AND owner_id=$3', [id, projectId, ownerId])).rows[0];
  if (!row) throw fault(404, 'JOB_NOT_FOUND', 'Job not found.');
  if (!['queued','processing','review'].includes(row.status)) throw fault(409, 'JOB_FINISHED', 'This job has already finished.');
  await cancelIn(db, id, 'Cancelled by the project owner.');
  await pruneHistory(db,ownerId);
  return view((await db.query('SELECT '+fields+' FROM developer_script_jobs WHERE id=$1', [id])).rows[0]);
 });
 controllers.get(id)?.abort(); return result;
}
async function list(projectId, ownerId, limit = 10) { wake(); return (await query('SELECT '+fields+' FROM developer_script_jobs WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3', [projectId, ownerId, limit])).rows.map(view); }
async function get(projectId, ownerId, id) { wake(); return view((await query('SELECT '+fields+' FROM developer_script_jobs WHERE id=$1 AND project_id=$2 AND owner_id=$3', [id, projectId, ownerId])).rows[0]); }
async function original(projectId, ownerId, id) {
 const row = id ? (await query('SELECT original_content_enc,original_content_iv,filename FROM developer_script_jobs WHERE id=$1 AND project_id=$2 AND owner_id=$3', [id, projectId, ownerId])).rows[0] : (await query('SELECT s.original_content_enc,s.original_content_iv,s.filename FROM developer_scripts s JOIN developer_projects p ON p.id=s.project_id WHERE p.id=$1 AND p.owner_id=$2 AND s.deleted_at IS NULL', [projectId, ownerId])).rows[0];
 if (!row?.original_content_enc || !row.original_content_iv) throw fault(404, 'ORIGINAL_UNAVAILABLE', 'The original source is unavailable. Upload the original source again.');
 return { code: crypto.decryptAES(row.original_content_enc, row.original_content_iv), filename: row.filename };
}
async function update(job, progress, level, message) {
 const changed = await query("UPDATE developer_script_jobs SET progress=$3,logs=$4::jsonb,lease_expires_at=$5 WHERE id=$1 AND status='processing' AND worker_token=$2 RETURNING id", [job.id, job.worker_token, progress, JSON.stringify([...(json(job.logs) || []), log(level, message)].slice(-80)), new Date(Date.now() + LEASE_MS)]);
 if (!changed.rows[0]) throw fault(409, 'SCRIPT_CANCELLED', safeMessages.SCRIPT_CANCELLED);
 await query('UPDATE developer_script_worker_lease SET expires_at=$2 WHERE id=1 AND worker_token=$1',[job.worker_token,new Date(Date.now()+LEASE_MS)]);
 job.logs = [...(json(job.logs) || []), log(level, message)].slice(-80);
}
function changed(job, script) { return (script?.version || 0) !== job.expected_version || (script?.build_hash || null) !== job.expected_hash || (script?.safety_status || null) !== job.expected_safety; }
async function publishIn(db, job, script, account) {
 const intent = json(job.publication); if (!intent) return;
 const listing = (await db.query('SELECT updated_at FROM developer_listings WHERE project_id=$1', [job.project_id])).rows[0];
 if ((listing?.updated_at ? new Date(listing.updated_at).getTime() : null) !== (job.expected_listing_updated_at ? new Date(job.expected_listing_updated_at).getTime() : null)) throw fault(409, 'RELEASE_CHANGED', safeMessages.RELEASE_CHANGED);
 let hub = (await db.query('SELECT id,auto_profile,published_at FROM developer_hubs WHERE owner_id=$1', [job.owner_id])).rows[0];
 if (!hub) { const id = randomUUID(); hub = (await db.query("INSERT INTO developer_hubs(id,owner_id,slug,name,description,published_at,auto_profile) VALUES($1,$2,$3,$4,'',now(),true) RETURNING id,auto_profile,published_at", [id, job.owner_id, 'creator-'+id, String(account.username || 'Developer').slice(0,80)])).rows[0]; }
 if (hub.auto_profile && !hub.published_at) await db.query('UPDATE developer_hubs SET published_at=now(),updated_at=now() WHERE id=$1', [hub.id]);
 await db.query(`INSERT INTO developer_listings(project_id,hub_id,title,description,game,access_mode,mobile_support,published_at,snapshot_content_enc,snapshot_content_iv,script_version,snapshot_validated,snapshot_obfuscated,target_mode,place_id,safety_status,safety_hash,snapshot_original_content_enc,snapshot_original_content_iv)
  VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17)
  ON CONFLICT(project_id) DO UPDATE SET hub_id=$2,title=$3,description=$4,game=$5,access_mode=$6,mobile_support=$7,published_at=COALESCE(developer_listings.published_at,now()),snapshot_content_enc=$8,snapshot_content_iv=$9,script_version=$10,snapshot_validated=true,snapshot_obfuscated=$11,target_mode=$12,place_id=$13,safety_status=$14,safety_hash=$15,snapshot_original_content_enc=$16,snapshot_original_content_iv=$17,updated_at=now()`,
  [job.project_id, hub.id, intent.title, intent.description, script.target_mode === 'single' ? intent.game : 'Universal', intent.accessMode, intent.mobileSupport, script.content_enc, script.content_iv, script.version, script.obfuscated, script.target_mode, script.place_id, script.safety_status, script.safety_hash,job.original_content_enc,job.original_content_iv]);
 if (intent.accessMode === 'free') await moderation.recordAutomaticClear(db,job.project_id,'free_snapshot',script.version,script.build_hash);
 await moderation.audit(db, { action: 'listing.published', actorId: job.owner_id, projectId: job.project_id, version: script.version, hash: script.safety_hash });
}
async function saveBuild(db, job, build, scan, encrypted) {
 if (scan.status !== 'clear' || scan.scannerVersion !== SCANNER_VERSION || scan.hash !== build.buildHash) throw fault(422,'SECURITY_UNVERIFIED',safeMessages.SECURITY_UNVERIFIED);
 const row = (await db.query(`INSERT INTO developer_scripts(project_id,content_enc,content_iv,validated,obfuscated,target_mode,place_id,builder_version,build_hash,safety_status,safety_hash,scanner_version,original_content_enc,original_content_iv,filename,original_size_bytes,output_size_bytes,obfuscation_level,build_duration_ms,version)
  VALUES($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$8,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  ON CONFLICT(project_id) DO UPDATE SET content_enc=$2,content_iv=$3,validated=true,obfuscated=$4,target_mode=$5,place_id=$6,builder_version=$7,build_hash=$8,safety_status=$9,safety_hash=$8,scanner_version=$10,original_content_enc=$11,original_content_iv=$12,filename=$13,original_size_bytes=$14,output_size_bytes=$15,obfuscation_level=$16,build_duration_ms=$17,version=$18,updated_at=now() RETURNING *`,
  [job.project_id, encrypted.enc, encrypted.iv, !!build.obfuscated, build.targetMode, build.placeId, build.builderVersion, build.buildHash, 'clear', scan.scannerVersion, job.original_content_enc, job.original_content_iv, job.filename, job.original_size_bytes, build.outputSizeBytes, build.obfuscationLevel, build.buildDurationMs,build.buildHash===job.expected_hash?job.expected_version:job.expected_version+1])).rows[0];
 await moderation.recordAutomaticClear(db,job.project_id,'current',row.version,row.build_hash,scan.findings);
 return row;
}
async function pruneHistory(db, ownerId) {
 const rows=(await db.query("SELECT id,project_id,original_size_bytes,(original_content_enc IS NOT NULL) AS has_original FROM developer_script_jobs WHERE owner_id=$1 AND status IN ('succeeded','failed','cancelled') AND worker_token IS NULL ORDER BY created_at DESC,id DESC",[ownerId])).rows;
 const perProject=new Map(); let bytes=0;
 for(const row of rows){
  const count=(perProject.get(row.project_id)||0)+1;perProject.set(row.project_id,count);
  if(count>100){await db.query('DELETE FROM developer_script_jobs WHERE id=$1',[row.id]);continue;}
  if(!row.has_original)continue;
  if(count<=20 && bytes+row.original_size_bytes<=32*1024*1024){bytes+=row.original_size_bytes;continue;}
  await db.query('UPDATE developer_script_jobs SET original_content_enc=NULL,original_content_iv=NULL WHERE id=$1',[row.id]);
 }
}
async function finish(job, build, scan, signal) {
 return transaction(async db => {
  signal?.throwIfAborted();
  const { account, script } = await available(db, job.project_id, job.owner_id, job.kind === 'publish');
  const live = (await db.query('SELECT status,worker_token FROM developer_script_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
  if (!live || live.status !== 'processing' || live.worker_token !== job.worker_token) throw fault(409, 'SCRIPT_CANCELLED', safeMessages.SCRIPT_CANCELLED);
  if (changed(job, script)) throw fault(409, 'RELEASE_CHANGED', safeMessages.RELEASE_CHANGED);
  if(job.publication){const listing=(await db.query('SELECT updated_at FROM developer_listings WHERE project_id=$1',[job.project_id])).rows[0];if((listing?.updated_at?new Date(listing.updated_at).getTime():null)!==(job.expected_listing_updated_at?new Date(job.expected_listing_updated_at).getTime():null))throw fault(409,'RELEASE_CHANGED',safeMessages.RELEASE_CHANGED);}
  const encrypted = crypto.encryptAES(build.code);
  if (scan.status !== 'clear' || scan.scannerVersion !== SCANNER_VERSION || scan.hash !== build.buildHash) throw Object.assign(fault(422,'SECURITY_UNVERIFIED',safeMessages.SECURITY_UNVERIFIED),{findings:moderation.findings(scan.findings),hash:build.buildHash});
  if (script?.safety_status === 'quarantined' && script.build_hash === build.buildHash) throw Object.assign(fault(422,'SECURITY_UNVERIFIED',safeMessages.SECURITY_UNVERIFIED),{findings:[{rule:'quarantine.unchanged_release',severity:'review',line:1}],hash:build.buildHash});
   const stored = await saveBuild(db, job, build, scan, encrypted);
   await publishIn(db, job, stored, account);
   await moderation.audit(db, { action: 'upload.clear', actorId: job.owner_id, projectId: job.project_id, version: stored.version, hash: build.buildHash, findings: scan.findings });
   const result = { version: stored.version, validated: true, obfuscated: !!build.obfuscated, obfuscationLevel: build.obfuscationLevel, securityStatus: stored.safety_status, targetMode: build.targetMode, placeId: build.placeId, published: job.kind === 'publish' }, status = 'succeeded';
  await db.query('UPDATE developer_script_jobs SET status=$3,progress=100,result=$4::jsonb,output_size_bytes=$5,build_duration_ms=$6,logs=$7::jsonb,finished_at=now(),worker_token=NULL,lease_expires_at=NULL WHERE id=$1 AND worker_token=$2', [job.id, job.worker_token, status, JSON.stringify(result), build.outputSizeBytes, build.buildDurationMs, JSON.stringify([...job.logs, log('info','Automatically verified release saved'+(job.kind === 'publish' ? ' and published.' : '.'))])]);
  await pruneHistory(db,job.owner_id);signal?.throwIfAborted();
 });
}
async function reviewDecision(db, submission, state) {
 if (state === 'approved') throw fault(409,'AUTOMATIC_VERIFICATION_ONLY','Human approval is unavailable. Submit readable source for automatic verification.');
 if (!submission.job_id) return state;
 const job = (await db.query('SELECT * FROM developer_script_jobs WHERE id=$1 FOR UPDATE', [submission.job_id])).rows[0];
 if (!job || job.status !== 'review') return 'stale';
 await db.query("UPDATE developer_script_jobs SET status='failed',error_code=$2,error_message=$3,finished_at=now(),logs=$4::jsonb WHERE id=$1", [job.id, state === 'stale' ? 'RELEASE_CHANGED' : 'SECURITY_REJECTED', state === 'stale' ? safeMessages.RELEASE_CHANGED : 'The release was rejected by security review.', JSON.stringify([...(json(job.logs) || []), log('warning', state === 'stale' ? safeMessages.RELEASE_CHANGED : 'Security review rejected the release; current release preserved.')])]);
 await pruneHistory(db,job.owner_id);return state;
}
async function processJob(job) {
 const controller = new AbortController(); controllers.set(job.id, controller);
 const deadline = setTimeout(() => controller.abort(fault(422, 'SCRIPT_TIMEOUT', safeMessages.SCRIPT_TIMEOUT)), 100000);
 try {
  await update(job, 10, 'info', 'Checking original source safety.');
  const content = crypto.decryptAES(job.original_content_enc, job.original_content_iv);
  const before = scanScript(content, { phase: 'source' });
  if (before.status !== 'clear') { const code=before.status==='blocked'?'SECURITY_BLOCKED':'SECURITY_UNVERIFIED'; throw Object.assign(fault(422,code,safeMessages[code]),{findings:moderation.findings(before.findings),hash:before.hash}); }
  await update(job, 25, 'info', job.obfuscate ? 'Validating and applying '+job.obfuscation_level+' obfuscation.' : 'Validating source without obfuscation.');
  const build = await builder.build(content, { obfuscate: job.obfuscate, obfuscationLevel: job.obfuscation_level, targetMode: job.target_mode, placeId: job.place_id ? Number(job.place_id) : null, signal: controller.signal });
  if (controller.signal.aborted) throw controller.signal.reason || fault(409, 'SCRIPT_CANCELLED', safeMessages.SCRIPT_CANCELLED);
  if (!build.validated || Buffer.byteLength(build.code) > MAX_OUTPUT) throw fault(422, 'SCRIPT_RESOURCE_LIMIT', safeMessages.SCRIPT_RESOURCE_LIMIT);
  await update(job, 75, 'info', 'Output syntax validated; checking delivery safety.');
  const after = scanScript(build.code, { phase: 'output' });
  if (after.status !== 'clear') { const code=after.status==='blocked'?'SECURITY_BLOCKED':'SECURITY_UNVERIFIED'; throw Object.assign(fault(422,code,safeMessages[code]),{findings:moderation.findings([...before.findings,...after.findings]),hash:build.buildHash}); }
  if (after.hash !== build.buildHash) throw Object.assign(fault(422,'SECURITY_BLOCKED',safeMessages.SECURITY_BLOCKED),{findings:[{rule:'release_integrity_mismatch',severity:'high',line:1}],hash:after.hash});
  const scan = combineScans(before,after);
  await update(job, 90, 'info', 'Rechecking account, project and release before saving.');
  await finish(job, build, scan, controller.signal);
 } catch (error) {
  const code = controller.signal.aborted && controller.signal.reason?.code === 'SCRIPT_TIMEOUT' ? 'SCRIPT_TIMEOUT' : error.code || 'SCRIPT_UNAVAILABLE';
  const message = safeMessages[code] || 'The build could not finish. The current release remains active.';
  await query("UPDATE developer_script_jobs SET status='failed',error_code=$3,error_message=$4,finished_at=now(),worker_token=NULL,lease_expires_at=NULL,logs=$5::jsonb,result=$6::jsonb WHERE id=$1 AND status='processing' AND worker_token=$2", [job.id, job.worker_token, code, message, JSON.stringify([...(job.logs || []), log('error', message)]),error.findings?JSON.stringify({findings:error.findings}):null]).catch(() => {});
  await transaction(async db=>{const account=(await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[job.owner_id])).rows[0];const project=(await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[job.project_id])).rows[0];if(account&&project&&['SECURITY_BLOCKED','SECURITY_UNVERIFIED'].includes(code))await moderation.audit(db,{actorId:job.owner_id,action:'upload.blocked',projectId:job.project_id,hash:error.hash,findings:error.findings});await pruneHistory(db,job.owner_id);}).catch(()=>{});
 } finally {
  clearTimeout(deadline); controllers.delete(job.id);
  // Release only after the local subprocess has actually exited. A deleted
  // job cannot release another process's slot because this row has no FK.
  await query('UPDATE developer_script_worker_lease SET worker_token=NULL,expires_at=NULL WHERE id=1 AND worker_token=$1',[job.worker_token]).catch(()=>{});
  await query("UPDATE developer_script_jobs SET worker_token=NULL,lease_expires_at=NULL WHERE id=$1 AND worker_token=$2 AND status='cancelled'",[job.id,job.worker_token]).catch(()=>{});
  await transaction(async db=>{await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE',[job.owner_id]);await pruneHistory(db,job.owner_id);}).catch(()=>{});
 }
}
function retryAfter(ms) {
 clearTimeout(timer);
 if (stopping) return;
 timer = setTimeout(wake, Math.max(250,Math.min(ms,LEASE_MS + 500))); timer.unref();
}
async function claim() {
 return transaction(async db => {
  // A short global admission lock bounds workers across overlapping deployments.
  await db.query('SELECT pg_advisory_xact_lock(1732517019,3)');
  const slot=(await db.query('SELECT worker_token,expires_at FROM developer_script_worker_lease WHERE id=1 FOR UPDATE')).rows[0];
  if(slot?.worker_token&&slot.expires_at&&new Date(slot.expires_at).getTime()>Date.now()){if(!running.size)retryAfter(new Date(slot.expires_at).getTime()-Date.now()+100);return null;}
  await db.query("UPDATE developer_script_jobs SET worker_token=NULL,lease_expires_at=NULL WHERE status='cancelled' AND lease_expires_at<$1",[new Date()]);
  await db.query("UPDATE developer_script_jobs SET status='failed',error_code='SCRIPT_TIMEOUT',error_message=$1,finished_at=now(),worker_token=NULL,lease_expires_at=NULL WHERE status='processing' AND lease_expires_at<$2 AND attempts>=2", [safeMessages.SCRIPT_TIMEOUT, new Date()]);
  await db.query("UPDATE developer_script_jobs SET status='queued',worker_token=NULL,lease_expires_at=NULL WHERE status='processing' AND lease_expires_at<$1 AND attempts<2", [new Date()]);
  const active = (await db.query("SELECT lease_expires_at FROM developer_script_jobs WHERE status='processing' ORDER BY lease_expires_at LIMIT 1")).rows[0];
  if(active){
   // Local workers wake on completion. Only a lease belonging to another
   // process needs a timer; an empty queue leaves the database entirely idle.
   if(!running.size)retryAfter(new Date(active.lease_expires_at).getTime()-Date.now()+100);
   return null;
  }
  const candidate = (await db.query("SELECT id FROM developer_script_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1")).rows[0];
  if (!candidate) return null;
  const token=randomUUID(),expiry=new Date(Date.now()+LEASE_MS);
  const claimed=(await db.query("UPDATE developer_script_jobs SET status='processing',worker_token=$2,lease_expires_at=$3,started_at=now(),attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING *", [candidate.id, token, expiry])).rows[0] || null;
  if(claimed)await db.query('UPDATE developer_script_worker_lease SET worker_token=$1,expires_at=$2 WHERE id=1',[token,expiry]);
  return claimed;
 });
}
function wake() {
 if (stopping || pumping) return;
 clearTimeout(timer); pumping = true;
 pumpTask = new Promise(resolve => setImmediate(async () => {
  try {
   while (!stopping && running.size < WORKERS) {
    const job = await claim(); retries=0; if (!job) break;
    const task = processJob(job).finally(() => { running.delete(task); wake(); }); running.add(task);
   }
  } catch {
   // Durable jobs remain in the database. Retry only a bounded number of
   // times after a failure; owner polling/enqueue/restart can wake them later.
   if(++retries<=5)retryAfter(Math.min(30000,1000*2**retries));
  }
  finally { pumping = false; resolve(); }
 }));
}
function start() {
 if (started) return; started = true; stopping = false; retries=0; wake();
}
async function stop() {
 stopping = true; started = false; clearTimeout(timer);
 await pumpTask;
 for (const controller of controllers.values()) controller.abort(fault(409, 'SCRIPT_CANCELLED', safeMessages.SCRIPT_CANCELLED));
 await Promise.allSettled([...running]);
}
module.exports = { enqueue, list, get, original, cancel, view, options, start, stop, wake, reviewDecision, MAX_SOURCE, MAX_OUTPUT, WORKERS };
