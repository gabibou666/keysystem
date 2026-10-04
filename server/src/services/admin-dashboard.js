'use strict';
const {proofJoins,listingVerified}=require('./script-publication-policy');
const pool = require('../db');
const access = require('./staff-access');
const auth = require('./developer-auth');
const moderation = require('./moderation');
const { randomUUID } = require('crypto');
const { isIP } = require('net');
const RANK = { USER: 0, MODERATOR: 1, ADMIN: 2, CO_OWNER: 3, OWNER: 4 };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PAGE_SIZE = 25;
function fault(status, message, code = 'ADMIN_ACTION_REFUSED') { return Object.assign(new Error(message), { status, code }); }
function permissions(role) {
  const rank = RANK[role] || 0;
  return { manageUsers: rank >= 2, manageProjects: rank >= 2, deleteScripts: rank >= 2, moderate: rank >= 1, canReadTeam: rank >= 1, manageTeam: rank >= 2, viewAudit: rank >= 3, manageSettings: rank >= 3 };
}
function reason(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 500) throw fault(400, 'Provide a reason up to 500 characters.', 'INVALID_REASON');
  return moderation.privateText(value.trim());
}
function confirmation(body, value) { if (body.confirmation !== value) throw fault(409, 'Confirm this action by entering ' + value + '.', 'CONFIRMATION_REQUIRED'); }
function lower(actor, targetRole, newRole) {
  if (!(RANK[actor.role] > (RANK[targetRole] || 0)) || targetRole === 'OWNER' || newRole === 'OWNER' || newRole && !(RANK[actor.role] > RANK[newRole])) throw fault(403, 'You can act only on roles strictly below your own.', 'ROLE_HIERARCHY');
}
function requireRole(actor, role) { if ((RANK[actor.role] || 0) < RANK[role]) throw fault(403, 'This action requires ' + role + '.', 'PERMISSION_DENIED'); }
function search(query = {}, statuses = ['all']) {
  const page = Number(query.page || 1), q = query.q || '', status = query.status || statuses[0];
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || typeof q !== 'string' || q.length > 100 || !statuses.includes(status)) throw fault(400, 'Invalid search, status or page.', 'INVALID_SEARCH');
  return { page, q, pattern: '%' + q.replace(/[\\%_]/g, '\\$&') + '%', status, offset: (page - 1) * PAGE_SIZE };
}
async function role(accountId, db = pool) { return access.role(accountId, db); }
async function enrichOwners(rows, db = pool) {
  const owners = new Map();
  for (const row of rows) { const id = row.owner_id || row.discord_id; if (id && !owners.has(id)) owners.set(id, await role(id, db)); }
  return rows.map(row => ({ ...row, owner_role: owners.get(row.owner_id || row.discord_id) || 'USER' }));
}
async function pageResult(sql, where, params, page, mapper) {
  const count = (await pool.query('SELECT count(*) AS total ' + sql + ' WHERE ' + where, params)).rows[0];
  const items = (await pool.query('SELECT ' + mapper.columns + ' ' + sql + ' WHERE ' + where + ' ORDER BY ' + mapper.order + ' LIMIT 25 OFFSET $' + (params.length + 1), [...params, page.offset])).rows;
  const total = Number(count.total);
  return { success: true, items: (await enrichOwners(items)).map(mapper.view), total, page: page.page, pages: Math.ceil(total / PAGE_SIZE) };
}
const userColumns = 'a.discord_id,a.username,a.email,a.email_verified,a.created_at,a.banned_at,a.ban_reason,a.suspended_until,a.suspension_reason,a.last_login_at';
function userView(row, actor) {
  return { id: row.discord_id, username: row.username, ...(RANK[actor.role] >= 2 ? { email: row.email, emailVerified: row.email_verified } : {}), role: row.owner_role || 'USER', createdAt: row.created_at, banned: !!row.banned_at, bannedAt: row.banned_at, suspendedUntil: row.suspended_until, projectCount: Number(row.project_count || 0), lastLoginAt: row.last_login_at };
}
async function users(query, actor) {
  const p = search(query, ['all', 'active', 'banned', 'suspended']);
  const status = { all: 'true', active: 'a.banned_at IS NULL AND (a.suspended_until IS NULL OR a.suspended_until<=now())', banned: 'a.banned_at IS NOT NULL', suspended: 'a.suspended_until>now()' }[p.status];
  const matching = '(a.username ILIKE $1 OR a.discord_id ILIKE $1' + (RANK[actor.role] >= 2 ? ' OR a.email ILIKE $1' : '') + ')';
  return pageResult('FROM developer_accounts a LEFT JOIN (SELECT owner_id,count(*) AS project_count FROM developer_projects GROUP BY owner_id) pc ON pc.owner_id=a.discord_id', matching + ' AND ' + status, [p.pattern], p, { columns: userColumns + ',pc.project_count', order: 'a.created_at DESC,a.discord_id', view: row => userView(row, actor) });
}
async function user(id, actor) {
  if (typeof id !== 'string' || id.length > 255) throw fault(404, 'Account not found.');
  const row = (await pool.query('SELECT ' + userColumns + ' FROM developer_accounts a WHERE a.discord_id=$1', [id])).rows[0];
  if (!row) throw fault(404, 'Account not found.');
  row.owner_role = await role(id);
  const projects = (await pool.query('SELECT p.id,p.name,p.created_at,p.disabled,p.hidden,COALESCE(l.total,0) AS license_count FROM developer_projects p LEFT JOIN (SELECT project_id,count(*) AS total FROM developer_licenses WHERE project_id IN (SELECT id FROM developer_projects WHERE owner_id=$1) GROUP BY project_id) l ON l.project_id=p.id WHERE p.owner_id=$1 ORDER BY p.created_at DESC LIMIT 100', [id])).rows.map(p=>({id:p.id,name:p.name,createdAt:p.created_at,disabled:p.disabled,hidden:p.hidden,licenseCount:Number(p.license_count||0)}));
  const projectCount=Number((await pool.query('SELECT count(*) AS total FROM developer_projects WHERE owner_id=$1',[id])).rows[0].total);
  const warnings = (await pool.query('SELECT id,reason,created_at FROM developer_account_warnings WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100', [id])).rows.map(w => ({ id: w.id, message: w.reason, createdAt: w.created_at }));
  return { success: true, user: { ...userView({ ...row, project_count: projectCount }, actor), banReason: row.ban_reason, suspensionReason: row.suspension_reason }, projects, warnings };
}
async function projects(query) {
  const p = search(query, ['all', 'active', 'disabled']);
  const state = p.status === 'disabled' ? '(p.disabled=true OR p.deleted_at IS NOT NULL)' : p.status === 'active' ? 'p.disabled=false AND p.deleted_at IS NULL' : 'true';
  return pageResult('FROM developer_projects p JOIN developer_accounts a ON a.discord_id=p.owner_id LEFT JOIN developer_scripts s ON s.project_id=p.id LEFT JOIN (SELECT project_id,count(*) AS license_count FROM developer_licenses GROUP BY project_id) lc ON lc.project_id=p.id', '(p.name ILIKE $1 OR p.id::text ILIKE $1 OR a.username ILIKE $1) AND ' + state, [p.pattern], p, { columns: 'p.id,p.name,p.owner_id,a.username AS owner_name,p.created_at,p.disabled,p.hidden,p.deleted_at,lc.license_count,s.version', order: 'p.created_at DESC,p.id', view: r => ({ id: r.id, name: r.name, ownerId: r.owner_id, ownerName: r.owner_name, ownerRole: r.owner_role, createdAt: r.created_at, disabled: r.disabled, hidden: r.hidden, deletedAt: r.deleted_at, licenseCount: Number(r.license_count || 0), scriptVersion: r.version || null }) });
}
async function licenses(query) {
  const p = search(query, ['all', 'active', 'revoked', 'expired']);
  const state = { all: 'true', active: 'l.revoked=false AND l.expires_at>now()', revoked: 'l.revoked=true', expired: 'l.expires_at<=now()' }[p.status];
  return pageResult('FROM developer_licenses l JOIN developer_projects p ON p.id=l.project_id JOIN developer_accounts a ON a.discord_id=p.owner_id', '(l.id::text ILIKE $1 OR l.project_id::text ILIKE $1 OR l.key_prefix ILIKE $1 OR p.name ILIKE $1 OR a.username ILIKE $1) AND ' + state, [p.pattern], p, { columns: 'l.id,l.project_id,l.key_prefix,l.note,l.expires_at,l.revoked,l.admin_revoked,l.created_at,p.name AS project_name,p.owner_id', order: 'l.created_at DESC,l.id', view: r => ({ id: r.id, projectId: r.project_id, projectName: r.project_name, ownerId: r.owner_id, ownerRole: r.owner_role, keyPrefix: r.key_prefix, note: moderation.privateText(r.note), expiresAt: r.expires_at, revoked: r.revoked, adminRevoked: r.admin_revoked, createdAt: r.created_at }) });
}
async function scripts(query) {
  const p = search(query, ['all', 'published', 'hidden', 'removed']);
  const state = { all: 'true', published: 'l.published_at IS NOT NULL AND p.hidden=false AND s.deleted_at IS NULL', hidden: 'p.hidden=true AND s.deleted_at IS NULL', removed: 's.deleted_at IS NOT NULL' }[p.status];
  return pageResult('FROM developer_scripts s JOIN developer_projects p ON p.id=s.project_id JOIN developer_accounts a ON a.discord_id=p.owner_id LEFT JOIN developer_listings l ON l.project_id=p.id LEFT JOIN (SELECT project_id,count(*) AS report_count FROM developer_moderation_reports WHERE status=\'open\' GROUP BY project_id) rc ON rc.project_id=p.id', '(p.name ILIKE $1 OR l.title ILIKE $1 OR p.id::text ILIKE $1 OR a.username ILIKE $1) AND ' + state, [p.pattern], p, { columns: 'p.id,p.name,p.owner_id,a.username AS owner_name,p.hidden,s.disabled,s.deleted_at,s.version,s.safety_status,s.updated_at,s.obfuscated,s.obfuscation_level,l.title,l.published_at,rc.report_count', order: 's.updated_at DESC,p.id', view: r => ({ projectId: r.id, title: r.title || r.name, ownerId: r.owner_id, ownerName: r.owner_name, ownerRole: r.owner_role, published: !!r.published_at, hidden: r.hidden, removed: !!r.deleted_at, disabled: r.disabled, version: r.version, safetyStatus: r.safety_status, obfuscated: r.obfuscated, obfuscationLevel: r.obfuscation_level, updatedAt: r.updated_at, openReportCount: Number(r.report_count || 0) }) });
}
async function reports(query) {
  const p = search(query, ['open', 'processed', 'rejected']);
  const state = p.status === 'open' ? 'r.status=\'open\'' : p.status === 'rejected' ? 'r.status=\'resolved\' AND r.resolution_reason=\'rejected\'' : 'r.status=\'resolved\' AND r.resolution_reason<>\'rejected\'';
  const sql = 'FROM developer_moderation_reports r JOIN developer_projects p ON p.id=r.project_id LEFT JOIN developer_listings l ON l.project_id=p.id';
  const where=state+' AND (r.description ILIKE $1 OR p.name ILIKE $1 OR l.title ILIKE $1 OR r.project_id::text ILIKE $1)';
  const total = Number((await pool.query('SELECT count(*) AS total ' + sql + ' WHERE ' + where,[p.pattern])).rows[0].total);
  const rows = (await pool.query('SELECT r.id,r.project_id,r.reason,r.description,r.status,r.created_at,r.resolved_at,r.staff_note,r.resolution_reason,l.title,p.name ' + sql + ' WHERE ' + where + ' ORDER BY r.created_at DESC,r.id LIMIT 25 OFFSET $2', [p.pattern,p.offset])).rows;
  return { success: true, items: rows.map(r => ({ id: r.id, projectId: r.project_id, title: r.title || r.name, reason: r.reason, description: moderation.privateText(r.description), status: r.status === 'open' ? 'open' : r.resolution_reason === 'rejected' ? 'rejected' : 'processed', createdAt: r.created_at, resolvedAt: r.resolved_at, note: moderation.privateText(r.staff_note) })), total, page: p.page, pages: Math.ceil(total / PAGE_SIZE) };
}
async function overview(actor) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - 29);
  const definitions = {
    users: 'SELECT count(*) AS total FROM developer_accounts',
    projects: 'SELECT count(*) AS total FROM developer_projects WHERE deleted_at IS NULL',
    licenses: 'SELECT count(*) AS total FROM developer_licenses',
    scripts: `SELECT count(*) AS total FROM developer_listings l
      JOIN developer_hubs h ON h.id=l.hub_id
      JOIN developer_projects p ON p.id=l.project_id
      JOIN developer_scripts s ON s.project_id=p.id
      JOIN developer_accounts a ON a.discord_id=p.owner_id
      ${proofJoins}
      WHERE l.published_at IS NOT NULL AND h.published_at IS NOT NULL
        AND ${listingVerified}
        AND p.disabled=false AND p.hidden=false AND p.deleted_at IS NULL
        AND s.disabled=false AND s.deleted_at IS NULL
        AND a.banned_at IS NULL AND (a.suspended_until IS NULL OR a.suspended_until<=now())`,
    openReports: 'SELECT count(*) AS total FROM developer_moderation_reports WHERE status=\'open\'',
    bannedUsers: 'SELECT count(*) AS total FROM developer_accounts WHERE banned_at IS NOT NULL',
    suspendedUsers: 'SELECT count(*) AS total FROM developer_accounts WHERE suspended_until>now()',
    newUsers30d: 'SELECT count(*) AS total FROM developer_accounts WHERE created_at>=$1',
    issuedLicenses30d: 'SELECT count(*) AS total FROM developer_licenses WHERE created_at>=$1',
  };
  const entries = await Promise.all(Object.entries(definitions).map(async ([key, sql]) => [key, Number((await pool.query(sql, sql.includes('$1') ? [start] : [])).rows[0].total)]));
  const daily = Array.from({ length: 30 }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return { date: d.toISOString().slice(0, 10), users: 0, licenses: 0, validations: 0 }; });
  for (const [table, key] of [['developer_accounts', 'users'], ['developer_licenses', 'licenses'], ['developer_events', 'validations']]) {
    const rows = (await pool.query('SELECT CAST(created_at AS date) AS day,count(*) AS total FROM ' + table + ' WHERE created_at>=$1 GROUP BY CAST(created_at AS date)', [start])).rows;
    for (const row of rows) { const day = new Date(row.day).toISOString().slice(0, 10), entry = daily.find(d => d.date === day); if (entry) entry[key] = Number(row.total); }
  }
  const recent = RANK[actor.role] >= 3 ? (await pool.query('SELECT id,action,created_at FROM developer_admin_audit ORDER BY created_at DESC,id LIMIT 8')).rows.map(r => ({ id: r.id, action: r.action, createdAt: r.created_at })) : [];
  return { success: true, periodDays: 30, stats: Object.fromEntries(entries), daily, recent };
}
async function audit(db, req, actor, action, targetType, targetId, note, before = {}, after = {}) {
  const rawIp = String(req.ip || '').replace(/^::ffff:/, '');
  await db.query('INSERT INTO developer_admin_audit(id,actor_id,actor_role,action,target_type,target_id,reason,before_data,after_data,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)', [randomUUID(), actor.accountId, actor.role, action, targetType, targetId || null, reason(note), JSON.stringify(before), JSON.stringify(after), isIP(rawIp) ? rawIp : '']);
}
async function transaction(req, minRole, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '20s'");
    await moderation.lockAdminChanges(db);
    const accountId = req.staff.accountId;
    await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [accountId]);
    const actor = await access.getStaff(accountId, db);
    if (!actor.active || RANK[actor.role] < RANK[minRole]) throw fault(403, 'Staff permission changed. Activate administration again.', 'PERMISSION_DENIED');
    const session = (await db.query("SELECT token_hash FROM developer_admin_sessions WHERE token_hash=$1 AND account_id=$2 AND developer_session_hash=$3 AND last_activity_at>now()-interval '2 hours'", [req.adminSession.tokenHash, accountId, auth.hash(req.cookies[auth.COOKIE])])).rows[0];
    if (!session) throw fault(401, 'Your administration session has expired.', 'ADMIN_SESSION_REQUIRED');
    const result = await work(db, actor);
    await db.query('COMMIT'); return result;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
