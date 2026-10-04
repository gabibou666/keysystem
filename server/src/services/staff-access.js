'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { normalizeEmail } = require('./account-identity');
const RANK = Object.freeze({ USER: 0, MODERATOR: 1, ADMIN: 2, CO_OWNER: 3, OWNER: 4 });
const COOKIE = 'ah_admin_session';
const IDLE_MS = 2 * 60 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ownerDiscordId = () => String(process.env.OWNER_DISCORD_ID || '899294059225579531').trim();
const normalizeRole = value => {
  const role = String(typeof value === 'object' && value ? value.role : value || 'USER').toUpperCase().replace(/-/g, '_');
  return Object.hasOwn(RANK, role) ? role : 'USER';
};
const rank = value => RANK[normalizeRole(value)];
const isStaff = value => rank(value) >= RANK.MODERATOR;
const fail = (code, message, status = 403) => Object.assign(new Error(message), { code, status });
function canAct(actor, target, nextRole) {
  const actorRole = normalizeRole(actor), targetRole = normalizeRole(target);
  return isStaff(actorRole) && targetRole !== 'OWNER' && rank(actorRole) > rank(targetRole) &&
    (nextRole === undefined || (normalizeRole(nextRole) !== 'OWNER' && rank(actorRole) > rank(nextRole)));
}
function assertLower(actor, target, nextRole) {
  if (!canAct(actor, target, nextRole)) throw fail('ROLE_HIERARCHY', 'You can only manage accounts and roles below your own.');
}
async function lockAdminChanges(db) { await db.query('SELECT pg_advisory_xact_lock(1732517019,1)'); }
async function getStaff(accountId, db = pool) {
  const account = (await db.query('SELECT discord_id,username,email,email_verified,banned_at,suspended_until FROM developer_accounts WHERE discord_id=$1', [accountId])).rows[0];
  if (!account) return { accountId, role: 'USER', rank: 0, owner: false, active: false, exists: false };
  const identities = (await db.query('SELECT provider,subject,oauth_verified_at,provider_username FROM developer_identities WHERE account_id=$1', [accountId])).rows;
  const verifiedDiscord = identities.filter(identity => identity.provider === 'discord' && identity.oauth_verified_at);
  const owner = verifiedDiscord.some(identity => identity.subject === ownerDiscordId());
  const assignment = (await db.query('SELECT role FROM developer_staff_roles WHERE account_id=$1', [accountId])).rows[0];
  let effective = assignment ? normalizeRole(assignment.role) : 'USER';
  if (!assignment) {
    const legacy = (await db.query('SELECT role FROM developer_moderation_roles WHERE account_id=$1', [accountId])).rows[0];
    if (legacy) effective = normalizeRole(legacy.role);
    const configured = new Set(String(process.env.MODERATION_ADMIN_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
    // The legacy server environment selects internal account IDs. It can
    // grant ADMIN only; OWNER still requires verified Discord OAuth. An
    // explicit USER assignment overrides this legacy bootstrap setting.
    if (configured.has(accountId)) effective = 'ADMIN';
  }
  if (owner) effective = 'OWNER';
  const active = !account.banned_at && (!account.suspended_until || new Date(account.suspended_until).getTime() <= Date.now());
  return { accountId, role: effective, rank: rank(effective), owner, active, exists: true, username: account.username, email: account.email, emailVerified: account.email_verified, identities };
}
async function role(accountId, db = pool) { return (await getStaff(accountId, db)).role; }
async function assertActive(accountId, db = pool) {
  const account = (await db.query('SELECT discord_id,banned_at,suspended_until FROM developer_accounts WHERE discord_id=$1', [accountId])).rows[0];
  if (!account) throw fail('SIGN_IN_REQUIRED', 'Sign in again to continue.', 401);
  if (account.banned_at) throw fail('ACCOUNT_BANNED', 'This account has been banned. Contact support.', 403);
  if (account.suspended_until && new Date(account.suspended_until).getTime() > Date.now()) throw fail('ACCOUNT_SUSPENDED', 'This account is temporarily suspended. Contact support.', 403);
  return account;
}
async function invalidateSessions(accountId, db = pool) {
  await db.query('DELETE FROM developer_admin_sessions WHERE account_id=$1', [accountId]);
  await db.query('DELETE FROM developer_sessions WHERE account_id=$1', [accountId]);
}
function safeData(value, depth = 0) {
  if (depth > 5 || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeData(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (/password|secret|token|credential|content_enc|content_iv|source|script_content|hwid|fingerprint|aes|hmac|(?:^|_)key(?:_|$)/i.test(key)) continue;
    output[key] = safeData(item, depth + 1);
  }
  return output;
}
async function audit(db, event) {
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(event.action || '')) throw fail('INVALID_AUDIT_ACTION', 'Invalid audit action.', 400);
  await db.query('INSERT INTO developer_admin_audit(id,actor_id,actor_role,action,target_type,target_id,reason,before_data,after_data,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)',
    [crypto.randomUUID(), event.actorId || null, normalizeRole(event.actorRole), event.action, String(event.targetType || '').slice(0, 80), event.targetId || null, String(event.reason || '').slice(0, 500), JSON.stringify(safeData(event.before || {})), JSON.stringify(safeData(event.after || {})), String(event.ip || '').slice(0, 100)]);
}
// Caller-supplied names never match a pending invitation. Username invitations
// require an explicit binding by staff to an already verified account.
async function applyInvitations(accountId, db = pool, context = {}) {
  if (db === pool && context.inTransaction !== true) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await lockAdminChanges(client); await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [accountId]); const result = await applyInvitations(accountId, client, {...context,inTransaction:true}); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const target = await getStaff(accountId, db);
  if (!target.active || target.owner) return [];
  const verified = target.emailVerified || target.identities.some(identity => identity.oauth_verified_at);
  if (!verified) return [];
  const pending = (await db.query('SELECT * FROM developer_staff_invitations WHERE accepted_at IS NULL AND cancelled_at IS NULL AND expires_at>now() ORDER BY created_at,id')).rows;
  const accepted = [];
  for (const invitation of pending) {
    if (invitation.target_account_id && invitation.target_account_id !== accountId) continue;
    const eligible = invitation.target_type === 'email' ? target.emailVerified && normalizeEmail(invitation.target_value) === normalizeEmail(target.email) :
      invitation.target_type === 'discord' ? target.identities.some(identity => identity.provider === 'discord' && identity.oauth_verified_at && identity.subject === invitation.target_value) :
        invitation.target_type === 'username' ? invitation.target_account_id === accountId :
          invitation.target_type === 'account' && (invitation.target_account_id === accountId || invitation.target_value === accountId);
    if (!eligible || !invitation.created_by) continue;
    const grantor = await getStaff(invitation.created_by, db), current = await getStaff(accountId, db);
    if (!grantor.active || !canAct(grantor.role, current.role, invitation.role)) continue;
    const consumed = (await db.query('UPDATE developer_staff_invitations SET accepted_at=now(),accepted_by=$1 WHERE id=$2 AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at>now() RETURNING id', [accountId, invitation.id])).rows[0];
    if (!consumed) continue;
    await db.query('INSERT INTO developer_staff_roles(account_id,role,updated_by) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET role=$2,updated_by=$3,updated_at=now()', [accountId, invitation.role, invitation.created_by]);
    await invalidateSessions(accountId, db);
    await audit(db, { actorId: invitation.created_by, actorRole: grantor.role, action: 'staff.invitation.accepted', targetType: 'account', targetId: accountId, before: { role: current.role }, after: { role: invitation.role, invitationId: invitation.id }, ip: context.ip });
    accepted.push(invitation.id);
  }
  return accepted;
}
async function afterVerifiedLogin(accountId, proof, db) {
  await assertActive(accountId, db);
  // This function is called only after password+verified email or a server-side
  // OAuth exchange. It does not accept a request body or a client user ID.
  await db.query('UPDATE developer_accounts SET last_login_at=now(),last_login_provider=$1,last_login_subject=$2 WHERE discord_id=$3', [proof.provider, proof.subject || null, accountId]);
  return applyInvitations(accountId, db, {ip:proof.ip,inTransaction:true});
}
function cookieOptions() { return { ...require('./developer-auth').cookieOptions(), sameSite: 'strict', path: '/' }; }
function csrfToken(adminToken, developerToken) { return crypto.createHmac('sha256', process.env.HMAC_SECRET).update('admin:csrf:' + adminToken + ':' + developerToken).digest('hex'); }
function checkOrigin(req) {
  const expected = new URL(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).origin;
  if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') throw fail('INVALID_ORIGIN', 'Invalid origin.');
  if (!req.is('application/json')) throw fail('JSON_REQUIRED', 'JSON is required.', 415);
}
async function getContext(req, db = pool) {
  const auth = require('./developer-auth');
  const account = await auth.account(req);
  if (!account) throw fail('SIGN_IN_REQUIRED', 'Sign in to continue.', 401);
  const staff = await getStaff(account.discord_id, db);
  if (!staff.active) throw fail('ACCOUNT_BLOCKED', 'This account cannot access administration.');
  const developerToken = req.cookies?.[auth.COOKIE], adminToken = req.cookies?.[COOKIE];
  let session = null;
  if (typeof adminToken === 'string' && /^[a-f0-9]{64}$/.test(adminToken)) {
    session = (await db.query('SELECT token_hash,csrf_hash,last_activity_at FROM developer_admin_sessions WHERE token_hash=$1 AND account_id=$2 AND developer_session_hash=$3 AND last_activity_at>$4', [digest(adminToken), account.discord_id, digest(developerToken), new Date(Date.now() - IDLE_MS)])).rows[0] || null;
    if (session && isStaff(staff.role)) {
      const touched = (await db.query('UPDATE developer_admin_sessions SET last_activity_at=now() WHERE token_hash=$1 RETURNING token_hash', [session.token_hash])).rows[0];
      if (!touched) session = null;
      else req.res?.cookie(COOKIE, adminToken, { ...cookieOptions(), maxAge: IDLE_MS });
    } else session = null;
  }
  const token = session ? csrfToken(adminToken, developerToken) : null;
  const adminSession = session ? { tokenHash: session.token_hash, csrfHash: session.csrf_hash, expiresAt: new Date(Date.now() + IDLE_MS).toISOString() } : null;
  return { ...staff, staff, adminSession, activated: !!adminSession, csrfToken: token, expiresAt: adminSession?.expiresAt || null };
}
async function createAdminSession(req, res) {
  checkOrigin(req);
  if (req.method !== 'POST' || req.body?.confirmation !== 'ACTIVATE') throw fail('CONFIRMATION_REQUIRED', 'Confirm administrative access.', 400);
  const auth = require('./developer-auth'), account = await auth.account(req);
  if (!account) throw fail('SIGN_IN_REQUIRED', 'Sign in to continue.', 401);
  const client = await pool.connect();
  const token = crypto.randomBytes(32).toString('hex'), developerToken = req.cookies[auth.COOKIE], csrf = csrfToken(token, developerToken);
  let staff;
  try {
    await client.query('BEGIN'); await lockAdminChanges(client); await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [account.discord_id]);
    await assertActive(account.discord_id, client); staff = await getStaff(account.discord_id, client);
    if (!isStaff(staff.role)) throw fail('STAFF_REQUIRED', 'Staff access is required.');
    const current = (await client.query('SELECT account_id FROM developer_sessions WHERE account_id=$1 AND token_hash=$2 AND expires_at>now()', [account.discord_id, digest(developerToken)])).rows[0];
    if (!current) throw fail('SIGN_IN_REQUIRED', 'Sign in again to continue.', 401);
    await client.query('DELETE FROM developer_admin_sessions WHERE developer_session_hash=$1', [digest(developerToken)]);
    await client.query('INSERT INTO developer_admin_sessions(token_hash,account_id,developer_session_hash,csrf_hash) VALUES($1,$2,$3,$4)', [digest(token), account.discord_id, digest(developerToken), digest(csrf)]);
    await audit(client, { actorId: account.discord_id, actorRole: staff.role, action: 'admin.session.opened', targetType: 'account', targetId: account.discord_id, ip: req.ip });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: IDLE_MS });
  return { ...staff, staff, activated: true, csrfToken: csrf, expiresAt: new Date(Date.now() + IDLE_MS).toISOString() };
}
async function endAdminSession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const closed=(await client.query('DELETE FROM developer_admin_sessions WHERE token_hash=$1 RETURNING account_id',[digest(token)])).rows[0];
      if(closed) await audit(client,{actorId:closed.account_id,actorRole:await role(closed.account_id,client),action:'admin.session.closed',targetType:'account',targetId:closed.account_id,ip:req.ip});
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  res.clearCookie(COOKIE, cookieOptions());
  return { success: true };
}
function requireStaff(minimum = 'MODERATOR') {
  return (req, res, next) => getContext(req).then(context => {
    if (!isStaff(context.role) || rank(context.role) < rank(minimum)) throw fail('STAFF_REQUIRED', 'Insufficient staff permissions.');
    if (!context.adminSession) throw fail('ADMIN_ACTIVATION_REQUIRED', 'Activate your administrative session first.', 401);
    req.staff = context.staff; req.adminSession = context.adminSession; req.adminContext = context; next();
  }).catch(error => next(error));
}
function csrf(req, res, next) {
  try {
    checkOrigin(req);
    const value = req.get('x-csrf-token');
    if (!req.adminSession || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || !/^[a-f0-9]{64}$/.test(req.adminSession.csrfHash || '') || !crypto.timingSafeEqual(Buffer.from(digest(value)), Buffer.from(req.adminSession.csrfHash))) throw fail('INVALID_CSRF', 'Invalid administrative confirmation token.');
    next();
  } catch (error) { next(error); }
}
const staffRateLimit = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => req.staff?.accountId || req.account?.discord_id || req.ip, message: { success: false, error: 'Too many administrative requests. Try again shortly.' } });
module.exports = { COOKIE, IDLE_MS, RANK, normalizeRole, rank, isStaff, canAct, canManage: canAct, assertLower, lockAdminChanges, getStaff, role, assertActive, invalidateSessions, applyInvitations, acceptPendingInvitations: applyInvitations, afterVerifiedLogin, audit, getContext, createAdminSession, openSession: createAdminSession, endAdminSession, closeSession: endAdminSession, requireStaff, csrf, mutation: csrf, staffRateLimit, cookieOptions, ownerDiscordId };
