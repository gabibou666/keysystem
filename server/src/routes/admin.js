const express = require('express');
const crypto = require('../services/crypto');
const pool = require('../db');
const auth = require('../admin/auth');
const { runPipeline, rebuildWithPatches } = require('../compat/pipeline');
const { decryptAES, encryptAES } = require('../services/crypto');
const { notifyDiscord } = require('../services/notify');
const robuxOffers = require('../services/robux');

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
    // secure: base sur la requete reelle (Render = toujours HTTPS) plutot que NODE_ENV
    const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.cookie('ks_admin', token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: auth.SESSION_DURATION_MS,
      path: '/',
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
    const [execs, uniq, byExec, perDay, errs, keysPerDay, manualTotal] = await Promise.all([
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
      pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, COUNT(*)::int c
         FROM keys WHERE created_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(`SELECT COUNT(*)::int c FROM keys WHERE source = 'manual'`),
    ]);
    res.json({
      success: true,
      executions: execs.rows[0].c,
      uniqueUsers: uniq.rows[0].c,
      byExecutor: byExec.rows,
      perDay: perDay.rows,
      errors7d: errs.rows[0].c,
      keysPerDay: keysPerDay.rows,
      manualKeysTotal: manualTotal.rows[0].c,
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
    `SELECT k.id, k.kid, k.bound_user_id, k.duration_hours, k.note, k.source, k.expires_at, k.renewed_count, k.revoked, k.created_at,
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

// ---------- CREATION DE CLES MANUELLES ----------
// Body: { durationHours, count, boundUserId?, note? }
router.post('/keys/create', requireAdmin, async (req, res) => {
  try {
    const durationHours = parseInt(req.body?.durationHours, 10);
    const count = parseInt(req.body?.count, 10) || 1;
    const boundUserId = parseInt(req.body?.boundUserId, 10) || null;
    const note = (req.body?.note || '').slice(0, 200);

    if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > 8760) {
      return res.status(400).json({ success: false, error: 'Duration must be 1-8760 hours.' });
    }
    if (count < 1 || count > 50) {
      return res.status(400).json({ success: false, error: 'Count must be 1-50.' });
    }

    const created = [];
    for (let i = 0; i < count; i++) {
      const gen = crypto.generateKey();
      const ins = await pool.query(
        `INSERT INTO keys (kid, signature, bound_user_id, duration_hours, note, source, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'manual', now() + make_interval(hours => $4))
         RETURNING id, kid, signature, expires_at`,
        [gen.kid, gen.signature, boundUserId, durationHours, note || null]
      );
      const r = ins.rows[0];
      created.push({
        id: r.id,
        key: `${r.kid}.${r.signature}`,
        expiresAt: r.expires_at,
      });
    }

    res.json({ success: true, created, count: created.length, durationHours });
  } catch (e) {
    console.error('[keys/create]', e);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ---------- DETAIL D'UNE CLE ----------
router.get('/keys/:id/detail', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id, kid, signature, bound_user_id, duration_hours, note, source,
              expires_at, renewed_count, revoked, created_at
       FROM keys WHERE id = $1`,
      [id]
    );
    const k = rows[0];
    if (!k) return res.status(404).json({ success: false, error: 'Key not found.' });

    const execs = await pool.query(
      `SELECT executor, version, ip, created_at FROM executions
       WHERE key_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );

    res.json({
      success: true,
      key: {
        id: k.id,
        keyString: `${k.kid}.${k.signature}`,
        boundUserId: k.bound_user_id !== null ? parseInt(k.bound_user_id, 10) : null,
        durationHours: k.duration_hours,
        note: k.note,
        source: k.source,
        expiresAt: k.expires_at,
        renewedCount: k.renewed_count,
        revoked: k.revoked,
        createdAt: k.created_at,
        totalExecs: execs.rows.length,
      },
      executions: execs.rows.map((e) => ({
        executor: e.executor,
        version: parseInt(e.version, 10),
        ip: e.ip,
        at: e.created_at,
      })),
    });
  } catch (e) {
    console.error('[keys/detail]', e);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
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
  notifyDiscord({
    title: '⛔ User banned',
    color: 'ban',
    description: `Roblox ID \`${userId}\` banned by admin.`,
    fields: [{ name: 'Reason', value: reason || '—' }],
  });
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
    `SELECT v.id, v.version, v.note, v.place_id, v.original_hash, v.created_at, v.published, v.published_at,
            (SELECT COUNT(*)::int FROM script_builds b WHERE b.version_id = v.id) AS builds
     FROM script_versions v ORDER BY v.version DESC`
  );
  res.json({ success: true, versions: rows });
});