async function accountTarget(db, actor, id) {
  if (typeof id !== 'string' || id.length > 255) throw fault(404, 'Account not found.');
  const row = (await db.query('SELECT discord_id,username,banned_at,suspended_until FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw fault(404, 'Account not found.');
  const targetRole = await role(id, db); lower(actor, targetRole); return { ...row, role: targetRole };
}
async function projectTarget(db, actor, id) {
  if (!UUID.test(id)) throw fault(404, 'Project not found.');
  const lookup = (await db.query('SELECT owner_id FROM developer_projects WHERE id=$1', [id])).rows[0];
  if (!lookup) throw fault(404, 'Project not found.');
  await accountTarget(db, actor, lookup.owner_id);
  const project = (await db.query('SELECT id,owner_id,disabled,hidden,deleted_at FROM developer_projects WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!project) throw fault(404, 'Project not found.'); return project;
}
async function userAction(req, action) {
  const body = req.body || {}, note = reason(action === 'warn' ? body.message : body.reason);
  if (action === 'ban') confirmation(body, 'BAN');
  if (action === 'delete') confirmation(body, 'DELETE');
  if (action === 'warn' && !note) throw fault(400, 'Provide an explanatory warning.');
  let until;
  if (action === 'suspend') { until = new Date(body.until); if (!Number.isFinite(until.getTime()) || until <= new Date() || until.getTime() > Date.now() + 90 * 86400000) throw fault(400, 'Choose a suspension ending within 90 days.'); }
  return transaction(req, action === 'warn' ? 'MODERATOR' : 'ADMIN', async (db, actor) => {
    const target = await accountTarget(db, actor, req.params.id);
    if (action === 'ban') await db.query('UPDATE developer_accounts SET banned_at=now(),ban_reason=$1 WHERE discord_id=$2', [note, target.discord_id]);
    if (action === 'unban') await db.query("UPDATE developer_accounts SET banned_at=NULL,ban_reason='',suspended_until=NULL,suspension_reason='' WHERE discord_id=$1", [target.discord_id]);
    if (action === 'suspend') await db.query('UPDATE developer_accounts SET suspended_until=$1,suspension_reason=$2 WHERE discord_id=$3', [until, note, target.discord_id]);
    if (['ban', 'suspend', 'logout'].includes(action)) await db.query('DELETE FROM developer_sessions WHERE account_id=$1', [target.discord_id]);
    if (action === 'warn') await db.query('INSERT INTO developer_account_warnings(id,account_id,created_by,reason) VALUES($1,$2,$3,$4)', [randomUUID(), target.discord_id, actor.accountId, note]);
    if (action === 'delete') await require('./account-data').eraseAccount(db, target.discord_id);
    await audit(db, req, actor, 'user.' + action, 'account', target.discord_id, note, { role: target.role, banned: !!target.banned_at, suspendedUntil: target.suspended_until }, { action, ...(until ? { suspendedUntil: until.toISOString() } : {}) });
    return { success: true, action, id: target.discord_id };
  });
}
async function projectAction(req, action) {
  const note = reason(req.body.reason); if (action === 'delete') confirmation(req.body, 'DELETE');
  return transaction(req, 'ADMIN', async (db, actor) => {
    const p = await projectTarget(db, actor, req.params.id);
    if (action === 'delete') await require('./account-data').eraseProject(db, p.id);
    else await db.query('UPDATE developer_projects SET disabled=$1,disabled_reason=$2 WHERE id=$3', [action === 'disable', action === 'disable' ? note : '', p.id]);
    await audit(db, req, actor, 'project.' + action, 'project', p.id, note, { disabled: p.disabled }, { action });
    return { success: true, action, id: p.id };
  });
}
async function licenseAction(req, action) {
  const note = reason(req.body.reason);
  return transaction(req, 'ADMIN', async (db, actor) => {
    if (!UUID.test(req.params.id)) throw fault(404, 'Licence not found.');
    const lookup = (await db.query('SELECT project_id FROM developer_licenses WHERE id=$1', [req.params.id])).rows[0];
    if (!lookup) throw fault(404, 'Licence not found.');
    await projectTarget(db, actor, lookup.project_id);
    const old = (await db.query('SELECT id,revoked FROM developer_licenses WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!old) throw fault(404, 'Licence not found.');
    await db.query('UPDATE developer_licenses SET revoked=$1,admin_revoked=$1,admin_revoked_reason=$2,admin_revoked_at=$3 WHERE id=$4', [action === 'revoke',action === 'revoke' ? note : '',action === 'revoke'?new Date():null, old.id]);
    await audit(db, req, actor, 'license.' + action, 'license', old.id, note, { revoked: old.revoked }, { revoked: action === 'revoke' });
    return { success: true, action, id: old.id };
  });
}
async function changeScript(db, req, actor, projectId, action, note) {
  const p = await projectTarget(db, actor, projectId);
  const script = (await db.query('SELECT project_id,disabled,deleted_at,version FROM developer_scripts WHERE project_id=$1', [p.id])).rows[0];
  if (!script) throw fault(404, 'Script not found.');
  if (action === 'delete' || action === 'unhide' && (script.disabled || script.deleted_at)) requireRole(actor, 'ADMIN');
  await db.query('UPDATE developer_projects SET hidden=$1 WHERE id=$2', [action !== 'unhide', p.id]);
  if (action === 'remove' || action === 'delete') await db.query('UPDATE developer_listings SET published_at=NULL,updated_at=now() WHERE project_id=$1', [p.id]);
  if (action === 'unhide' && (script.disabled || script.deleted_at)) await db.query('UPDATE developer_scripts SET disabled=false,deleted_at=NULL WHERE project_id=$1', [p.id]);
  if (action === 'delete') {
    await db.query('DELETE FROM developer_script_jobs WHERE project_id=$1',[p.id]);
    await db.query("UPDATE developer_scripts SET content_enc='',content_iv='',original_content_enc=NULL,original_content_iv=NULL,original_size_bytes=NULL,output_size_bytes=NULL,obfuscation_level=NULL,disabled=true,deleted_at=now(),validated=false,obfuscated=false,safety_status='unreviewed',build_hash=NULL,safety_hash=NULL WHERE project_id=$1", [p.id]);
    await db.query("UPDATE developer_listings SET snapshot_content_enc=NULL,snapshot_content_iv=NULL,snapshot_validated=false,snapshot_obfuscated=false,safety_status='unreviewed',safety_hash=NULL WHERE project_id=$1", [p.id]);
    await db.query("UPDATE developer_moderation_submissions SET content_enc=NULL,content_iv=NULL,status=CASE WHEN status='pending' THEN 'rejected' ELSE status END,decided_at=COALESCE(decided_at,now()) WHERE project_id=$1", [p.id]);
  }
  await audit(db, req, actor, 'script.' + action, 'project', p.id, note, { hidden: p.hidden, removed: !!script.deleted_at, version: script.version }, { action });
}
async function scriptAction(req, action) {
  const note = reason(req.body.reason); if (action === 'delete') confirmation(req.body, 'DELETE');
  return transaction(req, action === 'delete' ? 'ADMIN' : 'MODERATOR', async (db, actor) => { await changeScript(db, req, actor, req.params.id, action, note); return { success: true, action, id: req.params.id }; });
}
async function reportDecision(req) {
  const body = req.body, decision = body.decision, action = body.action || 'none', note = reason(body.note);
  if (!['processed', 'rejected'].includes(decision) || !['none', 'hide', 'ban'].includes(action) || decision === 'rejected' && action !== 'none') throw fault(400, 'Choose a valid report decision and action.');
  if (action === 'ban') confirmation(body, 'BAN');
  return transaction(req, action === 'ban' ? 'ADMIN' : 'MODERATOR', async (db, actor) => {
    if (!UUID.test(req.params.id)) throw fault(404, 'Report not found.');
    const lookup = (await db.query('SELECT project_id FROM developer_moderation_reports WHERE id=$1', [req.params.id])).rows[0];
    if (!lookup) throw fault(404, 'Report not found.');
    const project = await projectTarget(db, actor, lookup.project_id);
    const report = (await db.query('SELECT id,status FROM developer_moderation_reports WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!report) throw fault(404, 'Report not found.');
    if (report.status !== 'open') throw fault(409, 'This report has already been handled.');
    if (action === 'hide') await changeScript(db, req, actor, project.id, 'hide', note);
    if (action === 'ban') {
      await db.query('UPDATE developer_accounts SET banned_at=now(),ban_reason=$1 WHERE discord_id=$2', [note, project.owner_id]);
      await db.query('DELETE FROM developer_sessions WHERE account_id=$1', [project.owner_id]);
      await audit(db, req, actor, 'user.ban', 'account', project.owner_id, note, {}, { banned: true });
    }
    await db.query("UPDATE developer_moderation_reports SET status='resolved',staff_note=$1,resolution_note=$1,resolution_reason=$2,resolved_at=now(),assigned_to=$3 WHERE id=$4", [note, decision, actor.accountId, report.id]);
    await audit(db, req, actor, 'report.' + decision, 'report', report.id, note, { status: 'open' }, { decision, action });
    return { success: true, id: report.id, decision, action };
  });
}
async function team(actor) {
  const rows = (await pool.query('SELECT a.discord_id,a.username,a.email FROM developer_accounts a WHERE a.discord_id IN (SELECT account_id FROM developer_staff_roles) OR a.discord_id IN (SELECT account_id FROM developer_moderation_roles) OR a.discord_id IN (SELECT account_id FROM developer_identities WHERE provider=\'discord\' AND subject=$1 AND oauth_verified_at IS NOT NULL) ORDER BY a.username,a.discord_id', [access.ownerDiscordId()])).rows;
  const items = [];
  for (const row of rows) { const r = await role(row.discord_id); if (RANK[r]) items.push({ id: row.discord_id, username: row.username, ...(RANK[actor.role]>=2?{email:row.email}:{}), role: r }); }
  for (const id of String(process.env.MODERATION_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (!items.some(r => r.id === id)) { const row = (await pool.query('SELECT discord_id,username,email FROM developer_accounts WHERE discord_id=$1', [id])).rows[0]; if(row){const effective=await role(row.discord_id);if(access.isStaff(effective))items.push({id:row.discord_id,username:row.username,...(RANK[actor.role]>=2?{email:row.email}:{}),role:effective});} }
  }
  const invites = (await pool.query('SELECT id,target_type,target_value,role,target_account_id,created_at,expires_at,accepted_at,cancelled_at FROM developer_staff_invitations ORDER BY created_at DESC LIMIT 100')).rows.map(inviteView);
  return { success: true, items, invites: RANK[actor.role]>=2?invites:invites.map(i=>({id:i.id,role:i.role,status:i.status,createdAt:i.createdAt,expiresAt:i.expiresAt})) };
}
function inviteView(r) { return { id: r.id, targetType: r.target_type, target: r.target_value, email: r.target_type === 'email' ? r.target_value : undefined, role: r.role, status: r.cancelled_at ? 'cancelled' : r.accepted_at ? 'accepted' : new Date(r.expires_at) <= new Date() ? 'expired' : !r.target_account_id && r.target_type === 'username' ? 'identity_required' : 'pending', requiresBinding: !r.target_account_id && r.target_type === 'username', createdAt: r.created_at, expiresAt: r.expires_at }; }
async function teamRole(req) {
  const newRole = String(req.body.role || '').toUpperCase(), note = reason(req.body.reason);
  if (!['USER', 'MODERATOR', 'ADMIN', 'CO_OWNER'].includes(newRole)) throw fault(400, 'Choose a valid assignable staff role.');
  if (['ADMIN', 'CO_OWNER'].includes(newRole)) confirmation(req.body, newRole);
  return transaction(req, 'ADMIN', async (db, actor) => {
    const target = await accountTarget(db, actor, req.params.id); lower(actor, target.role, newRole);
    await db.query('INSERT INTO developer_staff_roles(account_id,role,updated_by) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET role=$2,updated_by=$3,updated_at=now()', [target.discord_id, newRole, actor.accountId]);
    // Old assignments must not remain as an alternate authorization path.
    await db.query('DELETE FROM developer_moderation_roles WHERE account_id=$1', [target.discord_id]);
    await db.query('DELETE FROM developer_admin_sessions WHERE account_id=$1', [target.discord_id]);
    await db.query('UPDATE developer_staff_invitations SET cancelled_at=now() WHERE created_by=$1 AND accepted_at IS NULL AND cancelled_at IS NULL', [target.discord_id]);
    await audit(db, req, actor, 'team.role_changed', 'account', target.discord_id, note, { role: target.role }, { role: newRole });
    return { success: true, id: target.discord_id, role: newRole };
  });
}
async function invitationTarget(db, type, value) {
  if (!['email', 'discord', 'username', 'account'].includes(type) || typeof value !== 'string' || !value.trim() || value.length > 255) throw fault(400, 'Choose an identity type and a valid identifier.');
  value = value.trim(); let rows;
  if (type === 'email') { value = require('./account-identity').normalizeEmail(value); if (!require('./account-identity').validEmail(value)) throw fault(400, 'Provide a valid email address.'); rows = (await db.query('SELECT discord_id FROM developer_accounts WHERE email=$1 AND email_verified=true', [value])).rows; }
  else if (type === 'discord') { if (!/^\d{17,20}$/.test(value)) throw fault(400, 'Provide a Discord user ID.'); rows = (await db.query("SELECT account_id AS discord_id FROM developer_identities WHERE provider='discord' AND subject=$1 AND oauth_verified_at IS NOT NULL", [value])).rows; }
  else if (type === 'account') rows = (await db.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 AND (email_verified=true OR discord_id IN (SELECT account_id FROM developer_identities WHERE oauth_verified_at IS NOT NULL))', [value])).rows;
  else rows = (await db.query('SELECT discord_id FROM developer_accounts WHERE lower(username)=lower($1) AND (email_verified=true OR discord_id IN (SELECT account_id FROM developer_identities WHERE oauth_verified_at IS NOT NULL))', [value])).rows;
  if (rows.length > 1) throw fault(409, 'This name is ambiguous. Use a verified email or Discord ID.');
  if (type === 'account' && !rows[0]) throw fault(404, 'A verified account with that ID was not found.');
  return { value, accountId: rows[0]?.discord_id || null };
}
async function invite(req) {
  const body = req.body, newRole = String(body.role || '').toUpperCase(), note = reason(body.reason);
  if (!['MODERATOR', 'ADMIN', 'CO_OWNER'].includes(newRole)) throw fault(400, 'Choose an assignable staff role.');
  if (['ADMIN', 'CO_OWNER'].includes(newRole)) confirmation(body, newRole);
  return transaction(req, 'ADMIN', async (db, actor) => {
    lower(actor, 'USER', newRole);
    const target = await invitationTarget(db, body.targetType || 'email', body.target || body.email);
    if (target.accountId) await accountTarget(db, actor, target.accountId);
    const old = (await db.query('SELECT id FROM developer_staff_invitations WHERE target_type=$1 AND target_value=$2 AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at>now()', [body.targetType || 'email', target.value])).rows[0];
    if (old) throw fault(409, 'An active invitation already targets that identity.');
    const id = randomUUID(), expires = new Date(Date.now() + 7 * 86400000);
    const row = (await db.query('INSERT INTO developer_staff_invitations(id,target_type,target_value,role,target_account_id,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,target_type,target_value,role,target_account_id,created_at,expires_at,accepted_at,cancelled_at', [id, body.targetType || 'email', target.value, newRole, target.accountId, actor.accountId, expires])).rows[0];
    await audit(db, req, actor, 'team.invited', 'invitation', id, note, {}, { role: newRole, targetType: row.target_type, pending: true });
    return { success: true, invite: inviteView(row) };
  });
}
async function invitationAction(req, action) {
  const note = reason(req.body?.reason);
  return transaction(req, action === 'bind' ? 'CO_OWNER' : 'ADMIN', async (db, actor) => {
    if (!UUID.test(req.params.id)) throw fault(404, 'Invitation not found.');
    const row = (await db.query('SELECT id,target_type,target_value,role,target_account_id,created_at,expires_at,accepted_at,cancelled_at FROM developer_staff_invitations WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!row) throw fault(404, 'Invitation not found.'); lower(actor, 'USER', row.role);
    if (row.accepted_at || row.cancelled_at || new Date(row.expires_at) <= new Date()) throw fault(409, 'This invitation is no longer pending.');
    if (action === 'bind') {
      if (!['email', 'discord', 'account'].includes(req.body.targetType)) throw fault(400, 'Bind to a verified email, Discord ID or account.');
      const target = await invitationTarget(db, req.body.targetType, req.body.target);
      if (!target.accountId) throw fault(404, 'The verified account was not found.');
      await accountTarget(db, actor, target.accountId);
      await db.query('UPDATE developer_staff_invitations SET target_account_id=$1,target_type=$2,target_value=$3 WHERE id=$4', [target.accountId, req.body.targetType, target.value, row.id]);
    } else await db.query('UPDATE developer_staff_invitations SET cancelled_at=now() WHERE id=$1', [row.id]);
    await audit(db, req, actor, 'team.invitation_' + action, 'invitation', row.id, note, {}, { action });
    return { success: true, id: row.id, action };
  });
}
async function auditLog(query) {
  const p = search(query), action = query.action || '';
  if (typeof action !== 'string' || action.length > 80 || action && !/^[a-z_.-]+$/.test(action)) throw fault(400, 'Invalid action filter.');
  const where = '(action ILIKE $1 OR target_id ILIKE $1 OR actor_id ILIKE $1) AND ($2=\'\' OR action=$2)';
  const total = Number((await pool.query('SELECT count(*) AS total FROM developer_admin_audit WHERE ' + where, [p.pattern, action])).rows[0].total);
  const rows = (await pool.query('SELECT id,actor_id,actor_role,action,target_type,target_id,reason,before_data,after_data,ip,created_at FROM developer_admin_audit WHERE ' + where + ' ORDER BY created_at DESC,id LIMIT 25 OFFSET $3', [p.pattern, action, p.offset])).rows;
  return { success: true, items: rows.map(r => ({ id: r.id, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, targetType: r.target_type, targetId: r.target_id, note: r.reason, before: r.before_data, after: r.after_data, ip: r.ip, createdAt: r.created_at })), total, page: p.page, pages: Math.ceil(total / PAGE_SIZE) };
}
async function settings() { return { success: true, settings: await require('./site-controls').getSettings({ fresh: true }) }; }
async function updateSettings(req) {
  const b = req.body, note = reason(b.reason);
  if (typeof b.maintenance !== 'boolean' || typeof b.registrationsOpen !== 'boolean' || typeof b.announcement !== 'string' || b.announcement.length > 500 || b.maintenanceMessage !== undefined && (typeof b.maintenanceMessage !== 'string' || b.maintenanceMessage.length > 500) || b.announcementEnabled !== undefined && typeof b.announcementEnabled !== 'boolean' || b.announcementLevel !== undefined && !['info', 'warning', 'success'].includes(b.announcementLevel)) throw fault(400, 'Provide valid site settings.');
  const result = await transaction(req, 'CO_OWNER', async (db, actor) => {
    const before = (await db.query('SELECT maintenance_enabled,registration_open,announcement_enabled,announcement_level FROM developer_site_settings WHERE id=1 FOR UPDATE')).rows[0];
    await db.query('UPDATE developer_site_settings SET maintenance_enabled=$1,maintenance_message=$2,registration_open=$3,announcement_enabled=$4,announcement_message=$5,announcement_level=$6,updated_at=now(),updated_by=$7 WHERE id=1', [b.maintenance, b.maintenanceMessage || '', b.registrationsOpen, b.announcementEnabled ?? !!b.announcement.trim(), b.announcement.trim(), b.announcementLevel || 'info', actor.accountId]);
    await audit(db, req, actor, 'settings.updated', 'site', '1', note, before || {}, { maintenance: b.maintenance, registrationsOpen: b.registrationsOpen, announcementEnabled: b.announcementEnabled ?? !!b.announcement.trim(), announcementLevel: b.announcementLevel || 'info' });
    return { success: true };
  });
  require('./site-controls').invalidateSettings(); return { ...result, settings: await require('./site-controls').getSettings({ fresh: true }) };
}
module.exports = { RANK, permissions, fault, reason, confirmation, lower, requireRole, search, users, user, projects, licenses, scripts, reports, overview, transaction, accountTarget, projectTarget, audit, userAction, projectAction, licenseAction, scriptAction, reportDecision, team, teamRole, invite, invitationAction, auditLog, settings, updateSettings };
