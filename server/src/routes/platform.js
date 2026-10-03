'use strict';
const express = require('express');
const nodeCrypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const crypto = require('../services/crypto');
const auth = require('../services/developer-auth');
const providers = require('../services/checkpoint-providers');
const router = express.Router();
const checkpointStartLimiter = rateLimit({ windowMs: 600000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many checkpoint starts. Try again in 10 minutes.' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ success: false, error });
const site = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Try again in a minute.' } }));

// Browser mutations use JSON + a same-origin check. Public SDK checks are exempt.
function sameOrigin(req, res, next) {
  if (!req.is('application/json')) return fail(res, 415, 'JSON required');
  const origin = req.get('origin');
  if (origin && origin !== new URL(site(req)).origin) return fail(res, 403, 'Invalid origin');
  if (req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'Invalid origin');
  next();
}
const requireDeveloper = wrap(async (req, res, next) => {
  req.developer = await auth.account(req);
  if (!req.developer) return fail(res, 401, 'Sign in to your developer account to continue.');
  req.developerId = req.developer.discord_id; next();
});
const ownProject = wrap(async (req, res, next) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1 AND owner_id=$2', [req.params.projectId, req.developerId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  req.project = rows[0]; next();
});
function projectView(p) {
  const provider = p.checkpoint_provider || 'lootlabs';
  return { id: p.id, name: p.name, description: p.description, durationHours: p.duration_hours,
    hwidBinding: p.hwid_binding, checkpointProvider: provider,
    checkpointLinkUrl: p.checkpoint_link_url, checkpointLinkId: p.checkpoint_link_id,
    checkpointsConfigured: checkpointConfigured(p),
    checkpointCount: p.checkpoint_count, createdAt: p.created_at };
}
function checkpointConfigured(p) {
  if (!p) return false;
  switch (p.checkpoint_provider || 'lootlabs') {
    case 'lootlabs': return !!p.lootlabs_token_enc;
    case 'workink': return !!(p.checkpoint_link_url && p.checkpoint_link_id);
    case 'linkvertise': case 'linkunlocker': return !!(p.checkpoint_link_url && p.checkpoint_token_enc);
    default: return false;
  }
}
router.get('/v1/loader/:projectId', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT id FROM developer_projects WHERE id=$1', [req.params.projectId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  res.type('text/plain').send(require('../services/platform-loader').loader(req.params.projectId, site(req)));
}));
router.get('/me', wrap(async (req, res) => {
  const user = await auth.account(req);
  res.json({ success: true, loggedIn: !!user, username: user?.username });
}));
router.get('/projects', requireDeveloper, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT p.*,COALESCE(l.licenses,0) AS licenses,COALESCE(e.validations,0) AS validations
    FROM developer_projects p
    LEFT JOIN (SELECT project_id,COUNT(*)::int AS licenses FROM developer_licenses
      WHERE project_id IN (SELECT id FROM developer_projects WHERE owner_id=$1) GROUP BY project_id) l ON l.project_id=p.id
    LEFT JOIN (SELECT project_id,COUNT(*)::int AS validations FROM developer_events
      WHERE success=true AND project_id IN (SELECT id FROM developer_projects WHERE owner_id=$1) GROUP BY project_id) e ON e.project_id=p.id
    WHERE p.owner_id=$1 ORDER BY p.created_at DESC`, [req.developerId]);
  res.json({ success: true, projects: rows.map(p => ({ ...projectView(p), licenses: p.licenses, validations: p.validations })) });
}));
router.post('/projects', sameOrigin, requireDeveloper, wrap(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return fail(res, 400, 'Project name must contain 1–80 characters.');
  const token = 'ahp_' + crypto.randomToken(32);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT discord_id FROM developer_accounts WHERE discord_id=$1 FOR UPDATE', [req.developerId]);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM developer_projects WHERE owner_id=$1', [req.developerId]);
    if (count.rows[0].count >= 10) { await client.query('ROLLBACK'); return fail(res, 409, 'Your account can have up to 10 projects.'); }
    const { rows } = await client.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4) RETURNING *',
      [nodeCrypto.randomUUID(), req.developerId, name, crypto.hashToken(token)]);
    await client.query('COMMIT'); res.status(201).json({ success: true, project: projectView(rows[0]), apiToken: token });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/projects/:projectId', requireDeveloper, ownProject, wrap(async (req, res) => {
  const id = req.project.id;
  const [licenses, events, script, stats] = await Promise.all([
    pool.query('SELECT id,key_prefix,note,expires_at,revoked,(hwid_hash IS NOT NULL) AS bound,created_at FROM developer_licenses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100', [id]),
    pool.query('SELECT success,reason,executor,created_at FROM developer_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30', [id]),
    pool.query('SELECT version,updated_at FROM developer_scripts WHERE project_id=$1', [id]),
    pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE NOT revoked AND expires_at>now())::int AS active FROM developer_licenses WHERE project_id=$1`, [id]),
  ]);
  res.json({ success: true, project: projectView(req.project), licenses: licenses.rows, events: events.rows,
    script: script.rows[0] || null, stats: stats.rows[0] });
}));
router.patch('/projects/:projectId', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { name, description, durationHours, hwidBinding } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof description !== 'string' || description.length > 500 ||
    !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 8760 || typeof hwidBinding !== 'boolean') return fail(res, 400, 'Invalid project settings.');
  const { rows } = await pool.query('UPDATE developer_projects SET name=$1,description=$2,duration_hours=$3,hwid_binding=$4 WHERE id=$5 AND owner_id=$6 RETURNING *',
    [name.trim(), description, durationHours, hwidBinding, req.project.id, req.developerId]);
  res.json({ success: true, project: projectView(rows[0]) });
}));
router.post('/projects/:projectId/token', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const apiToken = 'ahp_' + crypto.randomToken(32);
  await pool.query('UPDATE developer_projects SET api_token_hash=$1 WHERE id=$2 AND owner_id=$3', [crypto.hashToken(apiToken), req.project.id, req.developerId]);
  res.json({ success: true, apiToken });
}));
router.put('/projects/:projectId/script', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const content = req.body.content;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 1024 * 1024) return fail(res, 400, 'Provide a Lua script smaller than 1 MB.');
  const enc = crypto.encryptAES(content);
  const { rows } = await pool.query(`INSERT INTO developer_scripts(project_id,content_enc,content_iv) VALUES($1,$2,$3)
    ON CONFLICT(project_id) DO UPDATE SET content_enc=$2,content_iv=$3,version=developer_scripts.version+1,updated_at=now() RETURNING version`, [req.project.id, enc.enc, enc.iv]);
  res.json({ success: true, version: rows[0].version });
}));
const issueLicenses = wrap(async (req, res) => {
  const hours = req.body.durationHours ?? req.project.duration_hours;
  const count = req.body.count ?? 1;
  const note = req.body.note ?? '';
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760 || !Number.isInteger(count) || count < 1 || count > 50 || typeof note !== 'string' || note.length > 200) return fail(res, 400, 'Invalid license settings.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE', [req.project.id]);
    const total = await client.query('SELECT COUNT(*)::int AS count FROM developer_licenses WHERE project_id=$1', [req.project.id]);
    if (total.rows[0].count + count > 10000) { await client.query('ROLLBACK'); return fail(res, 409, 'Project license limit reached (10,000).'); }
    const licenses = [];
    for (let i = 0; i < count; i++) {
      const key = 'ah_' + crypto.randomToken(24);
      const { rows } = await client.query(`INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+($6::text || ' hours')::interval) RETURNING id,expires_at`,
      [nodeCrypto.randomUUID(), req.project.id, crypto.hashToken(key), key.slice(0, 11), note, hours]);
      licenses.push({ ...rows[0], key });
    }
    await client.query('COMMIT'); res.status(201).json({ success: true, licenses });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.post('/projects/:projectId/licenses', sameOrigin, requireDeveloper, ownProject, issueLicenses);
router.post('/projects/:projectId/licenses/:licenseId/:action', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { licenseId, action } = req.params;
  if (!UUID.test(licenseId) || !['revoke','restore','reset-device'].includes(action)) return fail(res, 400, 'Invalid license action.');
  const assignment = { revoke: 'revoked=true', restore: 'revoked=false', 'reset-device': 'hwid_hash=NULL' }[action];
  const result = await pool.query(`UPDATE developer_licenses SET ${assignment} WHERE id=$1 AND project_id=$2 RETURNING id`, [licenseId, req.project.id]);
  if (!result.rows[0]) return fail(res, 404, 'License not found');
  res.json({ success: true });
}));

