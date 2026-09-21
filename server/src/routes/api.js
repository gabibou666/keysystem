const express = require('express');
const nodeCrypto = require('crypto');
const rateLimit = require('express-rate-limit');
const crypto = require('../services/crypto');
const lootlabs = require('../services/lootlabs');
const pool = require('../db');
const path = require('path');
const { requireDiscordUser } = require('./discord');
const { secret } = require('../config-check');
const discordService = require('../services/discord');
const tokens = require('../services/tokens');
const wmService = require('../services/watermark');
const { notifyDiscord } = require('../services/notify');
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
  let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
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

    // Anti-Leave / Anti-Bypass: Verifie que l'utilisateur est bien membre du serveur Discord
    const inGuild = await discordService.isGuildMember(req.discordId);
    if (!inGuild) {
      const inviteUrl = await discordService.getGuildInvite();
      return res.status(403).json({
        success: false,
        reason: 'discord_member_required',
        error: 'You must be a member of our Discord server to get a key.',
        inviteUrl,
      });
    }

    let keyId = null;
    // Renouvellement: une cle valide peut etre prolongee.
    // Cle inconnue/invalide/revoquee => on l'IGNORE et on delivre une NOUVELLE cle:
    // sinon une cle morte dans le localStorage bloquerait l'utilisateur a vie
    // (chaque clic renverrait la meme cle morte). Cote securite, ignorer ne change
    // rien: obtenir une cle passe toujours par une pub LootLabs completee, et les
    // rate-limits (IP + compte Discord) s'appliquent pareil.
    if (req.body?.key) {
      const parsed = crypto.verifyKeyFormat(req.body.key);
      if (parsed) {
        const { rows } = await pool.query('SELECT id, revoked FROM keys WHERE kid = $1', [parsed.kid]);
        if (rows[0] && !rows[0].revoked) keyId = rows[0].id;
      }
    }

    // Ad limit: max 2 cles obtenues par IP par 12h (ne bloque PAS sur les sessions inachevées/abandonnées)
    const ip = clientIp(req);
    const [recent, byOwner] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS c FROM ll_sessions
         WHERE ip = $1 AND status IN ('completed', 'claimed') AND ad_limit_reset = false AND created_at > now() - interval '12 hours'`,
        [ip]
      ),
      // ANTI-PROXY: limite aussi par COMPTE DISCORD — les proxies changent l'IP,
      // pas le compte. 4 sessions complétées / 12h max par proprietaire Discord.
      pool.query(
        `SELECT COUNT(*)::int AS c FROM ll_sessions
         WHERE owner_discord_id = $1 AND status IN ('completed', 'claimed') AND ad_limit_reset = false AND created_at > now() - interval '12 hours'`,
        [req.discordId]
      ),
    ]);
    if (recent.rows[0].c >= 2 || byOwner.rows[0].c >= 4) {
      return res.status(429).json({
        success: false,
        reason: 'ad_limit',
        error: 'Ad limit reached (2 keys max every 12 hours). Come back later.',
      });
    }

    // Invalide les anciennes sessions inachevées de cet utilisateur pour éviter tout conflit
    await pool.query(
      `UPDATE ll_sessions SET status = 'expired'
       WHERE owner_discord_id = $1 AND status = 'pending'`,
      [req.discordId]
    ).catch(() => {});

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

    // Parrainage: si un parrain (ref) est passé et valide (Discord ID distinct)
    const refBy = typeof req.body?.ref === 'string' ? req.body.ref.trim() : null;
    if (refBy && refBy !== req.discordId && /^\d{17,20}$/.test(refBy)) {
      await pool.query(
        `INSERT INTO referrals (referrer_discord_id, referred_discord_id, referred_ip, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (referred_discord_id) DO NOTHING`,
        [refBy, req.discordId, ip]
      ).catch(() => {});
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
//      ou etre l'IP user annoncee (fallback template court) â€” le referer seul est spoofable
//   2. Delai minimum realiste: > 20s depuis started_at (un humain met du temps, un bot valide en secondes)
//   3. Transaction atomique: FOR UPDATE + dedup unique_id (jamais deux fois le meme checkpoint)
//   4. A la complÃ©tion: generation du TOKEN DE COMPLETION (JWT signe, usage unique, TTL 30 min)
//      -> /key/status l'exigera pour delivrer la cle. Aucune delivrance sans lui.
router.get('/lootlabs/postback', async (req, res) => {
  try {
    const { click_id } = req.query;
    if (!click_id || typeof click_id !== 'string' || click_id.length > 128) {
      return res.status(400).send('missing click_id');
    }

    const sourceIp = clientIp(req);

    // Blacklist connue des serveurs de bots / bypass
    const BLOCKED_POSTBACK_IPS = new Set(['37.27.162.36']);
    if (BLOCKED_POSTBACK_IPS.has(sourceIp)) {
      console.warn(`[postback] REJET IP blacklistee (bot bypass: ${sourceIp}, puid=${click_id.slice(0, 8)}...)`);
      return res.status(403).send('rejected: blacklisted ip');
    }

    // --- Verification du secret partagé LootLabs (anti-forge absolu) ---
    // Si LOOTLABS_POSTBACK_SECRET est défini dans .env, il DOIT être présent dans l'URL (&secret=...)
    // configurée dans le panel LootLabs. Rejette toute tentative manuelle/bot externe.
    const expectedSecret = process.env.LOOTLABS_POSTBACK_SECRET;
    if (expectedSecret) {
      const providedSecret = String(req.query.secret || req.headers['x-postback-secret'] || '');
      // safeEqual: comparaison a temps constant qui ne jette jamais
      // (timingSafeEqual levait une exception quand les longueurs differaient).
      if (!crypto.safeEqual(providedSecret, expectedSecret)) {
        console.warn(`[postback] REJET secret invalide/absent (puid=${String(click_id).slice(0, 8)}..., src=${sourceIp})`);
        return res.status(403).send('rejected: invalid postback secret');
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[postback] ALERTE: LOOTLABS_POSTBACK_SECRET non configure en production !');
    }

    // unique_id optionnel: fallback genere si le template du panel ne l'inclut pas
    const unique_id =
      (typeof req.query.unique_id === 'string' && req.query.unique_id.slice(0, 128)) ||
      'auto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const claimedUserIp = typeof req.query.ip === 'string' ? req.query.ip.slice(0, 64) : null;

    // ANTI-FORGE durci: un checkpoint sans NI unique_id NI ip de l'utilisateur ne
    // prouve rien (n'importe qui forgeant un postback pourrait le faire sans eux).
    // On exige au moins un des deux temoins de conversion LootLabs.
    if (!req.query.unique_id && !claimedUserIp) {
      console.warn(`[postback] REJET: ni unique_id ni ip fournis (puid=${String(click_id).slice(0, 8)}...)`);
      return res
        .status(400)
        .send('rejected: missing conversion witnesses (unique_id or ip required)');
    }

    // --- Verification d'origine: le postback doit venir de l'infrastructure LootLabs ---
    // (doc: "A GET request will be sent there" — serveur LootLabs -> nous)
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
        originNote = 'not_direct_infra';
      }
    } catch {
      originNote = 'dns_error';
    }

    // Si aucun secret n'est configure ET que l'origine n'est pas LootLabs, REJET strict
    if (!expectedSecret && originNote === 'not_direct_infra') {
      console.warn(`[postback] REJET: origine non reconnue sans secret (src=${sourceIp}, puid=${click_id.slice(0, 8)}...)`);
      return res.status(403).send('rejected: untrusted origin');
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

    // --- ANTI-SELF-POSTBACK: Le joueur ne peut PAS appeler son propre postback ---
    // Le postback LootLabs est serveur-a-serveur. Si l'IP source est l'IP du client, c'est une fraude.
    if (session.ip && sourceIp === session.ip) {
      console.warn(`[postback] REJET auto-postback: l'IP cliente tente de valider sa propre session (puid=${click_id.slice(0, 8)}..., ip=${sourceIp})`);
      return res.status(403).send('rejected: client cannot self-postback');
    }

    // --- Delai anti-bot: un bypass automatique/script valide en < 2-3 secondes.
    // Un humain sur mobile ou PC met au minimum 12 à 15 secondes par tache.
    const MIN_SECONDS = Math.max(12, (session.tasks_required || 1) * 10);
    const elapsedSec = (Date.now() - new Date(session.started_at).getTime()) / 1000;
    if (elapsedSec < MIN_SECONDS) {
      console.warn(`[postback] REJET robot instantané: ${elapsedSec.toFixed(1)}s < ${MIN_SECONDS}s requis (puid=${click_id.slice(0, 8)}...)`);
      await pool.query(
        `UPDATE ll_sessions SET status = 'rejected_too_fast' WHERE id = $1 AND status = 'pending'`,
        [session.id]
      );
      return res.status(429).send('rejected: completed too fast');
    }

    // --- Suivi IP (audit / mobile 4G tolerance) ---
    // Sur mobile 4G/CGNAT, l'IP de navigation et l'IP vue par LootLabs peuvent
    // différer légèrement (plage opérateur). La sécurité absolue repose sur le puid
    // cryptographique (256 bits non devinable), le secret postback optionnel, et le fait
    // que la clé n'est délivrée qu'au cookie Discord propriétaire vérifié.
    if (claimedUserIp && session.ip && claimedUserIp !== session.ip) {
      console.log(`[postback] Variation IP mobile/opérateur (session=${session.ip}, lootlabs=${claimedUserIp}) - acceptée`);
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
      // On log pour audit mais on continue (CDN legitime possible) â€” la defense principale
      // reste: delai minimum + dedup + token signe + IP metier.
      console.log(`[postback] origin note: ${originNote} (src=${sourceIp})`);
    }

    const done = session.tasks_done + 1;
    if (done >= session.tasks_required) {
      // ComplÃ©tion: genere le TOKEN signe a usage unique (TTL 30 min).
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
//      peut recevoir la cle â€” un puid vole/ne fuite ne sert a rien.
//   2. La delivrance exige le TOKEN DE COMPLETION (JWT signe, usage unique, TTL 30 min)
//      genere par le postback â€” pas de token, pas de cle.
//   3. Le token est brule (NULL) au premier usage reussi: impossible de rejouer.
//   4. Rate-limite specifique (polling) â€” un script de polling en masse se bloque.
// Les utilisateurs legitimes ne voient AUCUNE difference (leur cookie+token sont valides).
const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true });

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
      return res.status(429).json({ success: false, status: 'rejected', error: 'Verification completed too fast (bot detected). Please restart a session.' });
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

    if (session.status === 'expired') {
      return res.status(410).json({
        success: false,
        status: 'token_expired',
        error: 'This session has expired. Please select a duration below.',
      });
    }

    // Auto-expiration après 15 minutes pour ne pas bloquer l'utilisateur indéfiniment
    const ageMs = Date.now() - new Date(session.created_at).getTime();
    if (session.status === 'pending' && ageMs > 15 * 60 * 1000) {
      await pool.query("UPDATE ll_sessions SET status = 'expired' WHERE id = $1", [session.id]).catch(() => {});
      return res.status(410).json({
        success: false,
        status: 'token_expired',
        error: 'Session timed out after 15 minutes. Please select a duration below.',
      });
    }

    if (session.status !== 'completed') {
      return res.json({ success: true, status: 'pending', tasksDone: session.tasks_done, tasksRequired: session.tasks_required });
    }

    // --- Verrou proprietaire: la session appartient a un Discord user ---
    // (toutes les sessions post-migration ont un owner; les anciennes sans owner
    //  ne sont plus delivrables â€” securite avant compatibilite)
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
        error: 'Session expired â€” start a new one.',
      });
    }

    // --- Tout est valide: on BRULE le token (usage unique) et on delivre ---
    // CLAIM ATOMIQUE: le UPDATE ne passe QUE si la session est encore 'completed'
    // avec son token. Deux polls concurrents (retour d'onglet: visibilitychange +
    // focus + tick 2s) ne peuvent PAS delivrer deux fois â€” un seul gagne le claim,
    // l'autre recoit already_claimed AVANT tout INSERT/UPDATE de cle.
    const claim = await pool.query(
      `UPDATE ll_sessions SET completion_token = NULL, status = 'claimed', claimed_at = now()
       WHERE id = $1 AND status = 'completed' AND completion_token IS NOT NULL`,
      [session.id]
    );
    if (claim.rowCount === 0) {
      return res.status(409).json({
        success: false,
        status: 'already_claimed',
        error: 'This session\'s key has already been claimed.',
      });
    }

    // Recupere la duree choisie au start de la session
    const duration = session.tasks_required === 1 ? 12 : 24;

    if (session.key_id) {
      // Renouvellement: meme kid, meme string cote client.
      // Grave aussi le owner Discord de la session sur la clÃ© (le renouveleur
      // devient propriÃ©taire visible â€” anti-usurpation: seul le owner du cookie peut etre ici).
      const upd = await pool.query(
        `UPDATE keys SET expires_at = now() + make_interval(hours => $1), duration_hours = $1,
                renewed_count = renewed_count + 1, owner_discord_id = $3
         WHERE id = $2 AND revoked = false RETURNING kid, signature, expires_at`,
        [duration, session.key_id, session.owner_discord_id]
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

    // Nouvelle cle: liee au owner Discord de la session (createur de la clÃ©)
    const gen = crypto.generateKey();
    const ins = await pool.query(
      `INSERT INTO keys (kid, signature, duration_hours, owner_discord_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $3)) RETURNING id, kid, signature, expires_at`,
      [gen.kid, gen.signature, duration, session.owner_discord_id]
    );
    const key = ins.rows[0];
    await pool.query('UPDATE ll_sessions SET key_id = $1 WHERE id = $2', [key.id, session.id]);

    // Parrainage: valide le statut si ce compte Discord avait été parrainé
    await pool.query(
      `UPDATE referrals SET status = 'completed', completed_at = now()
       WHERE referred_discord_id = $1 AND status = 'pending'`,
      [session.owner_discord_id]
    ).catch(() => {});

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
      'SELECT kid, expires_at, revoked, bound_user_id, bound_hwid, hwid_last_reset, owner_discord_id FROM keys WHERE kid = $1',
      [parsed.kid]
    );
    const key = rows[0];
    if (!key) return res.json({ success: false, error: 'Unknown key' });
    if (key.revoked) return res.json({ success: false, error: 'Revoked', revoked: true });

    let inDiscord = true;
    let discordInvite = null;
    if (key.owner_discord_id) {
      inDiscord = await discordService.isGuildMember(key.owner_discord_id);
      if (!inDiscord) {
        discordInvite = await discordService.getGuildInvite();
      }
    }

    const expired = new Date(key.expires_at).getTime() < Date.now();
    res.json({
      success: true,
      valid: !expired && inDiscord,
      expiresAt: key.expires_at,
      expired,
      inDiscord,
      discordInvite,
      bound: !!key.bound_user_id,
      hwidBound: !!key.bound_hwid,
    });
  } catch (e) {
    console.error('[key/info]', e);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ---------- POST /api/key/reset-hwid ----------
// Permet à l'utilisateur Discord de réinitialiser le lien HWID de son appareil (cooldown 24h)
router.post('/key/reset-hwid', async (req, res) => {
  try {
    const requesterDiscordId = discordService.verifyUserCookie(req.cookies && req.cookies[discordService.USER_COOKIE]);
    if (!requesterDiscordId) {
      return res.status(401).json({ success: false, error: 'Please sign in with Discord first.' });
    }

    // Recherche la clé active du compte Discord
    const { rows } = await pool.query(
      `SELECT * FROM keys
       WHERE owner_discord_id = $1 AND revoked = false AND expires_at > now()
       ORDER BY id DESC LIMIT 1`,
      [requesterDiscordId]
    );
    const key = rows[0];
    if (!key) {
      return res.status(404).json({ success: false, error: 'No active key found for your Discord account.' });
    }

    if (!key.bound_hwid) {
      return res.json({
        success: true,
        message: 'Your key is already unbound. Launch it on your new device to bind it.',
      });
    }

    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    if (key.hwid_last_reset) {
      const elapsed = Date.now() - new Date(key.hwid_last_reset).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remainingMs = COOLDOWN_MS - elapsed;
        const remainingH = Math.floor(remainingMs / (60 * 60 * 1000));
        const remainingM = Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
        return res.status(429).json({
          success: false,
          error: `Cooldown active: next HWID reset available in ${remainingH}h ${remainingM}m.`,
          remainingMs,
        });
      }
    }

    await pool.query(
      `UPDATE keys SET bound_hwid = NULL, hwid_last_reset = now() WHERE id = $1`,
      [key.id]
    );

    res.json({
      success: true,
      message: '✅ HWID successfully reset! You can now launch the script on your new PC/device.',
    });
  } catch (e) {
    console.error('[key/reset-hwid]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- GET /api/key/hwid-status ----------
// Statut HWID et cooldown pour l'affichage web
router.get('/key/hwid-status', async (req, res) => {
  try {
    const requesterDiscordId = discordService.verifyUserCookie(req.cookies && req.cookies[discordService.USER_COOKIE]);
    if (!requesterDiscordId) {
      return res.json({ success: false, loggedIn: false });
    }

    const { rows } = await pool.query(
      `SELECT bound_hwid, hwid_last_reset, expires_at FROM keys
       WHERE owner_discord_id = $1 AND revoked = false AND expires_at > now()
       ORDER BY id DESC LIMIT 1`,
      [requesterDiscordId]
    );
    const key = rows[0];
    if (!key) {
      return res.json({ success: true, loggedIn: true, hasKey: false });
    }

    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    let canReset = true;
    let remainingMs = 0;
    if (key.hwid_last_reset) {
      const elapsed = Date.now() - new Date(key.hwid_last_reset).getTime();
      if (elapsed < COOLDOWN_MS) {
        canReset = false;
        remainingMs = COOLDOWN_MS - elapsed;
      }
    }

    res.json({
      success: true,
      loggedIn: true,
      hasKey: true,
      isBound: !!key.bound_hwid,
      canReset,
      remainingMs,
    });
  } catch (e) {
    console.error('[key/hwid-status]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- GET /api/referrals/stats ----------
// Statistiques de parrainage de l'utilisateur connecté
router.get('/referrals/stats', async (req, res) => {
  try {
    const requesterDiscordId = discordService.verifyUserCookie(req.cookies && req.cookies[discordService.USER_COOKIE]);
    if (!requesterDiscordId) {
      return res.json({ success: false, loggedIn: false });
    }

    const [refs, rewards] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM referrals WHERE referrer_discord_id = $1`,
        [requesterDiscordId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS claimed FROM referral_rewards WHERE discord_id = $1`,
        [requesterDiscordId]
      ),
    ]);

    const totalReferred = refs.rows[0].total || 0;
    const completedReferred = refs.rows[0].completed || 0;
    const claimedRewards = rewards.rows[0].claimed || 0;
    const earnedRewards = Math.floor(completedReferred / 2);
    const availableRewards = Math.max(0, earnedRewards - claimedRewards);

    res.json({
      success: true,
      loggedIn: true,
      discordId: requesterDiscordId,
      totalReferred,
      completedReferred,
      claimedRewards,
      availableRewards,
      progressToNext: completedReferred % 2,
    });
  } catch (e) {
    console.error('[referrals/stats]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- POST /api/referrals/claim ----------
// Réclamation d'une clé VIP 24h sans pub contre 2 parrainages complétés
router.post('/referrals/claim', async (req, res) => {
  try {
    const requesterDiscordId = discordService.verifyUserCookie(req.cookies && req.cookies[discordService.USER_COOKIE]);
    if (!requesterDiscordId) {
      return res.status(401).json({ success: false, error: 'Please sign in with Discord first.' });
    }

    const [refs, rewards] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM referrals WHERE referrer_discord_id = $1`,
        [requesterDiscordId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS claimed FROM referral_rewards WHERE discord_id = $1`,
        [requesterDiscordId]
      ),
    ]);

    const completedReferred = refs.rows[0].completed || 0;
    const claimedRewards = rewards.rows[0].claimed || 0;
    const earnedRewards = Math.floor(completedReferred / 2);
    const availableRewards = Math.max(0, earnedRewards - claimedRewards);

    if (availableRewards <= 0) {
      return res.status(400).json({
        success: false,
        error: 'No rewards available. Invite 2 friends who get a key to unlock a free 24h VIP Key!',
      });
    }

    const gen = crypto.generateKey();
    const duration = 24;
    const expiresAt = new Date(Date.now() + duration * 60 * 60 * 1000);

    const ins = await pool.query(
      `INSERT INTO keys (kid, signature, duration_hours, owner_discord_id, expires_at, source, note)
       VALUES ($1, $2, $3, $4, $5, 'referral', 'Reward for 2 friends referred')
       RETURNING id, kid, signature, expires_at`,
      [gen.kid, gen.signature, duration, requesterDiscordId, expiresAt]
    );
    const newKey = ins.rows[0];

    await pool.query(
      `INSERT INTO referral_rewards (discord_id, reward_type, key_id) VALUES ($1, 'key_24h_vip', $2)`,
      [requesterDiscordId, newKey.id]
    );

    res.json({
      success: true,
      key: `${newKey.kid}.${newKey.signature}`,
      expiresAt: newKey.expires_at,
      message: '🎉 24h VIP Key claimed successfully! No ads needed.',
    });
  } catch (e) {
    console.error('[referrals/claim]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- POST /api/v1/check ----------
// Loader: { key, userId, executor, placeId } -> { script } si OK
router.post('/v1/check', checkLimiter, async (req, res) => {
  try {
    const { key, userId, executor, hwid } = req.body || {};
    const cleanHwid = typeof hwid === 'string' && hwid.trim().length >= 8 ? hwid.trim().slice(0, 128) : null;
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

    // Anti-Leave: Verification de presence sur le serveur Discord
    if (dbKey.owner_discord_id) {
      const inGuild = await discordService.isGuildMember(dbKey.owner_discord_id);
      if (!inGuild) {
        const inviteUrl = await discordService.getGuildInvite();
        return res.json({
          success: false,
          reason: 'not_in_discord',
          error: 'You must remain in our Discord server to use this script!',
          discordInvite: inviteUrl,
        });
      }
    }

    // Ban par UserId Roblox (cascade)
    const ban = await pool.query('SELECT id FROM bans WHERE user_id = $1', [uid]);
    if (ban.rows[0]) return res.json({ success: false, reason: 'banned' });

    // Liaison au premier UserId (NB: pg renvoie BIGINT en string -> comparaison en string)
    if (dbKey.bound_user_id !== null && String(dbKey.bound_user_id) !== String(uid)) {
      return res.json({ success: false, reason: 'bound_to_other_user' });
    }
    // Liaison au premier HWID (appareil/machine unique)
    if (cleanHwid && dbKey.bound_hwid && dbKey.bound_hwid !== cleanHwid) {
      return res.json({ success: false, reason: 'bound_to_other_device' });
    }
    if (!dbKey.bound_user_id || (!dbKey.bound_hwid && cleanHwid)) {
      await pool.query(
        'UPDATE keys SET bound_user_id = COALESCE(bound_user_id, $1), bound_hwid = COALESCE(bound_hwid, $2) WHERE id = $3',
        [uid, cleanHwid, dbKey.id]
      );
    }

    // Expiration
    const expired = new Date(dbKey.expires_at).getTime() < Date.now();
    if (expired) return res.json({ success: false, reason: 'expired' });

    // Statut du script (Safe / Undetected / Updating / Detected)
    if (placeId) {
      const statusCheck = await pool.query(
        'SELECT status, note FROM game_statuses WHERE place_id = $1',
        [placeId]
      );
      if (statusCheck.rows[0]) {
        const s = statusCheck.rows[0].status;
        if (s === 'updating') {
          return res.json({
            success: false,
            reason: 'script_updating',
            message: statusCheck.rows[0].note || 'Script is currently being updated for this game. Please check back shortly.',
          });
        }
        if (s === 'detected') {
          return res.json({
            success: false,
            reason: 'script_detected',
            message: statusCheck.rows[0].note || 'Script is temporarily disabled for security (detection risk).',
          });
        }
      }
    }

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

    // WATERMARK: nonce unique par exÃ©cution -> chaque dump servi est traÃ§able.
    // Le snippet beaconne sous le compte de QUI l'exÃ©cute -> un dump partagÃ©
    // est dÃ©tectÃ© (beacon d'un autre userId que l'acheteur) et le leak identifiable.
    const wmNonce = crypto.randomToken(12);
    const wmB64 = wmService.makeWatermark(wmNonce, uid);
    const beacon = wmService.beaconSnippet(wmB64, process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`);
    const watermarkedScript = beacon + '\n' + activeBuild.content;

    // Log execution (avec nonce pour relier beacons -> exécution -> clé, et HWID si dispo)
    await pool.query(
      `INSERT INTO executions (key_id, user_id, executor, build_id, version, ip, wm_nonce, hwid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [dbKey.id, uid, (executor || '').slice(0, 40), activeBuild.id, activeBuild.version, clientIp(req), wmNonce, cleanHwid]
    );

    // expiresAt ISO 8601 UTC (format exige par DateTime.fromIsoDate cote Luau)
    res.json({
      success: true,
      script: watermarkedScript,
      version: activeBuild.version,
      expiresAt: new Date(dbKey.expires_at).toISOString(),
    });
  } catch (e) {
    console.error('[v1/check]', e);
    res.status(500).json({ success: false, reason: 'server_error' });
  }
});

// ---------- POST /api/v1/report ----------
// Telemetrie loader: { userId, executor, version, error } OU beacon { wm }
router.post(
  '/v1/report',
  rateLimit({ windowMs: 60 * 1000, max: 40 }),
  async (req, res) => {
    try {
      const { userId, executor, version, error, wm } = req.body || {};

      // ===== Beacon watermark anti-partage =====
      if (wm) {
        const decoded = wmService.decodeWatermark(String(wm).slice(0, 300));
        if (decoded) {
          const ip = clientIp(req);
          const uid = parseInt(userId, 10) || null;
          await pool.query(
            'INSERT INTO beacons (wm_nonce, user_id, executor, ip) VALUES ($1,$2,$3,$4)',
            [decoded.nonce, uid, (executor || '').slice(0, 40), ip]
          );

          // DÃ©tection de partage: le watermark Ã©mis pour l'acheteur A beaconne
          // sous un autre compte/IP -> le dump circule.
          const exec2 = await pool.query(
            `SELECT e.key_id, e.user_id AS owner_uid FROM executions e WHERE e.wm_nonce = $1 LIMIT 1`,
            [decoded.nonce]
          );
          if (exec2.rows[0]) {
            const keyId = exec2.rows[0].key_id;
            const ownerUid = parseInt(exec2.rows[0].owner_uid, 10);
            const suspectUid = uid;

            // Cas 1: un AUTRE compte exÃ©cute le dump de l'acheteur => partage direct
            const sharedWithOther = suspectUid && ownerUid && suspectUid !== ownerUid;
            // Cas 2: le dump beaconne depuis >= 3 IP distinctes => redistribution
            const ips = await pool.query(
              `SELECT COUNT(DISTINCT ip)::int AS c FROM beacons WHERE wm_nonce = $1`,
              [decoded.nonce]
            );
            const multiIp = ips.rows[0].c >= 3;

            if (sharedWithOther || multiIp) {
              const alerts = await pool.query(
                `UPDATE keys SET share_alerts = share_alerts + 1
                 WHERE id = $1 AND revoked = false RETURNING share_alerts`,
                [keyId]
              );
              const count = alerts.rows[0] ? alerts.rows[0].share_alerts : 99;
              if (count >= 3) {
                // AUTO-REVOCATION: 3 alertes confirmÃ©es => la clÃ© meurt
                await pool.query('UPDATE keys SET revoked = true WHERE id = $1', [keyId]);
                notifyDiscord({
                  title: 'ðŸ”’ Key auto-revoked (sharing detected)',
                  color: 'warn',
                  description: `Watermark \`${decoded.nonce}\` triggered **${count}** sharing alerts.
Key **#${keyId}** (owner Roblox \`${ownerUid}\`) has been revoked automatically.`,
                  fields: [
                    { name: 'Distinct IPs', value: String(ips.rows[0].c) },
                    { name: 'Last beacon', value: `user \`${suspectUid || '?'}'\` from \`${ip}\` Â· ${executor || '?'}` },
                  ],
                });
              } else if (count === 1) {
                // Premiere alerte: on notifie sans couper (peut etre un simple changement d'IP)
                notifyDiscord({
                  title: 'âš ï¸ Possible key sharing detected',
                  color: 'warn',
                  description: `Watermark \`${decoded.nonce}\` (key #${keyId}, owner \`${ownerUid}\`) beaconed from a different context.`,
                  fields: [{ name: 'Beacon', value: `user \`${suspectUid || '?'}'\` Â· IP \`${ip}\` Â· ${ips.rows[0].c} distinct IP(s)` }],
                });
              }
            }
          }
        }
        return res.json({ success: true });
      }

      // ===== TÃ©lÃ©mÃ©trie classique =====
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
    } catch (e) {
      console.error('[v1/report]', e);
      res.status(500).json({ success: false });
    }
  }
);

// ---------- GET /api/v1/windui ----------
// Self-host de la lib WindUI (dist officiel, v1.6.66 figee): le loader ne depend
// plus du GitHub Footagesus (dispo/renommage). Cache 1h navigateur.
router.get('/v1/windui', (req, res) => {
  const fs = require('fs');
  const p = path.join(__dirname, '..', '..', 'loader', 'windui-dist.lua');
  try {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(fs.readFileSync(p, 'utf8'));
  } catch {
    res.status(503).send('-- windui indisponible');
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

// ---------- GET /api/config/public ----------
// Source de verite unique pour le front: plus aucune URL (invitation Discord,
// loader) codee en dur dans les pages HTML. Evite les liens morts quand le bot
// regenere une invitation ou quand le domaine change.
router.get('/config/public', async (req, res) => {
  const siteUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  let inviteUrl = null;
  try {
    inviteUrl = await discordService.getGuildInvite();
  } catch (e) {
    console.warn('[config/public] invitation indisponible:', e.message);
  }
  res.json({
    success: true,
    siteUrl,
    inviteUrl,
    loaderUrl: `${siteUrl}/api/v1/loader`,
  });
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
// Jeux supportes (builds actifs) avec nom + icone + stats + statut (Safe/Updating/Detected)
router.get('/games/public', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (b.place_id) b.place_id, b.version,
              COALESCE(gs.status, 'safe') AS status,
              gs.note AS status_note
       FROM script_builds b
       LEFT JOIN game_statuses gs ON gs.place_id = b.place_id
       WHERE b.active = true AND b.place_id IS NOT NULL
       ORDER BY b.place_id, b.created_at DESC`
    );
    const games = await Promise.all(
      rows.map((r) =>
        getGameInfo(r.place_id).then((info) => ({
          placeId: parseInt(r.place_id, 10),
          version: parseInt(r.version, 10),
          status: r.status || 'safe',
          statusNote: r.status_note || '',
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

// ---------- GET /api/changelog (alias public) ----------
router.get('/changelog', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT version, note, created_at, published, place_id FROM script_versions
       WHERE published = true AND note <> '' ORDER BY version DESC LIMIT 50`
    );
    const versions = await Promise.all(
      rows.map(async (v) => {
        let gameName = null;
        if (v.place_id) {
          const info = await getGameInfo(v.place_id).catch(() => null);
          gameName = info ? info.name : `Game ${v.place_id}`;
        }
        return {
          version: v.version,
          note: v.note,
          created_at: v.created_at,
          published: v.published,
          placeId: v.place_id ? parseInt(v.place_id, 10) : null,
          gameName,
        };
      })
    );
    res.json({ success: true, versions });
  } catch (e) {
    res.json({ success: true, versions: [] });
  }
});

// ============================================================================
// POST /api/v1/token -- CONTROLE DE SESSION (anti-dump)
// ----------------------------------------------------------------------------
// Le preambule ajoute a CHAQUE build appelle ce point regulierement. Sans reponse
// valide, le script se neutralise.
// POURQUOI: sans ce controle, une copie extraite (dump) d'un script continue de
// fonctionner sans cle et sans publicite, indefiniment -- c'est la fuite qui
// coute le plus cher. Aucune protection cote client n'est inviolable, le script
// s'executant chez l'utilisateur; mais un controle PERIODIQUE transforme une
// copie gratuite et permanente en une copie qui cesse de fonctionner.
// ============================================================================
const SESSION_TTL_SECONDS = Math.max(60, Number(process.env.SESSION_TTL_SECONDS) || 600);

router.post('/v1/token', async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.replace(/\s+/g, '') : '';
    const userId = String(req.body?.userId || '');
    const parsed = crypto.verifyKeyFormat(key);
    if (!parsed) return res.status(401).json({ ok: false, reason: 'invalid_key' });
    if (!/^\d{5,20}$/.test(userId)) return res.status(401).json({ ok: false, reason: 'invalid_user' });

    const { rows } = await pool.query(
      'SELECT kid, bound_user_id, expires_at, revoked FROM keys WHERE kid = $1',
      [parsed.kid]
    );
    const row = rows[0];
    if (!row || row.revoked) return res.status(403).json({ ok: false, reason: 'key_revoked' });
    if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return res.status(403).json({ ok: false, reason: 'key_expired' });
    }
    // Liaison au premier UserId: une cle partagee est refusee ici, comme au
    // moment de la delivrance.
    if (row.bound_user_id && String(row.bound_user_id) !== userId) {
      return res.status(403).json({ ok: false, reason: 'key_bound_to_other_user' });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    // Nonce: deux appels dans la meme seconde ne doivent PAS produire le meme
    // jeton (sinon l'artefact est rejouable a l'identique).
    const nonce = nodeCrypto.randomBytes(6).toString('hex');
    const charge = `${parsed.kid}.${userId}.${expiresAt}.${nonce}`;
    const signature = nodeCrypto
      .createHmac('sha256', secret('HMAC_SECRET'))
      .update(`ks-session:${charge}`)
      .digest('hex')
      .slice(0, 40);

    res.json({
      ok: true,
      token: `${charge}.${signature}`,
      expiresIn: SESSION_TTL_SECONDS,
      intervalSec: Math.max(30, SESSION_TTL_SECONDS - 60),
    });
  } catch (err) {
    console.error('[v1/token]', err.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

module.exports = router;
