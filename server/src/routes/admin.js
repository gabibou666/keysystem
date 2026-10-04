'use strict';
const express = require('express');
const pool = require('../db');
const auth = require('../services/developer-auth');
const access = require('../services/staff-access');
const admin = require('../services/admin-dashboard');
const { errorSummary } = require('../services/private-diagnostics');
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, message, code) => res.status(status).json({ success: false, error: message, code });
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('Cross-Origin-Resource-Policy', 'same-origin'); next(); });
router.use(wrap(async(req,res,next)=>{
  const account=await auth.account(req);
  if(!account)return fail(res,404,'Not found.','NOT_FOUND');
  const staff=await access.getStaff(account.discord_id);
  if(!staff.active||!access.isStaff(staff.role))return fail(res,404,'Not found.','NOT_FOUND');
  req.staff=staff;req.account=account;next();
}));
router.use(access.staffRateLimit);
const staffView=staff=>({accountId:staff.accountId,username:staff.username||'',role:staff.role,rank:staff.rank});
function json(req, res, next) {
  if (!req.is('application/json')) return fail(res, 415, 'JSON required.', 'JSON_REQUIRED');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return fail(res, 400, 'A JSON object is required.', 'INVALID_BODY');
  next();
}
router.post('/session', json, wrap(async (req, res) => {
  const expected = new URL(process.env.PUBLIC_URL || req.protocol + '://' + req.get('host')).origin;
  if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') throw admin.fault(403, 'Invalid origin.', 'INVALID_ORIGIN');
  if (req.body.confirmation !== 'ACTIVATE') throw admin.fault(409, 'Explicitly activate administration.', 'CONFIRMATION_REQUIRED');
  const result = await access.createAdminSession(req, res);
  res.json({ success: true, staff:staffView(result.staff),csrfToken:result.csrfToken,expiresAt:result.expiresAt,permissions:admin.permissions(result.staff.role) });
}));
router.delete('/session', access.requireStaff('MODERATOR'), access.csrf, json, wrap(async (req, res) => { await access.endAdminSession(req, res); res.json({ success: true }); }));
router.get('/me', access.requireStaff('MODERATOR'), wrap(async (req, res) => {
  const context = await access.getContext(req);
  const row = (await pool.query('SELECT username FROM developer_accounts WHERE discord_id=$1', [req.staff.accountId])).rows[0];
  res.json({ success: true, staff:staffView({...req.staff,username:row?.username||''}), csrfToken: context.csrfToken, expiresAt: req.adminSession.expiresAt, permissions: admin.permissions(req.staff.role) });
}));
const read = (path, minimum, operation) => router.get(path, access.requireStaff(minimum), wrap(async (req, res) => res.json(await operation(req))));
const mutate = (method, path, minimum, operation) => router[method](path, access.requireStaff(minimum), access.csrf, json, wrap(async (req, res) => res.json(await operation(req))));
read('/overview', 'MODERATOR', req => admin.overview(req.staff));
read('/users', 'MODERATOR', req => admin.users(req.query, req.staff));
read('/users/:id', 'MODERATOR', req => admin.user(req.params.id, req.staff));
for (const action of ['ban', 'unban', 'suspend', 'logout', 'delete', 'warn']) mutate('post', '/users/:id/' + action, action === 'warn' ? 'MODERATOR' : 'ADMIN', req => admin.userAction(req, action));
read('/projects', 'MODERATOR', req => admin.projects(req.query));
for (const action of ['disable', 'enable', 'delete']) mutate('post', '/projects/:id/' + action, 'ADMIN', req => admin.projectAction(req, action));
read('/licenses', 'MODERATOR', req => admin.licenses(req.query));
for (const action of ['revoke', 'restore']) mutate('post', '/licenses/:id/' + action, 'ADMIN', req => admin.licenseAction(req, action));
read('/scripts', 'MODERATOR', req => admin.scripts(req.query));
for (const action of ['hide', 'unhide', 'remove', 'delete']) mutate('post', '/scripts/:id/' + action, action === 'delete' ? 'ADMIN' : 'MODERATOR', req => admin.scriptAction(req, action));
read('/reports', 'MODERATOR', req => admin.reports(req.query));
mutate('post', '/reports/:id/decision', 'MODERATOR', admin.reportDecision);
read('/team', 'MODERATOR', req => admin.team(req.staff));
mutate('put', '/team/:id/role', 'ADMIN', admin.teamRole);
mutate('post', '/team/invites', 'ADMIN', admin.invite);
mutate('delete', '/team/invites/:id', 'ADMIN', req => admin.invitationAction(req, 'cancel'));
mutate('post', '/team/invites/:id/bind', 'CO_OWNER', req => admin.invitationAction(req, 'bind'));
read('/audit', 'CO_OWNER', req => admin.auditLog(req.query));
read('/settings', 'CO_OWNER', admin.settings);
mutate('put', '/settings', 'CO_OWNER', admin.updateSettings);
router.use((req, res) => fail(res, 404, 'Not found.', 'NOT_FOUND'));
router.use((error, req, res, next) => {
  if (res.headersSent) return res.destroy();
  if (error.status) return fail(res, error.status, error.message, error.code || 'ADMIN_ACTION_REFUSED');
  console.error('[admin]', errorSummary(error));
  fail(res, 503, 'Administration temporarily unavailable.', 'ADMIN_UNAVAILABLE');
});
module.exports = router;
