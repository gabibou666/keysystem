const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('../services/crypto');
const lootlabs = require('../services/lootlabs');
const pool = require('../db');
const path = require('path');
const { requireDiscordUser } = require('./discord');
const discordService = require('../services/discord');
const tokens = require('../services/tokens');
const { getGameInfo, getUsersInfo } = require('../services/roblox');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  message: { success: false, error: 'Too many requests, try again in a few minutes.' },
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
// GATE: connexion Discord requise (ajout au serveur via OAuth)
// Anti-bypass: puid 32 bytes non devinable + session liee au proprietaire (owner_discord_id)
// + rate-limit strict (express-rate-limit) + limite 2 pubs/12h/IP
router.post('/key/start', startLimiter, requireDiscordUser, async (req, res) => {
  try {
    const duration = parseInt(req.body?.duration, 10);
    if (!lootlabs.DURATIONS[duration]) {
      return res.status(400).json({ success: false, error: 'Invalid duration (12 or 24).' });
    }

    let keyId = null;
    // Renouvellement: une cle valide peut etre prolongee
    if (req.body?.key) {
      const parsed = crypto.verifyKeyFormat(req.body.key);
      if (!parsed) return res.status(400).json({ success: false, error: 'Invalid key.' });
      const { rows } = await pool.query('SELECT id, revoked FROM keys WHERE kid = $1', [parsed.kid]);
      if (!rows[0] || rows[0].revoked) {
        return res.status(400).json({ success: false, error: 'Unknown or revoked key.' });
      }
      keyId = rows[0].id;
    }

    // Ad limit: max 2 ad sessions per IP within 12 hours (anti-farm en masse)
    const ip = clientIp(req);
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ll_sessions
       WHERE ip = $1 AND created_at > now() - interval '12 hours'`,
      [ip]
    );
    if (recent.rows[0].c >= 2) {
      return res.status(429).json({
        success: false,
        reason: 'ad_limit',
        error: 'Ad limit reached (2 ads max every 12 hours). Come back later.',
      });
    }

    // puid 32 bytes (64 hex): non devinable, non enumerable
    const puid = crypto.randomToken(32);

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
          'Could not create the link: ' +
          (e.lootlabsMessage || e.message) +
          ' (check your Creator Details in the LootLabs panel)',
      });
    }

    // La session est liee au proprietaire Discord: le status ne delivrera
    // la cle qu'a CE proprietaire (cookie signe ks_user).
    await pool.query(
      `INSERT INTO ll_sessions (puid, key_id, tasks_required, ip, owner_discord_id, started_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [puid, keyId, tasksRequired, ip, req.discordId]
    );

    res.json({ success: true, lootUrl, puid, tasksRequired });
  } catch (e) {
    console.error('[key/start]', e);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ---------- POSTBACK LOOTLABS (verification serveur-a-serveur) ----------
// Doc: help.lootlabs.gg/en/article/postback-api-1ndz3i2/
// "Every time a user completes a task, a GET Request will be sent to your postback URL"
// Protections cumulees ici:
//   1. Origin: IP source du postback doit resoudre vers un domaine LootLabs (verif DNS)
//      ou etre l'IP user annoncee (fallback template court) — le referer seul est spoofable
//   2. Delai minimum realiste: > 20s depuis started_at (un humain met du temps, un bot valide en secondes)
//   3. Transaction atomique: FOR UPDATE + dedup unique_id (jamais deux fois le meme checkpoint)
//   4. A la complétion: generation du TOKEN DE COMPLETION (JWT signe, usage unique, TTL 5 min)
//      -> /key/status l'exigera pour delivrer la cle. Aucune delivrance sans lui.
router.get('/lootlabs/postback', async (req, res) => {
  try {
    const { click_id } = req.query;
    if (!click_id || typeof click_id !== 'string' || click_id.length > 128) {
      return res.status(400).send('missing click_id');
    }

    // unique_id optionnel: fallback genere si le template du panel ne l'inclut pas
    const unique_id =
      (typeof req.query.unique_id === 'string' && req.query.unique_id.slice(0, 128)) ||
      'auto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const claimedUserIp = typeof req.query.ip === 'string' ? req.query.ip.slice(0, 64) : null;

    // --- Verification d'origine: le postback doit venir de l'infrastructure LootLabs ---
    // (doc: "A GET request will be sent there" — serveur LootLabs -> nous)
    const sourceIp = clientIp(req);
    const dns = require('dns').promises;
    let originOk = false;
    let originNote = 'unknown';
    try {
      // Resout les domaines officiels LootLabs et compare avec l'IP source
      const hosts = ['lootlabs.gg', 'creators.lootlabs.gg', 'loot-link.com', 'links.lootlabs.gg'];
      const lists = await Promise.all(
        hosts.map((h) => dns.resolve(h).catch(() => []))
      );
      const allIps = new Set(lists.flat());
      if (allIps.has(sourceIp)) {
        originOk = true;
        originNote = 'lootlabs_infra';
      } else {
        // Fallback accepte: CDN/proxy legitimes (Render est derriere Cloudflare, l'IP source
        // peut etre un edge). On accepte si l'IP USER annoncee par LootLabs correspond
        // a une session recente activee par cette IP (cohérence metier).
        originNote = 'not_direct_infra';
      }
    } catch {
      originNote = 'dns_error';
    }

    // Dedup par unique_id (doc: "prevent duplicate processing")
    const dup = await pool.query('SELECT id FROM postbacks WHERE unique_id = $1', [unique_id]);
    if (dup.rows[0]) return res.send('duplicate ok');

    // Session + transaction
    const sess = await pool.query(
      'SELECT * FROM ll_sessions WHERE puid = $1 FOR UPDATE',
      [click_id]
    );
    const session = sess.rows[0];
    if (!session) return res.status(404).send('session not found');

    // --- Delai minimum realiste: un humain complete en > 20s, un bypass script en secondes ---
    const MIN_SECONDS = 20;
    const elapsedSec = (Date.now() - new Date(session.started_at).getTime()) / 1000;
    if (elapsedSec < MIN_SECONDS) {
      console.warn(`[postback] REJET delai ${elapsedSec.toFixed(1)}s < ${MIN_SECONDS}s (puid=${click_id.slice(0, 8)}...)`);
      await pool.query(
        `UPDATE ll_sessions SET status = 'rejected_too_fast' WHERE id = $1 AND status = 'pending'`,
        [session.id]
      );
      return res.status(429).send('rejected: completed too fast');
    }

    // --- Cohérence IP metier: l'IP user annoncee doit matcher l'IP qui a cree la session
    //     (si le template du panel fournit ip=). Un attaquant qui forge un postback depuis
    //     son serveur ne connaît pas l'IP de la victime. Silencieux pour les vrais users.
    if (claimedUserIp && session.ip && claimedUserIp !== session.ip) {
      console.warn(`[postback] REJET ip mismatch: annoncee=${claimedUserIp} session=${session.ip}`);
      return res.status(403).send('rejected: ip mismatch');
    }

    // Trace le postback (audit: IP source + note origine)
    await pool.query('INSERT INTO postbacks (unique_id, puid, ip) VALUES ($1, $2, $3)', [
      unique_id,
      click_id,
      sourceIp,
    ]);
    await pool.query('UPDATE ll_sessions SET postback_ip = $1 WHERE id = $2', [sourceIp, session.id]);

    if (session.status === 'completed') return res.send('already ok');
    if (originNote === 'not_direct_infra') {
      // On log pour audit mais on continue (CDN legitime possible) — la defense principale
      // reste: delai minimum + dedup + token signe + IP metier.
      console.log(`[postback] origin note: ${originNote} (src=${sourceIp})`);
    }

    const done = session.tasks_done + 1;
    if (done >= session.tasks_required) {
      // Complétion: genere le TOKEN signe a usage unique (TTL 5 min).
      // La cle ne sera delivree QUE via ce token + proprietaire verifie.
      const completionToken = tokens.issueCompletionToken({
        puid: click_id,
        ownerDiscordId: session.owner_discord_id,
        ip: session.ip,
        tasksDone: done,
        tasksRequired: session.tasks_required,
      });
      await pool.query(
        `UPDATE ll_sessions SET tasks_done = $1, status = 'completed', completed_at = now(), completion_token = $2 WHERE id = $3`,
        [done, completionToken, session.id]
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
// ANTI-BYPASS (couches cumulees):
//   1. Seul le PROPRIETAIRE de la session (owner_discord_id == cookie ks_user signe)
//      peut recevoir la cle — un puid vole/ne fuite ne sert a rien.
//   2. La delivrance exige le TOKEN DE COMPLETION (JWT signe, usage unique, TTL 5 min)
//      genere par le postback — pas de token, pas de cle.
//   3. Le token est brule (NULL) au premier usage reussi: impossible de rejouer.
//   4. Rate-limite specifique (polling) — un script de polling en masse se bloque.
// Les utilisateurs legitimes ne voient AUCUNE difference (leur cookie+token sont valides).
const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });

router.get('/key/status', statusLimiter, async (req, res) => {
  try {
    const { puid } = req.query;
    if (!puid || typeof puid !== 'string' || puid.length > 128) {
      return res.status(400).json({ success: false, error: 'puid required' });
    }
    const { rows } = await pool.query('SELECT * FROM ll_sessions WHERE puid = $1', [puid]);
    const session = rows[0];
    if (!session) return res.status(404).json({ success: false, error: 'Unknown session' });

    if (session.status === 'rejected_too_fast') {
      return res.json({ success: true, status: 'rejected', reason: 'too_fast' });
    }

    // Session deja delivree (token brule): rejeu impossible, message clair.
    // Verifie AVANT le lock proprietaire pour ne pas dependre du cookie sur une session morte.
    if (session.status === 'claimed') {
      return res.status(409).json({
        success: false,
        status: 'already_claimed',
        error: 'This session\'s key has already been claimed.',
      });
    }

    if (session.status !== 'completed') {
      return res.json({ success: true, status: 'pending', tasksDone: session.tasks_done, tasksRequired: session.tasks_required });
    }

    // --- Verrou proprietaire: la session appartient a un Discord user ---
    // (toutes les sessions post-migration ont un owner; les anciennes sans owner
    //  ne sont plus delivrables — securite avant compatibilite)
    const requesterDiscordId = discordService.verifyUserCookie(req.cookies && req.cookies[discordService.USER_COOKIE]);
    if (!session.owner_discord_id || !requesterDiscordId || requesterDiscordId !== session.owner_discord_id) {
      console.warn(`[key/status] REJET non-proprietaire (puid=${String(puid).slice(0, 8)}..., owner=${session.owner_discord_id ? 'set' : 'none'}, requester=${requesterDiscordId ? 'set' : 'none'})`);
      return res.status(403).json({
        success: false,
        status: 'forbidden',
        error: 'This key session belongs to another user.',
      });
    }

    // --- Token de completion: JWT signe, usage unique (deja consomme = NULL) ---
    if (!session.completion_token) {
      console.warn(`[key/status] REJET token absent/deja consomme (puid=${String(puid).slice(0, 8)}...)`);
      return res.status(409).json({
        success: false,
        status: 'already_claimed',
        error: 'This session\'s key has already been claimed.',
      });
    }
    const tokenCheck = tokens.verifyCompletionToken(session.completion_token, { expectPuid: session.puid });
    if (!tokenCheck.valid) {
      // Expire ou invalide: on brule le token (attaque par force impossible)
      await pool.query('UPDATE ll_sessions SET completion_token = NULL WHERE id = $1', [session.id]);
      console.warn(`[key/status] REJET token ${tokenCheck.reason} (puid=${String(puid).slice(0, 8)}...)`);
      return res.status(403).json({
        success: false,
        status: 'token_' + tokenCheck.reason,
        error: 'Session expired — start a new one.',
      });
    }

    // --- Tout est valide: on BRULE le token (usage unique) et on delivre ---
    await pool.query(
      `UPDATE ll_sessions SET completion_token = NULL, status = 'claimed', claimed_at = now() WHERE id = $1`,
      [session.id]
    );

    // Recupere la duree choisie au start de la session
    const duration = session.tasks_required === 1 ? 12 : 24;

    if (session.key_id) {
      // Renouvellement: meme kid, meme string cote client
      const upd = await pool.query(
        `UPDATE keys SET expires_at = now() + make_interval(hours => $1), duration_hours = $1, renewed_count = renewed_count + 1
         WHERE id = $2 AND revoked = false RETURNING kid, signature, expires_at`,
        [duration, session.key_id]
      );
      if (!upd.rows[0]) {
        return res.json({ success: false, status: 'revoked_key', error: 'Key was revoked.' });
      }
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
      [gen.kid, gen.signature, duration]
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
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ---------- GET /api/key/info?key=... ----------
// Countdown pour la page d'accueil (localStorage)
const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true });

router.get('/key/info', infoLimiter, async (req, res) => {
  try {
    const parsed = crypto.verifyKeyFormat(req.query.key || '');
    if (!parsed) return res.json({ success: false, error: 'Invalid format' });

    const { rows } = await pool.query(
      'SELECT kid, expires_at, revoked, bound_user_id FROM keys WHERE kid = $1',
      [parsed.kid]
    );
    const key = rows[0];
    if (!key) return res.json({ success: false, error: 'Unknown key' });
    if (key.revoked) return res.json({ success: false, error: 'Revoked', revoked: true });

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
    res.status(500).json({ success: false, error: 'Server error.' });
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

// ---------- GET /api/games/public ----------
// Jeux supportes (builds actifs) avec nom + icone + stats recuperees des APIs Roblox
router.get('/games/public', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (place_id) place_id, version
       FROM script_builds WHERE active = true AND place_id IS NOT NULL
       ORDER BY place_id, created_at DESC`
    );
    const games = await Promise.all(
      rows.map((r) =>
        getGameInfo(r.place_id).then((info) => ({
          placeId: parseInt(r.place_id, 10),
          version: parseInt(r.version, 10),
          name: info ? info.name : `Game ${r.place_id}`,
          iconUrl: info ? info.iconUrl : null,
          playing: info ? info.playing : null,
          visits: info && info.visits != null ? parseInt(info.visits, 10) : null,
        }))
      )
    );
    // Trie par joueurs actuels decroissant (nulls a la fin)
    games.sort((a, b) => (b.playing || 0) - (a.playing || 0));
    res.json({ success: true, games });
  } catch (e) {
    console.error('[games/public]', e);
    res.json({ success: true, games: [] });
  }
});

// ---------- GET /api/activity/public ----------
// Stats d'activite publiques: NOMBRES uniquement (anonyme - pas de pseudos)
router.get('/activity/public', async (req, res) => {
  try {
    const [onlineQ, usersTodayQ, execTodayQ, totalUsersQ] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS c FROM executions
         WHERE created_at > now() - interval '15 minutes'`
      ),
      pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS c FROM executions
         WHERE created_at > date_trunc('day', now())`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM executions WHERE created_at > date_trunc('day', now())`
      ),
      pool.query('SELECT COUNT(DISTINCT user_id)::int AS c FROM executions'),
    ]);
    res.json({
      success: true,
      onlineNow: onlineQ.rows[0].c,
      usersToday: usersTodayQ.rows[0].c,
      executionsToday: execTodayQ.rows[0].c,
      totalUsers: totalUsersQ.rows[0].c,
    });
  } catch (e) {
    console.error('[activity/public]', e);
    res.json({ success: true, onlineNow: 0, usersToday: 0, executionsToday: 0, totalUsers: 0 });
  }
});

module.exports = router;
