// Test limite 2 pubs / 12h: 3e demande doit etre refusee (ad_limit)
require('dotenv').config();
const pool = require('./src/db');

async function main() {
  // nettoie les sessions de test de cet IP
  await pool.query(`DELETE FROM ll_sessions WHERE ip = '127.0.0.1'`);

  const post = () =>
    fetch('http://localhost:3000/api/key/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ duration: 12 }),
    }).then((r) => r.json());

  // s'assure que l'IP locale compte (trust proxy => x-forwarded-for pris en compte)
  const r1 = await post();
  console.log('demande 1:', r1.success ? 'OK (lien cree)' : 'FAIL ' + JSON.stringify(r1).slice(0, 120));
  const r2 = await post();
  console.log('demande 2:', r2.success ? 'OK (lien cree)' : 'FAIL ' + JSON.stringify(r2).slice(0, 120));
  const r3 = await post();
  console.log('demande 3 (doit etre ad_limit):', r3.reason === 'ad_limit' ? 'OK refusee' : 'FAIL ' + JSON.stringify(r3).slice(0, 120));

  // une autre IP passe
  const r4 = await fetch('http://localhost:3000/api/key/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '99.88.77.66' },
    body: JSON.stringify({ duration: 12 }),
  }).then((r) => r.json());
  console.log('autre IP (doit passer):', r4.success ? 'OK' : 'FAIL ' + JSON.stringify(r4).slice(0, 120));

  // nettoyage
  await pool.query(`DELETE FROM ll_sessions WHERE ip IN ('127.0.0.1','99.88.77.66')`);
  console.log('nettoyage: OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
