// ============================================================================
// Test E2E du système Server Booster (clés 7 jours gratuites & anti-cumul)
// ============================================================================
'use strict';
require('dotenv').config();
const assert = require('assert');
const pool = require('./src/db');
const discordService = require('./src/services/discord');
const crypto = require('./src/services/crypto');

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;

async function ensureServer() {
  const ok = await fetch(`${BASE}/ping`).then((r) => r.ok).catch(() => false);
  if (!ok) {
    process.env.PORT = PORT;
    require('./src/index');
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const up = await fetch(`${BASE}/ping`).then((r) => r.ok).catch(() => false);
      if (up) break;
    }
  }
}

async function runTests() {
  console.log('--- Demarrage des tests Booster ---');
  await ensureServer();

  let pass = 0;
  let fail = 0;
  function check(label, condition) {
    if (condition) {
      console.log(`  OK   ${label}`);
      pass++;
    } else {
      console.error(`  FAIL ${label}`);
      fail++;
    }
  }

  const TEST_DISCORD_ID = '999888777666555444';
  const userCookie = discordService.signUserCookie(TEST_DISCORD_ID);

  // Nettoyage prealable des donnees de test
  await pool.query('DELETE FROM booster_claims WHERE discord_id = $1', [TEST_DISCORD_ID]);
  await pool.query('DELETE FROM keys WHERE owner_discord_id = $1', [TEST_DISCORD_ID]);

  // Sauvegarde de l'implementation originale
  const origGetBoosterStatus = discordService.getBoosterStatus;
  const origIsGuildMember = discordService.isGuildMember;

  try {
    // 1. Appel sans connexion
    const resNoAuth = await fetch(`${BASE}/api/booster/status`);
    const dataNoAuth = await resNoAuth.json();
    check('status sans cookie -> loggedIn false', resNoAuth.status === 200 && dataNoAuth.loggedIn === false);

    const resClaimNoAuth = await fetch(`${BASE}/api/booster/claim`, { method: 'POST' });
    const dataClaimNoAuth = await resClaimNoAuth.json();
    check('claim sans cookie -> 401 discord_required', resClaimNoAuth.status === 401 && dataClaimNoAuth.reason === 'discord_required');

    // 2. Utilisateur connecte mais NON booster
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: false,
      premiumSince: null,
    });

    const resNonBooster = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataNonBooster = await resNonBooster.json();
    check('status non booster -> isBooster false, canRenew false', dataNonBooster.isBooster === false && dataNonBooster.canRenew === false);

    const resClaimNonBooster = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimNonBooster = await resClaimNonBooster.json();
    check('claim non booster -> 403 not_booster', resClaimNonBooster.status === 403 && dataClaimNonBooster.error === 'not_booster');

    // 3. Utilisateur connecte et BOOSTER ACTIF -> Premiere reclamation
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: true,
      premiumSince: '2026-09-20T10:00:00.000Z',
    });

    const resClaimFirst = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimFirst = await resClaimFirst.json();
    check('claim premier boost -> 200 succes, cle creee', resClaimFirst.status === 200 && dataClaimFirst.success && dataClaimFirst.action === 'create' && !!dataClaimFirst.key);

    const firstKeyStr = dataClaimFirst.key;
    const expiresAtFirst = new Date(dataClaimFirst.expiresAt).getTime();
    const hoursRemainingFirst = (expiresAtFirst - Date.now()) / (1000 * 60 * 60);
    check('duree initiale ~168 heures (7 jours)', hoursRemainingFirst >= 167 && hoursRemainingFirst <= 169);

    // Verification en base de donnees
    const dbKeyRes = await pool.query('SELECT * FROM keys WHERE owner_discord_id = $1 AND source = \'booster\'', [TEST_DISCORD_ID]);
    check('cle enregistree en base avec source booster et 168h', dbKeyRes.rows.length === 1 && dbKeyRes.rows[0].duration_hours === 168 && dbKeyRes.rows[0].source === 'booster');

    const dbClaimRes = await pool.query('SELECT * FROM booster_claims WHERE discord_id = $1', [TEST_DISCORD_ID]);
    check('reclamation tracee dans booster_claims (action create)', dbClaimRes.rows.length === 1 && dbClaimRes.rows[0].action === 'create');

    // 4. ANTI-CUMUL STRICT: tentative immediate de réclamation alors que la clé a > 24h restantes
    const resClaimSpam = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimSpam = await resClaimSpam.json();
    check('tentative cumul avec cle active -> 409 already_active', resClaimSpam.status === 409 && dataClaimSpam.error === 'already_active');
    check('la reponse renvoie la cle existante sans ajouter de temps', dataClaimSpam.key === firstKeyStr);

    const dbKeyCheck = await pool.query('SELECT expires_at FROM keys WHERE id = $1', [dbKeyRes.rows[0].id]);
    check('la date d expiration en base n a PAS ete prolongee (aucun cumul)', new Date(dbKeyCheck.rows[0].expires_at).getTime() === expiresAtFirst);

    // 5. Statut apres attribution
    const resStatusActive = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataStatusActive = await resStatusActive.json();
    check('status avec cle active -> hasActiveKey true, canRenew false', dataStatusActive.hasActiveKey === true && dataStatusActive.canRenew === false && dataStatusActive.key === firstKeyStr);

    // 6. Renouvellement: simulation de fin de cle (< 24h restantes)
    // On met la date d expiration a dans 2 heures
    await pool.query('UPDATE keys SET expires_at = now() + interval \'2 hours\' WHERE id = $1', [dbKeyRes.rows[0].id]);

    const resStatusCanRenew = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataStatusCanRenew = await resStatusCanRenew.json();
    check('status avec < 24h restantes -> canRenew true', dataStatusCanRenew.canRenew === true);

    // L'utilisateur booste toujours -> renouvellement accorde
    const resClaimRenew = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimRenew = await resClaimRenew.json();
    check('renouvellement avec boost actif -> 200 succes, action renew', resClaimRenew.status === 200 && dataClaimRenew.success && dataClaimRenew.action === 'renew');
    check('meme cle conservee (kid.sig identique)', dataClaimRenew.key === firstKeyStr);

    const renewedExpiresAt = new Date(dataClaimRenew.expiresAt).getTime();
    const renewedHours = (renewedExpiresAt - Date.now()) / (1000 * 60 * 60);
    check('cle prolongee de 7 jours (~168h a ~170h)', renewedHours >= 168 && renewedHours <= 171);

    // 7. Verification in-game: la cle fonctionne dans /api/v1/check
    discordService.isGuildMember = async () => true;
    const resCheckInGame = await fetch(`${BASE}/api/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: firstKeyStr,
        userId: 123456789,
        executor: 'Wave',
        hwid: 'booster-hwid-device-12345',
      }),
    });
    const dataCheckInGame = await resCheckInGame.json();
    check('cle booster valide in-game (/api/v1/check)', dataCheckInGame.success === true && !!dataCheckInGame.script);

    // 8. Arret du boost: si l'utilisateur a arrete de booster et tente de renouveler
    // On avance l'expiration a expiree
    await pool.query('UPDATE keys SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [dbKeyRes.rows[0].id]);
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: false, // n'est plus booster!
      premiumSince: null,
    });

    const resClaimCancelled = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimCancelled = await resClaimCancelled.json();
    check('tentative renouvellement apres arret du boost -> refuse 403 not_booster', resClaimCancelled.status === 403 && dataClaimCancelled.error === 'not_booster');

  } finally {
    // Restauration de la methode originale
    discordService.getBoosterStatus = origGetBoosterStatus;
    discordService.isGuildMember = origIsGuildMember;
    // Nettoyage des donnees de test
    await pool.query('DELETE FROM booster_claims WHERE discord_id = $1', [TEST_DISCORD_ID]);
    await pool.query('DELETE FROM keys WHERE owner_discord_id = $1', [TEST_DISCORD_ID]);
  }

  console.log(`\nResultats: ${pass} passes, ${fail} echecs`);
  if (fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((e) => {
  console.error('Erreur test:', e);
  process.exit(1);
});
