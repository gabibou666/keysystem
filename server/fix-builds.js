// Repare v3 et v4: reconstruit leurs builds depuis les originaux chiffres
require('dotenv').config();
const pool = require('./src/db');
const { rebuildVersionBuild } = require('./src/compat/pipeline-helpers');

async function main() {
  // Toutes les versions publiees sans build actif
  const broken = await pool.query(
    `SELECT v.id, v.version, v.place_id
     FROM script_versions v
     WHERE NOT EXISTS (
       SELECT 1 FROM script_builds b WHERE b.version_id = v.id AND b.active = true
     )`
  );
  console.log('versions sans build actif: ' + broken.rows.length);
  for (const v of broken.rows) {
    const ok = await rebuildVersionBuild(v.id);
    console.log(`v${v.version} (place ${v.place_id ?? 'tous'}): ${ok ? 'build reconstruit + active' : 'ECHEC (original invalide?)'}`);
  }

  // Verifie l'etat final
  const active = await pool.query(
    `SELECT version, place_id FROM script_builds WHERE active = true ORDER BY version`
  );
  console.log('\n=== BUILDS ACTIFS APRES REPARATION ===');
  active.rows.forEach((a) => console.log(`v${a.version} place=${a.place_id ?? 'tous'}`));
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