// Liste des scripts publiés par jeu (pour le loader: quel PlaceId a un script actif)
router.get('/script/games', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT place_id, MAX(version) AS version, MAX(published_at) AS published_at
     FROM script_builds WHERE active = true AND place_id IS NOT NULL
     GROUP BY place_id ORDER BY place_id`
  );
  res.json({ success: true, games: rows });
});

// Sauvegarder une nouvelle version (brouillon) + pipeline complet
router.post('/script/save', requireAdmin, async (req, res) => {
  try {
    const source = req.body?.source;
    const note = (req.body?.note || '').slice(0, 500);
    const placeId = parseInt(req.body?.placeId, 10) || null;
    if (typeof source !== 'string' || source.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Source vide ou trop courte' });
    }
    if (source.length > 500000) {
      return res.status(400).json({ success: false, error: 'Script trop volumineux (500 Ko max)' });
    }

    // Numero de version (global) + numero de version par jeu
    const last = await pool.query('SELECT COALESCE(MAX(version), 0) v FROM script_versions');
    const version = last.rows[0].v + 1;

    // Chiffre l'original
    const hash = crypto.sha256(source);
    const enc = encryptAES(source);

    const ins = await pool.query(
      `INSERT INTO script_versions (version, note, place_id, original_enc, original_iv, original_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [version, note, placeId, enc.enc, enc.iv, hash]
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
      `INSERT INTO script_builds (version_id, version, place_id, content, build_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [versionId, version, placeId, pipelineResult.build, pipelineResult.patches.length ? 'ai' : 'shims']
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

  const ver = await pool.query('SELECT id, place_id FROM script_versions WHERE version = $1', [version]);
  if (!ver.rows[0]) return res.status(404).json({ success: false, error: 'Version inconnue' });
  const placeId = ver.rows[0].place_id;

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

  // AUTO-SUPPRESSION: publier une version pour un jeu supprime automatiquement
  // toutes les anciennes versions de CE jeu (builds + versions + patches orphelins).
  // Le dashboard reste propre: un PlaceId = UNE version en cours.
  const verRow = ver.rows[0];

  // 1. Anciennes versions du meme PlaceId (hors celle qu'on publie)
  const oldVersions = await pool.query(
    `SELECT v.id, v.version FROM script_versions v
     WHERE v.place_id IS NOT DISTINCT FROM $1 AND v.id <> $2`,
    [placeId, verRow.id]
  );
  let removedVersions = 0;
  if (oldVersions.rows.length) {
    const oldIds = oldVersions.rows.map((r) => r.id);
    // Ordonne: detach executions -> patches -> builds -> versions (respect des FK)
    await pool.query(
      `UPDATE executions SET build_id = NULL WHERE build_id IN (SELECT id FROM script_builds WHERE version_id = ANY($1::int[]))`,
      [oldIds]
    );
    await pool.query(
      `DELETE FROM ai_patches WHERE build_id IN (SELECT id FROM script_builds WHERE version_id = ANY($1::int[]))`,
      [oldIds]
    );
    await pool.query(`DELETE FROM script_builds WHERE version_id = ANY($1::int[])`, [oldIds]);
    await pool.query(`DELETE FROM script_versions WHERE id = ANY($1::int[])`, [oldIds]);
    removedVersions = oldIds.length;
  }

  // 2. Builds restants du meme jeu hors la version publiee (le DELETE est STRICTEMENT
  //    exclusif de verRow.id: jamais toucher le build de la version qu'on publie)
  await pool.query(
    `DELETE FROM script_builds WHERE version_id <> $2 AND (place_id IS NOT DISTINCT FROM $1 AND version <> $3)`,
    [placeId, verRow.id, version]
  );

  // 3. Active le build de la version publiee (garantit qu'il existe)
  const activated = await pool.query(
    `UPDATE script_builds SET active = true WHERE version = $1 RETURNING id`,
    [version]
  );
  if (!activated.rows.length) {
    // Filet de securite: version sans build (cas v3/v4 casses par l'ancien bug).
    // On reconstruit depuis l'original chiffre via le pipeline.
    const { rebuildVersionBuild } = require('../compat/pipeline-helpers');
    const rebuilt = await rebuildVersionBuild(verRow.id);
    if (!rebuilt) {
      return res.status(409).json({
        success: false,
        error: 'Cette version n\'a pas de build — re-save le script puis publie.',
      });
    }
  }
  await pool.query(
    'UPDATE script_versions SET published = true, published_at = now() WHERE version = $1',
    [version]
  );
  res.json({ success: true, removedOldVersions: removedVersions });
});

// ---------- STATS VENTES ROBUX (format attendu par l'onglet Revenue) ----------
router.get('/robux-stats', requireAdmin, async (req, res) => {
  try {
    const offers = robuxOffers.getOffers();
    const priceBySku = Object.fromEntries(offers.map((o) => [o.sku, o.priceR$]));
    const nameBySku = Object.fromEntries(offers.map((o) => [o.sku, o.name]));

    // Achats livres: purchases (gamepass) + receipts (webhook in-game)
    const [purchTotals, purchPerDay, purchPerSku, recentPurch, recentReceipts] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int c, COALESCE(SUM(
           CASE offer_sku WHEN 'day1' THEN 50 WHEN 'week1' THEN 250
             WHEN 'month1' THEN 750 WHEN 'lifetime' THEN 2000 ELSE 0 END
         ), 0)::int robux
         FROM robux_purchases WHERE status = 'delivered'`
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', verified_at), 'YYYY-MM-DD') d,
                COUNT(*)::int cnt,
                COALESCE(SUM(CASE offer_sku WHEN 'day1' THEN 50 WHEN 'week1' THEN 250
                   WHEN 'month1' THEN 750 WHEN 'lifetime' THEN 2000 ELSE 0 END), 0)::int revenue
         FROM robux_purchases WHERE status = 'delivered' AND verified_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT offer_sku sku, COUNT(*)::int count FROM robux_purchases
         WHERE status = 'delivered' GROUP BY 1`
      ),
      pool.query(
        `SELECT roblox_user_id "userId", roblox_username username, offer_sku offer, status,
                verified_at date
         FROM robux_purchases ORDER BY verified_at DESC LIMIT 50`
      ),
      pool.query(
        `SELECT roblox_user_id "userId", roblox_username username, offer_sku offer, status,
                created_at date
         FROM robux_receipts ORDER BY created_at DESC LIMIT 50`
      ),
    ]);

    // Fusionne purchases + receipts (historique recent, sans doublons receipt/purchase eventuels)
    const seen = new Set();
    const recentSales = [...recentPurch.rows, ...recentReceipts.rows]
      .filter((r) => {
        const id = r.userId + ':' + r.offer + ':' + new Date(r.date).toISOString().slice(0, 16);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 50)
      .map((r) => ({
        userId: parseInt(r.userId, 10),
        username: r.username,
        offer: r.offer,
        offerName: nameBySku[r.offer] || r.offer,
        priceR$: priceBySku[r.offer] || 0,
        method: recentReceipts.rows.includes(r) ? 'webhook' : 'gamepass',
        status: r.status,
        date: r.date,
      }));

    res.json({
      success: true,
      totals: {
        revenueR$: purchTotals.rows[0].robux,
        purchases: purchTotals.rows[0].c,
      },
      perDay: purchPerDay.rows.map((r) => ({ d: r.d, count: r.cnt, revenue: r.revenue })),
      perOffer: purchPerSku.rows.map((r) => ({
        sku: r.sku,
        count: r.count,
        revenue: (priceBySku[r.sku] || 0) * r.count,
        priceR$: priceBySku[r.sku] || 0,
      })),
      recentSales,
    });
  } catch (e) {
    console.error('[admin/robux-stats]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ---------- DECODAGE WATERMARK (tracer un leak) ----------
// POST /api/admin/watermark/decode { wm } -> acheteur, executions, beacons
router.post('/watermark/decode', requireAdmin, async (req, res) => {
  try {
    const decoded = require('../services/watermark').decodeWatermark(String(req.body?.wm || '').slice(0, 300));
    if (!decoded) return res.status(400).json({ success: false, error: 'Invalid watermark' });

    const execs = await pool.query(
      `SELECT e.key_id, e.user_id, e.executor, e.version, e.ip, e.created_at,
              k.kid, k.revoked, k.share_alerts
       FROM executions e LEFT JOIN keys k ON k.id = e.key_id
       WHERE e.wm_nonce = $1`,
      [decoded.nonce]
    );
    const beacons = await pool.query(
      `SELECT user_id, executor, ip, created_at FROM beacons WHERE wm_nonce = $1 ORDER BY created_at DESC LIMIT 50`,
      [decoded.nonce]
    );

    res.json({
      success: true,
      watermark: {
        nonce: decoded.nonce,
        issuedToUserId: decoded.userId,
        issuedAt: decoded.issuedAt,
      },
      execution: execs.rows[0] || null,
      beacons: beacons.rows,
      distinctIps: [...new Set(beacons.rows.map((b) => b.ip))].length,
    });
  } catch (e) {
    console.error('[watermark/decode]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
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

// ---------- ROBUX REVENUE STATS ----------
// Revenus Robux: totaux, par offre, par jour, dernieres ventes
router.get('/robux-stats', requireAdmin, async (req, res) => {
  try {
    const priceMap = { day1: 50, week1: 250, month1: 750, lifetime: 2000 };

    const [totalPurchases, totalReceipts, perOfferP, perOfferR, perDayP, perDayR, recentP, recentR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int c FROM robux_purchases`),
      pool.query(`SELECT COUNT(*)::int c FROM robux_receipts`),
      pool.query(
        `SELECT offer_sku, COUNT(*)::int c FROM robux_purchases WHERE status = 'delivered' GROUP BY offer_sku ORDER BY c DESC`
      ),
      pool.query(
        `SELECT offer_sku, COUNT(*)::int c FROM robux_receipts GROUP BY offer_sku ORDER BY c DESC`
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', verified_at), 'YYYY-MM-DD') d, COUNT(*)::int c
         FROM robux_purchases WHERE status = 'delivered'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, COUNT(*)::int c
         FROM robux_receipts
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT roblox_username, roblox_user_id, offer_sku, status, delivered_at, verified_at
         FROM robux_purchases ORDER BY verified_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT roblox_username, roblox_user_id, offer_sku, key_string, created_at
         FROM robux_receipts ORDER BY created_at DESC LIMIT 20`
      ),
    ]);

    // Merge purchases + receipts pour les stats
    const mergeOffers = {};
    for (const r of [...perOfferP.rows, ...perOfferR.rows]) {
      mergeOffers[r.offer_sku] = (mergeOffers[r.offer_sku] || 0) + r.c;
    }
    const offersBreakdown = Object.entries(mergeOffers).map(([sku, count]) => ({
      sku,
      count,
      priceR$: priceMap[sku] || 0,
      revenue: (priceMap[sku] || 0) * count,
    })).sort((a, b) => b.revenue - a.revenue);

    // Merge par jour
    const mergeDays = {};
    for (const r of [...perDayP.rows, ...perDayR.rows]) {
      mergeDays[r.d] = (mergeDays[r.d] || 0) + r.c;
    }
    const perDay = Object.entries(mergeDays).map(([d, c]) => ({ d, c })).sort((a, b) => a.d.localeCompare(b.d));

    // Calculer revenu par jour
    const priceBySku = priceMap;
    const perDayRevenue = perDay.map(x => {
      // Revenu estime basé sur la repartition proportionnelle
      const totalUnits = Object.values(mergeOffers).reduce((a, b) => a + b, 0) || 1;
      let rev = 0;
      for (const [sku, count] of Object.entries(mergeOffers)) {
        const ratio = count / totalUnits;
        rev += (priceBySku[sku] || 0) * Math.round(x.c * ratio);
      }
      return { d: x.d, c: x.c, revenue: Math.round(rev) };
    });

    const totalUnits = offersBreakdown.reduce((a, b) => a + b.count, 0);
    const totalRevenue = offersBreakdown.reduce((a, b) => a + b.revenue, 0);

    // Recent sales merged (purchases + receipts)
    const recentSales = [
      ...recentP.rows.map(r => ({
        username: r.roblox_username,
        userId: r.roblox_user_id,
        offer: r.offer_sku,
        priceR$: priceMap[r.offer_sku] || 0,
        status: r.status,
        date: r.delivered_at || r.verified_at,
        method: 'gamepass',
      })),
      ...recentR.rows.map(r => ({
        username: r.roblox_username,
        userId: r.roblox_user_id,
        offer: r.offer_sku,
        priceR$: priceMap[r.offer_sku] || 0,
        status: 'delivered',
        date: r.created_at,
        method: 'webhook',
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

    res.json({
      success: true,
      totals: {
        purchases: totalPurchases.rows[0].c + totalReceipts.rows[0].c,
        revenueR$: totalRevenue,
        uniqueBuyers: totalPurchases.rows[0].c + totalReceipts.rows[0].c,
      },
      perOffer: offersBreakdown,
      perDay: perDayRevenue,
      recentSales,
    });
  } catch (e) {
    console.error('[admin/robux-stats]', e);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
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
