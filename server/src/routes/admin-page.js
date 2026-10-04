'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../services/developer-auth');

// The protected document is outside the public static directory. Asset aliases,
// case variations and a direct /admin.html request cannot expose it.
module.exports = function adminPages({ assetVersion, siteUrl, preview = false }) {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many administration requests. Try again in a minute.' } }));
  router.get(['/', '/overview', '/users', '/projects', '/licenses', '/scripts', '/reports', '/team', '/audit', '/settings'], async (req, res, next) => {
    try {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      const account = await auth.account(req);
      if (!account) return res.status(404).type('text').send('Not found');
      const staff = require('../services/staff-access');
      const role = await staff.role(account.discord_id);
      if (!staff.isStaff(role) || ['/audit', '/settings'].includes(req.path) && !['OWNER', 'CO_OWNER'].includes(role)) {
        return res.status(404).type('text').send('Not found');
      }
      let html = fs.readFileSync(path.join(__dirname, '../../views/admin.html'), 'utf8')
        .replaceAll('__V__', assetVersion).replaceAll('__SITE__', siteUrl);
      if (preview) html = html.replace(/(<body\b[^>]*>)/i, '$1<div class="local-preview-notice" role="note">Local preview · Test data only</div>');
      res.type('html').send(html);
    } catch (error) { next(error); }
  });
  return router;
};
