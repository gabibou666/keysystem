// test-features.js — Tests automatisés : Reset HWID, Parrainage & Anti-Dump
require('dotenv').config();
const http = require('http');
const express = require('express');
const pool = require('./src/db');
const crypto = require('./src/services/crypto');
const discord = require('./src/services/discord');
const apiRoutes = require('./src/routes/api');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx !== -1) {
        cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      }
    });
  }
  req.cookies = cookies;
  next();
});
app.use('/api', apiRoutes);

let server;
const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;

function check(label, ok) {
  if (ok) {
    console.log(`  -> PASS: ${label}`);
  } else {
    console.error(`  -> FAIL: ${label}`);
    process.exitCode = 1;
  }
}

async function main() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log('=== TEST DES NOUVELLES FONCTIONNALITES ===\n');

  const OWNER_A = '999000111222333444';
  const FRIEND_B = '999000111222333445';
  const FRIEND_C = '999000111222333446';
  const cookieA = discord.signUserCookie(OWNER_A);
  const cookieB = discord.signUserCookie(FRIEND_B);
  const cookieC = discord.signUserCookie(FRIEND_C);

  try {
    // -------------------------------------------------------------
    // PARTIE 1 : Auto-Reset HWID
    // -------------------------------------------------------------
    console.log('--- 1. Test Auto-Reset HWID ---');

    // Nettoyage préalable
    await pool.query('DELETE FROM keys WHERE owner_discord_id IN ($1, $2, $3)', [OWNER_A, FRIEND_B, FRIEND_C]);
    await pool.query('DELETE FROM referrals WHERE referrer_discord_id = $1 OR referred_discord_id IN ($2, $3)', [OWNER_A, FRIEND_B, FRIEND_C]);
    await pool.query('DELETE FROM referral_rewards WHERE discord_id = $1', [OWNER_A]);

    // Crée une clé initiale liée à un appareil HWID-OLD
    const gen = crypto.generateKey();
    const expires = new Date(Date.now() + 12 * 3600 * 1000);
    const keyRow = await pool.query(
      `INSERT INTO keys (kid, signature, duration_hours, expires_at, owner_discord_id, bound_hwid, bound_user_id)
       VALUES ($1, $2, 12, $3, $4, 'hwid-device-old-123', 888888) RETURNING id`,
      [gen.kid, gen.signature, expires, OWNER_A]
    );

    // 1.1 Statut HWID avant reset
    const rStat1 = await fetch(`${BASE}/api/key/hwid-status`, {
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dStat1 = await rStat1.json();
    check('Statut HWID récupéré (isBound = true, canReset = true)', dStat1.hasKey && dStat1.isBound && dStat1.canReset);

    // 1.2 Exécution du Reset HWID
    const rReset = await fetch(`${BASE}/api/key/reset-hwid`, {
      method: 'POST',
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dReset = await rReset.json();
    check('Reset HWID accepté (HTTP 200, success = true)', rReset.status === 200 && dReset.success === true);

    // Vérifie en BDD que bound_hwid est NULL
    const checkDb = await pool.query('SELECT bound_hwid, hwid_last_reset FROM keys WHERE id = $1', [keyRow.rows[0].id]);
    check('BDD: bound_hwid est redevenu NULL', checkDb.rows[0].bound_hwid === null && !!checkDb.rows[0].hwid_last_reset);

    // 1.3 Tentative immédiate de 2ème reset (doit être refusée par le cooldown)
    // On simule une clé re-verrouillée
    await pool.query("UPDATE keys SET bound_hwid = 'hwid-device-new-456' WHERE id = $1", [keyRow.rows[0].id]);
    const rReset2 = await fetch(`${BASE}/api/key/reset-hwid`, {
      method: 'POST',
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dReset2 = await rReset2.json();
    check('Second reset immédiat bloqué par le cooldown 24h (HTTP 429)', rReset2.status === 429 && dReset2.success === false);

    // -------------------------------------------------------------
    // PARTIE 2 : Système de Parrainage
    // -------------------------------------------------------------
    console.log('\n--- 2. Test Système de Parrainage ---');

    // 2.1 Stats initiales du parrain A
    const rRefStats1 = await fetch(`${BASE}/api/referrals/stats`, {
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dRefStats1 = await rRefStats1.json();
    check('Stats parrainage initiales (0 invité, 0 récompense)', dRefStats1.totalReferred === 0 && dRefStats1.availableRewards === 0);

    // 2.2 Enregistrement d'un filleul B invité par A
    await pool.query(
      `INSERT INTO referrals (referrer_discord_id, referred_discord_id, referred_ip, status)
       VALUES ($1, $2, '198.51.100.1', 'pending')`,
      [OWNER_A, FRIEND_B]
    );

    // 2.3 Le filleul B complète sa première clé -> statut passe à completed
    await pool.query(
      `UPDATE referrals SET status = 'completed', completed_at = now()
       WHERE referred_discord_id = $1`,
      [FRIEND_B]
    );

    // Vérifie progression (1 filleul complété -> 0 clé dispo, encore 1 nécessaire)
    const rRefStats2 = await fetch(`${BASE}/api/referrals/stats`, {
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dRefStats2 = await rRefStats2.json();
    check('Progression après 1 ami validé (completed = 1, availableRewards = 0)', dRefStats2.completedReferred === 1 && dRefStats2.availableRewards === 0);

    // 2.4 Le filleul C complète sa clé -> seuil de 2 atteint !
    await pool.query(
      `INSERT INTO referrals (referrer_discord_id, referred_discord_id, referred_ip, status, completed_at)
       VALUES ($1, $2, '198.51.100.2', 'completed', now())`,
      [OWNER_A, FRIEND_C]
    );

    const rRefStats3 = await fetch(`${BASE}/api/referrals/stats`, {
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dRefStats3 = await rRefStats3.json();
    check('Seuil de 2 atteint (completed = 2, availableRewards = 1)', dRefStats3.completedReferred === 2 && dRefStats3.availableRewards === 1);

    // 2.5 Réclamation de la Clé VIP 24h
    const rClaim = await fetch(`${BASE}/api/referrals/claim`, {
      method: 'POST',
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dClaim = await rClaim.json();
    check('Clé VIP 24h sans pub réclamée avec succès (success = true)', rClaim.status === 200 && dClaim.success === true && !!dClaim.key);

    // 2.6 Vérification que la récompense a été consommée
    const rRefStats4 = await fetch(`${BASE}/api/referrals/stats`, {
      headers: { Cookie: `${discord.USER_COOKIE}=${cookieA}` },
    });
    const dRefStats4 = await rRefStats4.json();
    check('Récompense consommée (availableRewards = 0, claimedRewards = 1)', dRefStats4.availableRewards === 0 && dRefStats4.claimedRewards === 1);

    // -------------------------------------------------------------
    // PARTIE 3 : Anti-Dump & Télémétrie
    // -------------------------------------------------------------
    console.log('\n--- 3. Test Anti-Dump & Télémétrie In-Game ---');

    // Simulation d'une alerte sécurité envoyée par loader.luau
    const rReport = await fetch(`${BASE}/api/v1/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 888888,
        executor: 'Wave',
        error: 'security_tamper: spy_gui:SimpleSpy',
      }),
    });
    check('Rapport d\'intrusion anti-dump enregistré (HTTP 200)', rReport.status === 200);

    // Nettoyage
    await pool.query('DELETE FROM keys WHERE owner_discord_id IN ($1, $2, $3)', [OWNER_A, FRIEND_B, FRIEND_C]);
    await pool.query('DELETE FROM referrals WHERE referrer_discord_id = $1 OR referred_discord_id IN ($2, $3)', [OWNER_A, FRIEND_B, FRIEND_C]);
    await pool.query('DELETE FROM referral_rewards WHERE discord_id = $1', [OWNER_A]);

    console.log('\n=== TOUS LES TESTS SONT PASSES AVEC SUCCES ===');
  } catch (e) {
    console.error('Erreur test:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
