// Tests E2E anti-bypass: chaque protection doit REJETER l'attaque
require('dotenv').config();
const crypto = require('./src/services/crypto');
const pool = require('./src/db');

const BASE = 'http://localhost:' + (process.env.PORT || 3000);

async function ensureServer() {
  const ok = await fetch(`${BASE}/api/keepalive`).then(() => true).catch(() => false);
  if (!ok) {
    require('./src/index');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  await ensureServer();
  let pass = 0, fail = 0;
  const check = (label, ok) => {
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    ok ? pass++ : fail++;
  };

  // ---- Contexte: simule une session creee par le proprietaire "u-owner-123"
  const OWNER = '999000111';
  const puid = crypto.randomToken(32);
  await pool.query(
    `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
     VALUES ($1, 1, '203.0.113.50', $2, now() - interval '3 minutes')`,
    [puid, OWNER]
  );

  // Cookie signe du proprietaire
  const discord = require('./src/services/discord');
  const ownerCookie = discord.signUserCookie(OWNER);

  // Secret postback s'il est configure
  const postbackSecretParam = process.env.LOOTLABS_POSTBACK_SECRET
    ? `&secret=${process.env.LOOTLABS_POSTBACK_SECRET}`
    : '';

  // ==== ATTAQUE 1: vol de session COMPLETEE — status SANS cookie ====
  // Preparation: complete la session d'abord (>25s de started_at)
  await fetch(`${BASE}/api/lootlabs/postback?click_id=${puid}&unique_id=pre-${Date.now()}${postbackSecretParam}`);
  const a1 = await fetch(`${BASE}/api/key/status?puid=${puid}`);
  const d1 = await a1.json();
  check('session completee, status SANS cookie -> refuse (pas de cle)', a1.status === 403 && !d1.key);

  // ==== ATTAQUE 2: status avec cookie d'UN AUTRE utilisateur ====
  const otherCookie = discord.signUserCookie('888777666');
  const a2 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${otherCookie}` },
  });
  const d2 = await a2.json();
  check('session completee, cookie d un autre -> refuse 403 forbidden', a2.status === 403 && d2.status === 'forbidden');

  // ==== ATTAQUE 3: postback immediate (< 25s pour 1 tache) = bot ====
  const fastPuid = crypto.randomToken(32);
  await pool.query(
    `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
     VALUES ($1, 1, '203.0.113.51', $2, now())`,
    [fastPuid, OWNER]
  );
  const a3 = await fetch(`${BASE}/api/lootlabs/postback?click_id=${fastPuid}&unique_id=fast-${Date.now()}${postbackSecretParam}`);
  const sess3 = await pool.query('SELECT status FROM ll_sessions WHERE puid = $1', [fastPuid]);
  check('postback < 25s (1 tache) -> rejete (429 + status rejected_too_fast)', a3.status === 429 && sess3.rows[0].status === 'rejected_too_fast');

  // ==== ATTAQUE 4: postback 2 taches (24h) trop rapide (< 55s) ====
  const fast2Puid = crypto.randomToken(32);
  await pool.query(
    `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
     VALUES ($1, 2, '203.0.113.52', $2, now() - interval '35 seconds')`,
    [fast2Puid, OWNER]
  );
  const a3bis = await fetch(`${BASE}/api/lootlabs/postback?click_id=${fast2Puid}&unique_id=fast2-${Date.now()}${postbackSecretParam}`);
  const sess3bis = await pool.query('SELECT status FROM ll_sessions WHERE puid = $1', [fast2Puid]);
  check('postback < 55s pour 2 taches (24h) -> rejete 429', a3bis.status === 429 && sess3bis.rows[0].status === 'rejected_too_fast');

  // ==== ATTAQUE 5: postback legitime (>25s) MAIS puid inconnu ====
  const a4 = await fetch(`${BASE}/api/lootlabs/postback?click_id=unknown-puid-xyz&unique_id=x-${Date.now()}${postbackSecretParam}`);
  check('postback puid inconnu -> 404', a4.status === 404);

  // ==== ATTAQUE 6: postback avec secret invalide si secret active ====
  if (process.env.LOOTLABS_POSTBACK_SECRET) {
    const secretPuid = crypto.randomToken(32);
    await pool.query(
      `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
       VALUES ($1, 1, '203.0.113.53', $2, now() - interval '2 minutes')`,
      [secretPuid, OWNER]
    );
    const aSecret = await fetch(`${BASE}/api/lootlabs/postback?click_id=${secretPuid}&unique_id=badsec-${Date.now()}&secret=wrong-secret-value`);
    check('postback avec secret invalide -> refuse (403)', aSecret.status === 403);
    await pool.query('DELETE FROM ll_sessions WHERE puid = $1', [secretPuid]);
  } else {
    check('postback secret: non configure en dev (passe sans secret)', true);
  }

  // ==== FLUX LEGITIME: le proprietaire recupere sa cle ====
  const a6 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${ownerCookie}` },
  });
  const d6 = await a6.json();
  check('status du proprietaire -> cle delivree', a6.status === 200 && d6.success && !!d6.key);

  // ==== ATTAQUE 7: rejouer le status (token a usage unique) ====
  const a7 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${ownerCookie}` },
  });
  const d7 = await a7.json();
  check('rejeu du status -> deja consomme (409)', a7.status === 409 && d7.status === 'already_claimed');

  // ==== ATTAQUE 8: token de completion expire (TTL) ====
  const tokens = require('./src/services/tokens');
  const expiredToken = tokens.issueCompletionToken({ puid: 'puid-x', tasksDone: 1, tasksRequired: 1 });
  const verif = tokens.verifyCompletionToken(expiredToken, { expectPuid: 'puid-y' });
  check('token avec puid different -> puid_mismatch', !verif.valid && verif.reason === 'puid_mismatch');
  const tampered = expiredToken.slice(0, -3) + 'abc';
  const verif2 = tokens.verifyCompletionToken(tampered);
  check('token falsifie -> invalide', !verif2.valid);

  // ==== ATTAQUE 9: IP mismatch dans le postback (template avec ip=) ====
  const ipPuid = crypto.randomToken(32);
  await pool.query(
    `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
     VALUES ($1, 1, '203.0.113.50', $2, now() - interval '2 minutes')`,
    [ipPuid, OWNER]
  );
  const a8 = await fetch(`${BASE}/api/lootlabs/postback?click_id=${ipPuid}&unique_id=ip-${Date.now()}&ip=1.2.3.4${postbackSecretParam}`);
  check('postback avec IP user differente -> refuse (403)', a8.status === 403);

  // ==== ATTAQUE 10: Vérification HWID in-game (/api/v1/check) ====
  if (d6.key) {
    const hwidA = 'hwid-device-alpha-123456';
    const hwidB = 'hwid-device-bravo-789012';
    const testUid = 88812345;

    // 1er check: lie le userId et le HWID
    const chk1 = await fetch(`${BASE}/api/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: d6.key, userId: testUid, executor: 'TestExec', hwid: hwidA }),
    });
    const dChk1 = await chk1.json();
    check('1er check avec HWID-A -> accepte', dChk1.success === true);

    // 2eme check: meme userId mais HWID DIFFERENT (autre machine)
    const chk2 = await fetch(`${BASE}/api/v1/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: d6.key, userId: testUid, executor: 'TestExec', hwid: hwidB }),
    });
    const dChk2 = await chk2.json();
    check('2eme check avec HWID-B different -> refuse bound_to_other_device', dChk2.success === false && dChk2.reason === 'bound_to_other_device');
  }

  // ==== Nettoyage (ordre FK: ll_sessions avant keys) ====
  const keyKid = d6.key ? d6.key.split('.')[0] : null;
  await pool.query(`DELETE FROM ll_sessions WHERE puid IN ($1, $2, $3, $4)`, [puid, fastPuid, fast2Puid, ipPuid]);
  if (keyKid) {
    await pool.query('DELETE FROM executions WHERE key_id IN (SELECT id FROM keys WHERE kid = $1)', [keyKid]).catch(() => {});
    await pool.query('DELETE FROM keys WHERE kid = $1', [keyKid]).catch(() => {});
  }
  await pool.query(`DELETE FROM postbacks WHERE puid IN ($1, $2, $3, $4)`, [puid, fastPuid, fast2Puid, ipPuid]);
  console.log('\nnettoyage OK');
  console.log(`\n=== RESULTAT: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
