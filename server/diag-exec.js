// Diagnostic: le check a-t-il reussi ? erreurs remontees par le loader ?
require('dotenv').config();
const pool = require('./src/db');

async function main() {
  const keys = await pool.query(
    `SELECT k.id, k.kid, k.bound_user_id, k.expires_at, k.revoked,
            (SELECT COUNT(*)::int FROM executions e WHERE e.key_id = k.id) AS execs
     FROM keys k ORDER BY k.created_at DESC LIMIT 5`
  );
  console.log('=== CLES ===');
  keys.rows.forEach((k) => {
    const expired = new Date(k.expires_at) < new Date();
    console.log(
      `#${k.id} lie=${k.bound_user_id || 'aucun'} ${expired ? 'EXPIREE' : 'valide'} revoked=${k.revoked} execs=${k.execs}`
    );
  });

  const execs = await pool.query(
    'SELECT user_id, executor, version, ip, created_at FROM executions ORDER BY created_at DESC LIMIT 5'
  );
  console.log('\n=== EXECUTIONS ===');
  if (execs.rows.length) {
    execs.rows.forEach((e) => console.log(`user=${e.user_id} exec=${e.executor} v${e.version} ip=${e.ip} le=${new Date(e.created_at).toLocaleString('fr-FR')}`));
  } else {
    console.log('AUCUNE: le /check n\'a jamais reussi');
  }

  const errs = await pool.query(
    'SELECT user_id, executor, version, error_msg, created_at FROM error_reports ORDER BY created_at DESC LIMIT 10'
  );
  console.log('\n=== RAPPORTS D\'ERREUR LOADER ===');
  if (errs.rows.length) {
    errs.rows.forEach((e) => console.log(`[${new Date(e.created_at).toLocaleString('fr-FR')}] user=${e.user_id} ${e.executor} v${e.version}: ${e.error_msg}`));
  } else {
    console.log('Aucun rapport d\'erreur remonte par le loader');
  }

  const build = await pool.query(
    'SELECT id, version, place_id, active, length(content) AS len FROM script_builds WHERE active = true ORDER BY created_at DESC LIMIT 3'
  );
  console.log('\n=== BUILDS ACTIFS ===');
  build.rows.forEach((b) => console.log(`#${b.id} v${b.version} place=${b.place_id} active=${b.active} taille=${b.len} chars`));

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
