const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('../services/crypto');
const lootlabs = require('../services/lootlabs');
const pool = require('../db');
const path = require('path');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  message: { success: false, error: 'Trop de demandes, reessaie dans une minute.' },
});
const checkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  message: { success: false, error: 'rate_limited' },
});

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
}

// ---------- POST /api/key/start ----------
// Body: { duration: 12 | 24 }
// Soit nouvelle cle, soit renouvellement de la cle fournie.
router.post('/key/start', startLimiter, async (req, res) => {
  try {
    const duration = parseInt(req.body?.duration, 10);
    if (!lootlabs.DURATIONS[duration]) {
      return res.status(400).json({ success: false, error: 'Duree invalide (12 ou 24).' });
    }

    let keyId = null;
    // Renouvellement: une cle valide peut etre prolongee
    if (req.body?.key) {
      const parsed = crypto.verifyKeyFormat(req.body.key);
      if (!parsed) return res.status(400).json({ success: false, error: 'Cle invalide.' });
      const { rows } = await pool.query('SELECT id, revoked FROM keys WHERE kid = $1', [parsed.kid]);
      if (!rows[0] || rows[0].revoked) {
        return res.status(400).json({ success: false, error: 'Cle inconnue ou revoquee.' });
      }
      keyId = rows[0].id;
    }

    const puid = crypto.randomToken(16);

    let lootUrl, tasksRequired;
    try {
      const link = await lootlabs.createMonetizedLink({ durationHours: duration, puid });
      lootUrl = link.lootUrl;
      tasksRequired = link.tasksRequired;
    } catch (e) {
      console.error('[key/start] LootLabs:', e.message);
      return res.status(502).json({
        success: false,
        error:
          'Impossible de creer le lien: ' +
          (e.lootlabsMessage || e.message) +
          ' (verifie tes Creator Details dans le panel LootLabs)',
      });
    }

    await pool.query(
      `INSERT INTO ll_sessions (puid, key_id, tasks_required, ip) VALUES ($1, $2, $3, $4)`,
      [puid, keyId, tasksRequired, clientIp(req)]
    );

    res.json({ success: true, lootUrl, puid, tasksRequired });
  } catch (e) {
    console.error('[key/start]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// ---------- GET /api/lootlabs/postback ----------
// Postback LootLabs: ?click_id=<puid>&ip=<ip>&unique_id=<id>
// Tolérant: click_id seul suffit (ip/unique_id optionnels selon le template du panel)
router.get('/lootlabs/postback', async (req, res) => {
  try {
    const { click_id } = req.query;
    if (!click_id) return res.status(400).send('missing click_id');

    // unique_id optionnel: fallback genere si le template du panel ne l'inclut pas
    const unique_id =
      req.query.unique_id || 'auto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const ip = req.query.ip || null;

    // Dédup par unique_id
    const dup = await pool.query('SELECT id FROM postbacks WHERE unique_id = $1', [unique_id]);
    if (dup.rows[0]) return res.send('duplicate ok');

    const sess = await pool.query(
      'SELECT * FROM ll_sessions WHERE puid = $1 FOR UPDATE',
      [click_id]
    );
    const session = sess.rows[0];
    if (!session) return res.status(404).send('session not found');

    await pool.query('INSERT INTO postbacks (unique_id, puid, ip) VALUES ($1, $2, $3)', [
      unique_id,
      click_id,
      ip || null,
    ]);

    if (session.status === 'completed') return res.send('already ok');

    const done = session.tasks_done + 1;
    if (done >= session.tasks_required) {
      await pool.query(
        `UPDATE ll_sessions SET tasks_done = $1, status = 'completed', completed_at = now() WHERE id = $2`,
        [done, session.id]
      );
    } else {
      await pool.query('UPDATE ll_sessions SET tasks_done = $1 WHERE id = $2', [done, session.id]);
    }
    res.send('ok');
  } catch (e) {
    console.error('[postback]', e);
    res.status(500).send('error');
  }
});

// ---------- GET /api/key/status?puid=... ----------
// Polling apres les pubs: la cle est delivree quand la session est complete.
router.get('/key/status', async (req, res) => {
  try {
    const { puid } = req.query;
    if (!puid || typeof puid !== 'string' || puid.length > 64) {
      return res.status(400).json({ success: false, error: 'puid requis' });
    }
    const { rows } = await pool.query('SELECT * FROM ll_sessions WHERE puid = $1', [puid]);
    const session = rows[0];
    if (!session) return res.status(404).json({ success: false, error: 'Session inconnue' });

    if (session.status !== 'completed') {
      return res.json({ success: true, status: 'pending', tasksDone: session.tasks_done, tasksRequired: session.tasks_required });
    }

    // Session completee: delivrer ou prolonger la cle
    // Recupere la duree choisie au start de la session
    const sess = await pool.query('SELECT tasks_required FROM ll_sessions WHERE id = $1', [session.id]);
    const duration = sess.rows[0].tasks_required === 1 ? 12 : 24;

    if (session.key_id) {
      // Renouvellement: meme kid, meme string cote client
      const upd = await pool.query(
        `UPDATE keys SET expires_at = now() + make_interval(hours => $1), duration_hours = $1, renewed_count = renewed_count + 1
         WHERE id = $2 AND revoked = false RETURNING kid, signature, expires_at`,
        [duration, session.key_id]
      );
      // NOTE: duration stockee en heures; make_interval accepte le param
      const key = upd.rows[0];
      return res.json({
        success: true,
        status: 'completed',
        renewed: true,
        key: `${key.kid}.${key.signature}`,
        expiresAt: key.expires_at,
      });
    }

    // Nouvelle cle
    const gen = crypto.generateKey();
    const ins = await pool.query(
      `INSERT INTO keys (kid, signature, duration_hours, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $3)) RETURNING id, kid, signature, expires_at`,
      [gen.kid, gen.signature, session.tasks_required === 1 ? 12 : 24]
    );
    const key = ins.rows[0];
    await pool.query('UPDATE ll_sessions SET key_id = $1 WHERE id = $2', [key.id, session.id]);

    res.json({
      success: true,
      status: 'completed',
      renewed: false,
      key: `${key.kid}.${key.signature}`,
      expiresAt: key.expires_at,
    });
  } catch (e) {
    console.error('[key/status]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ---------- GET /api/key/info?key=... ----------
// Countdown pour la page d'accueil (localStorage)
const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true });

router.get('/key/info', infoLimiter, async (req, res) => {
  try {
    const parsed = crypto.verifyKeyFormat(req.query.key || '');
    if (!parsed) return res.json({ success: false, error: 'Format invalide' });

    const { rows } = await pool.query(
      'SELECT kid, expires_at, revoked, bound_user_id FROM keys WHERE kid = $1',
      [parsed.kid]
    );
    const key = rows[0];
    if (!key) return res.json({ success: false, error: 'Cle inconnue' });
    if (key.revoked) return res.json({ success: false, error: 'Revoquee', revoked: true });

    const expired = new Date(key.expires_at).getTime() < Date.now();
    res.json({
      success: true,
      valid: !expired,
      expiresAt: key.expires_at,
      expired,
      bound: !!key.bound_user_id,
    });
  } catch (e) {
    console.error('[key/info]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ---------- POST /api/v1/check ----------
// Loader: { key, userId, executor, placeId } -> { script } si OK
router.post('/v1/check', checkLimiter, async (req, res) => {
  try {
    const { key, userId, executor } = req.body || {};
    const placeId = parseInt(req.body?.placeId, 10) || null;
    const parsed = crypto.verifyKeyFormat(key || '');
    if (!parsed) {
      return res.json({ success: false, reason: 'invalid_key' });
    }
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(uid)) return res.json({ success: false, reason: 'invalid_user' });

    const { rows } = await pool.query('SELECT * FROM keys WHERE kid = $1', [parsed.kid]);
    const dbKey = rows[0];
    if (!dbKey) return res.json({ success: false, reason: 'invalid_key' });
    if (dbKey.revoked) return res.json({ success: false, reason: 'revoked' });

    // Ban par UserId Roblox (cascade)
    const ban = await pool.query('SELECT id FROM bans WHERE user_id = $1', [uid]);
    if (ban.rows[0]) return res.json({ success: false, reason: 'banned' });

    // Liaison au premier UserId (NB: pg renvoie BIGINT en string -> comparaison en string)
    if (dbKey.bound_user_id !== null && String(dbKey.bound_user_id) !== String(uid)) {
      return res.json({ success: false, reason: 'bound_to_other_user' });
    }
    if (!dbKey.bound_user_id) {
      await pool.query('UPDATE keys SET bound_user_id = $1 WHERE id = $2', [uid, dbKey.id]);
    }

    // Expiration
    const expired = new Date(dbKey.expires_at).getTime() < Date.now();
    if (expired) return res.json({ success: false, reason: 'expired' });

    // Build actif pour CE jeu (placeId), sinon build "tous jeux" (place_id null)
    let buildQuery;
    if (placeId) {
      buildQuery = await pool.query(
        `SELECT b.id, b.version, b.content FROM script_builds b
         WHERE b.active = true AND b.place_id = $1
         ORDER BY b.created_at DESC LIMIT 1`,
        [placeId]
      );
      if (!buildQuery.rows[0]) {
        buildQuery = await pool.query(
          `SELECT b.id, b.version, b.content FROM script_builds b
           WHERE b.active = true AND b.place_id IS NULL
           ORDER BY b.created_at DESC LIMIT 1`
        );
      }
    } else {
      buildQuery = await pool.query(
        'SELECT b.id, b.version, b.content FROM script_builds b WHERE b.active = true ORDER BY b.created_at DESC LIMIT 1'
      );
    }
    if (!buildQuery.rows[0]) {
      return res.json({ success: false, reason: 'no_script' });
    }
    const activeBuild = buildQuery.rows[0];

    // Log execution
    await pool.query(
      `INSERT INTO executions (key_id, user_id, executor, build_id, version, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
      [dbKey.id, uid, (executor || '').slice(0, 40), activeBuild.id, activeBuild.version, clientIp(req)]
    );

    res.json({
      success: true,
      script: activeBuild.content,
      version: activeBuild.version,
      expiresAt: dbKey.expires_at,
    });
  } catch (e) {
    console.error('[v1/check]', e);
    res.status(500).json({ success: false, reason: 'server_error' });
  }
});

// ---------- POST /api/v1/report ----------
// Telemetrie loader: { userId, executor, version, error }
router.post('/v1/report', rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const { userId, executor, version, error } = req.body || {};
    await pool.query(
      'INSERT INTO error_reports (user_id, executor, version, error_msg) VALUES ($1,$2,$3,$4)',
      [
        parseInt(userId, 10) || null,
        (executor || '').slice(0, 40),
        parseInt(version, 10) || null,
        (error || '').slice(0, 500),
      ]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

// ---------- GET /api/v1/loader ----------
// Sert le loader GUI (rotatable sans redistribution)
router.get('/v1/loader', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  const fs = require('fs');
  const loaderPath = path.join(__dirname, '..', '..', 'loader', 'loader.luau');
  try {
    res.send(fs.readFileSync(loaderPath, 'utf8'));
  } catch {
    res.status(503).send('-- loader indisponible: loader/loader.luau manquant');
  }
});

// ---------- GET /api/stats/public ----------
// Compteur public accueil
router.get('/stats/public', async (req, res) => {
  try {
    const [execs, users] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM executions'),
      pool.query('SELECT COUNT(DISTINCT user_id)::int AS c FROM executions'),
    ]);
    res.json({
      success: true,
      executions: execs.rows[0].c,
      users: users.rows[0].c,
    });
  } catch {
    res.json({ success: true, executions: 0, users: 0 });
  }
});

module.exports = router;