// Secret server-side token; it must never be embedded in a distributed Lua script.
router.post('/v1/projects/:projectId/licenses', wrap(async (req, res, next) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (!/^ahp_[a-f0-9]{64}$/.test(token)) return fail(res, 401, 'Invalid API token');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1 AND api_token_hash=$2', [req.params.projectId, crypto.hashToken(token)]);
  if (!rows[0]) return fail(res, 401, 'Invalid API token');
  req.project = rows[0]; req.developerId = rows[0].owner_id;
  // Delegate to the authenticated issuance handler, not browser authentication.
  await issueLicenses(req, res, next);
}));

router.post('/v1/check', wrap(async (req, res) => {
  const { projectId, key, hwid, executor } = req.body || {};
  if (typeof projectId !== 'string' || typeof key !== 'string' || !UUID.test(projectId) || !/^ah_[a-f0-9]{48}$/.test(key)) return fail(res, 400, 'Invalid key or project');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM developer_licenses WHERE project_id=$1 AND key_hash=$2 FOR UPDATE', [projectId, crypto.hashToken(key)]);
    const license = result.rows[0];
    const project = license ? await client.query('SELECT hwid_binding FROM developer_projects WHERE id=$1', [projectId]) : { rows: [] };
    let reason = !license ? 'invalid_key' : license.revoked ? 'revoked' : new Date(license.expires_at).getTime() <= Date.now() ? 'expired' : null;
    let hwidHash = null;
    if (!reason && project.rows[0].hwid_binding) {
      if (typeof hwid !== 'string' || hwid.trim().length < 8 || hwid.length > 256) reason = 'hwid_required';
      else { hwidHash = crypto.hashToken(projectId + ':' + hwid.trim()); if (license.hwid_hash && license.hwid_hash !== hwidHash) reason = 'bound_to_other_device'; }
    }
    const script = !reason ? await client.query('SELECT content_enc,content_iv,version FROM developer_scripts WHERE project_id=$1', [projectId]) : { rows: [] };
    if (!reason && req.body.loadScript === true && !script.rows[0]) reason = 'no_script';
    if (!license) { await client.query('ROLLBACK'); return res.status(401).json({ success: false, reason }); }
    if (!reason && hwidHash && !license.hwid_hash) await client.query('UPDATE developer_licenses SET hwid_hash=$1 WHERE id=$2', [hwidHash, license.id]);
    await client.query('INSERT INTO developer_events(project_id,license_id,success,reason,executor) VALUES($1,$2,$3,$4,$5)',
      [projectId, license.id, !reason, reason || 'valid', typeof executor === 'string' ? executor.slice(0, 40) : '']);
    const content = !reason && req.body.loadScript === true ? crypto.decryptAES(script.rows[0].content_enc, script.rows[0].content_iv) : undefined;
    await client.query('COMMIT');
    if (reason) return res.status(403).json({ success: false, reason });
    res.json({ success: true, expiresAt: license.expires_at, script: content, version: script.rows[0]?.version });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.put('/projects/:projectId/checkpoints', sameOrigin, requireDeveloper, ownProject, wrap(async (req, res) => {
  const { apiToken, count, linkUrl, linkId } = req.body;
  const provider = req.body.provider || 'lootlabs';
  if (!providers.names[provider]) return fail(res, 400, 'Unsupported checkpoint provider.');
  const link = provider === 'lootlabs' ? null : providers.safeLink(linkUrl, provider);
  if (provider !== 'lootlabs' && !link) return fail(res, 400, 'Provide a valid HTTPS link from the selected provider.');
  if (provider === 'workink' && (typeof linkId !== 'string' || !/^[0-9]{1,20}$/.test(linkId))) return fail(res, 400, 'Provide the numeric Work.ink link ID.');
  if (provider === 'lootlabs' && (typeof apiToken !== 'string' || apiToken.trim().length < 8 || apiToken.length > 500 || !Number.isInteger(count) || count < 1 || count > 5)) return fail(res, 400, 'Provide your LootLabs API token and 1–5 tasks.');
  if (['linkvertise','linkunlocker'].includes(provider) && (typeof apiToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(apiToken.trim()))) return fail(res, 400, 'Provide a 64-character provider API token.');
  const token = provider === 'workink' ? null : crypto.encryptAES(apiToken.trim());
  const secret = provider === 'lootlabs' ? crypto.randomToken(32) : null;
  await pool.query(`UPDATE developer_projects SET checkpoint_provider=$1,checkpoint_link_url=$2,checkpoint_link_id=$3,
    checkpoint_token_enc=$4,checkpoint_token_iv=$5,lootlabs_token_enc=$6,lootlabs_token_iv=$7,
    checkpoint_secret_hash=$8,checkpoint_count=$9 WHERE id=$10 AND owner_id=$11`,
    [provider, link, provider === 'workink' ? linkId : null, provider === 'lootlabs' ? null : token?.enc || null,
      provider === 'lootlabs' ? null : token?.iv || null, provider === 'lootlabs' ? token.enc : null,
      provider === 'lootlabs' ? token.iv : null, secret ? crypto.hashToken(secret) : null,
      provider === 'lootlabs' ? count : 1, req.project.id, req.developerId]);
  res.json({ success: true, provider, postbackUrl: secret ? `${site(req)}/api/platform/checkpoints/${req.project.id}/postback?secret=${secret}` : null,
    targetUrl: provider === 'linkvertise' ? `${site(req)}/api/platform/checkpoints/${req.project.id}/return` : null });
}));
router.get('/public/projects/:projectId', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT id,name,description,duration_hours,checkpoint_count,checkpoint_provider,checkpoint_link_url,checkpoint_link_id,checkpoint_token_enc,lootlabs_token_enc FROM developer_projects WHERE id=$1', [req.params.projectId]);
  if (!rows[0]) return fail(res, 404, 'Project not found');
  res.json({ success: true, project: { id: rows[0].id, name: rows[0].name, description: rows[0].description,
    durationHours: rows[0].duration_hours, checkpointCount: rows[0].checkpoint_count,
    checkpointProvider: rows[0].checkpoint_provider || 'lootlabs', available: checkpointConfigured(rows[0]) } });
}));
router.post('/checkpoints/:projectId/start', sameOrigin, checkpointStartLimiter, wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const { rows } = await pool.query('SELECT * FROM developer_projects WHERE id=$1', [req.params.projectId]);
  const p = rows[0]; if (!checkpointConfigured(p)) return fail(res, 409, 'The developer has not configured checkpoints yet.');
  const id = crypto.randomToken(32), browser = crypto.randomToken(32);
  let started;
  try { started = await providers.prepareStart(p, id, site(req), crypto.decryptAES, crypto.randomToken, crypto.hashToken); }
  catch { return fail(res, 502, `${providers.names[p.checkpoint_provider || 'lootlabs']} could not create your link. Contact the developer.`); }
  await pool.query(`INSERT INTO developer_checkpoints(id,project_id,browser_hash,tasks_required,duration_hours,provider,provider_reference,return_proof_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, p.id, crypto.hashToken(browser), p.checkpoint_count, p.duration_hours, started.provider, started.reference, started.proofHash]);
  const cookieOptions = { httpOnly: true, secure: req.secure || site(req).startsWith('https:'), sameSite: 'lax', path: '/api/platform/checkpoints', maxAge: 1800000 };
  res.cookie('ah_checkpoint_' + id, browser, cookieOptions);
  res.cookie('ah_checkpoint_current_' + p.id, id, cookieOptions);
  res.json({ success: true, session: id, url: started.url });
}));
router.get('/checkpoints/:projectId/return', wrap(async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  if (!UUID.test(req.params.projectId)) return fail(res, 404, 'Project not found');
  const id = typeof req.query.session === 'string' ? req.query.session : req.cookies?.['ah_checkpoint_current_' + req.params.projectId];
  if (!/^[a-f0-9]{64}$/.test(id || '')) return fail(res, 403, 'Checkpoint session missing.');
  const browser = req.cookies?.['ah_checkpoint_' + id];
  if (!browser) return fail(res, 403, 'Open this page in the browser used to start the checkpoint.');
  const [projectResult, sessionResult] = await Promise.all([
    pool.query('SELECT * FROM developer_projects WHERE id=$1', [req.params.projectId]),
    pool.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND browser_hash=$3 AND expires_at>now()',
      [id, req.params.projectId, crypto.hashToken(browser)]),
  ]);
  const project = projectResult.rows[0], session = sessionResult.rows[0];
  if (!project || !session || session.provider !== project.checkpoint_provider) return fail(res, 403, 'Checkpoint session invalid or expired.');
  const claim = `${site(req)}/claim?project=${project.id}&session=${id}`;
  if (session.tasks_done >= session.tasks_required) return res.redirect(303, claim);
  let valid;
  try { valid = await providers.verifyReturn(project, session, req.query, crypto.decryptAES, crypto.hashToken); }
  catch { return res.redirect(303, claim + '&checkpoint=failed'); }
  if (!valid) return res.redirect(303, claim + '&checkpoint=failed');
  const receipt = crypto.hashToken(`${session.provider}:${id}:${req.query.token || req.query.hash || req.query.proof}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND browser_hash=$3 AND expires_at>now() FOR UPDATE',
      [id, project.id, crypto.hashToken(browser)]);
    if (!locked.rows[0] || locked.rows[0].provider !== session.provider) { await client.query('ROLLBACK'); return fail(res, 403, 'Checkpoint session invalid or expired.'); }
    const inserted = await client.query('INSERT INTO developer_checkpoint_receipts(project_id,receipt_id,checkpoint_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt_id',
      [project.id, receipt, id]);
    if (inserted.rows[0]) await client.query('UPDATE developer_checkpoints SET tasks_done=LEAST(tasks_done+1,tasks_required) WHERE id=$1', [id]);
    await client.query('COMMIT');
    res.redirect(303, claim);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/checkpoints/:projectId/postback', wrap(async (req, res) => {
  if (!UUID.test(req.params.projectId) || typeof req.query.secret !== 'string' || !/^[a-f0-9]{64}$/.test(req.query.secret)) return fail(res, 403, 'Invalid callback');
  const receipt = req.query.unique_id, session = req.query.sub_id || req.query.click_id || req.query.puid;
  if (typeof receipt !== 'string' || receipt.length < 1 || receipt.length > 200 || !/^[a-f0-9]{64}$/.test(session || '')) return fail(res, 400, 'Missing receipt or session');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query("SELECT id FROM developer_projects WHERE id=$1 AND checkpoint_provider='lootlabs' AND checkpoint_secret_hash=$2", [req.params.projectId, crypto.hashToken(req.query.secret)]);
    if (!project.rows[0]) { await client.query('ROLLBACK'); return fail(res, 403, 'Invalid callback'); }
    const { rows } = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND project_id=$2 AND expires_at>now() FOR UPDATE', [session, req.params.projectId]);
    if (!rows[0] || rows[0].provider !== 'lootlabs') { await client.query('ROLLBACK'); return fail(res, 403, 'Invalid callback'); }
    const inserted = await client.query('INSERT INTO developer_checkpoint_receipts(project_id,receipt_id,checkpoint_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING receipt_id', [req.params.projectId, receipt, session]);
    if (inserted.rows[0]) await client.query('UPDATE developer_checkpoints SET tasks_done=LEAST(tasks_done+1,tasks_required) WHERE id=$1', [session]);
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.get('/checkpoints/:session/status', wrap(async (req, res) => {
  const id = req.params.session;
  if (!/^[a-f0-9]{64}$/.test(id)) return fail(res, 404, 'Session not found');
  const browser = req.cookies?.['ah_checkpoint_' + id];
  if (!browser) return fail(res, 403, 'Open this page in the browser used to start the checkpoint.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM developer_checkpoints WHERE id=$1 AND browser_hash=$2 AND expires_at>now() FOR UPDATE', [id, crypto.hashToken(browser)]);
    const c = rows[0];
    if (!c) { await client.query('ROLLBACK'); return fail(res, 410, 'Session expired. Start again.'); }
    if (c.tasks_done < c.tasks_required) { await client.query('COMMIT'); return res.json({ success: true, status: 'pending', completed: c.tasks_done, required: c.tasks_required }); }
    let key = c.key_enc ? crypto.decryptAES(c.key_enc, c.key_iv) : null;
    if (!key) {
      await client.query('SELECT id FROM developer_projects WHERE id=$1 FOR UPDATE', [c.project_id]);
      const total = await client.query('SELECT COUNT(*)::int AS count FROM developer_licenses WHERE project_id=$1', [c.project_id]);
      if (total.rows[0].count >= 10000) { await client.query('ROLLBACK'); return fail(res, 409, 'Project license limit reached. Contact the developer.'); }
      key = 'ah_' + crypto.randomToken(24);
      await client.query(`INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+($6::text || ' hours')::interval)`, [nodeCrypto.randomUUID(), c.project_id, crypto.hashToken(key), key.slice(0, 11), `${providers.names[c.provider] || 'Provider'} checkpoint`, c.duration_hours]);
      const encrypted = crypto.encryptAES(key);
      await client.query('UPDATE developer_checkpoints SET key_enc=$1,key_iv=$2 WHERE id=$3', [encrypted.enc, encrypted.iv, id]);
    }
    await client.query('COMMIT'); res.json({ success: true, status: 'completed', key });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('[platform]', error.code || error.name, process.env.NODE_ENV === 'test' ? error.message.split('\n')[0] : '');
  fail(res, error.code === '42P01' ? 503 : 500, error.code === '42P01' ? 'Developer platform setup is pending. Please try again later.' : 'The request could not be completed. Try again.');
});
module.exports = router;
