// Diagnostic complet: cles + executions + activite recente
require('dotenv').config();
const pool = require('./src/db');

async function main() {
  const keys = await pool.query(
    `SELECT k.id, k.kid, k.bound_user_id, k.expires_at, k.revoked, k.renewed_count, k.created_at,
            (SELECT COUNT(*)::int FROM executions e WHERE e.key_id = k.id) AS execs
     FROM keys k ORDER BY k.created_at DESC LIMIT 10`
  );
  console.log('=== CLES ===');
  keys.rows.forEach((k) => {
    const expired = new Date(k.expires_at) < new Date();
    console.log(
      `#${k.id} ${k.kid.slice(0, 10)}... | UserId lie: ${k.bound_user_id || 'AUCUN (pas encore utilisee dans Roblox)'} | ${expired ? 'EXPIREE' : 'valide jusqu\'au ' + new Date(k.expires_at).toLocaleString('fr-FR')} | execs: ${k.execs}`
    );
  });

  const execs = await pool.query('SELECT COUNT(*)::int c FROM executions');
  console.log('\n=== EXECUTIONS LOADER TOTAL: ' + execs.rows[0].c + ' ===');

  const lastExecs = await pool.query(
    'SELECT user_id, executor, version, created_at FROM executions ORDER BY created_at DESC LIMIT 5'
  );
  if (lastExecs.rows.length) {
    lastExecs.rows.forEach((e) =>
      console.log(`user ${e.user_id} (${e.executor}) v${e.version} le ${new Date(e.created_at).toLocaleString('fr-FR')}`)
    );
  } else {
    console.log('Aucune execution: le loader n\'a jamais ete utilise avec une cle valide.');
  }

  const builds = await pool.query(
    'SELECT id, version, place_id, active, created_at FROM script_builds ORDER BY created_at DESC LIMIT 5'
  );
  console.log('\n=== BUILDS ===');
  if (builds.rows.length) {
    builds.rows.forEach((b) =>
      console.log(`#${b.id} v${b.version} place=${b.place_id || 'tous jeux'} actif=${b.active}`)
    );
  } else {
    console.log('AUCUN build: aucun script n\'a ete sauvegarde/publie via l\'admin!');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
