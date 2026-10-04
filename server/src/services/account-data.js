'use strict';
const pool = require('../db');
const crypto = require('./crypto');
const moderation = require('./moderation');
function failure(code, message, status) { const e = new Error(message); Object.assign(e, { code, status }); return e; }
function source(row, encrypted = 'content_enc', iv = 'content_iv') {
  if (!row[encrypted] || !row[iv]) return { source: null };
  try { return { source: crypto.decryptAES(row[encrypted], row[iv]) }; }
  catch { return { source: null, sourceUnavailable: true }; }
}
function omitEncrypted(row, encrypted = 'content_enc', iv = 'content_iv') {
  const { [encrypted]: unusedContent, [iv]: unusedIv, ...metadata } = row;
  return { ...metadata, ...source(row, encrypted, iv) };
}
const owned = 'SELECT id FROM developer_projects WHERE owner_id=$1';
const collections = [
  ['identities', 'SELECT provider,subject,oauth_verified_at FROM developer_identities WHERE account_id=$1 ORDER BY provider,subject'],
  ['sessions', 'SELECT expires_at,(token_hash=$2) AS current FROM developer_sessions WHERE account_id=$1 ORDER BY expires_at'],
  ['emailTokens', 'SELECT purpose,expires_at FROM developer_email_tokens WHERE account_id=$1 ORDER BY expires_at,purpose'],
  ['projects', 'SELECT id,name,description,duration_hours,hwid_binding,checkpoint_provider,checkpoint_link_url,checkpoint_link_id,checkpoint_count,key_ui_mode,key_ui_layout,key_ui_color,key_ui_button_size,disabled,hidden,deleted_at,created_at FROM developer_projects WHERE owner_id=$1 ORDER BY id'],
  ['scripts', `SELECT project_id,content_enc,content_iv,version,updated_at,validated,obfuscated,target_mode,place_id,builder_version,safety_status,scanner_version FROM developer_scripts WHERE project_id IN (${owned}) ORDER BY project_id`, omitEncrypted, 2],
  ['originalSources', `SELECT project_id,original_content_enc,original_content_iv,filename,original_size_bytes,updated_at FROM developer_scripts WHERE project_id IN (${owned}) ORDER BY project_id`, row => omitEncrypted(row, 'original_content_enc', 'original_content_iv'), 1],
  ['scriptJobs', `SELECT id,project_id,kind,status,progress,original_content_enc,original_content_iv,filename,original_size_bytes,output_size_bytes,obfuscate,obfuscation_level,logs,result,error_code,error_message,created_at,started_at,finished_at FROM developer_script_jobs WHERE owner_id=$1 AND project_id IN (${owned}) ORDER BY id`, row => omitEncrypted(row, 'original_content_enc', 'original_content_iv'), 1],
  ['profile', 'SELECT id,slug,name,description,discord_url,website_url,avatar_theme,published_at,created_at,updated_at FROM developer_hubs WHERE owner_id=$1 ORDER BY id'],
  ['publications', `SELECT l.project_id,l.title,l.description,l.game,l.access_mode,l.mobile_support,l.published_at,l.updated_at,l.script_version,l.snapshot_validated,l.snapshot_obfuscated,l.target_mode,l.place_id,l.safety_status,l.snapshot_content_enc,l.snapshot_content_iv FROM developer_listings l JOIN developer_hubs h ON h.id=l.hub_id WHERE l.project_id IN (${owned}) AND h.owner_id=$1 ORDER BY l.project_id`, row => omitEncrypted(row, 'snapshot_content_enc', 'snapshot_content_iv'), 2],
  ['publicationOriginalSources', `SELECT l.project_id,l.script_version,l.updated_at,l.snapshot_original_content_enc,l.snapshot_original_content_iv FROM developer_listings l JOIN developer_hubs h ON h.id=l.hub_id WHERE l.project_id IN (${owned}) AND h.owner_id=$1 ORDER BY l.project_id`, row => omitEncrypted(row, 'snapshot_original_content_enc', 'snapshot_original_content_iv'), 1],
  ['licenses', `SELECT id,project_id,key_prefix,note,expires_at,revoked,admin_revoked,(hwid_hash IS NOT NULL) AS device_bound,created_at FROM developer_licenses WHERE project_id IN (${owned}) ORDER BY id`],
  ['validations', `SELECT id,project_id,license_id,success,reason,executor,created_at FROM developer_events WHERE project_id IN (${owned}) ORDER BY id`],
  ['scriptMetrics', `SELECT project_id,views,executions FROM developer_script_metrics WHERE project_id IN (${owned}) ORDER BY project_id`],
  ['scriptSecurityChecks', `SELECT project_id,target_kind,content_version,scanner_version,checked_at,result,findings FROM developer_script_revalidation WHERE project_id IN (${owned}) ORDER BY project_id,target_kind`],
  ['checkpointSessions', `SELECT project_id,provider,tasks_required,tasks_done,duration_hours,expires_at,created_at FROM developer_checkpoints WHERE project_id IN (${owned}) ORDER BY id`],
  ['moderationSubmissions', `SELECT id,project_id,base_version,version,content_enc,content_iv,target_mode,place_id,builder_version,scanner_version,findings,status,created_at,decided_at FROM developer_moderation_submissions WHERE owner_id=$1 AND project_id IN (${owned}) ORDER BY id`, omitEncrypted, 2],
  ['reportsSubmitted', 'SELECT id,project_id,reason,description,status,created_at,resolved_at FROM developer_moderation_reports WHERE reporter_id=$1 ORDER BY id'],
  ['staffRole', 'SELECT role,updated_at FROM developer_staff_roles WHERE account_id=$1 ORDER BY account_id'],
  ['warnings', 'SELECT id,reason,created_at FROM developer_account_warnings WHERE account_id=$1 ORDER BY created_at,id'],
  ['adminSessions', 'SELECT created_at,last_activity_at FROM developer_admin_sessions WHERE account_id=$1 ORDER BY created_at'],
  ['staffInvitations', "SELECT id,target_type,target_value,role,created_at,expires_at,accepted_at,cancelled_at FROM developer_staff_invitations WHERE target_account_id=$1 OR (target_type='account' AND target_value=$1) OR (target_type='email' AND target_value IN (SELECT email FROM developer_accounts WHERE discord_id=$1 AND email_verified=true)) OR (target_type='discord' AND target_value IN (SELECT subject FROM developer_identities WHERE account_id=$1 AND provider='discord' AND oauth_verified_at IS NOT NULL)) ORDER BY created_at,id"],
  ['adminAudit', "SELECT id,action,target_type,CASE WHEN target_type='account' AND target_id=$1 THEN target_id ELSE NULL END AS target_id,CASE WHEN actor_id=$1 THEN ip ELSE NULL END AS ip,created_at FROM developer_admin_audit WHERE actor_id=$1 OR (target_type='account' AND target_id=$1) ORDER BY created_at,id"],
  ['audit', `SELECT id,action,CASE WHEN project_id IN (${owned}) THEN project_id ELSE NULL END AS project_id,version,rule_ids,status_code,role_value,created_at FROM developer_moderation_audit WHERE actor_id=$1 OR subject_id=$1 OR project_id IN (${owned}) ORDER BY created_at,id`],
];
// Complete, paginated streaming keeps scripts/licences out of a single huge
// in-memory object. A read-only snapshot keeps collections mutually consistent.
async function* exportAccount(accountId, tokenHash, options = {}) {
  const limit = (value, maximum) => Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
  const duration = limit(options.durationMs, 60000), acquisition = limit(options.acquireMs, 5000), queryDuration = limit(options.queryMs, 10000);
  const deadline = Date.now() + duration;
  const controller = new AbortController(), signal = controller.signal;
  const expired = () => failure('EXPORT_TIMEOUT', 'Data export timed out. Please try again.', 504);
  const externalAbort = () => controller.abort(options.signal.reason || failure('EXPORT_CLOSED', 'Export connection closed.', 499));
  let db, released = false, completed = false;
  function release(destroy = false) { if (db && !released) { released = true; db.release(destroy); } }
  // Destroying an interrupted client closes its backend transaction and keeps
  // unfinished queries from being handed to the next pool borrower.
  const interrupt = () => release(true);
  signal.addEventListener('abort', interrupt);
  if (options.signal) {
    if (options.signal.aborted) externalAbort();
    else options.signal.addEventListener('abort', externalAbort, { once: true });
  }
  const deadlineTimer = setTimeout(() => controller.abort(expired()), duration);
  async function connect() {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { if (!settled) { settled = true; cleanup(); reject(signal.reason); } };
      const timer = setTimeout(() => controller.abort(expired()), Math.min(acquisition, Math.max(1, deadline - Date.now())));
      signal.addEventListener('abort', abort, { once: true });
      // A pool checkout that resolves after the timeout is immediately returned;
      // no abandoned request retains that connection.
      Promise.resolve().then(() => { signal.throwIfAborted(); return pool.connect(); }).then(client => {
        if (settled) { client.release(); return; }
        settled = true; cleanup(); resolve(client);
      }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    });
  }
  async function query(sql, params) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) { controller.abort(expired()); throw signal.reason; }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const finish = (callback, value) => { if (!settled) { settled = true; cleanup(); callback(value); } };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => controller.abort(expired()), Math.min(queryDuration, Math.max(1, deadline - Date.now())));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return db.query(sql, params); }).then(result => finish(resolve, result), error => {
        if (error.code === '57014') { controller.abort(expired()); finish(reject, signal.reason); }
        else finish(reject, error);
      });
    });
  }
  try {
    db = await connect(); signal.throwIfAborted();
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL statement_timeout = '10s'");
    await query("SET LOCAL lock_timeout = '5s'");
    const a = (await query('SELECT a.* FROM developer_accounts a JOIN developer_sessions s ON s.account_id=a.discord_id WHERE a.discord_id=$1 AND s.token_hash=$2 AND s.expires_at>now()', [accountId, tokenHash])).rows[0];
    if (!a) throw failure('SESSION_REVOKED', 'Sign in again to export your data.', 401);
    const account = { id: a.discord_id, username: a.username, email: a.email, emailVerified: a.email_verified, createdAt: a.created_at, termsAcceptedAt: a.terms_accepted_at || null, termsVersion: a.terms_version || null, privacyVersion: a.privacy_version || null, bannedAt:a.banned_at,suspendedUntil:a.suspended_until,lastLoginAt:a.last_login_at, moderationRole: await moderation.role(accountId, { query }) };
    yield JSON.stringify({ format: 'audit-hub-account-export', schemaVersion: 1, exportedAt: new Date().toISOString(), account,
      exclusions: ['Authentication/API/provider secrets and password/token hashes', 'Visitor IP/browser/device fingerprints and checkpoint keys', 'Other developers’ private data and other people’s reports or moderation notes', 'Original uploads already discarded are not reconstructed; downloaded copies and provider/backup data'] }).slice(0, -1);
    for (const [name, sql, map = row => row, size = 100] of collections) {
      yield ',' + JSON.stringify(name) + ':[';
      let offset = 0, first = true;
      while (true) {
        const params = name === 'sessions' ? [accountId, tokenHash, size, offset] : [accountId, size, offset];
        const limit = name === 'sessions' ? '$3' : '$2', skip = name === 'sessions' ? '$4' : '$3';
        const rows = (await query(sql + ` LIMIT ${limit} OFFSET ${skip}`, params)).rows;
        for (const row of rows) { yield (first ? '' : ',') + JSON.stringify(map(row)); first = false; }
        if (rows.length < size) break;
        offset += rows.length;
      }
      yield ']';
    }
    await query('COMMIT'); completed = true; yield '}';
  } finally {
    if (db && !released && !completed) {
      try { await query('ROLLBACK'); } catch { release(true); }
    }
    release(); clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', interrupt);
    options.signal?.removeEventListener('abort', externalAbort);
  }
}
async function deleteAccount(accountId, tokenHash) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '20s'");
    await moderation.lockAdminChanges(db);
    const a = (await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [accountId])).rows[0];
    const s = (await db.query('SELECT account_id FROM developer_sessions WHERE account_id=$1 AND token_hash=$2 AND expires_at>now()', [accountId, tokenHash])).rows[0];
    if (!a || !s) throw failure('SESSION_REVOKED', 'Sign in again before deleting your account.', 401);
    const staff = require('./staff-access');
    const ownRole = await staff.role(accountId, db);
    if (ownRole === 'OWNER') throw failure('OWNER_PROTECTED', 'The configured owner cannot delete this account.', 409);
    if (['ADMIN','CO_OWNER'].includes(ownRole)) {
      const configured=String(process.env.MODERATION_ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),values=[accountId,staff.ownerDiscordId(),...configured];
      const configuredSql=configured.length?' OR discord_id IN ('+configured.map((_,i)=>'$'+(i+3)).join(',')+')':'';
      const peers=(await db.query("SELECT discord_id FROM developer_accounts WHERE discord_id<>$1 AND (discord_id IN (SELECT account_id FROM developer_staff_roles WHERE role IN ('ADMIN','CO_OWNER')) OR discord_id IN (SELECT account_id FROM developer_moderation_roles WHERE role='admin') OR discord_id IN (SELECT account_id FROM developer_identities WHERE provider='discord' AND subject=$2 AND oauth_verified_at IS NOT NULL)"+configuredSql+")",values)).rows;
      let replacement = false;
      for(const peer of peers){const candidate=await staff.getStaff(peer.discord_id,db);if(candidate.active&&['OWNER','CO_OWNER','ADMIN'].includes(candidate.role)){replacement=true;break;}}
      if (!replacement) throw failure('LAST_ADMIN', 'Assign another administrator before deleting this account.', 409);
    }
    await eraseAccount(db, accountId);
    await moderation.audit(db, { action: 'account.deleted', statusCode: 200 });
    await db.query('COMMIT'); return { success: true, deleted: true };
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
  finally { db.release(); }
}
// Called only inside a transaction after the caller has authorized and locked
// the account/project. The dedicated admin security audit is deliberately kept.
async function eraseProject(db, projectId) {
  await db.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE',[projectId]);
  await db.query("UPDATE developer_moderation_audit SET project_id=NULL,action_note='',build_hash=NULL,version=NULL,role_value=NULL WHERE project_id=$1",[projectId]);
  for (const table of ['developer_events','developer_moderation_reports','developer_moderation_submissions','developer_script_jobs','developer_checkpoint_receipts','developer_checkpoints','developer_licenses','developer_scripts','developer_listings']) await db.query('DELETE FROM '+table+' WHERE project_id=$1',[projectId]);
  await db.query('DELETE FROM developer_projects WHERE id=$1',[projectId]);
}
async function eraseAccount(db, accountId) {
  await db.query('SELECT id FROM developer_projects WHERE owner_id=$1 ORDER BY id FOR UPDATE',[accountId]);
  await db.query("DELETE FROM developer_staff_invitations WHERE target_account_id=$1 OR (target_type='account' AND target_value=$1) OR (target_type='email' AND target_value IN (SELECT email FROM developer_accounts WHERE discord_id=$1)) OR (target_type='username' AND lower(target_value) IN (SELECT lower(username) FROM developer_accounts WHERE discord_id=$1)) OR (target_type='discord' AND target_value IN (SELECT subject FROM developer_identities WHERE account_id=$1 AND provider='discord'))",[accountId]);
  await db.query("UPDATE developer_staff_invitations SET cancelled_at=now() WHERE created_by=$1 AND accepted_at IS NULL AND cancelled_at IS NULL",[accountId]);
  await db.query("UPDATE developer_moderation_audit SET actor_id=CASE WHEN actor_id=$1 THEN NULL ELSE actor_id END,subject_id=CASE WHEN subject_id=$1 THEN NULL ELSE subject_id END,project_id=CASE WHEN project_id IN ("+owned+") THEN NULL ELSE project_id END,action_note='',build_hash=NULL,version=NULL,role_value=NULL WHERE actor_id=$1 OR subject_id=$1 OR project_id IN ("+owned+")",[accountId]);
  await db.query('DELETE FROM developer_moderation_reports WHERE reporter_id=$1',[accountId]);
  await db.query('DELETE FROM developer_moderation_submissions WHERE owner_id=$1',[accountId]);
  const projects=(await db.query('SELECT id FROM developer_projects WHERE owner_id=$1 ORDER BY id',[accountId])).rows;
  for(const project of projects)await eraseProject(db,project.id);
  await db.query('DELETE FROM developer_hubs WHERE owner_id=$1',[accountId]);
  for (const table of ['developer_admin_sessions','developer_account_warnings','developer_staff_roles','developer_identities','developer_sessions','developer_email_tokens','developer_moderation_roles']) await db.query('DELETE FROM '+table+' WHERE account_id=$1',[accountId]);
  await db.query('DELETE FROM developer_accounts WHERE discord_id=$1',[accountId]);
}
module.exports = { exportAccount, deleteAccount, eraseAccount, eraseProject };
