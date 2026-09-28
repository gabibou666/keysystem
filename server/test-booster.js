// ============================================================================
// Test E2E du système Server Booster (1 boost = 1 clé 7 jours, 2ème boost requis pour +7j)
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
  console.log('--- Demarrage des tests Booster (Regle stricte: 1 boost = 1 cle 7j) ---');
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
  await pool.query('DELETE FROM booster_credits WHERE discord_id = $1', [TEST_DISCORD_ID]);
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
      boostCount: 0,
      premiumSince: null,
    });

    const resNonBooster = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataNonBooster = await resNonBooster.json();
    check('status non booster -> isBooster false, canClaim false', dataNonBooster.isBooster === false && dataNonBooster.canClaim === false);

    const resClaimNonBooster = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimNonBooster = await resClaimNonBooster.json();
    check('claim non booster -> 403 not_booster', resClaimNonBooster.status === 403 && dataClaimNonBooster.error === 'not_booster');

    // 3. Utilisateur connecte avec 1 SEUL BOOST -> Premiere reclamation
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: true,
      boostCount: 1,
      premiumSince: '2026-09-20T10:00:00.000Z',
    });

    const resStatusBefore = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataStatusBefore = await resStatusBefore.json();
    check('status 1 boost non reclame -> canClaim true, remainingBoosts 1', dataStatusBefore.canClaim === true && dataStatusBefore.remainingBoosts === 1);

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
    check('1 reclamation tracee dans booster_claims', dbClaimRes.rows.length === 1);

    // 4. REGLE STRICTE: tentative immediate avec le meme boost -> REFUSE (second_boost_required)
    const resClaimSpam = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimSpam = await resClaimSpam.json();
    check('tentative 2eme claim avec 1 seul boost -> refuse 403 second_boost_required', resClaimSpam.status === 403 && dataClaimSpam.error === 'second_boost_required');
    check('reponse renvoie la cle existante sans modifier la duree', dataClaimSpam.key === firstKeyStr);

    const dbKeyCheck = await pool.query('SELECT expires_at FROM keys WHERE id = $1', [dbKeyRes.rows[0].id]);
    check('la date d expiration n a pas bouge', new Date(dbKeyCheck.rows[0].expires_at).getTime() === expiresAtFirst);

    // 5. REGLE STRICTE: La cle de 7 jours expire (simulation), mais l'utilisateur a toujours 1 SEUL boost
    // Il NE DOIT PAS pouvoir renouveler gratuitement sans un 2eme boost !
    await pool.query('UPDATE keys SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [dbKeyRes.rows[0].id]);

    const resStatusExpired = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataStatusExpired = await resStatusExpired.json();
    check('cle expiree mais 1 seul boost -> hasActiveKey false, canClaim FALSE (aucun renouvellement auto)', dataStatusExpired.hasActiveKey === false && dataStatusExpired.canClaim === false && dataStatusExpired.remainingBoosts === 0);

    const resClaimExpiredNoBoost = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimExpiredNoBoost = await resClaimExpiredNoBoost.json();
    check('tentative claim avec cle expiree et 1 seul boost -> refuse 403 second_boost_required', resClaimExpiredNoBoost.status === 403 && dataClaimExpiredNoBoost.error === 'second_boost_required');

    // 6. L'UTILISATEUR AJOUTE UN 2EME BOOST SUR DISCORD (boostCount = 2) !
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: true,
      boostCount: 2, // 2 BOOSTS DETECTES !
      premiumSince: '2026-09-20T10:00:00.000Z',
    });

    const resStatus2ndBoost = await fetch(`${BASE}/api/booster/status`, {
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataStatus2ndBoost = await resStatus2ndBoost.json();
    check('status avec 2eme boost ajoute -> canClaim TRUE, remainingBoosts 1', dataStatus2ndBoost.canClaim === true && dataStatus2ndBoost.remainingBoosts === 1 && dataStatus2ndBoost.boostCount === 2);

    // Reclamation du 2eme boost: accorde +7 jours (168h) supplementaires !
    const resClaim2nd = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaim2nd = await resClaim2nd.json();
    check('reclamation avec 2eme boost -> 200 succes, action renew', resClaim2nd.status === 200 && dataClaim2nd.success && dataClaim2nd.action === 'renew');
    check('meme cle conservee', dataClaim2nd.key === firstKeyStr);

    const renewedExpiresAt = new Date(dataClaim2nd.expiresAt).getTime();
    const renewedHours = (renewedExpiresAt - Date.now()) / (1000 * 60 * 60);
    check('cle reactivee/prolongee de 7 jours (~168h)', renewedHours >= 167 && renewedHours <= 169);

    const dbClaimsCount2 = await pool.query('SELECT COUNT(*)::int AS count FROM booster_claims WHERE discord_id = $1', [TEST_DISCORD_ID]);
    check('2 reclamations au total tracees en base', dbClaimsCount2.rows[0].count === 2);

    // 7. Tentative d'un 3eme claim sans 3eme boost -> REFUSE
    const resClaim3rd = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaim3rd = await resClaim3rd.json();
    check('tentative 3eme claim avec 2 boosts -> refuse 403 second_boost_required', resClaim3rd.status === 403 && dataClaim3rd.error === 'second_boost_required');

    // 8. Test de validation in-game: la cle fonctionne dans /api/v1/check
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

    // 9. Arret du boost: si l'utilisateur a arrete de booster completement
    discordService.getBoosterStatus = async () => ({
      inGuild: true,
      isBooster: false, // n'est plus booster!
      boostCount: 0,
      premiumSince: null,
    });

    const resClaimCancelled = await fetch(`${BASE}/api/booster/claim`, {
      method: 'POST',
      headers: { Cookie: `${discordService.USER_COOKIE}=${userCookie}` },
    });
    const dataClaimCancelled = await resClaimCancelled.json();
    check('tentative claim apres arret du boost -> refuse 403 not_booster', resClaimCancelled.status === 403 && dataClaimCancelled.error === 'not_booster');

  } finally {
    // Restauration de la methode originale
    discordService.getBoosterStatus = origGetBoosterStatus;
    discordService.isGuildMember = origIsGuildMember;
    // Nettoyage des donnees de test
    await pool.query('DELETE FROM booster_claims WHERE discord_id = $1', [TEST_DISCORD_ID]);
    await pool.query('DELETE FROM booster_credits WHERE discord_id = $1', [TEST_DISCORD_ID]);
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
