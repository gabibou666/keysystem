const express = require('express');
const crypto = require('../services/crypto');
const pool = require('../db');
const auth = require('../admin/auth');
const { runPipeline, rebuildWithPatches } = require('../compat/pipeline');
const { decryptAES, encryptAES } = require('../services/crypto');

const router = express.Router();

function adminRedirectUri(req) {
  return `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/admin/auth/callback`;
}

// Middleware: exige une session admin
async function requireAdmin(req, res, next) {
  const session = await auth.getSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Non autorise' });
  req.admin = session;
  next();
}

// ---------- OAuth ----------
router.get('/auth/login', (req, res) => {
  auth.getLoginUrl(adminRedirectUri(req)).then((url) => res.redirect(url));
});

router.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('code manquant');
    const tokenData = await auth.exchangeCode(code, adminRedirectUri(req));
    const user = await auth.fetchDiscordUser(tokenData.access_token);
    if (!auth.getAdminIds().includes(user.id)) {
      return res.status(403).send('Ce compte Discord n est pas administrateur.');
    }
    const token = await auth.createSession(user.id);
    res.cookie('ks_admin', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: auth.SESSION_DURATION_MS,
    });
    res.redirect('/admin/');
  } catch (e) {
    console.error('[admin/callback]', e);
    res.status(500).send('Erreur OAuth Discord');
  }
});

router.post('/auth/logout', async (req, res) => {
  await auth.destroySession(req);
  res.clearCookie('ks_admin');
  res.json({ success: true });
});

router.get('/me', async (req, res) => {
  const session = await auth.getSession(req);
  res.json({ loggedIn: !!session, discordId: session ? session.discord_id : null });
});

// ---------- STATS ----------
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [execs, uniq, byExec, perDay, errs] = await Promise.all([
      pool.query('SELECT COUNT(*)::int c FROM executions'),
      pool.query('SELECT COUNT(DISTINCT user_id)::int c FROM executions'),
      pool.query(
        `SELECT executor, COUNT(*)::int c FROM executions GROUP BY executor ORDER BY c DESC LIMIT 15`
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, COUNT(*)::int c
         FROM executions WHERE created_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT COUNT(*)::int c FROM error_reports WHERE created_at > now() - interval '7 days'`
      ),
    ]);
    res.json({
      success: true,
      executions: execs.rows[0].c,
      uniqueUsers: uniq.rows[0].c,
      byExecutor: byExec.rows,
      perDay: perDay.rows,
      errors7d: errs.rows[0].c,
    });
  } catch (e) {
    console.error('[admin/stats]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ---------- CLES ----------
router.get('/keys', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const { rows } = await pool.query(
    `SELECT k.id, k.kid, k.bound_user_id, k.duration_hours, k.expires_at, k.renewed_count, k.revoked, k.created_at,
            (SELECT COUNT(*)::int FROM executions e WHERE e.key_id = k.id) AS execs
     FROM keys k ORDER BY k.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ success: true, keys: rows });
});

