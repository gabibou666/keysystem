'use strict';
const pool = require('../db');
const CACHE_MS = 10000;
const DEFAULTS = Object.freeze({ maintenance: false, maintenanceMessage: '', registrationsOpen: true,
  announcement: '', announcementEnabled: false, announcementLevel: 'info' });
let cached, expiresAt = 0, pending, generation = 0;
function view(row) {
  if (!row) return { ...DEFAULTS };
  return {
    maintenance: row.maintenance_enabled === true,
    maintenanceMessage: String(row.maintenance_message || '').slice(0, 500),
    registrationsOpen: row.registration_open !== false,
    announcement: row.announcement_enabled ? String(row.announcement_message || '').slice(0, 500) : '',
    announcementEnabled: row.announcement_enabled === true,
    announcementLevel: ['info', 'warning', 'success'].includes(row.announcement_level) ? row.announcement_level : 'info',
  };
}
async function read(db) {
  const result = await db.query({ text: 'SELECT maintenance_enabled,maintenance_message,registration_open,announcement_enabled,announcement_message,announcement_level FROM developer_site_settings WHERE id=1', query_timeout: 3000 });
  return view(result.rows[0]);
}
async function getSettings({ db = pool, fresh = false } = {}) {
  if (fresh || db !== pool) return read(db);
  if (cached && Date.now() < expiresAt) return cached;
  if (!pending) {
    const revision = generation;
    const work = read(db).then(value => {
      if (revision === generation) { cached = value; expiresAt = Date.now() + CACHE_MS; }
      return value;
    }).finally(() => { if (pending === work) pending = undefined; });
    pending = work;
  }
  return pending;
}
function invalidateSettings() { cached = undefined; expiresAt = 0; pending = undefined; generation++; }

async function enforceMaintenance(req, res, next) {
  try {
    const settings = await getSettings();
    if (!settings.maintenance) return next();
    const account = await require('./developer-auth').account(req);
    if (account && ['OWNER', 'CO_OWNER'].includes(await require('./staff-access').role(account.discord_id))) return next();
    res.set('Retry-After', '300').status(503).json({ success: false, code: 'MAINTENANCE',
      error: settings.maintenanceMessage || 'The site is undergoing maintenance. Please try again later.' });
  } catch { res.set('Retry-After', '30').status(503).json({ success: false, error: 'The service is temporarily unavailable.' }); }
}

// Delivery is denied for disabled projects and suspended or banned publishers,
// including token-based APIs that do not use a browser session.
async function projectAvailable(id, db = pool) {
  const { rows } = await db.query(`SELECT p.id FROM developer_projects p JOIN developer_accounts a ON a.discord_id=p.owner_id
    WHERE p.id=$1 AND p.disabled=false AND p.deleted_at IS NULL AND a.banned_at IS NULL
      AND (a.suspended_until IS NULL OR a.suspended_until<=now())`, [id]);
  return !!rows[0];
}
module.exports = { getSettings, invalidateSettings, enforceMaintenance, projectAvailable, view, DEFAULTS, CACHE_MS };
