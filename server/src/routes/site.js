'use strict';

const express = require('express');
const pool = require('../db');
const { createSiteStats } = require('../services/site-stats');
const controls = require('../services/site-controls');
const router = express.Router();
const stats = createSiteStats({ pool });

function supportEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim();
  if (email.length > 254 || /[\s\u0000-\u001f\u007f]/.test(email)) return '';
  const [local, domain, extra] = email.split('@');
  if (extra !== undefined || !local || local.length > 64 || !/^[A-Za-z0-9._+-]+$/.test(local) || !domain) return '';
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return '';
  return email;
}

function publicUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000-\u0020\u007f]/.test(text)) return '';
  try {
    const url = new URL(text);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

router.get('/config', async (req, res) => {
  // Announcements and emergency maintenance changes must not linger in a CDN.
  res.set('Cache-Control', 'no-store');
  let settings;
  try { settings = await controls.getSettings(); } catch { settings = controls.DEFAULTS; }
  res.json({
    supportEmail: supportEmail(process.env.SUPPORT_EMAIL),
    discordUrl: publicUrl(process.env.DISCORD_URL),
    statusUrl: publicUrl(process.env.STATUS_URL),
    changelogUrl: '/changelog',
    legalName: legalText(process.env.LEGAL_NAME, 200),
    legalEmail: supportEmail(process.env.LEGAL_EMAIL),
    legalAddress: legalText(process.env.LEGAL_ADDRESS, 500),
    ...settings,
  });
});

function legalText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
}

router.get('/stats', async (req, res) => {
  // Caching happens in the service, with a single exact ten-minute lifetime.
  // Avoid an additional browser/CDN lifetime that could extend stale counts.
  res.set('Cache-Control', 'no-store');
  res.json(await stats.get());
});

module.exports = router;
