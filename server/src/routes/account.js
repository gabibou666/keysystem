'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../services/developer-auth');
const data = require('../services/account-data');
const router = express.Router();
const activeExports = new Set();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, error, code) => res.status(status).json({ success: false, error, ...(code ? { code } : {}) });
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('Cross-Origin-Resource-Policy', 'same-origin'); next(); });
router.use(wrap(async (req, res, next) => { req.account = await auth.account(req); if (!req.account) return fail(res, 401, 'Sign in to manage your personal data.', 'SIGN_IN_REQUIRED'); next(); }));
router.use(rateLimit({ windowMs: 3600000, max: 10, keyGenerator: req => req.account.discord_id, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many data requests. Try again later.' } }));
async function write(res, chunk, signal) {
  signal.throwIfAborted();
  if (res.destroyed) throw new Error('Export connection closed.');
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    function clean() { res.off('drain', drained); res.off('close', closed); signal.removeEventListener('abort', interrupted); }
    function drained() { clean(); resolve(); }
    function closed() { clean(); reject(new Error('Export connection closed.')); }
    function interrupted() { clean(); reject(signal.reason); }
    res.once('drain', drained); res.once('close', closed);
    signal.addEventListener('abort', interrupted, { once: true });
  });
}
router.get('/export', wrap(async (req, res) => {
  const accountId = req.account.discord_id;
  // Reserve before taking an export connection, leaving the other pool slots
  // available for sign-in, the dashboard and licence validation.
  if (activeExports.has(accountId) || activeExports.size >= 2) {
    res.set('Retry-After', '5'); return fail(res, 429, 'Another export is in progress. Try again shortly.', 'EXPORT_BUSY');
  }
  activeExports.add(accountId);
  const controller = new AbortController();
  const closed = () => controller.abort(new Error('Export connection closed.'));
  res.once('close', closed);
  if (res.destroyed) closed();
  const timeout = setTimeout(() => {
    const error = new Error('Data export timed out. Please try again.'); error.code = 'EXPORT_TIMEOUT'; error.status = 504;
    controller.abort(error);
    if (res.headersSent) res.destroy();
  }, 60000);
  const stream = data.exportAccount(accountId, auth.hash(req.cookies[auth.COOKIE]), { signal: controller.signal });
  try {
    const first = await stream.next();
    res.type('application/json'); res.set('Content-Disposition', `attachment; filename="audit-hub-export-${new Date().toISOString().slice(0, 10)}.json"`);
    await write(res, first.value, controller.signal);
    for await (const chunk of stream) await write(res, chunk, controller.signal);
    res.end();
  } finally {
    clearTimeout(timeout); res.off('close', closed);
    controller.abort(new Error('Export finished.'));
    try { await stream.return(); } finally { activeExports.delete(accountId); }
  }
}));
router.delete('/', (req, res, next) => {
  const expected = new URL(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).origin;
  if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'Invalid origin', 'INVALID_ORIGIN');
  if (!req.is('application/json')) return fail(res, 415, 'JSON required', 'JSON_REQUIRED');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || req.body.confirmation !== 'DELETE' || Object.keys(req.body).some(key => key !== 'confirmation')) return fail(res, 400, 'Type DELETE to confirm account deletion.', 'CONFIRMATION_REQUIRED');
  next();
}, wrap(async (req, res) => {
  const result = await data.deleteAccount(req.account.discord_id, auth.hash(req.cookies[auth.COOKIE]));
  for (const [name, path] of [[auth.COOKIE, '/'], ['ah_admin_session','/'], ['ah_registration', '/'], ['ks_user', '/'], ['ah_google', '/api/auth/google'], ['ah_oauth_state', '/api/discord']]) res.clearCookie(name, { ...auth.cookieOptions(), path });
  for (const name of Object.keys(req.cookies)) if (/^ah_checkpoint_[a-f0-9]{64}$/i.test(name) || /^ah_checkpoint_current_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(name)) res.clearCookie(name, { ...auth.cookieOptions(), path: '/api/platform/checkpoints' });
  res.json(result);
}));
router.use((error, req, res, next) => {
  if (res.headersSent || res.destroyed) return res.destroy();
  res.removeHeader('Content-Disposition');
  if (error.status) return fail(res, error.status, error.message, error.code);
  fail(res, 503, 'Personal data service temporarily unavailable. Try again.', 'ACCOUNT_DATA_UNAVAILABLE');
});
module.exports = router;