router.post('/keys/:id/revoke', requireAdmin, async (req, res) => {
  await pool.query('UPDATE keys SET revoked = true WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

router.post('/keys/:id/unrevoke', requireAdmin, async (req, res) => {
  await pool.query('UPDATE keys SET revoked = false WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ---------- BANS ----------
router.get('/bans', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bans ORDER BY created_at DESC LIMIT 200');
  res.json({ success: true, bans: rows });
});

router.post('/bans', requireAdmin, async (req, res) => {
  const userId = parseInt(req.body?.userId, 10);
  if (!Number.isFinite(userId)) return res.status(400).json({ success: false, error: 'userId invalide' });
  const reason = (req.body?.reason || '').slice(0, 200);
  await pool.query(
    `INSERT INTO bans (user_id, reason) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason`,
    [userId, reason]
  );
  res.json({ success: true });
});

router.delete('/bans/:userId', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM bans WHERE user_id = $1', [parseInt(req.params.userId, 10)]);
  res.json({ success: true });
});

// ---------- SCRIPT MANAGER ----------
// Liste des versions (sans le contenu chiffre)
router.get('/script/versions', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.note, v.original_hash, v.created_at, v.published, v.published_at,
            (SELECT COUNT(*)::int FROM script_builds b WHERE b.version_id = v.id) AS builds
     FROM script_versions v ORDER BY v.version DESC`
  );
  res.json({ success: true, versions: rows });
});

// Sauvegarder une nouvelle version (brouillon) + pipeline complet
router.post('/script/save', requireAdmin, async (req, res) => {
  try {
    const source = req.body?.source;
    const note = (req.body?.note || '').slice(0, 500);
    if (typeof source !== 'string' || source.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Source vide ou trop courte' });
    }
    if (source.length > 500000) {
      return res.status(400).json({ success: false, error: 'Script trop volumineux (500 Ko max)' });
    }

    // Numero de version
    const last = await pool.query('SELECT COALESCE(MAX(version), 0) v FROM script_versions');
    const version = last.rows[0].v + 1;

    // Chiffre l'original
    const hash = crypto.sha256(source);
    const enc = encryptAES(source);

    const ins = await pool.query(
      `INSERT INTO script_versions (version, note, original_enc, original_iv, original_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [version, note, enc.enc, enc.iv, hash]
    );
    const versionId = ins.rows[0].id;

    // Pipeline complet (shims + IA + obfuscation)
    let pipelineResult;
    try {
      pipelineResult = await runPipeline(source, { useAI: true });
    } catch (e) {
      return res.status(422).json({
        success: false,
        error: `Pipeline echoue: ${e.message}`,
        versionId,
      });
    }

    // Build shims (+ patches valides auto)
    const buildIns = await pool.query(
      `INSERT INTO script_builds (version_id, version, content, build_type) VALUES ($1, $2, $3, $4) RETURNING id`,
      [versionId, version, pipelineResult.build, pipelineResult.patches.length ? 'ai' : 'shims']
    );
    const buildId = buildIns.rows[0].id;

    // Patches IA en attente de review
    for (const p of pipelineResult.patches) {
      await pool.query(
        'INSERT INTO ai_patches (build_id, find, replace, reason) VALUES ($1, $2, $3, $4)',
        [buildId, p.find, p.replace, p.reason || '']
      );
    }

    res.json({
      success: true,
      version,
      versionId,
      buildId,
      buildType: pipelineResult.patches.length ? 'ai' : 'shims',
      patches: pipelineResult.patches.length,
      rejectedPatches: pipelineResult.rejectedPatches,
      compatReport: pipelineResult.report,
    });
  } catch (e) {
    console.error('[script/save]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// Obtenir l'original deciffré (en memoire uniquement, pour l'editeur)
router.get('/script/original/:version', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT original_enc, original_iv, original_hash FROM script_versions WHERE version = $1',
    [parseInt(req.params.version, 10)]
  );
  const v = rows[0];
  if (!v) return res.status(404).json({ success: false, error: 'Version inconnue' });
  try {
    const source = decryptAES(v.original_enc, v.original_iv);
    if (crypto.sha256(source) !== v.original_hash) {
      return res.status(500).json({ success: false, error: 'Integrite compromise (hash mismatch)' });
    }
    res.json({ success: true, source });
  } catch {
    res.status(500).json({ success: false, error: 'AES_KEY incorrecte ou donnees corrompues' });
  }
});

// Publier une version (build actif)
router.post('/script/publish', requireAdmin, async (req, res) => {
  const version = parseInt(req.body?.version, 10);
  if (!Number.isFinite(version)) return res.status(400).json({ success: false, error: 'version requise' });

  const ver = await pool.query('SELECT id FROM script_versions WHERE version = $1', [version]);
  if (!ver.rows[0]) return res.status(404).json({ success: false, error: 'Version inconnue' });

  // Patches IA rejects appliques? Verifie qu'aucun patch pending pour ce build
  const pending = await pool.query(
    `SELECT COUNT(*)::int c FROM ai_patches p
     JOIN script_builds b ON b.id = p.build_id
     WHERE b.version = $1 AND p.status = 'pending'`,
    [version]
  );
  if (pending.rows[0].c > 0) {
    return res.status(409).json({
      success: false,
      error: `${pending.rows[0].c} patch(s) IA en attente de review. Approuve-les ou rejette-les d'abord.`,
    });
  }

  await pool.query('UPDATE script_builds SET active = false WHERE active = true');
  await pool.query('UPDATE script_builds SET active = true WHERE version = $1', [version]);
  await pool.query(
    'UPDATE script_versions SET published = true, published_at = now() WHERE version = $1',
    [version]
  );
  res.json({ success: true });
});

// ---------- PATCHS IA ----------
router.get('/patches/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.build_id, p.find, p.replace, p.reason, p.created_at, b.version
     FROM ai_patches p JOIN script_builds b ON b.id = p.build_id
     WHERE p.status = 'pending' ORDER BY p.created_at DESC`
  );
  res.json({ success: true, patches: rows });
});

router.post('/patches/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE ai_patches SET status = 'approved' WHERE id = $1 RETURNING build_id, find, replace`,
      [req.params.id]
    );
    const patch = rows[0];
    if (!patch) return res.status(404).json({ success: false, error: 'Patch inconnu' });

    // Reconstruit le build avec tous les patches approuves
    const build = await pool.query('SELECT version_id, version FROM script_builds WHERE id = $1', [patch.build_id]);
    const ver = await pool.query(
      'SELECT original_enc, original_iv, original_hash FROM script_versions WHERE id = $1',
      [build.rows[0].version_id]
    );
    const source = decryptAES(ver.rows[0].original_enc, ver.rows[0].original_iv);

    const approved = await pool.query(
      `SELECT find, replace FROM ai_patches WHERE build_id = $1 AND status = 'approved'`,
      [patch.build_id]
    );
    const { build: newBuild } = rebuildWithPatches(source, approved.rows);

    await pool.query('UPDATE script_builds SET content = $1 WHERE id = $2', [newBuild, patch.build_id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[patches/approve]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/patches/:id/reject', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE ai_patches SET status = 'rejected' WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

// ---------- CHANGELOG (public data pour la page /changelog) ----------
router.get('/changelog', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT version, note, created_at, published FROM script_versions
     WHERE published = true AND note <> '' ORDER BY version DESC LIMIT 50`
  );
  res.json({ success: true, versions: rows });
});

module.exports = router;
