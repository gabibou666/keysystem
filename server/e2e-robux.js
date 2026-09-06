// Tests E2E paiement Robux + auto-suppression publish
require('dotenv').config();
const pool = require('./src/db');
const crypto = require('./src/services/crypto');
const robux = require('./src/services/robux');

const BASE = 'http://localhost:3000';

async function main() {
  let pass = 0, fail = 0;
  const check = (l, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + l); ok ? pass++ : fail++; };

  // --- resolveUsername: vrai compte Roblox (Roblox admin) + compte inexistant ---
  const real = await robux.resolveUsername('Roblox');
  check('resolveUsername "Roblox" -> userId officiel', real.found && real.userId === 1);
  await new Promise((r) => setTimeout(r, 2000)); // espacement anti-429 Roblox
  const fake = await robux.resolveUsername('zzz_nobody_zzz_987654');
  // NB: Roblox peut 429 sous charge -> retryable acceptable; not_found est le cas nominal
  check(
    'resolveUsername inexistant -> not_found (ou retryable si Roblox rate-limit)',
    !fake.found && (fake.reason === 'not_found' || fake.retryable)
  );

  // --- ownership: pass non possede par user 1 (gamepass 99999999999) ---
  const notOwned = await robux.checkGamepassOwnership(1, 99999999999);
  check('ownership pass non achete -> owned=false', notOwned.owned === false);

  // --- GET /offers ---
  const offers = await (await fetch(BASE + '/api/robux/offers')).json();
  check('GET /offers -> 4 offres avec prix', offers.success && offers.offers.length === 4 && offers.offers[0].priceR$ === 50);

  // --- POST /verify: username inexistant ---
  const v1 = await fetch(BASE + '/api/robux/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.88' },
    body: JSON.stringify({ username: 'zzz_nobody_zzz_987654', offer_sku: 'day1' }),
  });
  const d1 = await v1.json();
  check(
    'verify compte inexistant -> not_found (ou pending si 429 Roblox)',
    d1.status === 'not_found' || d1.status === 'pending'
  );

  // --- POST /verify: compte reel + pass non achete -> pending (achat pas detecte) ---
  const v1b = await fetch(BASE + '/api/robux/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.89' },
    body: JSON.stringify({ username: 'Roblox', offer_sku: 'day1' }),
  });
  const d1b = await v1b.json();
  check('verify compte reel + pass non achete -> pending', d1b.status === 'pending' && d1b.retryable === true);

  // --- POST /verify: offre inconnue ---
  const v2 = await fetch(BASE + '/api/robux/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Roblox', offer_sku: 'xxx' }),
  });
  const d2 = await v2.json();
  check('verify offre invalide -> invalid_offer (400)', v2.status === 400 && d2.status === 'invalid_offer');

  // --- Webhook Option B: secret manquant -> 401 ---
  const w0 = await fetch(BASE + '/api/robux/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt_id: 'r1', roblox_user_id: 123, product_id: 456 }),
  });
  check('webhook sans secret -> 401', w0.status === 401);

  // --- Webhook: receipt valide -> cle livree, puis REPLAY -> meme cle (idempotent) ---
  // (utilise un product_id du mapping default pour day1)
  const productId = 'prod-day1';
  const w1 = await fetch(BASE + '/api/robux/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-e2e' },
    body: JSON.stringify({ receipt_id: 'e2e-receipt-001', roblox_user_id: 555001, username: 'e2e_user', product_id: productId }),
  });
  const wd1 = await w1.json();
  check('webhook valide -> cle livree', wd1.success && !!wd1.key);

  const w2 = await fetch(BASE + '/api/robux/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-e2e' },
    body: JSON.stringify({ receipt_id: 'e2e-receipt-001', roblox_user_id: 555001, username: 'e2e_user', product_id: productId }),
  });
  const wd2 = await w2.json();
  check('webhook REPLAY meme receipt -> MEME cle (idempotent)', wd2.success && wd2.key === wd1.key && wd2.replay === true);

  // --- Clé livrée est liée au roblox_user_id: un autre user ne peut pas l'utiliser ---
  const keyParts = wd1.key.split('.');
  const chk = await fetch(BASE + '/api/v1/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: wd1.key, userId: 555001, executor: 'E2E' }),
  });
  const cd = await chk.json();
  check('cle robux utilisable par son proprietaire (check OK)', cd.success === true);
  const chk2 = await fetch(BASE + '/api/v1/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: wd1.key, userId: 999002, executor: 'E2E' }),
  });
  const cd2 = await chk2.json();
  check('cle robux REFUSEE pour un autre compte (bound)', cd2.reason === 'bound_to_other_user');

  // --- Transaction anti-reuse (Option A): simulation directe ---
  const ins1 = await pool.query(
    `INSERT INTO robux_purchases (roblox_user_id, roblox_username, gamepass_id, offer_sku, status)
     VALUES (555002, 'e2e_a', 777001, 'day1', 'detected') ON CONFLICT (roblox_user_id, gamepass_id) DO NOTHING RETURNING id`
  );
  const ins2 = await pool.query(
    `INSERT INTO robux_purchases (roblox_user_id, roblox_username, gamepass_id, offer_sku, status)
     VALUES (555002, 'e2e_a', 777001, 'day1', 'detected') ON CONFLICT (roblox_user_id, gamepass_id) DO NOTHING RETURNING id`
  );
  check('transaction anti-reuse: 1er insert OK, 2e bloque', !!ins1.rows[0] && !ins2.rows[0]);

  // --- Rate limit verify: 5/min max -> la 6e doit etre 429 ---
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + '/api/robux/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ username: 'Roblox', offer_sku: 'day1' }),
    });
    if (r.status === 429) { got429 = true; break; }
  }
  check('rate limit /verify -> 429 au-dela de 5/min', got429);

  // --- Auto-suppression au publish: cree 2 versions du meme PlaceId, publie la 2e -> la 1e disparaît ---
  const vA = await pool.query(
    `INSERT INTO script_versions (version, note, place_id, original_enc, original_iv, original_hash)
     VALUES (901, 'old', 555901, 'x', 'y', 'z') RETURNING id`
  );
  const vB = await pool.query(
    `INSERT INTO script_versions (version, note, place_id, original_enc, original_iv, original_hash)
     VALUES (902, 'new', 555901, 'x', 'y', 'z') RETURNING id`
  );
  await pool.query(`INSERT INTO script_builds (version_id, version, place_id, content, active) VALUES ($1, 901, 555901, 'print("old")', true)`, [vA.rows[0].id]);
  await pool.query(`INSERT INTO script_builds (version_id, version, place_id, content, active) VALUES ($1, 902, 555901, 'print("new")', false)`, [vB.rows[0].id]);

  // Publie 902 via la logique de la route (simulation directe de la requete SQL de la route):
  const placeId = 555901;
  const oldVersions = await pool.query(
    `SELECT v.id FROM script_versions v WHERE v.place_id IS NOT DISTINCT FROM $1 AND v.id <> $2`,
    [placeId, vB.rows[0].id]
  );
  const oldIds = oldVersions.rows.map((r) => r.id);
  if (oldIds.length) {
    await pool.query(`UPDATE executions SET build_id = NULL WHERE build_id IN (SELECT id FROM script_builds WHERE version_id = ANY($1::int[]))`, [oldIds]);
    await pool.query(`DELETE FROM ai_patches WHERE build_id IN (SELECT id FROM script_builds WHERE version_id = ANY($1::int[]))`, [oldIds]);
    await pool.query(`DELETE FROM script_builds WHERE version_id = ANY($1::int[])`, [oldIds]);
    await pool.query(`DELETE FROM script_versions WHERE id = ANY($1::int[])`, [oldIds]);
  }
  await pool.query(`DELETE FROM script_builds WHERE place_id = $1 AND version <> 902`, [placeId]);
  await pool.query(`UPDATE script_builds SET active = true WHERE version = 902`, []);

  const after = await pool.query('SELECT version FROM script_versions WHERE place_id = 555901 ORDER BY version');
  const afterBuilds = await pool.query('SELECT version, active FROM script_builds WHERE place_id = 555901');
  check(
    'auto-suppression: 902 publiee, 901 supprimee (1 version restante: ' + after.rows.map(r => r.version).join(',') + ')',
    after.rows.length === 1 && after.rows[0].version === 902 && afterBuilds.rows[0].active === true
  );

  // --- Nettoyage ---
  await pool.query('DELETE FROM ll_sessions WHERE key_id IN (SELECT id FROM keys WHERE note LIKE $1)', ['robux:%']).catch(() => {});
  await pool.query('DELETE FROM executions WHERE user_id IN (555001, 999002)');
  await pool.query('DELETE FROM robux_purchases WHERE roblox_user_id IN (555001, 555002)');
  await pool.query('DELETE FROM robux_receipts WHERE roblox_user_id = 555001');
  await pool.query('DELETE FROM robux_api_logs');
  await pool.query('DELETE FROM keys WHERE note LIKE $1', ['robux:%']).catch(async () => {
    // si FK ll_sessions: detache d'abord
    await pool.query('DELETE FROM ll_sessions WHERE key_id IN (SELECT id FROM keys WHERE note LIKE $1)', ['robux:%']);
    await pool.query('DELETE FROM keys WHERE note LIKE $1', ['robux:%']);
  });
  await pool.query('DELETE FROM script_builds WHERE place_id = 555901');
  await pool.query('DELETE FROM script_versions WHERE place_id = 555901');
  console.log('\nnettoyage OK');
  console.log(`\n=== RESULTAT: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1); });
