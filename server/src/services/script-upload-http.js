'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const auth = require('./developer-auth');
const controls = require('./site-controls');
const webSecurity = require('./web-security');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// The large parser is restricted to this authenticated upload route. JSON
// escaping can expand an 8 MiB UTF-8 file; the source itself is checked again
// against its byte limit before any build or database insertion.
module.exports = function mountScriptUpload(app) {
  const limit = rateLimit({ windowMs: 600000, max: 12, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many script publications. Try again in ten minutes.' } });
  app.put('/api/platform/projects/:projectId/script', limit, controls.enforceMaintenance, async (req, res, next) => {
    try {
      if (!req.is('application/json')) return res.status(415).json({ success: false, error: 'JSON required.' });
      const expected = new URL(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).origin;
      if (req.get('origin') && req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).json({ success: false, error: 'Invalid origin.' });
      }
      const account = await auth.account(req);
      if (!account) return res.status(401).json({ success: false, error: 'Sign in to publish a script.' });
      if (!UUID.test(req.params.projectId)) return res.status(404).json({ success: false, error: 'Project not found.' });
      const project = (await pool.query('SELECT id,disabled,deleted_at FROM developer_projects WHERE id=$1 AND owner_id=$2', [req.params.projectId, account.discord_id])).rows[0];
      if (!project || project.deleted_at) return res.status(404).json({ success: false, error: 'Project not found.' });
      if (project.disabled) return res.status(403).json({ success: false, error: 'This project was disabled by the site team.' });
      next();
    } catch (error) { next(error); }
  }, express.json({ limit: '50mb', inflate: false }), webSecurity.bodyError);
};
